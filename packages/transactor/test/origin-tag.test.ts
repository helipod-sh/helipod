/**
 * G4 origin-frontier tag (client-sync verdict §(d) item 2), transactor half. The origin is an
 * ephemeral fan-out routing hint: it is stamped onto the emitted `OplogDelta.origin` at oplog
 * construction (AFTER `commitWrite` returns) and MUST NEVER reach `DocStore.commitWrite`/
 * `commitWriteBatch`'s `meta` — origin is not durable commit state (unlike `commitMeta`).
 *
 *   (c) origin never reaches either store's commitWrite meta (spy on both the single-commit
 *       `commitWrite` and the group-commit `commitWriteBatch` paths).
 *   (d) the grouped-commit path stamps per-unit origin correctly (each unit's own tag on its oplog).
 */
import { describe, it, expect } from "vitest";
import { SqliteDocStore, NodeSqliteAdapter } from "@helipod/docstore-sqlite";
import type { CommitUnit } from "@helipod/docstore";
import { MonotonicTimestampOracle } from "@helipod/docstore";
import { newDocumentId, encodeStorageTableId, type ShardId } from "@helipod/id-codec";
import { SingleWriterTransactor, ShardedTransactor, type OplogDelta } from "../src/index";

const TABLE = 30001;
const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Records every `meta` object handed to the store, on BOTH the single and batch commit paths. */
class MetaSpyStore extends SqliteDocStore {
  readonly singleMetas: Array<Record<string, string> | undefined> = [];
  readonly batchMetas: Array<Record<string, string> | undefined> = [];

  override async commitWrite(
    documents: Parameters<SqliteDocStore["commitWrite"]>[0],
    indexWrites: Parameters<SqliteDocStore["commitWrite"]>[1],
    shardId?: ShardId,
    opts?: { meta?: Record<string, string> },
  ): Promise<bigint> {
    this.singleMetas.push(opts?.meta);
    return super.commitWrite(documents, indexWrites, shardId, opts);
  }

  override async commitWriteBatch(units: readonly CommitUnit[], shardId?: ShardId): Promise<bigint[]> {
    for (const u of units) this.batchMetas.push(u.meta);
    return super.commitWriteBatch(units, shardId);
  }
}

describe("G4 origin tag — (c) origin never reaches the store's commitWrite meta", () => {
  it("single-commit path stamps oplog.origin but passes ONLY commitMeta to commitWrite", async () => {
    const store = new MetaSpyStore(new NodeSqliteAdapter());
    await store.setupSchema();
    const deltas: OplogDelta[] = [];
    const transactor = new SingleWriterTransactor(store, new MonotonicTimestampOracle(), {
      fanout: { publish: (d) => void deltas.push(d) },
    });
    const id = newDocumentId(TABLE);

    const r = await transactor.runInTransaction(async (ctx) => ctx.put(id, { x: 1n }), {
      origin: "session-abc",
      commitMeta: { idempotencyKey: "k1" },
    });

    expect(r.oplog!.origin).toBe("session-abc");
    // The store saw the durable commitMeta — but NOT the ephemeral origin.
    expect(store.singleMetas).toHaveLength(1);
    expect(store.singleMetas[0]).toEqual({ idempotencyKey: "k1" });
    expect(JSON.stringify(store.singleMetas[0])).not.toContain("session-abc");
    expect(store.singleMetas[0] && "origin" in store.singleMetas[0]).toBe(false);
  });

  it("origin unset → oplog carries no origin and the store meta is untouched", async () => {
    const store = new MetaSpyStore(new NodeSqliteAdapter());
    await store.setupSchema();
    const deltas: OplogDelta[] = [];
    const transactor = new SingleWriterTransactor(store, new MonotonicTimestampOracle(), {
      fanout: { publish: (d) => void deltas.push(d) },
    });
    await transactor.runInTransaction(async (ctx) => ctx.put(newDocumentId(TABLE), { x: 1n }));
    expect(deltas[0]!.origin).toBeUndefined();
    expect(store.singleMetas[0]).toBeUndefined();
  });

  it("group-commit path never folds origin into a unit's meta", async () => {
    const store = new MetaSpyStore(new NodeSqliteAdapter());
    await store.setupSchema();
    const deltas: OplogDelta[] = [];
    const transactor = new ShardedTransactor(store, {
      groupCommit: true,
      fanout: { publish: (d) => void deltas.push(d) },
    });
    await transactor.runInTransaction(async (ctx) => ctx.put(newDocumentId(TABLE), { x: 1n }), {
      origin: "session-xyz",
      commitMeta: { idempotencyKey: "k2" },
    });
    await delay(20);
    expect(store.batchMetas).toHaveLength(1);
    expect(store.batchMetas[0]).toEqual({ idempotencyKey: "k2" });
    expect(JSON.stringify(store.batchMetas[0] ?? {})).not.toContain("session-xyz");
  });
});

describe("G4 origin tag — (d) grouped-commit path stamps per-unit origin", () => {
  it("holds a slow first flush so N units batch, and each unit's oplog carries its OWN origin", async () => {
    // Hold the first flush so units accumulate into one batch (the group-commit.test.ts idiom).
    let seen = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    class GatedStore extends SqliteDocStore {
      readonly batchOrigins: Array<Record<string, string> | undefined>[] = [];
      override async commitWriteBatch(units: readonly CommitUnit[], shardId?: ShardId): Promise<bigint[]> {
        if (seen++ === 0) await gate;
        this.batchOrigins.push(units.map((u) => u.meta));
        return super.commitWriteBatch(units, shardId);
      }
    }
    const store = new GatedStore(new NodeSqliteAdapter());
    await store.setupSchema();
    const deltas: OplogDelta[] = [];
    const transactor = new ShardedTransactor(store, {
      groupCommit: true,
      fanout: { publish: (d) => void deltas.push(d) },
    });

    // First unit stages and its 1-unit batch goes in-flight, gated.
    const p0 = transactor.runInTransaction(async (ctx) => ctx.put(newDocumentId(TABLE), { i: 0n }), { origin: "s0" });
    await delay(20);
    // Three more stage while the first flush is held → they land as ONE batch of 3.
    const p1 = transactor.runInTransaction(async (ctx) => ctx.put(newDocumentId(TABLE), { i: 1n }), { origin: "s1" });
    const p2 = transactor.runInTransaction(async (ctx) => ctx.put(newDocumentId(TABLE), { i: 2n }), { origin: "s2" });
    const p3 = transactor.runInTransaction(async (ctx) => ctx.put(newDocumentId(TABLE), { i: 3n }), { origin: "s3" });
    await delay(20);
    release();
    const results = await Promise.all([p0, p1, p2, p3]);

    // Each result's oplog carries its OWN origin, in stage order — never smeared across the batch.
    expect(results.map((r) => r.oplog!.origin)).toEqual(["s0", "s1", "s2", "s3"]);
    // And the published deltas agree (per-unit, not per-batch).
    const byTs = new Map(deltas.map((d) => [d.commitTs, d.origin]));
    for (const r of results) expect(byTs.get(r.oplog!.commitTs)).toBe(r.oplog!.origin);
    // The batch actually engaged (proves per-unit stamping wasn't trivially one-per-flush).
    expect(store.batchOrigins.some((b) => b.length > 1)).toBe(true);
  });
});

// keep the table id import referenced (documents the storage-table under test)
void encodeStorageTableId;
