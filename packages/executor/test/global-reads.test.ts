/**
 * M2c Task 2 — kernel stashing of `.global()` (D1-resident) table READS into
 * `KernelContext.globalReads`, feeding `UdfResult.globalTables` for the version-poll
 * invalidation match.
 *
 * Drives `createKernelRouter().dispatch(ctx, op, argJson)` directly (the exact mechanism
 * `InlineSyscallChannel` uses internally), against a hand-built `KernelContext` carrying
 * `globalReads: new Set()` — mirrors the M2b `kernel-global-routing.test.ts` harness (same
 * in-memory better-sqlite3-backed `D1Client`, same `SimpleIndexCatalog`/`baseCtx` shape).
 */
import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { defineSchema, defineTable, v } from "@helipod/values";
import { D1DocStore, type D1Client, type D1PreparedStatement, type D1Session } from "@helipod/docstore-d1";
import { SqliteDocStore, NodeSqliteAdapter } from "@helipod/docstore-sqlite";
import { QueryRuntime } from "@helipod/query-engine";
import { DEFAULT_SHARD, encodeInternalDocumentId, encodeStorageIndexId, newDocumentId } from "@helipod/id-codec";
import type { DocumentValue, InternalDocumentId } from "@helipod/docstore";
import type { TransactionContext } from "@helipod/transactor";
import {
  createKernelRouter,
  SimpleIndexCatalog,
  GlobalTxn,
  QUERY_PROFILE,
  MUTATION_PROFILE,
  createSeededRandom,
  type KernelContext,
} from "../src/index";

// ── in-memory D1Client (mirrors packages/docstore-d1/test/support/sqlite-d1-client.ts) ─────────
function sqliteD1Client(): D1Client {
  const db = new Database(":memory:");
  const stmt = (sql: string, bound: unknown[]): D1PreparedStatement => ({
    bind: (...values: unknown[]) => stmt(sql, values),
    all: async () => {
      const prepared = db.prepare(sql);
      const results = prepared.reader ? (prepared.all(...bound) as Record<string, unknown>[]) : [];
      if (!prepared.reader) prepared.run(...bound);
      return { results: results as never };
    },
    run: async () => {
      const info = db.prepare(sql).run(...bound);
      return { changes: info.changes };
    },
  });
  const client: D1Client = {
    prepare: (sql) => stmt(sql, []),
    exec: async (sql) => {
      db.exec(sql);
    },
    withSession: (_bookmark?: string): D1Session => ({ client, latestBookmark: () => undefined }),
    batch: async (statements) => {
      const run = db.transaction((stmts: { sql: string; params: unknown[] }[]) => {
        for (const s of stmts) db.prepare(s.sql).run(...s.params);
      });
      run(statements);
    },
  };
  return client;
}

const globalSchema = defineSchema({
  counters: defineTable({ key: v.string(), value: v.number() }).index("by_key", ["key"]),
}).export();

const COUNTERS_TABLE_NUMBER = 31001;
const NOTES_TABLE_NUMBER = 31002;

// ── minimal stub TransactionContext for the LOCAL (MVCC) store ─────────────────────────────────
function makeStubTxn(): TransactionContext {
  const docs = new Map<string, DocumentValue>();
  return {
    snapshotTs: 1n,
    shardId: DEFAULT_SHARD,
    reads: { toArray: () => [] } as unknown as TransactionContext["reads"],
    get: async (id: InternalDocumentId) => docs.get(encodeInternalDocumentId(id)) ?? null,
    put: (id: InternalDocumentId, value: DocumentValue) => {
      docs.set(encodeInternalDocumentId(id), value);
    },
    delete: (id: InternalDocumentId) => {
      docs.delete(encodeInternalDocumentId(id));
    },
    recordRead: () => {},
    recordReadUnvalidated: () => {},
    recordWrite: () => {},
    stageIndexUpdates: () => {},
    pendingIndexOverlay: () => [],
  };
}

