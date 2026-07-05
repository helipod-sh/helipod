// packages/admin/test/admin-api.test.ts
import { describe, it, expect } from "vitest";
import { SqliteDocStore, NodeSqliteAdapter } from "@helipod/docstore-sqlite";
import { InMemoryLogSink, SimpleIndexCatalog, mutation, query } from "@helipod/executor";
import { defineSchema, defineTable, v } from "@helipod/values";
import { EmbeddedRuntime } from "@helipod/runtime-embedded";
import { encodeStorageIndexId } from "@helipod/id-codec";
import { AdminApi } from "../src/admin-api";
import { browseTableModule } from "../src/browse";

const schema = defineSchema({ notes: defineTable({ title: v.string(), done: v.boolean() }) });

async function makeApi() {
  const store = new SqliteDocStore(new NodeSqliteAdapter());
  const catalog = new SimpleIndexCatalog();
  catalog.addTable("notes", 10001);
  // Register the implicit by_creation index so query().collect() works
  catalog.addIndex({
    table: "notes",
    tableNumber: 10001,
    index: "by_creation",
    fields: [],
    indexId: encodeStorageIndexId(10001, "by_creation"),
  });
  const logSink = new InMemoryLogSink();
  const runtime = await EmbeddedRuntime.create({
    store,
    catalog,
    logSink,
    modules: {
      "notes:add": mutation(async (ctx, a: { title: string; done: boolean }) => ctx.db.insert("notes", a)),
      "notes:list": query(async (ctx) => ctx.db.query("notes", "by_creation").collect()),
    },
    adminModules: { "_admin:browseTable": browseTableModule },
  });
  const api = new AdminApi({
    runtime,
    schemaJson: schema.export() as never,
    tableNumbers: { notes: 10001 },
    manifest: [{ path: "notes", functions: [{ name: "add", type: "mutation" }, { name: "list", type: "query" }] }],
    logSink,
  });
  return { api, runtime };
}

describe("AdminApi", () => {
  it("lists tables with document counts", async () => {
    const { api, runtime } = await makeApi();
    await runtime.run("notes:add", { title: "a", done: false });
    const tables = await api.listTables();
    expect(tables).toEqual([{ name: "notes", indexes: [], shardKey: undefined, documentCount: 1 }]);
  });

  it("paginates table data", async () => {
    const { api, runtime } = await makeApi();
    await runtime.run("notes:add", { title: "a", done: false });
    await runtime.run("notes:add", { title: "b", done: true });
    const page = await api.getTableData("notes", { pageSize: 10 });
    expect(page.documents).toHaveLength(2);
    expect(page.hasMore).toBe(false);
  });

  it("filters table data via FilterCond", async () => {
    const { api, runtime } = await makeApi();
    await runtime.run("notes:add", { title: "a", done: false });
    await runtime.run("notes:add", { title: "b", done: true });
    const filtered = await api.getTableData("notes", { filter: [{ field: "title", op: "eq", value: "b" }] });
    expect(filtered.documents.map((d: any) => d.title)).toEqual(["b"]);
  });

  it("lists functions and reads the log", async () => {
    const { api, runtime } = await makeApi();
    await runtime.run("notes:list", {});
    expect(api.listFunctions()).toContainEqual({ path: "notes:list", kind: "query" });
    expect(api.queryLogs()[0]).toMatchObject({ path: "notes:list", status: "ok" });
  });

  it("throws on unknown admin function when no adminModules", async () => {
    const store = new SqliteDocStore(new NodeSqliteAdapter());
    const catalog = new SimpleIndexCatalog();
    const logSink = new InMemoryLogSink();
    const runtime = await EmbeddedRuntime.create({ store, catalog, logSink, modules: {} });
    const api = new AdminApi({
      runtime,
      schemaJson: { tables: {} },
      tableNumbers: { notes: 10001 },
      manifest: [],
      logSink,
    });
    await expect(api.getTableData("notes")).rejects.toThrow("unknown admin function");
  });
});
