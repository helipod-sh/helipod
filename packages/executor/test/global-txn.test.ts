import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { defineSchema, defineTable, v } from "@stackbase/values";
import { D1DocStore } from "@stackbase/docstore-d1";
import type { D1Client, D1PreparedStatement, D1Session } from "@stackbase/docstore-d1";
import { GlobalTxn } from "../src/global-txn";

// `@stackbase/docstore-d1` only exports its package root (no `test/support/...` subpath across
// package boundaries), so this is an inlined copy of that package's own better-sqlite3-backed
// D1Client test substrate — test-only, kept behaviorally identical to the original.
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
    exec: async (sql) => { db.exec(sql); },
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

const schema = defineSchema({ users: defineTable({ email: v.string(), n: v.number() }).global().index("by_email", ["email"], { unique: true }) }).export();
async function freshStore() { const s = new D1DocStore(sqliteD1Client(), schema); await s.applyDdl(); return s; }

describe("GlobalTxn", () => {
  it("read-your-own-writes: a staged insert is visible to get() before flush", async () => {
    const g = new GlobalTxn(await freshStore());
    g.stageInsert("users", { _id: "u1", _creationTime: 1, email: "a", n: 1 });
    expect((await g.get("users", "u1"))!.email).toBe("a"); // overlay hit, not yet in D1
    expect(g.hasWrites()).toBe(true);
    expect(g.ops).toHaveLength(1);
  });
  it("get() falls through to D1 for an unstaged row", async () => {
    const store = await freshStore();
    await store.commitBatch([{ kind: "insert", table: "users", doc: { _id: "u9", _creationTime: 9, email: "z", n: 9 } }]);
    const g = new GlobalTxn(store);
    expect((await g.get("users", "u9"))!.email).toBe("z");
  });
  it("a staged delete hides a D1 row from get()", async () => {
    const store = await freshStore();
    await store.commitBatch([{ kind: "insert", table: "users", doc: { _id: "u1", _creationTime: 1, email: "a", n: 1 } }]);
    const g = new GlobalTxn(store);
    g.stageDelete("users", "u1");
    expect(await g.get("users", "u1")).toBeNull();
  });
  it("queryByIndex overlays staged inserts and honors staged deletes", async () => {
    const store = await freshStore();
    await store.commitBatch([{ kind: "insert", table: "users", doc: { _id: "u1", _creationTime: 1, email: "a", n: 5 } }]);
    const g = new GlobalTxn(store);
    g.stageInsert("users", { _id: "u2", _creationTime: 2, email: "b", n: 5 });
    g.stageDelete("users", "u1");
    const rows = await g.queryByIndex("users", { index: "by_email", eq: { n: 5 } });
    expect(rows.map((r) => r._id).sort()).toEqual(["u2"]); // u1 deleted, u2 staged
  });
});