const unusedQueryRuntime = {
  collect: async () => {
    throw new Error("queryRuntime.collect should not be called for a .global() table");
  },
  paginate: async () => {
    throw new Error("queryRuntime.paginate should not be called for a .global() table");
  },
} as unknown as KernelContext["queryRuntime"];

function baseCtx(overrides: Partial<KernelContext>): KernelContext {
  return {
    profile: MUTATION_PROFILE,
    txn: makeStubTxn(),
    queryRuntime: unusedQueryRuntime,
    catalog: new SimpleIndexCatalog(),
    snapshotTs: 1n,
    random: createSeededRandom(1),
    logs: [],
    namespace: "",
    privileged: true,
    identity: null,
    now: Date.now(),
    policyRegistry: new Map(),
    getRuleContext: null,
    relationRegistry: { toMany: new Map(), toOne: new Map() },
    shardId: DEFAULT_SHARD,
    numShards: 1,
    shardDeclared: false,
    ...overrides,
  };
}

describe("kernel records .global() table reads into KernelContext.globalReads (M2c Task 2)", () => {
  let store: D1DocStore;
  let globalTxn: GlobalTxn;
  let catalog: SimpleIndexCatalog;
  const router = createKernelRouter();

  beforeEach(async () => {
    store = new D1DocStore(sqliteD1Client(), globalSchema);
    await store.applyDdl();
    globalTxn = new GlobalTxn(store);
    catalog = new SimpleIndexCatalog()
      .addTable("counters", COUNTERS_TABLE_NUMBER, undefined, false, null, true)
      .addIndex({
        table: "counters",
        tableNumber: COUNTERS_TABLE_NUMBER,
        index: "by_key",
        fields: ["key"],
        indexId: encodeStorageIndexId(COUNTERS_TABLE_NUMBER, "by_key"),
      })
      .addTable("notes", NOTES_TABLE_NUMBER, undefined, false, null, false);
  });

  it("db.get on a global table populates globalReads with the table name", async () => {
    const globalReads = new Set<string>();
    const ctx = baseCtx({ catalog, globalTxn, globalReads });
    const insertRes = await router.dispatch(ctx, "db.insert", JSON.stringify({ table: "counters", value: { key: "a", value: 1 } }));
    const { id } = JSON.parse(insertRes) as { id: string };
    // insert must NOT have recorded a read
    expect(globalReads.size).toBe(0);

    await router.dispatch(ctx, "db.get", JSON.stringify({ id }));
    expect(globalReads).toEqual(new Set(["counters"]));
  });

  it("an equality db.query on a global table populates globalReads with the table name", async () => {
    const globalReads = new Set<string>();
    const ctx = baseCtx({ catalog, globalTxn, globalReads });
    await router.dispatch(ctx, "db.insert", JSON.stringify({ table: "counters", value: { key: "eq", value: 1 } }));
    expect(globalReads.size).toBe(0); // the insert above must not have recorded a read

    const res = await router.dispatch(
      ctx,
      "db.query",
      JSON.stringify({ table: "counters", index: "by_key", range: [{ field: "key", operator: "eq", value: "eq" }] }),
    );
    const { docs } = JSON.parse(res) as { docs: Record<string, unknown>[] };
    expect(docs).toHaveLength(1);
    expect(globalReads).toEqual(new Set(["counters"]));
  });

  it("repeated reads of the same global table dedupe in the Set (still size 1)", async () => {
    const globalReads = new Set<string>();
    const ctx = baseCtx({ catalog, globalTxn, globalReads });
    const insertRes = await router.dispatch(ctx, "db.insert", JSON.stringify({ table: "counters", value: { key: "dup", value: 1 } }));
    const { id } = JSON.parse(insertRes) as { id: string };

    await router.dispatch(ctx, "db.get", JSON.stringify({ id }));
    await router.dispatch(
      ctx,
      "db.query",
      JSON.stringify({ table: "counters", index: "by_key", range: [{ field: "key", operator: "eq", value: "dup" }] }),
    );
    expect(globalReads).toEqual(new Set(["counters"]));
    expect(globalReads.size).toBe(1);
  });

  it("a LOCAL (non-global) db.get leaves globalReads empty", async () => {
    const globalReads = new Set<string>();
    const ctx = baseCtx({ catalog, globalTxn, globalReads });
    const insertRes = await router.dispatch(ctx, "db.insert", JSON.stringify({ table: "notes", value: { text: "hi" } }));
    const { id } = JSON.parse(insertRes) as { id: string };

    await router.dispatch(ctx, "db.get", JSON.stringify({ id }));

    expect(globalReads.size).toBe(0);
  });

  it("a LOCAL (non-global) db.query leaves globalReads empty", async () => {
    // A real QueryRuntime over a real (empty) local SqliteDocStore — the raw kernel-level
    // `unusedQueryRuntime` stub used elsewhere in this file deliberately throws for ANY call, so
    // the local (non-global) `db.query` path needs a real implementation here.
    const localStore = new SqliteDocStore(new NodeSqliteAdapter());
    await localStore.setupSchema();
    const localQueryRuntime = new QueryRuntime(localStore);
    const localCatalog = new SimpleIndexCatalog()
      .addTable("notes", NOTES_TABLE_NUMBER, undefined, false, null, false)
      .addIndex({
        table: "notes",
        tableNumber: NOTES_TABLE_NUMBER,
        index: "by_text",
        fields: ["text"],
        indexId: encodeStorageIndexId(NOTES_TABLE_NUMBER, "by_text"),
      });
    const globalReads = new Set<string>();
    const ctx = baseCtx({ catalog: localCatalog, queryRuntime: localQueryRuntime, globalTxn, globalReads });

    const res = await router.dispatch(
      ctx,
      "db.query",
      JSON.stringify({ table: "notes", index: "by_text", range: [{ field: "text", operator: "eq", value: "hi" }] }),
    );
    const { docs } = JSON.parse(res) as { docs: unknown[] };
    expect(docs).toEqual([]); // empty store — just proving the local path is exercised, not the data

    expect(globalReads.size).toBe(0);
  });

  it("db.replace on a global table (read-then-write) does NOT record a read (writes don't feed globalReads)", async () => {
    const globalReads = new Set<string>();
    const ctx = baseCtx({ catalog, globalTxn, globalReads });
    const insertRes = await router.dispatch(ctx, "db.insert", JSON.stringify({ table: "counters", value: { key: "rep", value: 1 } }));
    const { id } = JSON.parse(insertRes) as { id: string };
    expect(globalReads.size).toBe(0);

    // handleDbReplace's global branch does an internal `g.get` (RYOW existence check) — this must
    // NOT count as a recorded global read: a write already invalidates via the version-bump path.
    await router.dispatch(ctx, "db.replace", JSON.stringify({ id, value: { key: "rep", value: 2 } }));
    expect(globalReads.size).toBe(0);
  });

  it("db.delete on a global table does NOT record a read", async () => {
    const globalReads = new Set<string>();
    const ctx = baseCtx({ catalog, globalTxn, globalReads });
    const insertRes = await router.dispatch(ctx, "db.insert", JSON.stringify({ table: "counters", value: { key: "del", value: 1 } }));
    const { id } = JSON.parse(insertRes) as { id: string };
    expect(globalReads.size).toBe(0);

    await router.dispatch(ctx, "db.delete", JSON.stringify({ id }));
    expect(globalReads.size).toBe(0);
  });

  it("globalReads unarmed (undefined) is a no-op — recordGlobalRead never throws", async () => {
    const ctx = baseCtx({ profile: QUERY_PROFILE, catalog, globalTxn, globalReads: undefined });
    const insertCtx = baseCtx({ catalog, globalTxn });
    const insertRes = await router.dispatch(insertCtx, "db.insert", JSON.stringify({ table: "counters", value: { key: "noarm", value: 1 } }));
    const { id } = JSON.parse(insertRes) as { id: string };

    await expect(router.dispatch(ctx, "db.get", JSON.stringify({ id }))).resolves.toBeDefined();
  });
});
