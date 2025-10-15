/**
 * Per-shard commit-connection pool + per-slot advisory locks (Fenced Frontier B2a, D1/D5).
 *
 * WHY THIS EXISTS — the spec review PROVED the single pinned `NodePgClient` connection cannot run
 * two commit transactions concurrently: pg queues per session, so two interleaved `transaction()`
 * calls collapse into ONE BEGIN/COMMIT and the first COMMIT commits BOTH shards' half-staged rows
 * (atomicity corruption). The fix is a dedicated commit connection per shard.
 *
 * TEST STRATEGY (honest about the tools):
 *  - The pool's WIRING (distinct per-shard connections, lazy open, session timeouts on EVERY commit
 *    connection, app-name suffixes, the two-int per-slot lock on the shard's connection, per-shard
 *    connection-lost routing, close-all) is unit-tested with `pg` MOCKED — no live Postgres, exactly
 *    like `node-pg-client-listen.test.ts` / `session-timeouts.test.ts`.
 *  - `commitWrite`'s pool ROUTING (+ the D5 shardId threaded to the guard) is tested against a stub
 *    `PgClient`.
 *  - The atomicity-corruption HAZARD SHAPE is proven on a single connection with PGlite (real
 *    Postgres semantics, in-process) — demonstrating exactly the corruption the pool prevents.
 *  - PGlite is single-connection and cannot share a DB across instances, so the REAL two-connection
 *    concurrency proof (shard A's commit held open across an await while shard B's completes first)
 *    is a `STACKBASE_TEST_DATABASE_URL`-gated test in `commit-pool-real-pg.test.ts` + the T6 fleet E2E
 *    against real Postgres — it cannot be expressed here.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { newDocumentId, type InternalDocumentId } from "@stackbase/id-codec";
import type { DocumentLogEntry } from "@stackbase/docstore";
import { PostgresDocStore } from "../src/postgres-docstore";
import type { PgClient, PgQuerier, PgRow, PgTransactionalQuerier, PgValue } from "../src/pg-client";
import { SHARD_ADVISORY_LOCK_CLASS } from "../src/pg-client";
import { PgliteClient } from "./pglite-client";

// ---- pg mock (captures per-connection queries, app_name, event handlers, end) ------------------

interface FakeClientInstance {
  opts: { connectionString: string; application_name?: string };
  queries: { text: string; params?: unknown[] }[];
  handlers: Record<string, Array<(...a: unknown[]) => void>>;
  ended: boolean;
}

const state = vi.hoisted(() => ({
  instances: [] as FakeClientInstance[],
  // FIFO of connect() override behaviors, consumed one per connect() CALL (not per instance) — lets
  // a test make e.g. the first shard-connect attempt reject and the second (on a brand-new client)
  // succeed, without needing to know the instance index up front. Empty/no entry → default resolve.
  connectQueue: [] as Array<(() => Promise<void>) | undefined>,
}));

vi.mock("pg", () => {
  class FakeClient implements FakeClientInstance {
    queries: { text: string; params?: unknown[] }[] = [];
    handlers: Record<string, Array<(...a: unknown[]) => void>> = {};
    ended = false;
    constructor(public opts: { connectionString: string; application_name?: string }) {
      state.instances.push(this);
    }
    async connect(): Promise<void> {
      const behavior = state.connectQueue.shift();
      if (behavior) return behavior();
    }
    on(event: string, cb: (...a: unknown[]) => void): void {
      (this.handlers[event] ??= []).push(cb);
    }
    async query(text: string, params?: unknown[]): Promise<{ rows: unknown[] }> {
      this.queries.push({ text, params });
      if (/pg_try_advisory_lock/.test(text)) return { rows: [{ ok: true }] };
      return { rows: [] };
    }
    async end(): Promise<void> {
      this.ended = true;
    }
  }
  return { default: { Client: FakeClient, types: { getTypeParser: () => (v: string) => v } } };
});

// Imported AFTER vi.mock — vitest hoists the mock above imports regardless of source order.
import { NodePgClient } from "../src/node-pg-client";

/** Fire a captured event's handlers (simulates pg's error/end on a specific connection). */
function emit(inst: FakeClientInstance, event: string): void {
  for (const cb of inst.handlers[event] ?? []) cb();
}
const texts = (inst: FakeClientInstance): string[] => inst.queries.map((q) => q.text);

