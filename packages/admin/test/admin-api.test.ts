// packages/admin/test/admin-api.test.ts
import { describe, it, expect } from "vitest";
import { SqliteDocStore, NodeSqliteAdapter } from "@stackbase/docstore-sqlite";
import { InMemoryLogSink, SimpleIndexCatalog, mutation, query } from "@stackbase/executor";
import { defineSchema, defineTable, v } from "@stackbase/values";
import { EmbeddedRuntime } from "@stackbase/runtime-embedded";
import { encodeStorageIndexId } from "@stackbase/id-codec";
import { AdminApi } from "../src/admin-api";

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

  it("paginates and filters table data", async () => {
    const { api, runtime } = await makeApi();
    await runtime.run("notes:add", { title: "a", done: false });
    await runtime.run("notes:add", { title: "b", done: true });
    const page = await api.getTableData("notes", { pageSize: 10 });
    expect(page.total).toBe(2);
    const filtered = await api.getTableData("notes", { filter: "title:b" });
    expect(filtered.documents.map((d: any) => d.title)).toEqual(["b"]);
  });

  it("lists functions and reads the log", async () => {
    const { api, runtime } = await makeApi();
    await runtime.run("notes:list", {});
    expect(api.listFunctions()).toContainEqual({ path: "notes:list", kind: "query" });
    expect(api.queryLogs()[0]).toMatchObject({ path: "notes:list", status: "ok" });
  });

  it("throws on an unknown table", async () => {
    const { api } = await makeApi();
    await expect(api.getTableData("ghost")).rejects.toThrow("unknown table: ghost");
  });
});
