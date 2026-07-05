/**
 * M2b Task 8 — `EmbeddedRuntimeOptions.globalStore` threaded through `createEmbeddedRuntime`
 * into `ExecutorDeps.globalStore` (mirrors the `queryStore` precedent in `hybrid-seams.test.ts`).
 * Drives `runtime.run(...)` — the real end-user entry point — rather than the executor directly,
 * proving the option actually reaches `InlineUdfExecutor` through `EmbeddedRuntime.create()`'s
 * single construction site. Unset `globalStore` (every other suite) stays byte-identical, so no
 * regression coverage is duplicated here.
 */
import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { defineSchema, defineTable, v } from "@helipod/values";
import { SqliteDocStore, NodeSqliteAdapter } from "@helipod/docstore-sqlite";
import { encodeStorageIndexId } from "@helipod/id-codec";
import { SimpleIndexCatalog, mutation, query, type RegisteredFunction } from "@helipod/executor";
import { D1DocStore, type D1Client, type D1PreparedStatement, type D1Session } from "@helipod/docstore-d1";
import { createEmbeddedRuntime } from "../src/index";

// ── in-memory D1Client (mirrors packages/docstore-d1/test/support/sqlite-d1-client.ts and
//    packages/executor/test/executor-global-flush.test.ts's copy) ──────────────────────────────
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
  users: defineTable({ name: v.string() }).index("by_name", ["name"]),
}).export();

const USERS_TABLE_NUMBER = 60001;

const modules: Record<string, RegisteredFunction> = {
  "users:create": mutation<{ name: string }, string>({
    handler: (ctx, { name }) => ctx.db.insert("users", { name }),
  }),
  "users:list": query<Record<string, never>, unknown[]>({
    handler: (ctx) => ctx.db.query("users", "by_name").collect(),
  }),
};

function freshCatalog(): SimpleIndexCatalog {
  return new SimpleIndexCatalog()
    .addTable("users", USERS_TABLE_NUMBER, undefined, false, null, true)
    .addIndex({
      table: "users",
      tableNumber: USERS_TABLE_NUMBER,
      index: "by_name",
      fields: ["name"],
      indexId: encodeStorageIndexId(USERS_TABLE_NUMBER, "by_name"),
    });
}

describe("EmbeddedRuntimeOptions.globalStore threading (M2b Task 8)", () => {
  it("a .global()-table mutation run through runtime.run() lands in the injected D1DocStore", async () => {
    const store = new SqliteDocStore(new NodeSqliteAdapter());
    await store.setupSchema();

    const globalStore = new D1DocStore(sqliteD1Client(), globalSchema);
    await globalStore.applyDdl();

    const runtime = await createEmbeddedRuntime({ store, catalog: freshCatalog(), modules, globalStore });

    const res = await runtime.run<string>("users:create", { name: "ada" });
    expect(typeof res.value).toBe("string");

    const row = await globalStore.get("users", res.value);
    expect(row).toMatchObject({ name: "ada", _id: res.value });
  });

  it("unset globalStore stays byte-identical — a normal (non-global) mutation still runs fine", async () => {
    const store = new SqliteDocStore(new NodeSqliteAdapter());
    await store.setupSchema();
    const catalog = new SimpleIndexCatalog()
      .addTable("users", USERS_TABLE_NUMBER, undefined, false, null, false)
      .addIndex({
        table: "users",
        tableNumber: USERS_TABLE_NUMBER,
        index: "by_name",
        fields: ["name"],
        indexId: encodeStorageIndexId(USERS_TABLE_NUMBER, "by_name"),
      });
    const runtime = await createEmbeddedRuntime({ store, catalog, modules });

    const res = await runtime.run<string>("users:create", { name: "grace" });
    expect(typeof res.value).toBe("string");
    const list = await runtime.run<unknown[]>("users:list", {});
    expect(list.value).toHaveLength(1);
  });
});
