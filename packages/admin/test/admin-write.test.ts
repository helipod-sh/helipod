// packages/admin/test/admin-write.test.ts
import { describe, it, expect } from "vitest";
import { SqliteDocStore, NodeSqliteAdapter } from "@stackbase/docstore-sqlite";
import { InMemoryLogSink, SimpleIndexCatalog, mutation, query } from "@stackbase/executor";
import { defineSchema, defineTable, v } from "@stackbase/values";
import { EmbeddedRuntime } from "@stackbase/runtime-embedded";
import { encodeStorageIndexId } from "@stackbase/id-codec";
import { AdminApi } from "../src/admin-api";
import { systemModules } from "../src/system-functions";

const schema = defineSchema({ notes: defineTable({ title: v.string() }) });

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
      "notes:add": mutation(async (ctx, a: { title: string }) => ctx.db.insert("notes", a)),
      "notes:list": query(async (ctx) => ctx.db.query("notes", "by_creation").collect()),
    },
    systemModules: systemModules(),
  });
  const api = new AdminApi({
    runtime,
    schemaJson: schema.export() as never,
    tableNumbers: { notes: 10001 },
    manifest: [],
    logSink,
  });
  return { api, runtime };
}

describe("AdminApi writes", () => {
  it("runs a function and reports the result", async () => {
    const { api } = await makeApi();
    const r = await api.runFunction("notes:add", { title: "x" });
    expect(typeof r.value).toBe("string"); // the new doc id
    expect(r.committed).toBe(true);
  });

  it("patches and deletes a document", async () => {
    const { api, runtime } = await makeApi();
    const id = (await runtime.run<string>("notes:add", { title: "orig" })).value;

    const patched = await api.patchDocument(id, { title: "edited" });
    expect((patched as any).title).toBe("edited");

    await api.deleteDocument(id);
    const left = await runtime.run<unknown[]>("notes:list", {});
    expect(left.value).toEqual([]);
  });
});
