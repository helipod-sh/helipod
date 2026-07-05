/**
 * M2b Task 6 — kernel routing of `.global()` (D1-resident) tables to `GlobalTxn`, and the
 * co-write guard (`CrossStoreWriteError`) that rejects a single mutation writing BOTH a global
 * table and a local (MVCC) table.
 *
 * Drives `createKernelRouter().dispatch(ctx, op, argJson)` directly (the exact mechanism
 * `InlineSyscallChannel` uses internally — see `paginate-trace.test.ts` for the same pattern)
 * against a hand-built `KernelContext`:
 *   - `ctx.globalTxn` is a real `GlobalTxn` over a `D1DocStore` backed by an in-memory
 *     better-sqlite3 `D1Client` (mirrors `packages/docstore-d1/test/support/sqlite-d1-client.ts`,
 *     copied inline here so this test doesn't reach into another package's test directory).
 *   - `ctx.txn` is a minimal stub `TransactionContext` that records whether `put`/`delete` was
 *     called, so a test can prove a global write never touches it.
 */
import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { defineSchema, defineTable, v } from "@helipod/values";
import { DocumentNotFoundError, InvalidClientIdError } from "@helipod/errors";
import { D1DocStore, type D1Client, type D1PreparedStatement, type D1Session } from "@helipod/docstore-d1";
import { DEFAULT_SHARD, encodeInternalDocumentId, encodeStorageIndexId, newDocumentId } from "@helipod/id-codec";
import type { DocumentValue, InternalDocumentId } from "@helipod/docstore";
import type { TransactionContext } from "@helipod/transactor";
import {
  createKernelRouter,
  SimpleIndexCatalog,
  GlobalTxn,
  CrossStoreWriteError,
  QUERY_PROFILE,
  MUTATION_PROFILE,
  createSeededRandom,
  type KernelContext,
  type TablePolicy,
  type RuleContext,
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

const COUNTERS_TABLE_NUMBER = 30001;
const NOTES_TABLE_NUMBER = 30002;
const STRICT_TABLE_NUMBER = 30003;

// ── minimal stub TransactionContext for the LOCAL (MVCC) store ─────────────────────────────────
function makeStubTxn(calls: { put: boolean; delete: boolean }): TransactionContext {
  const docs = new Map<string, DocumentValue>();
  return {
    snapshotTs: 1n,
    shardId: DEFAULT_SHARD,
    reads: { toArray: () => [] } as unknown as TransactionContext["reads"],
    get: async (id: InternalDocumentId) => docs.get(encodeInternalDocumentId(id)) ?? null,
    put: (id: InternalDocumentId, value: DocumentValue) => {
      calls.put = true;
      docs.set(encodeInternalDocumentId(id), value);
    },
    delete: (id: InternalDocumentId) => {
      calls.delete = true;
      docs.delete(encodeInternalDocumentId(id));
    },
    recordRead: () => {},
    recordReadUnvalidated: () => {},
    recordWrite: () => {},
    stageIndexUpdates: () => {},
    pendingIndexOverlay: () => [],
  };
}

// `ctx.queryRuntime` is never reached by any global-routed path exercised here (the global branch
// in handleDbQuery/handleDbPaginate returns/throws before ever calling it) — a stub that throws on
// use both documents and enforces that invariant.
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
    txn: makeStubTxn({ put: false, delete: false }),
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

describe("kernel routing of .global() tables to GlobalTxn (M2b Task 6)", () => {
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
      .addTable("notes", NOTES_TABLE_NUMBER, undefined, false, null, false)
      // A global table WITH a document validator, for the guard-ordering test: a validation
      // failure must not falsely mark `writeStores.global`. Never registered in the D1 store's own
      // schema — validation throws before `stageInsert` is ever reached, so the store is untouched.
      .addTable("strict", STRICT_TABLE_NUMBER, v.object({ n: v.number() }).toJSON(), true, null, true);
  });

  it("db.insert on a global table stages into GlobalTxn, not ctx.txn", async () => {
    const calls = { put: false, delete: false };
    const ctx = baseCtx({ txn: makeStubTxn(calls), catalog, globalTxn });
    const res = await router.dispatch(ctx, "db.insert", JSON.stringify({ table: "counters", value: { key: "a", value: 1 } }));
    const { id } = JSON.parse(res) as { id: string };
    expect(typeof id).toBe("string");
    expect(calls.put).toBe(false); // never touched the local store
    expect(globalTxn.hasWrites()).toBe(true);
    expect(globalTxn.ops).toEqual([{ kind: "insert", table: "counters", doc: expect.objectContaining({ key: "a", value: 1, _id: id }) }]);
  });

  it("db.get on a global table reads back a staged insert (RYOW) without touching ctx.txn", async () => {
    const calls = { put: false, delete: false };
    const ctx = baseCtx({ txn: makeStubTxn(calls), catalog, globalTxn });
    const insertRes = await router.dispatch(ctx, "db.insert", JSON.stringify({ table: "counters", value: { key: "b", value: 2 } }));
    const { id } = JSON.parse(insertRes) as { id: string };

    const getRes = await router.dispatch(ctx, "db.get", JSON.stringify({ id }));
    const doc = JSON.parse(getRes) as Record<string, unknown> | null;
    expect(doc).toMatchObject({ _id: id, key: "b", value: 2 });
    expect(calls.put).toBe(false);
  });

  it("db.replace and db.delete on a global table stage into GlobalTxn", async () => {
    const ctx = baseCtx({ catalog, globalTxn });
    const insertRes = await router.dispatch(ctx, "db.insert", JSON.stringify({ table: "counters", value: { key: "c", value: 3 } }));
    const { id } = JSON.parse(insertRes) as { id: string };

    await router.dispatch(ctx, "db.replace", JSON.stringify({ id, value: { key: "c", value: 30 } }));
    const afterReplace = JSON.parse(await router.dispatch(ctx, "db.get", JSON.stringify({ id }))) as Record<string, unknown>;
    expect(afterReplace.value).toBe(30);

    await router.dispatch(ctx, "db.delete", JSON.stringify({ id }));
    const afterDelete = JSON.parse(await router.dispatch(ctx, "db.get", JSON.stringify({ id })));
    expect(afterDelete).toBeNull();

    expect(globalTxn.ops.map((o) => o.kind)).toEqual(["insert", "replace", "delete"]);
  });

  it("an equality db.query on a global table returns staged rows via GlobalTxn.queryByIndex", async () => {
    const ctx = baseCtx({ catalog, globalTxn });
    await router.dispatch(ctx, "db.insert", JSON.stringify({ table: "counters", value: { key: "eq", value: 1 } }));
    await router.dispatch(ctx, "db.insert", JSON.stringify({ table: "counters", value: { key: "eq", value: 2 } }));
    await router.dispatch(ctx, "db.insert", JSON.stringify({ table: "counters", value: { key: "other", value: 9 } }));

    const res = await router.dispatch(
      ctx,
      "db.query",
      JSON.stringify({ table: "counters", index: "by_key", range: [{ field: "key", operator: "eq", value: "eq" }] }),
    );
    const { docs } = JSON.parse(res) as { docs: Record<string, unknown>[] };
    expect(docs).toHaveLength(2);
    expect(docs.every((d) => d.key === "eq")).toBe(true);
  });

  it("a RANGE (non-eq) db.query on a global table throws 'not yet supported'", async () => {
    const ctx = baseCtx({ catalog, globalTxn });
    await expect(
      router.dispatch(
        ctx,
        "db.query",
        JSON.stringify({ table: "counters", index: "by_key", range: [{ field: "key", operator: "gt", value: "a" }] }),
      ),
    ).rejects.toThrow(/not yet (available|supported)/);
  });

  it("db.query with filters on a global table throws 'not yet supported'", async () => {
    const ctx = baseCtx({ catalog, globalTxn });
    await expect(
      router.dispatch(
        ctx,
        "db.query",
        JSON.stringify({
          table: "counters",
          index: "by_key",
          range: [{ field: "key", operator: "eq", value: "eq" }],
          filters: [{ op: "eq", field: "value", value: 1 }],
        }),
      ),
    ).rejects.toThrow(/not yet (available|supported)/);
  });

  it("db.paginate on a global table is rejected outright", async () => {
    const ctx = baseCtx({ catalog, globalTxn });
    await expect(
      router.dispatch(
        ctx,
        "db.paginate",
        JSON.stringify({ table: "counters", index: "by_key", cursor: null, pageSize: 10 }),
      ),
    ).rejects.toThrow(/pagination.*not yet supported/i);
  });

  it("a .global() op with no ctx.globalTxn (no D1 binding) fails fast", async () => {
    const ctx = baseCtx({ catalog, globalTxn: undefined });
    await expect(
      router.dispatch(ctx, "db.insert", JSON.stringify({ table: "counters", value: { key: "x", value: 1 } })),
    ).rejects.toThrow(/D1 binding/);
  });

  it("a mutation writing a LOCAL table then a GLOBAL table throws CrossStoreWriteError", async () => {
    const calls = { put: false, delete: false };
    const writeStores = { local: false, global: false };
    const ctx = baseCtx({ txn: makeStubTxn(calls), catalog, globalTxn, writeStores });

    await router.dispatch(ctx, "db.insert", JSON.stringify({ table: "notes", value: { text: "hi" } }));
    expect(calls.put).toBe(true);
    expect(writeStores.local).toBe(true);

    await expect(
      router.dispatch(ctx, "db.insert", JSON.stringify({ table: "counters", value: { key: "y", value: 1 } })),
    ).rejects.toThrow(CrossStoreWriteError);
  });

  it("a mutation writing a GLOBAL table then a LOCAL table throws CrossStoreWriteError (order-independent)", async () => {
    const calls = { put: false, delete: false };
    const writeStores = { local: false, global: false };
    const ctx = baseCtx({ txn: makeStubTxn(calls), catalog, globalTxn, writeStores });

    await router.dispatch(ctx, "db.insert", JSON.stringify({ table: "counters", value: { key: "z", value: 1 } }));
    expect(writeStores.global).toBe(true);

    await expect(
      router.dispatch(ctx, "db.insert", JSON.stringify({ table: "notes", value: { text: "hi" } })),
    ).rejects.toThrow(CrossStoreWriteError);
  });

  it("a query context (no writeStores) never trips the co-write guard", async () => {
    const ctx = baseCtx({ profile: QUERY_PROFILE, catalog, globalTxn, writeStores: undefined });
    await expect(router.dispatch(ctx, "db.get", JSON.stringify({ id: encodeInternalDocumentId(newDocumentId(COUNTERS_TABLE_NUMBER)) }))).resolves.toBeDefined();
  });

  // ── Fix 1: global reads fail-closed on a registered read policy ──────────────────────────────
  describe("global read paths fail-closed on a registered read policy", () => {
    const readPolicy: TablePolicy = { read: () => true };
    const getRuleContext = async (): Promise<RuleContext> => ({}) as RuleContext; // never actually invoked — the throw precedes it

    it("db.get on a global table WITH a read policy throws, non-privileged", async () => {
      const insertCtx = baseCtx({ catalog, globalTxn }); // privileged: true, to stage the row
      const insertRes = await router.dispatch(insertCtx, "db.insert", JSON.stringify({ table: "counters", value: { key: "p", value: 1 } }));
      const { id } = JSON.parse(insertRes) as { id: string };

      const readCtx = baseCtx({
        catalog,
        globalTxn,
        privileged: false,
        getRuleContext,
        policyRegistry: new Map([["counters", readPolicy]]),
      });
      await expect(router.dispatch(readCtx, "db.get", JSON.stringify({ id }))).rejects.toThrow(
        /read policies are not yet supported/,
      );
    });

    it("db.get on the SAME global table WITHOUT a policy still returns data, non-privileged", async () => {
      const insertCtx = baseCtx({ catalog, globalTxn });
      const insertRes = await router.dispatch(insertCtx, "db.insert", JSON.stringify({ table: "counters", value: { key: "q", value: 2 } }));
      const { id } = JSON.parse(insertRes) as { id: string };

      const readCtx = baseCtx({ catalog, globalTxn, privileged: false, getRuleContext, policyRegistry: new Map() });
      const doc = JSON.parse(await router.dispatch(readCtx, "db.get", JSON.stringify({ id }))) as Record<string, unknown>;
      expect(doc).toMatchObject({ key: "q", value: 2 });
    });

    it("db.query on a global table WITH a read policy throws, non-privileged", async () => {
      const insertCtx = baseCtx({ catalog, globalTxn });
      await router.dispatch(insertCtx, "db.insert", JSON.stringify({ table: "counters", value: { key: "r", value: 3 } }));

      const readCtx = baseCtx({
        catalog,
        globalTxn,
        privileged: false,
        getRuleContext,
        policyRegistry: new Map([["counters", readPolicy]]),
      });
      await expect(
        router.dispatch(
          readCtx,
          "db.query",
          JSON.stringify({ table: "counters", index: "by_key", range: [{ field: "key", operator: "eq", value: "r" }] }),
        ),
      ).rejects.toThrow(/read policies are not yet supported/);
    });

    it("db.query on the SAME global table WITHOUT a policy still returns data, non-privileged", async () => {
      const insertCtx = baseCtx({ catalog, globalTxn });
      await router.dispatch(insertCtx, "db.insert", JSON.stringify({ table: "counters", value: { key: "s", value: 4 } }));

      const readCtx = baseCtx({ catalog, globalTxn, privileged: false, getRuleContext, policyRegistry: new Map() });
      const res = await router.dispatch(
        readCtx,
        "db.query",
        JSON.stringify({ table: "counters", index: "by_key", range: [{ field: "key", operator: "eq", value: "s" }] }),
      );
      const { docs } = JSON.parse(res) as { docs: Record<string, unknown>[] };
      expect(docs).toHaveLength(1);
      expect(docs[0]).toMatchObject({ key: "s", value: 4 });
    });
  });

  // ── Fix: global writes fail-closed on a registered write policy (mirrors the read-policy fix) ──
  describe("global write paths fail-closed on a registered write policy", () => {
    const writePolicy: TablePolicy = { write: () => true };
    const getRuleContext = async (): Promise<RuleContext> => ({}) as RuleContext; // never actually invoked — the throw precedes it

    it("db.insert on a global table WITH a write policy throws, non-privileged", async () => {
      const ctx = baseCtx({
        catalog,
        globalTxn,
        privileged: false,
        getRuleContext,
        policyRegistry: new Map([["counters", writePolicy]]),
      });
      await expect(
        router.dispatch(ctx, "db.insert", JSON.stringify({ table: "counters", value: { key: "wp-insert", value: 1 } })),
      ).rejects.toThrow(/write policies are not yet supported/);
      expect(globalTxn.hasWrites()).toBe(false); // rejected before staging
    });

    it("db.insert on the SAME global table WITHOUT a policy still stages the write, non-privileged", async () => {
      const ctx = baseCtx({ catalog, globalTxn, privileged: false, getRuleContext, policyRegistry: new Map() });
      const res = await router.dispatch(ctx, "db.insert", JSON.stringify({ table: "counters", value: { key: "wp-insert-ok", value: 1 } }));
      const { id } = JSON.parse(res) as { id: string };
      expect(typeof id).toBe("string");
      expect(globalTxn.hasWrites()).toBe(true);
    });

    it("db.replace on a global table WITH a write policy throws, non-privileged", async () => {
      const insertCtx = baseCtx({ catalog, globalTxn }); // privileged: true, to stage the row
      const insertRes = await router.dispatch(insertCtx, "db.insert", JSON.stringify({ table: "counters", value: { key: "wp-replace", value: 1 } }));
      const { id } = JSON.parse(insertRes) as { id: string };

      const opsBefore = globalTxn.ops.length;
      const replaceCtx = baseCtx({
        catalog,
        globalTxn,
        privileged: false,
        getRuleContext,
        policyRegistry: new Map([["counters", writePolicy]]),
      });
      await expect(
        router.dispatch(replaceCtx, "db.replace", JSON.stringify({ id, value: { key: "wp-replace", value: 2 } })),
      ).rejects.toThrow(/write policies are not yet supported/);
      expect(globalTxn.ops.length).toBe(opsBefore); // rejected before staging
    });

    it("db.replace on the SAME global table WITHOUT a policy still stages the write, non-privileged", async () => {
      const insertCtx = baseCtx({ catalog, globalTxn });
      const insertRes = await router.dispatch(insertCtx, "db.insert", JSON.stringify({ table: "counters", value: { key: "wp-replace-ok", value: 1 } }));
      const { id } = JSON.parse(insertRes) as { id: string };

      const replaceCtx = baseCtx({ catalog, globalTxn, privileged: false, getRuleContext, policyRegistry: new Map() });
      await router.dispatch(replaceCtx, "db.replace", JSON.stringify({ id, value: { key: "wp-replace-ok", value: 2 } }));
      const afterReplace = JSON.parse(await router.dispatch(insertCtx, "db.get", JSON.stringify({ id }))) as Record<string, unknown>;
      expect(afterReplace.value).toBe(2);
    });

    it("db.delete on a global table WITH a write policy throws, non-privileged", async () => {
      const insertCtx = baseCtx({ catalog, globalTxn });
      const insertRes = await router.dispatch(insertCtx, "db.insert", JSON.stringify({ table: "counters", value: { key: "wp-delete", value: 1 } }));
      const { id } = JSON.parse(insertRes) as { id: string };

      const opsBefore = globalTxn.ops.length;
      const deleteCtx = baseCtx({
        catalog,
        globalTxn,
        privileged: false,
        getRuleContext,
        policyRegistry: new Map([["counters", writePolicy]]),
      });
      await expect(router.dispatch(deleteCtx, "db.delete", JSON.stringify({ id }))).rejects.toThrow(
        /write policies are not yet supported/,
      );
      expect(globalTxn.ops.length).toBe(opsBefore); // rejected before staging
    });

    it("db.delete on the SAME global table WITHOUT a policy still stages the write, non-privileged", async () => {
      const insertCtx = baseCtx({ catalog, globalTxn });
      const insertRes = await router.dispatch(insertCtx, "db.insert", JSON.stringify({ table: "counters", value: { key: "wp-delete-ok", value: 1 } }));
      const { id } = JSON.parse(insertRes) as { id: string };

      const deleteCtx = baseCtx({ catalog, globalTxn, privileged: false, getRuleContext, policyRegistry: new Map() });
      await router.dispatch(deleteCtx, "db.delete", JSON.stringify({ id }));
      const afterDelete = JSON.parse(await router.dispatch(insertCtx, "db.get", JSON.stringify({ id })));
      expect(afterDelete).toBeNull();
    });
  });

  // ── Fix 2: global replace preserves _creationTime and throws on a missing document ───────────
  describe("global db.replace matches local replace semantics", () => {
    it("a replace value omitting _creationTime keeps the OLD doc's _creationTime staged", async () => {
      const ctx = baseCtx({ catalog, globalTxn });
      const insertRes = await router.dispatch(ctx, "db.insert", JSON.stringify({ table: "counters", value: { key: "t", value: 5 } }));
      const { id } = JSON.parse(insertRes) as { id: string };
      const inserted = globalTxn.ops[0]! as Extract<(typeof globalTxn.ops)[number], { kind: "insert" }>;
      const originalCreationTime = inserted.doc._creationTime;
      expect(originalCreationTime).toBeTypeOf("number");

      // The replace value below omits `_creationTime` entirely, as a real `.replace()` call does.
      await router.dispatch(ctx, "db.replace", JSON.stringify({ id, value: { key: "t", value: 50 } }));

      const replaceOp = globalTxn.ops.find((o) => o.kind === "replace")!;
      expect(replaceOp.doc._creationTime).toBe(originalCreationTime);
      expect(replaceOp.doc._id).toBe(id);
      expect(replaceOp.doc.value).toBe(50);
    });

    it("replacing a missing _id throws DocumentNotFoundError", async () => {
      const ctx = baseCtx({ catalog, globalTxn });
      const missingId = encodeInternalDocumentId(newDocumentId(COUNTERS_TABLE_NUMBER));
      await expect(
        router.dispatch(ctx, "db.replace", JSON.stringify({ id: missingId, value: { key: "u", value: 1 } })),
      ).rejects.toThrow(DocumentNotFoundError);
    });
  });

  // ── Fix 3: the co-write guard marks AFTER validation on a global insert ──────────────────────
  it("a global insert that FAILS validation does not mark writeStores.global (so a later local write doesn't falsely throw)", async () => {
    const calls = { put: false, delete: false };
    const writeStores = { local: false, global: false };
    const ctx = baseCtx({ txn: makeStubTxn(calls), catalog, globalTxn, writeStores });

    await expect(
      router.dispatch(ctx, "db.insert", JSON.stringify({ table: "strict", value: { n: "not-a-number" } })),
    ).rejects.toThrow();
    expect(writeStores.global).toBe(false);
    expect(globalTxn.hasWrites()).toBe(false);

    // A subsequent LOCAL write in the same mutation must not be falsely rejected by the co-write
    // guard, since the failed global insert never actually staged anything.
    await router.dispatch(ctx, "db.insert", JSON.stringify({ table: "notes", value: { text: "ok" } }));
    expect(calls.put).toBe(true);
    expect(writeStores.local).toBe(true);
  });

  // ── Whole-branch review Fix 1: a client-supplied _id on a .global() insert is rejected ────────
  describe("client-supplied _id on a .global() insert (whole-branch review fix)", () => {
    it("db.insert on a global table WITH a client-supplied _id throws InvalidClientIdError", async () => {
      const ctx = baseCtx({ catalog, globalTxn });
      await expect(
        router.dispatch(
          ctx,
          "db.insert",
          JSON.stringify({ table: "counters", value: { key: "cid", value: 1, _id: "some-client-id" } }),
        ),
      ).rejects.toThrow(InvalidClientIdError);
      expect(globalTxn.hasWrites()).toBe(false); // rejected before staging
    });

    it("db.insert on a global table WITHOUT a supplied _id still succeeds and mints a server id", async () => {
      const ctx = baseCtx({ catalog, globalTxn });
      const res = await router.dispatch(
        ctx,
        "db.insert",
        JSON.stringify({ table: "counters", value: { key: "no-cid", value: 1 } }),
      );
      const { id } = JSON.parse(res) as { id: string };
      expect(typeof id).toBe("string");
      expect(id.length).toBeGreaterThan(0);

      const inserted = globalTxn.ops[0]! as Extract<(typeof globalTxn.ops)[number], { kind: "insert" }>;
      expect(inserted.doc._id).toBe(id);
    });
  });
});
