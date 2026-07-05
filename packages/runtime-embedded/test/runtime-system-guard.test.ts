// packages/runtime-embedded/test/runtime-system-guard.test.ts
// Regression test: _system:* functions must NOT be reachable via the public `run()` or sync surface.
import { describe, it, expect } from "vitest";
import { SqliteDocStore, NodeSqliteAdapter } from "@helipod/docstore-sqlite";
import { encodeStorageIndexId } from "@helipod/id-codec";
import { SimpleIndexCatalog, InMemoryLogSink, mutation, query, type RegisteredFunction } from "@helipod/executor";
import { DocumentNotFoundError } from "@helipod/errors";
import { EmbeddedRuntime } from "../src/index";

const TABLE_NUM = 20001;

/** Minimal inline system modules (mirrors packages/admin/src/system-functions.ts) */
function makeSystemModules(): Record<string, RegisteredFunction> {
  return {
    "_system:patchDocument": mutation(async (ctx, args: { id: string; fields: Record<string, unknown> }) => {
      const existing = await ctx.db.get(args.id);
      if (!existing) throw new DocumentNotFoundError(`cannot patch missing document ${args.id}`);
      await ctx.db.replace(args.id, { ...existing, ...args.fields } as never);
      return await ctx.db.get(args.id);
    }),
    "_system:deleteDocument": mutation(async (ctx, args: { id: string }) => {
      await ctx.db.delete(args.id);
      return null;
    }),
  };
}

async function makeRuntime() {
  const store = new SqliteDocStore(new NodeSqliteAdapter());
  const catalog = new SimpleIndexCatalog();
  catalog.addTable("notes", TABLE_NUM);
  catalog.addIndex({
    table: "notes",
    tableNumber: TABLE_NUM,
    index: "by_creation",
    fields: [],
    indexId: encodeStorageIndexId(TABLE_NUM, "by_creation"),
  });
  const logSink = new InMemoryLogSink();
  return EmbeddedRuntime.create({
    store,
    catalog,
    logSink,
    modules: {
      "notes:add": mutation(async (ctx, a: { title: string }) => ctx.db.insert("notes", a)),
      "notes:list": query(async (ctx) => ctx.db.query("notes", "by_creation").collect()),
    },
    systemModules: makeSystemModules(),
  });
}

describe("_system:* security guard", () => {
  it("runtime.run() rejects _system:* paths (bypass attempt is blocked)", async () => {
    const runtime = await makeRuntime();
    await expect(runtime.run("_system:deleteDocument", { id: "fake-id" })).rejects.toThrow();
  });

  it("runtime.run() also rejects any other _-prefixed path", async () => {
    const runtime = await makeRuntime();
    await expect(runtime.run("_internal:something", {})).rejects.toThrow();
  });

  it("runtime.runSystem() can patch a real document (privileged path still functions)", async () => {
    const runtime = await makeRuntime();

    // Insert a document via the public mutation surface.
    const insertResult = await runtime.run<string>("notes:add", { title: "original" });
    const id = insertResult.value;
    expect(typeof id).toBe("string");

    // Patch via the privileged runSystem() path — must succeed.
    const patched = await runtime.runSystem("_system:patchDocument", { id, fields: { title: "patched" } });
    expect((patched.value as Record<string, unknown>).title).toBe("patched");
  });

  it("runtime.runSystem() rejects unknown system paths", async () => {
    const runtime = await makeRuntime();
    await expect(runtime.runSystem("_system:nonExistentOp", {})).rejects.toThrow("unknown system function");
  });

  it("the sync surface (resolve closure) blocks _system:* mutations", async () => {
    const runtime = await makeRuntime();
    const conn = runtime.connect("test-session");

    // Attempt to invoke a _system:* mutation through the WebSocket sync protocol.
    // The sync executor uses the same `resolve` closure which guards against `_` prefixes.
    const responses: unknown[] = [];
    conn.onMessage((m) => responses.push(m));

    await conn.send({
      type: "Mutation",
      requestId: "r1",
      udfPath: "_system:deleteDocument",
      args: { id: "fake-id" },
    });

    // The response should contain a MutationResponse with an error (not a success).
    const mutResp = responses.find((r: any) => r.type === "MutationResponse") as any;
    expect(mutResp).toBeDefined();
    expect(mutResp.error).toBeDefined();
    expect(mutResp.success).toBeFalsy();
  });
});
