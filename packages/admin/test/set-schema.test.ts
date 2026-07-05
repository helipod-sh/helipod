// packages/admin/test/set-schema.test.ts
import { describe, it, expect } from "vitest";
import { SqliteDocStore, NodeSqliteAdapter } from "@helipod/docstore-sqlite";
import { InMemoryLogSink, SimpleIndexCatalog, mutation, query } from "@helipod/executor";
import { defineSchema, defineTable, v } from "@helipod/values";
import { EmbeddedRuntime } from "@helipod/runtime-embedded";
import { encodeStorageIndexId } from "@helipod/id-codec";
import { AdminApi, type SchemaJsonLike } from "../src/admin-api";
import { browseTableModule } from "../src/browse";

const schema = defineSchema({ notes: defineTable({ title: v.string(), done: v.boolean() }) });

async function makeApi() {
  const store = new SqliteDocStore(new NodeSqliteAdapter());
  const catalog = new SimpleIndexCatalog();
  catalog.addTable("notes", 10001);
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
  const schemaJson: SchemaJsonLike = schema.export();
  const manifest = [{ path: "notes", functions: [{ name: "add", type: "mutation" }, { name: "list", type: "query" }] }];
  const api = new AdminApi({
    runtime,
    schemaJson,
    tableNumbers: { notes: 10001 },
    manifest,
    logSink,
  });
  return { api, runtime, schemaJson, manifest };
}

describe("AdminApi.setSchema / getSchema", () => {
  it("swaps schema + tableNumbers so new tables become visible", async () => {
    const { api, schemaJson, manifest } = await makeApi();

    const before = await api.listTables();
    expect(before.map((t) => t.name)).toEqual(["notes"]);

    const newSchemaJson: SchemaJsonLike = {
      tables: {
        ...schemaJson.tables,
        events: { indexes: [{ indexDescriptor: "by_creation" }], shardKey: null },
      },
    };
    api.setSchema(newSchemaJson, { notes: 10001, events: 10002 }, manifest);

    const after = await api.listTables();
    expect(after.map((t) => t.name).sort()).toEqual(["events", "notes"]);
  });

  it("getSchema reflects the live schema/tableNumbers, updated by setSchema", async () => {
    const { api, schemaJson, manifest } = await makeApi();

    const live = api.getSchema();
    expect(live.schemaJson).toBe(schemaJson);
    expect(live.tableNumbers).toEqual({ notes: 10001 });

    const newSchemaJson: SchemaJsonLike = {
      tables: {
        ...schemaJson.tables,
        events: { indexes: [], shardKey: null },
      },
    };
    const newTableNumbers = { notes: 10001, events: 10002 };
    api.setSchema(newSchemaJson, newTableNumbers, manifest);

    const after = api.getSchema();
    expect(after.schemaJson).toBe(newSchemaJson);
    expect(after.tableNumbers).toEqual(newTableNumbers);
  });
});
