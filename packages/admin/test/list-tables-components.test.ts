// packages/admin/test/list-tables-components.test.ts
import { describe, it, expect } from "vitest";
import { SqliteDocStore, NodeSqliteAdapter } from "@helipod/docstore-sqlite";
import { InMemoryLogSink, SimpleIndexCatalog } from "@helipod/executor";
import { defineSchema, defineTable, v } from "@helipod/values";
import { EmbeddedRuntime } from "@helipod/runtime-embedded";
import { encodeStorageIndexId } from "@helipod/id-codec";
import { AdminApi } from "../src/admin-api";

// App schema has only "notes" — component tables are NOT in schemaJson
const schema = defineSchema({ notes: defineTable({ title: v.string() }) });

async function makeApiWithComponents() {
  const store = new SqliteDocStore(new NodeSqliteAdapter());
  const catalog = new SimpleIndexCatalog();

  // App table
  catalog.addIndex({
    table: "notes",
    tableNumber: 10001,
    index: "by_creation",
    fields: [],
    indexId: encodeStorageIndexId(10001, "by_creation"),
  });

  // Component table — exists in tableNumbers + catalog but NOT in schemaJson
  catalog.addIndex({
    table: "auth/sessions",
    tableNumber: 10002,
    index: "by_creation",
    fields: [],
    indexId: encodeStorageIndexId(10002, "by_creation"),
  });

  const logSink = new InMemoryLogSink();
  const runtime = await EmbeddedRuntime.create({ store, catalog, logSink, modules: {} });

  const api = new AdminApi({
    runtime,
    schemaJson: schema.export() as never,
    tableNumbers: { notes: 10001, "auth/sessions": 10002 },
    manifest: [],
    logSink,
    catalog,
  });
  return { api };
}

describe("AdminApi.listTables — component tables", () => {
  it("includes component tables that are in tableNumbers but not in schemaJson", async () => {
    const { api } = await makeApiWithComponents();
    const tables = await api.listTables();
    const names = tables.map((t) => t.name);
    expect(names).toContain("notes");
    expect(names).toContain("auth/sessions");
  });

  it("returns tables sorted by name", async () => {
    const { api } = await makeApiWithComponents();
    const tables = await api.listTables();
    const names = tables.map((t) => t.name);
    expect(names).toEqual([...names].sort());
  });

  it("derives component table indexes from catalog", async () => {
    const { api } = await makeApiWithComponents();
    const tables = await api.listTables();
    const authSessions = tables.find((t) => t.name === "auth/sessions");
    expect(authSessions).toBeDefined();
    expect(authSessions!.indexes).toEqual(["by_creation"]);
    expect(authSessions!.shardKey).toBeUndefined();
  });
});
