/* Helipod Enterprise. Licensed under the Helipod Commercial License — see ee/LICENSE. */
/**
 * Fenced Frontier B1 (Task 4): fencing-first eviction of an expired lease + wedged-writer takeover
 * via the acquire loop. Exercised against a real `PostgresDocStore`/`LeaseManager` over PGlite (real
 * Postgres semantics, in-process).
 *
 * SINGLE-CONNECTION CAVEAT: PGlite is one in-process connection, so the parts that need genuine
 * cross-connection contention are NOT covered here and are E2E-only (Task 7, real Postgres, two
 * independent connections):
 *   - the `SELECT ... FOR UPDATE` row-lock serialization of `evictExpired` against a CONCURRENT
 *     commit-guard UPDATE (and the `lock_timeout='2s'` bail that protects it), and
 *   - a real `pg_terminate_backend` actually killing a wedged holder's backend (here the terminate
 *     query is intercepted by a stub client — PGlite has a single backend and no advisory contention).
 * What IS proven here: the exact eviction SQL (epoch bump, url/app-name clear, frontier GREATEST
 * high-water preservation, old-app-name capture), the live-row no-op, and the acquire-loop tick
 * sequence (expired → evict → terminate-by-app-name → acquisition proceeds).
 */
import { describe, it, expect, vi } from "vitest";
import { newDocumentId, type InternalDocumentId } from "@helipod/id-codec";
import type { DocumentLogEntry } from "@helipod/docstore";
import type { PgClient, PgQuerier, PgRow, PgValue } from "@helipod/docstore-postgres";
import { PostgresDocStore } from "@helipod/docstore-postgres";
import { LeaseManager } from "../src/lease";
import { installCommitGuard } from "../src/node";
import { PgliteClient } from "./pglite-client";

const TABLE = 20004;

function doc(id: InternalDocumentId, body: string): DocumentLogEntry {
  return { ts: 0n, id, prev_ts: null, value: { id, value: { body } } };
}

/** A LeaseManager wired against a `PostgresDocStore` (for the sequence + commit guard) sharing the
 *  same PGlite connection. */
async function makeStore(opts?: { applicationName?: string }): Promise<{
  client: PgliteClient;
  pgStore: PostgresDocStore;
  lease: LeaseManager;
}> {
  const client = new PgliteClient();
  const pgStore = new PostgresDocStore(client);
  await pgStore.setupSchema(); // creates the helipod_ts sequence evictExpired draws from
  const lease = new LeaseManager(client, {
    advertiseUrl: "http://node-a:4000",
    applicationName: opts?.applicationName,
  });
  await lease.setup();
  return { client, pgStore, lease };
}

/** Force the lease row's `expires_at` into the past — the deterministic stand-in for "the holder
 *  stopped heartbeating" without waiting out the real 15s TTL. */
async function expireLease(client: PgClient): Promise<void> {
  await client.query(`UPDATE shard_leases SET expires_at = now() - interval '1 second' WHERE shard_id = 'default'`);
}

