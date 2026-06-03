import { describe, it, expect } from "vitest";
import { sqliteD1Client } from "./support/sqlite-d1-client";

describe("sqliteD1Client", () => {
  it("execs DDL, runs an insert, and reads it back", async () => {
    const c = sqliteD1Client();
    await c.exec(`CREATE TABLE t ("_id" TEXT PRIMARY KEY, "n" REAL)`);
    const ins = await c.prepare(`INSERT INTO t ("_id","n") VALUES (?,?)`).bind("a", 1).run();
    expect(ins.changes).toBe(1);
    const { results } = await c.prepare(`SELECT * FROM t WHERE "_id"=?`).bind("a").all();
    expect(results).toEqual([{ _id: "a", n: 1 }]);
  });
  it("surfaces the raw SQLite UNIQUE message so the store can map it", async () => {
    const c = sqliteD1Client();
    await c.exec(`CREATE TABLE t ("_id" TEXT PRIMARY KEY, "e" TEXT); CREATE UNIQUE INDEX uq ON t ("e")`);
    await c.prepare(`INSERT INTO t ("_id","e") VALUES (?,?)`).bind("a", "x").run();
    await expect(c.prepare(`INSERT INTO t ("_id","e") VALUES (?,?)`).bind("b", "x").run()).rejects.toThrow(/UNIQUE constraint failed/);
  });
  it("withSession returns a working client (bookmark is a no-op locally)", async () => {
    const c = sqliteD1Client();
    const s = c.withSession(undefined);
    await s.client.exec(`CREATE TABLE t ("_id" TEXT PRIMARY KEY)`);
    expect(s.latestBookmark()).toBeUndefined();
  });
});
