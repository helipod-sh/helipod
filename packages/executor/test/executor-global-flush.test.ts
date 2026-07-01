/**
 * M2b Task 7 — executor wiring: `InlineUdfExecutor` builds a fresh `GlobalTxn` per transaction
 * attempt, threads it onto `KernelContext`, and flushes the staged `.global()` writes as ONE
 * atomic `D1DocStore.commitBatch` AFTER the MVCC transaction resolves.
 *
 * Drives `InlineUdfExecutor.run()` end to end (the real syscall/kernel path, not a hand-built
 * `KernelContext` — see `kernel-global-routing.test.ts` for that lower-level coverage) with a
 * real in-process `SingleWriterTransactor` over `SqliteDocStore` (local/MVCC store) AND a real
 * `D1DocStore` backed by an in-memory better-sqlite3 `D1Client` (global store) — mirrors the
 * harness in `executor.test.ts` (local store) and `kernel-global-routing.test.ts` (D1Client).
 */
import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { defineSchema, defineTable, v } from "@stackbase/values";
import { SqliteDocStore, NodeSqliteAdapter } from "@stackbase/docstore-sqlite";
import { MonotonicTimestampOracle } from "@stackbase/docstore";
import { SingleWriterTransactor } from "@stackbase/transactor";
import { QueryRuntime } from "@stackbase/query-engine";
import { D1DocStore, type D1Client, type D1PreparedStatement, type D1Session } from "@stackbase/docstore-d1";
import { encodeStorageIndexId } from "@stackbase/id-codec";
import {
  InlineUdfExecutor,
  SimpleIndexCatalog,
  mutation,
  query,
  CrossStoreWriteError,
} from "../src/index";

// ── in-memory D1Client (mirrors packages/docstore-d1/test/support/sqlite-d1-client.ts and
//    kernel-global-routing.test.ts's copy) ──────────────────────────────────────────────────────
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

const COUNTERS_TABLE_NUMBER = 50001;
const NOTES_TABLE_NUMBER = 50002;

// --- functions (what a user would write in their functions directory) ---
const insertCounter = mutation<{ key: string; value: number }, string>({
  handler: (ctx, { key, value }) => ctx.db.insert("counters", { key, value }),
});

const insertCounterThenThrow = mutation<{ key: string; value: number }, string>({
  handler: async (ctx, { key, value }) => {
    await ctx.db.insert("counters", { key, value });
    throw new Error("boom-after-stage");
  },
});

const insertThenGetCounter = mutation<{ key: string; value: number }, unknown>({
  handler: async (ctx, { key, value }) => {
    const id = await ctx.db.insert("counters", { key, value });
    return ctx.db.get(id);
  },
});

const insertNoteThenCounter = mutation<{ text: string; key: string; value: number }, void>({
  handler: async (ctx, { text, key, value }) => {
    await ctx.db.insert("notes", { text });
    await ctx.db.insert("counters", { key, value });
  },
});

const listNotesByText = query<{ text: string }, unknown[]>({
  handler: (ctx, { text }) => ctx.db.query("notes", "by_text").eq("text", text).collect(),
});

let exec: InlineUdfExecutor;
let globalStore: D1DocStore;

beforeEach(async () => {
  const localStore = new SqliteDocStore(new NodeSqliteAdapter());
  await localStore.setupSchema();
  const transactor = new SingleWriterTransactor(localStore, new MonotonicTimestampOracle());

  globalStore = new D1DocStore(sqliteD1Client(), globalSchema);
  await globalStore.applyDdl();

  const catalog = new SimpleIndexCatalog()
    .addTable("counters", COUNTERS_TABLE_NUMBER, undefined, false, null, true)
    .addIndex({
      table: "counters",
      tableNumber: COUNTERS_TABLE_NUMBER,
      index: "by_key",
      fields: ["key"],
      indexId: encodeStorageIndexId(COUNTERS_TABLE_NUMBER, "by_key"),
    })
    .addIndex({
      table: "notes",
      tableNumber: NOTES_TABLE_NUMBER,
      index: "by_text",
      fields: ["text"],
      indexId: encodeStorageIndexId(NOTES_TABLE_NUMBER, "by_text"),
    });

  exec = new InlineUdfExecutor({
    transactor,
    queryRuntime: new QueryRuntime(localStore),
    catalog,
    globalStore,
  });
});

describe("executor wiring: GlobalTxn per attempt, flush after commit (M2b Task 7)", () => {
  it("a global-only mutation's insert lands in D1 after run() resolves", async () => {
    const res = await exec.run<string>(insertCounter, { key: "a", value: 1 });
    expect(typeof res.value).toBe("string");

    const rows = await globalStore.queryByIndex("counters", { index: "by_key" });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ key: "a", value: 1, _id: res.value });
  });

  it("a global mutation that THROWS after staging leaves D1 untouched (abort-safety)", async () => {
    await expect(exec.run(insertCounterThenThrow, { key: "b", value: 2 })).rejects.toThrow("boom-after-stage");

    const rows = await globalStore.queryByIndex("counters", { index: "by_key" });
    expect(rows).toHaveLength(0);
  });

  it("read-your-own-writes inside the handler (insert then get returns the doc)", async () => {
    const res = await exec.run<{ _id: string; key: string; value: number } | null>(insertThenGetCounter, {
      key: "c",
      value: 3,
    });
    expect(res.value).toMatchObject({ key: "c", value: 3 });

    // ...and it's durably in D1 after the run resolves too.
    const rows = await globalStore.queryByIndex("counters", { index: "by_key" });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ key: "c", value: 3 });
  });

  it("a mutation writing a local table AND a global table rejects with CrossStoreWriteError and writes NEITHER store", async () => {
    await expect(
      exec.run(insertNoteThenCounter, { text: "should-not-persist", key: "d", value: 4 }),
    ).rejects.toThrow(CrossStoreWriteError);

    const noteRows = (await exec.run(listNotesByText, { text: "should-not-persist" })).value as unknown[];
    expect(noteRows).toHaveLength(0);

    const counterRows = await globalStore.queryByIndex("counters", { index: "by_key" });
    expect(counterRows).toHaveLength(0);
  });
});