describe("Fenced Frontier B1: fencing-first eviction (Task 4)", () => {
  it("evictExpired() on an expired row bumps epoch, clears urls, bumps frontier, returns the old app name", async () => {
    const { client, lease } = await makeStore({ applicationName: "helipod-fleet-4000" });
    await lease.tryAcquire(); // epoch 1, writer_url + writer_app_name set
    await expireLease(client);

    const result = await lease.evictExpired();
    expect(result).toEqual({ fenced: true, oldAppName: "helipod-fleet-4000" });

    const row = await lease.read();
    expect(row?.epoch).toBe(2n); // fenced: epoch bumped
    expect(row?.writerUrl).toBeNull();
    expect(row?.writerAppName).toBeNull();
    expect(row?.frontierTs).toBeGreaterThanOrEqual(0n); // seeded 0 → GREATEST(0, nextval) ≥ 0

    await client.close();
  });

  it("evictExpired() on a LIVE (unexpired) row is a no-op → {fenced:false} and leaves the row untouched", async () => {
    const { client, lease } = await makeStore({ applicationName: "helipod-fleet-4000" });
    await lease.tryAcquire(); // fresh 15s TTL — live

    const before = await lease.read();
    const result = await lease.evictExpired();
    expect(result).toEqual({ fenced: false, oldAppName: null });

    const after = await lease.read();
    expect(after?.epoch).toBe(before?.epoch); // untouched — no epoch bump
    expect(after?.writerUrl).toBe("http://node-a:4000");
    expect(after?.writerAppName).toBe("helipod-fleet-4000");

    await client.close();
  });

  it("eviction after commits preserves the frontier high-water — GREATEST(frontier_ts, nextval), never a reset", async () => {
    const { client, pgStore, lease } = await makeStore({ applicationName: "helipod-fleet-4000" });
    await lease.tryAcquire(); // epoch 1
    installCommitGuard(pgStore, lease, () => {});

    // Two real commits advance frontier_ts to a NONZERO high-water via the commit guard.
    const commit1 = await pgStore.commitWrite([doc(newDocumentId(TABLE), "a")], []);
    const commit2 = await pgStore.commitWrite([doc(newDocumentId(TABLE), "b")], []);
    const frontierBefore = (await lease.read())!.frontierTs;
    expect(frontierBefore).toBe(commit2);
    expect(frontierBefore).toBeGreaterThan(0n);

    await expireLease(client);
    const result = await lease.evictExpired();
    expect(result.fenced).toBe(true);

    const frontierAfter = (await lease.read())!.frontierTs;
    // The GREATEST keeps the high-water: frontier survives eviction, ≥ its old value AND ≥ every
    // committed ts. A `nextval`-alone eviction could regress below commit2 if the sequence lagged.
    expect(frontierAfter).toBeGreaterThanOrEqual(frontierBefore);
    expect(frontierAfter).toBeGreaterThanOrEqual(commit1);
    expect(frontierAfter).toBeGreaterThanOrEqual(commit2);

    await client.close();
  });

  it("frontier survives eviction THEN re-acquisition with a NONZERO frontier — never reset (Task 3 review gap)", async () => {
    // The Task 3 test only proved frontier-survives-re-acquisition from a ZERO frontier (fresh row).
    // This drives the real chain: commit (frontier advances) → expire → EVICT → re-acquire, asserting
    // the durable-commit frontier is never reset by either the eviction or the subsequent acquisition.
    const { client, pgStore, lease } = await makeStore({ applicationName: "helipod-fleet-4000" });
    await lease.tryAcquire(); // epoch 1
    installCommitGuard(pgStore, lease, () => {});

    const commitTs = await pgStore.commitWrite([doc(newDocumentId(TABLE), "x")], []);
    const frontierCommitted = (await lease.read())!.frontierTs;
    expect(frontierCommitted).toBe(commitTs);
    expect(frontierCommitted).toBeGreaterThan(0n);

    await expireLease(client);
    await lease.evictExpired(); // fences: epoch → 2, frontier GREATEST-preserved
    const frontierAfterEvict = (await lease.read())!.frontierTs;
    expect(frontierAfterEvict).toBeGreaterThanOrEqual(frontierCommitted);

    // Re-acquire (ON CONFLICT preserves the frontier columns) — the new writer inherits the frontier.
    const reacquired = await lease.tryAcquire();
    expect(reacquired!.epoch).toBe(3n); // 1 (acquire) → 2 (evict) → 3 (re-acquire)
    const frontierAfterReacquire = (await lease.read())!.frontierTs;
    expect(frontierAfterReacquire).toBeGreaterThanOrEqual(frontierCommitted); // never reset to 0

    await client.close();
  });
});

/**
 * A `PgClient` wrapper over PGlite that (a) lets a test force `tryAcquireWriterLock()` to report
 * contention (false), and (b) intercepts the `pg_terminate_backend` query — PGlite has a single
 * backend and no advisory contention, so this stands in for the E2E's real termination. Everything
 * else (transactions, SELECT/UPDATE, the sequence) delegates to real PGlite.
 */
class EvictLoopClient implements PgClient {
  advisoryAvailable = false;
  readonly terminatedAppNames: string[] = [];
  constructor(private readonly inner: PgliteClient) {}

