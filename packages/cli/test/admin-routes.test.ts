import { describe, it, expect } from "vitest";
import { SqliteDocStore, NodeSqliteAdapter } from "@stackbase/docstore-sqlite";
import { InMemoryLogSink, SimpleIndexCatalog, mutation } from "@stackbase/executor";
import { defineSchema, defineTable, v } from "@stackbase/values";
import { EmbeddedRuntime } from "@stackbase/runtime-embedded";
import { AdminApi, systemModules } from "@stackbase/admin";
import { handleHttpRequest } from "../src/http-handler";

const schema = defineSchema({ notes: defineTable({ title: v.string() }) });

async function setup() {
  const store = new SqliteDocStore(new NodeSqliteAdapter());
  const catalog = new SimpleIndexCatalog();
  catalog.addTable("notes", 10001);
  const logSink = new InMemoryLogSink();
  const runtime = await EmbeddedRuntime.create({
    store,
    catalog,
    logSink,
    modules: {
      "notes:add": mutation(async (ctx, a: { title: string }) => ctx.db.insert("notes", a)),
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
  return { runtime, admin: { api, key: "k" } };
}

const info = { functions: [], tables: ["notes"] };

describe("admin routes via handleHttpRequest", () => {
  it("401 without the key, 200 with it", async () => {
    const { runtime, admin } = await setup();
    const noKey = await handleHttpRequest(runtime, { method: "GET", path: "/_admin/tables" }, info, admin);
    expect(noKey.status).toBe(401);
    const ok = await handleHttpRequest(
      runtime,
      { method: "GET", path: "/_admin/tables", authorization: "Bearer k" },
      info,
      admin,
    );
    expect(ok.status).toBe(200);
    expect(JSON.parse(ok.body)[0].name).toBe("notes");
  });
});