afterEach(() => {
  state.instances.length = 0;
  state.connectQueue.length = 0;
  vi.clearAllMocks();
});

describe("NodePgClient commit pool — wiring (pg mocked)", () => {
  it("a poolless client exposes NONE of the pool capabilities (presence == capability)", () => {
    const client = new NodePgClient({ connectionString: "postgres://fake" });
    expect(client.commitPoolShards).toBeUndefined();
    expect(client.commitQuerierFor).toBeUndefined();
    expect(client.onShardConnectionLost).toBeUndefined();
    expect(client.tryAcquireShardLock).toBeUndefined();
    expect(client.releaseShardLock).toBeUndefined();
  });

  it("a pool client exposes the pool capabilities and records the ordered shard list", () => {
    const client = new NodePgClient({
      connectionString: "postgres://fake",
      commitPool: { shards: ["default", "s1", "s2"] },
    });
    expect(client.commitPoolShards).toEqual(["default", "s1", "s2"]);
    expect(typeof client.commitQuerierFor).toBe("function");
    expect(typeof client.onShardConnectionLost).toBe("function");
    expect(typeof client.tryAcquireShardLock).toBe("function");
    expect(typeof client.releaseShardLock).toBe("function");
  });

  it("opens NO commit connection until commitQuerierFor is first called, one per shard, reused", async () => {
    const client = new NodePgClient({
      connectionString: "postgres://fake",
      applicationName: "stackbase-fleet-4000",
      commitPool: { shards: ["default", "s1"] },
    });
    // Constructor built only the pinned connection.
    expect(state.instances).toHaveLength(1);

    await client.commitQuerierFor!("s1");
    expect(state.instances).toHaveLength(2);
    const s1 = state.instances[1]!;
    expect(s1.opts.application_name).toBe("stackbase-fleet-4000-commit-s1");

    await client.commitQuerierFor!("default");
    expect(state.instances).toHaveLength(3);
    expect(state.instances[2]!.opts.application_name).toBe("stackbase-fleet-4000-commit-default");

    // Same shard again → reuses the existing connection, opens nothing new.
    await client.commitQuerierFor!("s1");
    expect(state.instances).toHaveLength(3);
  });

  it("a rejected shard connect is evicted, not memoized — the next attempt opens a fresh connection", async () => {
    const client = new NodePgClient({
      connectionString: "postgres://fake",
      commitPool: { shards: ["s1"] },
    });

    // First connect() call (the shard's commit connection — the pinned connection is never
    // touched in this test) rejects. Before the fix, the rejected promise was memoized forever
    // by `??=`, so every subsequent commitQuerierFor("s1") would replay this SAME rejection
    // without ever calling connect() again.
    state.connectQueue.push(() => Promise.reject(new Error("connect boom")));

    await expect(client.commitQuerierFor!("s1")).rejects.toThrow("connect boom");
    expect(state.instances).toHaveLength(2); // pinned + one failed shard-connect attempt

    // Second attempt: no override queued → the FakeClient's default connect() resolves. If the
    // cache entry were still memoized (bug), this would replay "connect boom" again and no new
    // `pg.Client` would be constructed — pg itself would also refuse to reconnect the SAME
    // client instance a second time, so reuse isn't even an option after a failed connect.
    const q = await client.commitQuerierFor!("s1");
    expect(state.instances).toHaveLength(3); // pinned + failed attempt + a FRESH shard client
    await q.query("SELECT 1");
    expect(texts(state.instances[2]!)).toContain("SELECT 1");
  });

  it("rejects commitQuerierFor / tryAcquireShardLock for an unknown shard or out-of-range slot", async () => {
    const client = new NodePgClient({
      connectionString: "postgres://fake",
      commitPool: { shards: ["default", "s1"] },
    });
    await expect(client.commitQuerierFor!("s9")).rejects.toThrow(/not a configured commit-pool shard/);
    await expect(client.tryAcquireShardLock!(5)).rejects.toThrow(/slot 5 out of range/);
  });

  it("applies session timeouts on EVERY commit connection before any user query (hazard a)", async () => {
    const client = new NodePgClient({
      connectionString: "postgres://fake",
      applicationName: "app",
      sessionTimeouts: { idleInTransactionMs: 5000, statementMs: 10000 },
      commitPool: { shards: ["s1"] },
    });
    const q = await client.commitQuerierFor!("s1");
    await q.query("SELECT 1");

    const s1 = state.instances[1]!;
    expect(texts(s1).slice(0, 3)).toEqual([
      "SET idle_in_transaction_session_timeout = 5000",
      "SET statement_timeout = 10000",
      "SELECT 1",
    ]);
  });

  it("commitQuerierFor's transaction BEGIN/COMMITs on THAT shard's connection, isolated per shard", async () => {
    const client = new NodePgClient({
      connectionString: "postgres://fake",
      commitPool: { shards: ["default", "s1"] },
    });
    const qS1 = await client.commitQuerierFor!("s1");
    await qS1.transaction(async (tx) => {
      await tx.query("INSERT INTO t VALUES (1)");
    });
    const qDefault = await client.commitQuerierFor!("default");
    await qDefault.transaction(async (tx) => {
      await tx.query("INSERT INTO t VALUES (2)");
    });

    const s1 = state.instances[1]!;
    const def = state.instances[2]!;
    // Each shard's BEGIN/INSERT/COMMIT lands on its OWN connection — never crossing over.
    expect(texts(s1)).toEqual(["BEGIN", "INSERT INTO t VALUES (1)", "COMMIT"]);
    expect(texts(def)).toEqual(["BEGIN", "INSERT INTO t VALUES (2)", "COMMIT"]);
    // The pinned connection was never used for a commit.
    expect(texts(state.instances[0]!)).not.toContain("BEGIN");
  });

  it("commitQuerierFor's transaction ROLLBACKs on throw (on the shard's connection)", async () => {
    const client = new NodePgClient({
      connectionString: "postgres://fake",
      commitPool: { shards: ["s1"] },
    });
    const q = await client.commitQuerierFor!("s1");
    await expect(
      q.transaction(async (tx) => {
        await tx.query("INSERT INTO t VALUES (1)");
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(texts(state.instances[1]!)).toEqual(["BEGIN", "INSERT INTO t VALUES (1)", "ROLLBACK"]);
  });

  it("tryAcquireShardLock(slot) issues the two-int pg_try_advisory_lock ON shards[slot]'s connection", async () => {
    const client = new NodePgClient({
      connectionString: "postgres://fake",
      applicationName: "app",
      commitPool: { shards: ["default", "s1", "s2"] },
    });
    const ok = await client.tryAcquireShardLock!(2);
    expect(ok).toBe(true);

    // Exactly one commit connection was opened — the one for slot 2 (shard "s2").
    expect(state.instances).toHaveLength(2);
    const s2 = state.instances[1]!;
    expect(s2.opts.application_name).toBe("app-commit-s2");
    const lock = s2.queries.find((q) => /pg_try_advisory_lock/.test(q.text))!;
    expect(lock.text).toBe("SELECT pg_try_advisory_lock($1, $2) AS ok");
    // Two-int form: distinct class id (never the single-writer int8 lock) + the slot number.
    expect(lock.params).toEqual([SHARD_ADVISORY_LOCK_CLASS, 2]);
    // …and it ran on the shard's OWN connection, so the lock is session-scoped to that shard.
    expect(state.instances[0]!.queries).toHaveLength(0); // pinned untouched
  });

  it("releaseShardLock(slot) issues the two-int pg_advisory_unlock ON THE SAME connection tryAcquireShardLock used, without ending it (B2b, D2)", async () => {
    const client = new NodePgClient({
      connectionString: "postgres://fake",
      applicationName: "app",
      commitPool: { shards: ["default", "s1", "s2"] },
    });
    const ok = await client.tryAcquireShardLock!(2);
    expect(ok).toBe(true);
    expect(state.instances).toHaveLength(2); // pinned + s2's commit connection

    await client.releaseShardLock!(2);

    // No THIRD connection was opened — the unlock reused the exact same shard connection.
    expect(state.instances).toHaveLength(2);
    const s2 = state.instances[1]!;
    expect(s2.opts.application_name).toBe("app-commit-s2");
    const unlock = s2.queries.find((q) => /pg_advisory_unlock/.test(q.text))!;
    expect(unlock.text).toBe("SELECT pg_advisory_unlock($1, $2) AS ok");
    // Two-int form, same class id + slot as the acquire it mirrors.
    expect(unlock.params).toEqual([SHARD_ADVISORY_LOCK_CLASS, 2]);
    // The connection itself is untouched — still open (not `end()`ed) — so a caller keeps using it
    // for OTHER shards' locks / future re-acquisition of this same slot.
    expect(s2.ended).toBe(false);
    // The pinned connection never saw any of this.
    expect(state.instances[0]!.queries).toHaveLength(0);
  });

  it("releaseShardLock rejects for an unknown shard or out-of-range slot (mirrors tryAcquireShardLock)", async () => {
    const client = new NodePgClient({
      connectionString: "postgres://fake",
      commitPool: { shards: ["default", "s1"] },
    });
    await expect(client.releaseShardLock!(5)).rejects.toThrow(/slot 5 out of range/);
  });

  it("onShardConnectionLost fires with the shardId exactly once (error, then end-guarded)", async () => {
    const client = new NodePgClient({
      connectionString: "postgres://fake",
      commitPool: { shards: ["default", "s1"] },
    });
    const lost: string[] = [];
    client.onShardConnectionLost!((shardId) => lost.push(shardId));

    await client.commitQuerierFor!("s1");
    await client.commitQuerierFor!("default");
    const s1 = state.instances[1]!;
    const def = state.instances[2]!;

    emit(s1, "error"); // s1's connection dies
    emit(s1, "end"); //   the follow-up end must NOT double-fire
    expect(lost).toEqual(["s1"]);

    emit(def, "error"); // a DIFFERENT shard routes its OWN id
    expect(lost).toEqual(["s1", "default"]);
  });

  it("close() ends all commit connections and does NOT fire onShardConnectionLost (graceful)", async () => {
    const client = new NodePgClient({
      connectionString: "postgres://fake",
      commitPool: { shards: ["default", "s1"] },
    });
    const lost: string[] = [];
    client.onShardConnectionLost!((shardId) => lost.push(shardId));
    await client.commitQuerierFor!("s1");
    await client.commitQuerierFor!("default");

    await client.close();

    expect(state.instances[1]!.ended).toBe(true);
    expect(state.instances[2]!.ended).toBe(true);
    // The deliberate close's `end` events are suppressed — no spurious per-shard lease loss.
    expect(lost).toEqual([]);
  });
});

// ---- commitWrite pool ROUTING + D5 shardId threading (stub PgClient, no pg) ---------------------

const TABLE = 20050;
function doc(id: InternalDocumentId, body: string): DocumentLogEntry {
  return { ts: 0n, id, prev_ts: null, value: { id, value: { body } } };
}

/** A stub with a pool: records which shard commitWrite routed to and proves the pinned transaction()
 *  is NEVER used in pool mode. */
class StubPoolClient implements PgClient {
  requestedShards: string[] = [];
  poolTxnRan = false;
  async query(): Promise<PgRow[]> {
    return [];
  }
  async transaction<T>(): Promise<T> {
    throw new Error("pinned transaction() must NOT run in pool mode");
  }
  async acquireWriterLock(): Promise<void> {}
  async tryAcquireWriterLock(): Promise<boolean> {
    return true;
  }
  async commitQuerierFor(shardId: string): Promise<PgTransactionalQuerier> {
    this.requestedShards.push(shardId);
    const q: PgQuerier = {
      query: async (text: string): Promise<PgRow[]> => (/nextval/.test(text) ? [{ ts: 7n }] : []),
    };
    return {
      ...q,
      transaction: async <T>(fn: (tx: PgQuerier) => Promise<T>): Promise<T> => {
        this.poolTxnRan = true;
        return fn(q);
      },
    };
  }
  async close(): Promise<void> {}
}

/** A stub WITHOUT a pool: proves commitWrite keeps the pinned `transaction()` path unchanged. */
class StubPinnedClient implements PgClient {
  pinnedTxnRan = false;
  async query(): Promise<PgRow[]> {
    return [];
  }
  async transaction<T>(fn: (tx: PgQuerier) => Promise<T>): Promise<T> {
    this.pinnedTxnRan = true;
    const q: PgQuerier = {
      query: async (text: string): Promise<PgRow[]> => (/nextval/.test(text) ? [{ ts: 3n }] : []),
    };
    return fn(q);
  }
  async acquireWriterLock(): Promise<void> {}
  async tryAcquireWriterLock(): Promise<boolean> {
    return true;
  }
  async close(): Promise<void> {}
}

describe("PostgresDocStore.commitWrite — pool routing (D1) + shardId to the guard (D5)", () => {
  it("routes the whole commit through commitQuerierFor(shard) and threads shardId to the guard", async () => {
    const client = new StubPoolClient();
    const store = new PostgresDocStore(client);
    const seenShard: string[] = [];
    store.setCommitGuard(async (_q, _units, shardId) => {
      seenShard.push(shardId);
    });

    const ts = await store.commitWrite([doc(newDocumentId(TABLE), "x")], [], "s3");

    expect(ts).toBe(7n);
    expect(client.requestedShards).toEqual(["s3"]); // routed to shard s3's commit connection
    expect(client.poolTxnRan).toBe(true);
    expect(seenShard).toEqual(["s3"]); // the guard received the shard (per-shard fence)
  });

  it("defaults to the 'default' shard when no shardId is given", async () => {
    const client = new StubPoolClient();
    const store = new PostgresDocStore(client);
    await store.commitWrite([doc(newDocumentId(TABLE), "x")], []);
    expect(client.requestedShards).toEqual(["default"]);
  });

  it("without a pool, commitWrite keeps the pinned transaction() path (byte-identical)", async () => {
    const client = new StubPinnedClient();
    const store = new PostgresDocStore(client);
    const ts = await store.commitWrite([doc(newDocumentId(TABLE), "x")], [], "s3");
    expect(ts).toBe(3n);
    expect(client.pinnedTxnRan).toBe(true);
  });
});

// ---- The atomicity-corruption HAZARD SHAPE on a single connection (PGlite, real PG semantics) ---

describe("single-connection hazard — WHY the pool exists (PGlite, real Postgres semantics)", () => {
  it("two interleaved transactions on ONE connection lose atomicity (a committed peer commits an aborting txn's write)", async () => {
    // This models exactly what the single pinned connection would do if it served two shards at once:
    // transactions on one Postgres session are NOT isolated from each other. Here transaction A stages
    // a row then ABORTS, but transaction B's COMMIT on the SAME connection commits A's row anyway.
    const client = new PgliteClient();
    await client.query("CREATE TABLE hz (id int)");

    let releaseA!: () => void;
    const gateA = new Promise<void>((r) => (releaseA = r));

    // A: BEGIN, INSERT 1, park on the gate, then throw → transaction() will attempt ROLLBACK.
    const txA = client.transaction(async (tx) => {
      await tx.query("INSERT INTO hz VALUES (1)");
      await gateA;
      throw new Error("A aborts");
    });
    // Let A execute up to the gate (its BEGIN + INSERT have run; it is now parked).
    await new Promise((r) => setTimeout(r, 0));

    // B runs fully on the SAME connection while A is parked — its COMMIT ends A's still-open txn too.
    await client.transaction(async (tx) => {
      await tx.query("INSERT INTO hz VALUES (2)");
    });

    releaseA();
    await expect(txA).rejects.toThrow("A aborts");

    // THE CORRUPTION: A aborted, yet its row (1) survived — B's COMMIT committed it. On independent
    // per-shard connections (the pool) this cannot happen: A's ROLLBACK would drop row 1.
    const rows = await client.query("SELECT id FROM hz ORDER BY id");
    const ids = rows.map((r) => Number(r.id));
    expect(ids).toContain(1);
    await client.close();
  });
});
