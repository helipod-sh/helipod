// packages/admin/test/admin-write.test.ts
import { describe, it, expect } from "vitest";
import { SqliteDocStore, NodeSqliteAdapter } from "@helipod/docstore-sqlite";
import { InMemoryLogSink, SimpleIndexCatalog, mutation, query } from "@helipod/executor";
import { defineSchema, defineTable, v } from "@helipod/values";
import { EmbeddedRuntime } from "@helipod/runtime-embedded";
import { encodeStorageIndexId } from "@helipod/id-codec";
import { AdminApi } from "../src/admin-api";
import { systemModules } from "../src/system-functions";

const schema = defineSchema({ notes: defineTable({ title: v.string() }) });

// ── Sharded harness (blocker 1: privileged admin doc edits route to the doc's owning ring) ──────
// `messages` is sharded by channelId; numShards = 8. chan-5 routes to s2 (per shard-guards.test.ts).
const MESSAGES = 20001;
async function makeShardedApi() {
  const store = new SqliteDocStore(new NodeSqliteAdapter());
  const catalog = new SimpleIndexCatalog();
  catalog.addTable("messages", MESSAGES, undefined, false, "channelId");
  catalog.addIndex({ table: "messages", tableNumber: MESSAGES, index: "by_channel", fields: ["channelId"], indexId: encodeStorageIndexId(MESSAGES, "by_channel") });
  catalog.addIndex({ table: "messages", tableNumber: MESSAGES, index: "by_creation", fields: [], indexId: encodeStorageIndexId(MESSAGES, "by_creation") });
  const logSink = new InMemoryLogSink();
  const runtime = await EmbeddedRuntime.create({
    store,
    catalog,
    logSink,
    numShards: 8,
    tableNumbers: { messages: MESSAGES },
    modules: {
      "messages:send": mutation<{ channelId: string; body: string }, string>({
        shardBy: "channelId",
        handler: (ctx, a) => ctx.db.insert("messages", a),
      }),
      "messages:replaceBody": mutation<{ channelId: string; id: string; body: string }, null>({
        shardBy: "channelId",
        handler: async (ctx, a) => {
          await ctx.db.replace(a.id, { channelId: a.channelId, body: a.body });
          return null;
        },
      }),
      "messages:list": query(async (ctx) => ctx.db.query("messages", "by_creation").collect()),
    },
    systemModules: systemModules(),
  });
  const api = new AdminApi({
    runtime,
    schemaJson: { tables: { messages: { indexes: [{ indexDescriptor: "by_channel" }, { indexDescriptor: "by_creation" }], shardKey: "channelId" } } } as never,
    tableNumbers: { messages: MESSAGES },
    manifest: [],
    logSink,
  });
  return { api, runtime };
}

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

  it("creates a document", async () => {
    const { api, runtime } = await makeApi();
    const created = await api.createDocument("notes", { title: "fresh" });
    expect((created as any).title).toBe("fresh");
    expect(typeof (created as any)._id).toBe("string");

    const list = await runtime.run<Array<{ title: string }>>("notes:list", {});
    expect(list.value.map((d) => d.title)).toEqual(["fresh"]);
  });

  it("routes a privileged patch of a SHARDED doc to its home ring (no fork, no ownership error)", async () => {
    const { api, runtime } = await makeShardedApi();
    const id = (await runtime.run<string>("messages:send", { channelId: "chan-5", body: "orig" })).value; // s2

    // Auto-routing: patchDocument resolves the doc's owning shard (s2) and lands there. Pre-fix this
    // ran on the default ring and threw the shard-ownership guard (forking s2's prev_ts chain).
    const patched = await api.patchDocument(id, { channelId: "chan-5", body: "edited" });
    expect((patched as any).body).toBe("edited");
    expect((patched as any).channelId).toBe("chan-5");
  });

  it("the un-routed (default-ring) path is exactly the fork bug: forcing shardId 'default' errors", async () => {
    const { runtime } = await makeShardedApi();
    const id = (await runtime.run<string>("messages:send", { channelId: "chan-5", body: "orig" })).value; // s2
    // Override the resolution to the default ring — the pre-fix behavior — and the ownership guard fires.
    await expect(
      runtime.runSystem("_system:patchDocument", { id, fields: { channelId: "chan-5", body: "x" } }, { shardId: "default" }),
    ).rejects.toThrow(/runs on shard default but the document \(channelId="chan-5"\) routes to shard s2/);
  });

  it("a concurrent home-shard user replace + admin patch both commit (serialized on one ring, not forked)", async () => {
    const { api, runtime } = await makeShardedApi();
    const id = (await runtime.run<string>("messages:send", { channelId: "chan-5", body: "orig" })).value; // s2

    // Both target s2's ring: the user replace via shardBy, the admin patch via resolved routing.
    // They serialize on s2's single writer mutex — a linear chain — rather than forking across rings.
    const [userRes, adminRes] = await Promise.allSettled([
      runtime.run("messages:replaceBody", { channelId: "chan-5", id, body: "user" }),
      api.patchDocument(id, { channelId: "chan-5", body: "admin" }),
    ]);
    expect(userRes.status).toBe("fulfilled");
    expect(adminRes.status).toBe("fulfilled");
    const final = (await runtime.run<Array<{ body: string }>>("messages:list", {})).value;
    expect(final).toHaveLength(1);
    expect(["user", "admin"]).toContain(final[0]!.body); // last writer wins on the shared ring
  });

  it("edit is a whole-document replace — a field omitted by the editor is removed", async () => {
    const { api, runtime } = await makeApi();
    const id = (await runtime.run<string>("notes:add", { title: "orig" })).value;
    await api.patchDocument(id, { title: "orig", extra: "x" });
    let doc = (await runtime.run<Array<Record<string, unknown>>>("notes:list", {})).value[0]!;
    expect(doc.extra).toBe("x");

    await api.patchDocument(id, { title: "orig" }); // editor dropped `extra`
    doc = (await runtime.run<Array<Record<string, unknown>>>("notes:list", {})).value[0]!;
    expect(doc.extra).toBeUndefined();
    expect(doc.title).toBe("orig");
  });
});
