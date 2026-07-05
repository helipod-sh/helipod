import { describe, it, expect } from "vitest";
import { SqliteDocStore, NodeSqliteAdapter } from "@helipod/docstore-sqlite";
import { SimpleIndexCatalog, mutation, query } from "@helipod/executor";
import { encodeStorageIndexId } from "@helipod/id-codec";
import { EmbeddedRuntime } from "../src/index";

function makeCatalog(): SimpleIndexCatalog {
  const c = new SimpleIndexCatalog();
  c.addTable("notes", 10001);
  c.addIndex({ table: "notes", tableNumber: 10001, index: "by_creation", fields: [], indexId: encodeStorageIndexId(10001, "by_creation") });
  return c;
}
const modules = {
  "notes:add": mutation(async (ctx, a: { title: string }) => ctx.db.insert("notes", a)),
  "notes:list": query(async (ctx) => ctx.db.query("notes", "by_creation").collect()),
  "notes:rename": mutation(async (ctx, a: { id: string; title: string }) => {
    const doc = await ctx.db.get(a.id);
    await ctx.db.replace(a.id, { ...(doc as Record<string, unknown>), title: a.title });
    return await ctx.db.get(a.id);
  }),
};

describe("persistence across restart", () => {
  it("reads persisted docs after a fresh runtime/oracle (recovers the timestamp high-water mark)", async () => {
    // One SqliteDocStore instance holds the data; a SECOND EmbeddedRuntime over it simulates a
    // process restart (fresh transactor + oracle, same persisted log).
    const store = new SqliteDocStore(new NodeSqliteAdapter());
    const rt1 = await EmbeddedRuntime.create({ store, catalog: makeCatalog(), modules });
    await rt1.run("notes:add", { title: "persisted" });

    const rt2 = await EmbeddedRuntime.create({ store, catalog: makeCatalog(), modules });
    // Indexed query (uses the snapshot ts) must see the persisted doc — not just an unbounded scan.
    const list = await rt2.run<Array<{ title: string }>>("notes:list", {});
    expect(list.value.map((d) => d.title)).toEqual(["persisted"]);
  });

  it("writes persist after a restart (new commits continue past the recovered high-water mark)", async () => {
    const store = new SqliteDocStore(new NodeSqliteAdapter());
    const rt1 = await EmbeddedRuntime.create({ store, catalog: makeCatalog(), modules });
    await rt1.run("notes:add", { title: "before" });

    const rt2 = await EmbeddedRuntime.create({ store, catalog: makeCatalog(), modules });
    await rt2.run("notes:add", { title: "after-restart" }); // a WRITE in the new process
    const list = await rt2.run<Array<{ title: string }>>("notes:list", {});
    expect(list.value.map((d) => d.title).sort()).toEqual(["after-restart", "before"]);
  });

  it("replace persists after a restart (matches the admin patch path)", async () => {
    const store = new SqliteDocStore(new NodeSqliteAdapter());
    const rt1 = await EmbeddedRuntime.create({ store, catalog: makeCatalog(), modules });
    const id = (await rt1.run<string>("notes:add", { title: "orig" })).value;

    const rt2 = await EmbeddedRuntime.create({ store, catalog: makeCatalog(), modules });
    const renamed = await rt2.run<{ title: string }>("notes:rename", { id, title: "renamed" });
    expect(renamed.value.title).toBe("renamed"); // read-your-own-writes after replace
    const list = await rt2.run<Array<{ title: string }>>("notes:list", {});
    expect(list.value.map((d) => d.title)).toEqual(["renamed"]); // persisted
  });
});
