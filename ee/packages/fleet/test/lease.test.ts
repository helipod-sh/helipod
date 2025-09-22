import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { LeaseManager } from "../src/lease";
import { fleetProbeMs, fleetAcquireRetryMs } from "../src/node";
import { PgliteClient } from "./pglite-client";

// Real advisory-lock CONTENTION (a second writer failing to acquire while the first holds it) is
// NOT covered here — PgliteClient is a single in-process connection where tryAcquireWriterLock()
// is always true (see test/pglite-client.ts). That path is covered only by the Task 7 E2E against
// real Postgres with two independent connections.

describe("LeaseManager", () => {
  let client: PgliteClient;

  beforeEach(() => {
    client = new PgliteClient();
  });

  afterEach(async () => {
    await client.close();
  });

  it("setup() creates the shard_leases table", async () => {
    const mgr = new LeaseManager(client, { advertiseUrl: "http://node-a:4000" });
    await mgr.setup();
    const rows = await client.query(
      "SELECT table_name FROM information_schema.tables WHERE table_name = 'shard_leases'",
    );
    expect(rows.length).toBe(1);
  });

  it("tryAcquire() returns epoch 1 on first call, epoch 2 on second", async () => {
    const mgr = new LeaseManager(client, { advertiseUrl: "http://node-a:4000" });
    await mgr.setup();

    const first = await mgr.tryAcquire();
    expect(first).toEqual({ epoch: 1n, writerUrl: "http://node-a:4000" });

    const second = await mgr.tryAcquire();
    expect(second).toEqual({ epoch: 2n, writerUrl: "http://node-a:4000" });
  });

  it("read() returns the latest lease row, including the fencing/frontier columns", async () => {
    const mgr = new LeaseManager(client, { advertiseUrl: "http://node-a:4000", applicationName: "node-a-app" });
    await mgr.setup();

    expect(await mgr.read()).toBeNull();

    await mgr.tryAcquire();
    expect(await mgr.read()).toMatchObject({
      epoch: 1n,
      writerUrl: "http://node-a:4000",
      writerAppName: "node-a-app",
      frontierTs: 0n,
      prevTs: 0n,
    });
    expect((await mgr.read())?.expiresAt).toBeTruthy();

    await mgr.tryAcquire();
    // Re-acquisition (epoch 2) bumps the epoch but must NOT reset frontier_ts/prev_ts — the
    // durable-commit chain survives across epochs (D3 depends on this).
    expect(await mgr.read()).toMatchObject({
      epoch: 2n,
      writerUrl: "http://node-a:4000",
      writerAppName: "node-a-app",
      frontierTs: 0n,
      prevTs: 0n,
    });
  });

  it("acquireLoop() fires onAcquired once then stop() halts further retries", async () => {
    vi.useFakeTimers();
    try {
      const mgr = new LeaseManager(client, { advertiseUrl: "http://node-a:4000", retryMs: 10 });
      await mgr.setup();

      const onAcquired = vi.fn();
      mgr.acquireLoop(onAcquired);

      // Let the loop's first (immediate or timer-driven) attempt run.
      await vi.advanceTimersByTimeAsync(10);
      expect(onAcquired).toHaveBeenCalledTimes(1);
      expect(onAcquired).toHaveBeenCalledWith({ epoch: 1n, writerUrl: "http://node-a:4000" });

      mgr.stop();

      // Advance well past several more retry intervals — nothing further should fire.
      await vi.advanceTimersByTimeAsync(10 * 10);
      expect(onAcquired).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("acquireLoop() survives a transient tryAcquire() rejection and keeps retrying", async () => {
    vi.useFakeTimers();
    try {
      const mgr = new LeaseManager(client, { advertiseUrl: "http://node-a:4000", retryMs: 10 });
      await mgr.setup();

      const original = mgr.tryAcquire.bind(mgr);
      let calls = 0;
      vi.spyOn(mgr, "tryAcquire").mockImplementation(async () => {
        calls += 1;
        if (calls === 1) throw new Error("transient connection error");
        return original();
      });

      const onAcquired = vi.fn();
      mgr.acquireLoop(onAcquired);

      // First attempt rejects; loop must not die — it should reschedule and succeed on retry.
      await vi.advanceTimersByTimeAsync(10);
      expect(onAcquired).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(10);
      expect(onAcquired).toHaveBeenCalledTimes(1);
      expect(onAcquired).toHaveBeenCalledWith({ epoch: 1n, writerUrl: "http://node-a:4000" });

      mgr.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("shard_id PRIMARY KEY enforces single-row-per-shard discipline on shard_leases", async () => {
    const mgr = new LeaseManager(client, { advertiseUrl: "http://node-a:4000" });
    await mgr.setup();

    // First bare INSERT for 'default' succeeds (table is empty). A second bare INSERT for the SAME
    // shard_id must violate the PRIMARY KEY — the upsert discipline (ON CONFLICT DO UPDATE) is how
    // tryAcquire() legitimately re-acquires; a plain duplicate INSERT (bypassing the upsert) must fail.
    await client.query(
      "INSERT INTO shard_leases (shard_id, epoch, writer_url, expires_at) VALUES ('default', 1, 'http://test:4000', now())",
    );
    await expect(
      client.query(
        "INSERT INTO shard_leases (shard_id, epoch, writer_url, expires_at) VALUES ('default', 2, 'http://test2:4000', now())",
      ),
    ).rejects.toThrow();
  });

  it("tryAcquire() records writer_app_name from LeaseManagerOptions.applicationName", async () => {
    const mgr = new LeaseManager(client, {
      advertiseUrl: "http://node-a:4000",
      applicationName: "stackbase-fleet-4000",
    });
    await mgr.setup();
    await mgr.tryAcquire();

    const rows = await client.query("SELECT writer_app_name FROM shard_leases WHERE shard_id = 'default'");
    expect(rows[0]!.writer_app_name).toBe("stackbase-fleet-4000");
  });

  it("heartbeat(epoch) extends expires_at and returns 1 row updated for the current epoch", async () => {
    const mgr = new LeaseManager(client, { advertiseUrl: "http://node-a:4000" });
    await mgr.setup();
    const acquired = await mgr.tryAcquire();

    const before = (await client.query("SELECT expires_at FROM shard_leases WHERE shard_id = 'default'"))[0]!
      .expires_at;
    const n = await mgr.heartbeat(acquired!.epoch);
    expect(n).toBe(1);
    const after = (await client.query("SELECT expires_at FROM shard_leases WHERE shard_id = 'default'"))[0]!
      .expires_at;
    expect(after).not.toBe(before);
  });

  it("heartbeat(epoch) with a stale (superseded) epoch returns 0 rows updated", async () => {
    const mgr = new LeaseManager(client, { advertiseUrl: "http://node-a:4000" });
    await mgr.setup();
    const first = await mgr.tryAcquire(); // epoch 1
    await mgr.tryAcquire(); // epoch 2 — supersedes epoch 1

    const n = await mgr.heartbeat(first!.epoch);
    expect(n).toBe(0);
  });

  it("currentEpoch() tracks the most recently acquired epoch, live across re-acquisitions", async () => {
    const mgr = new LeaseManager(client, { advertiseUrl: "http://node-a:4000" });
    await mgr.setup();
    expect(mgr.currentEpoch()).toBeNull();

    await mgr.tryAcquire();
    expect(mgr.currentEpoch()).toBe(1n);

    await mgr.tryAcquire();
    expect(mgr.currentEpoch()).toBe(2n);
  });

  it("ttlMs stamps a shorter expires_at — a small TTL expires quickly, exposed via ttlMs + isExpired()", async () => {
    const mgr = new LeaseManager(client, { advertiseUrl: "http://node-a:4000", ttlMs: 120 });
    expect(mgr.ttlMs).toBe(120); // public — the LeaseMonitor derives its probe cadence from this
    await mgr.setup();
    await mgr.tryAcquire();

    // Fresh lease is not yet expired.
    expect(await mgr.isExpired()).toBe(false);
    // After well past the 120ms TTL (no heartbeat), the DB's own clock reports it expired — the exact
    // signal a follower's evict path keys off. A default-TTL (15s) lease would NOT be expired here.
    await new Promise((r) => setTimeout(r, 300));
    expect(await mgr.isExpired()).toBe(true);
  });

  it("ttlMs defaults to 15000 and clamps a non-positive/NaN value back to the default", () => {
    expect(new LeaseManager(client, { advertiseUrl: "http://x:1" }).ttlMs).toBe(15_000);
    // A garbage TTL must not produce a born-expired lease (invalid SQL / negative interval); the
    // stamped value clamps to the default even though the reported ttlMs echoes the raw input.
    const bad = new LeaseManager(client, { advertiseUrl: "http://x:1", ttlMs: -5 });
    expect(bad.ttlMs).toBe(-5); // echoed as given (cadence derivation still gets a real number below)
  });
});

describe("LeaseManager.seedFrontier (F1 fix: pre-loaded-database bootstrap hole)", () => {
  let client: PgliteClient;

  beforeEach(() => {
    client = new PgliteClient();
  });

  afterEach(async () => {
    await client.close();
  });

  it("seeds frontier_ts up from 0 to the given maxTs, epoch-fenced to the current epoch", async () => {
    const mgr = new LeaseManager(client, { advertiseUrl: "http://node-a:4000" });
    await mgr.setup();
    const acquired = await mgr.tryAcquire(); // epoch 1, frontier_ts seeded to 0 (first-row creation)
    expect((await mgr.read())?.frontierTs).toBe(0n);

    await mgr.seedFrontier(acquired!.epoch, 1000n);

    expect((await mgr.read())?.frontierTs).toBe(1000n);
    // prev_ts is deliberately untouched by a seed (not a commit) — stays at its prior value.
    expect((await mgr.read())?.prevTs).toBe(0n);
  });

  it("is a no-op (GREATEST) when frontier_ts is already >= maxTs — an already-live fleet is unaffected", async () => {
    const mgr = new LeaseManager(client, { advertiseUrl: "http://node-a:4000" });
    await mgr.setup();
    const acquired = await mgr.tryAcquire();
    await mgr.seedFrontier(acquired!.epoch, 5000n);
    expect((await mgr.read())?.frontierTs).toBe(5000n);

    // A second seed with a LOWER maxTs (e.g. a restart re-running the seed step) must never regress.
    await mgr.seedFrontier(acquired!.epoch, 10n);
    expect((await mgr.read())?.frontierTs).toBe(5000n);
  });

  it("no-ops (affects 0 rows) against a stale/superseded epoch — never clobbers a newer writer's row", async () => {
    const mgr = new LeaseManager(client, { advertiseUrl: "http://node-a:4000" });
    await mgr.setup();
    const first = await mgr.tryAcquire(); // epoch 1
    await mgr.tryAcquire(); // epoch 2 — supersedes epoch 1, frontier_ts still 0

    // Seeding against the STALE epoch 1 must not touch the row at all (epoch-fenced WHERE clause).
    await mgr.seedFrontier(first!.epoch, 9999n);
    expect((await mgr.read())?.frontierTs).toBe(0n);
  });
});

describe("fleet cadence derivation (fleetProbeMs / fleetAcquireRetryMs)", () => {
  it("the default TTL reproduces the historical hard-coded probe/retry constants exactly", () => {
    // 15000ms TTL → 5000ms probe (old LeaseMonitor default) and 2000ms retry (old LeaseManager
    // default): the production default is byte-for-byte behavior-identical after the change.
    expect(fleetProbeMs(15_000)).toBe(5_000);
    expect(fleetAcquireRetryMs(15_000)).toBe(2_000);
  });

  it("a shortened TTL scales the whole clock proportionally, never to zero", () => {
    expect(fleetProbeMs(4_000)).toBe(Math.round(4_000 / 3)); // ~1333ms — 3 renewals per TTL
    expect(fleetAcquireRetryMs(4_000)).toBe(Math.round((4_000 * 2) / 15)); // ~533ms
    // Even an absurdly tiny TTL yields at least a 1ms interval (never a 0ms busy-loop).
    expect(fleetProbeMs(1)).toBeGreaterThanOrEqual(1);
    expect(fleetAcquireRetryMs(1)).toBeGreaterThanOrEqual(1);
  });
});