  async query(text: string, params?: readonly PgValue[]): Promise<PgRow[]> {
    if (text.includes("pg_terminate_backend")) {
      this.terminatedAppNames.push(params?.[0] as string);
      return []; // stand in for the real terminate (single-backend PGlite can't run it meaningfully)
    }
    return this.inner.query(text, params);
  }
  transaction<T>(fn: (tx: PgQuerier) => Promise<T>): Promise<T> {
    // Delegate to PGlite's real BEGIN/COMMIT; the callback's `tx` is the real querier (SET LOCAL,
    // SELECT ... FOR UPDATE, UPDATE all hit PGlite). The intercepted terminate query runs OUTSIDE any
    // transaction (via `query` above), so it never routes through here.
    return this.inner.transaction(fn);
  }
  async acquireWriterLock(): Promise<void> {}
  async tryAcquireWriterLock(): Promise<boolean> {
    return this.advisoryAvailable;
  }
  async close(): Promise<void> {
    await this.inner.close();
  }
}

describe("Fenced Frontier B1: wedged-writer takeover in the acquire loop (Task 4)", () => {
  it("expired lease + advisory-contended tick → evict → terminate-by-app-name → acquisition proceeds", async () => {
    vi.useFakeTimers();
    try {
      const inner = new PgliteClient();
      // Seed the schema + an EXPIRED lease held by a wedged writer, using the raw inner client.
      const pgStore = new PostgresDocStore(inner);
      await pgStore.setupSchema();
      const seedLease = new LeaseManager(inner, {
        advertiseUrl: "http://wedged:5000",
        applicationName: "helipod-fleet-5000",
      });
      await seedLease.setup();
      await seedLease.tryAcquire(); // epoch 1, held by the wedged writer
      await inner.query(
        `UPDATE shard_leases SET expires_at = now() - interval '1 second' WHERE shard_id = 'default'`,
      );

      // The taking-over node: advisory try FAILS (the wedged holder still owns the lock) until we
      // release it after termination.
      const client = new EvictLoopClient(inner);
      const taker = new LeaseManager(client, { advertiseUrl: "http://taker:6000", retryMs: 10 });

      const onAcquired = vi.fn();
      taker.acquireLoop(onAcquired);

      // Tick 1: advisory try false → lease expired → evictExpired (epoch → 2) → terminate the wedged
      // holder's backend by its app_name. Acquisition does NOT happen this tick (advisory still false).
      await vi.advanceTimersByTimeAsync(10);
      expect(client.terminatedAppNames).toEqual(["helipod-fleet-5000"]);
      expect(onAcquired).not.toHaveBeenCalled();
      expect((await seedLease.read())?.epoch).toBe(2n); // fenced

      // The terminate released the advisory lock — model that by letting the next try succeed.
      client.advisoryAvailable = true;
      await vi.advanceTimersByTimeAsync(10);
      // Acquisition proceeds: tryAcquire bumps the epoch again (monotonic — fine) and fires onAcquired.
      expect(onAcquired).toHaveBeenCalledTimes(1);
      expect(onAcquired.mock.calls[0]![0]).toMatchObject({ writerUrl: "http://taker:6000" });
      expect(onAcquired.mock.calls[0]![0].epoch).toBe(3n);

      taker.stop();
      await inner.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("advisory-contended tick with a LIVE lease neither evicts nor terminates (no takeover of a healthy writer)", async () => {
    vi.useFakeTimers();
    try {
      const inner = new PgliteClient();
      const pgStore = new PostgresDocStore(inner);
      await pgStore.setupSchema();
      const holder = new LeaseManager(inner, {
        advertiseUrl: "http://holder:5000",
        applicationName: "helipod-fleet-5000",
      });
      await holder.setup();
      await holder.tryAcquire(); // fresh 15s TTL — LIVE

      const client = new EvictLoopClient(inner); // advisory contended (false)
      const taker = new LeaseManager(client, { advertiseUrl: "http://taker:6000", retryMs: 10 });
      const onAcquired = vi.fn();
      taker.acquireLoop(onAcquired);

      await vi.advanceTimersByTimeAsync(10 * 5); // several ticks
      expect(client.terminatedAppNames).toEqual([]); // never fenced a live holder
      expect(onAcquired).not.toHaveBeenCalled();
      expect((await holder.read())?.epoch).toBe(1n); // untouched

      taker.stop();
      await inner.close();
    } finally {
      vi.useRealTimers();
    }
  });
});
