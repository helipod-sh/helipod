// packages/runtime-embedded/test/component-boundary.test.ts
import { describe, it, expect } from "vitest";
import { SqliteDocStore, NodeSqliteAdapter } from "@stackbase/docstore-sqlite";
import { defineSchema, defineTable, v } from "@stackbase/values";
import { mutation, query, type RegisteredFunction } from "@stackbase/executor";
import { defineComponent, composeComponents } from "@stackbase/component";
import { DocumentNotFoundError } from "@stackbase/errors";
import { EmbeddedRuntime } from "../src/index";

// Inline minimal system modules to avoid a circular dep: admin → runtime-embedded → admin.
function systemModules(): Record<string, RegisteredFunction> {
  return {
    "_system:patchDocument": mutation(async (ctx, args: { id: string; fields: Record<string, unknown> }) => {
      const existing = await ctx.db.get(args.id);
      if (!existing) throw new DocumentNotFoundError(`cannot edit missing document ${args.id}`);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await ctx.db.replace(args.id, args.fields as any);
      return await ctx.db.get(args.id);
    }),
  };
}

const auth = defineComponent({
  name: "auth",
  schema: defineSchema({ sessions: defineTable({ token: v.string() }).index("by_token", ["token"]) }),
  modules: {
    signIn: mutation(async (ctx) => ctx.db.insert("sessions", { token: "t" })),         // bare "sessions"
    listSessions: query(async (ctx) => ctx.db.query("sessions", "by_creation").collect()),
    peekMessages: query(async (ctx) => ctx.db.query("messages", "by_creation").collect()), // app table — must be denied
  },
});
const appSchema = defineSchema({ messages: defineTable({ body: v.string() }) });
const appModules = { "messages:add": mutation(async (ctx, a: { body: string }) => ctx.db.insert("messages", a)) };

async function makeRuntime() {
  const { catalog, moduleMap, componentNames } = composeComponents({ schemaJson: appSchema.export(), moduleMap: appModules }, [auth]);
  const runtime = await EmbeddedRuntime.create({
    store: new SqliteDocStore(new NodeSqliteAdapter()),
    catalog,
    modules: moduleMap,
    componentNames,
    systemModules: systemModules(),
  });
  return runtime;
}

describe("component boundary (live in the runtime)", () => {
  it("a component function runs at its own namespace and is isolated from the app", async () => {
    const runtime = await makeRuntime();
    await runtime.run("auth:signIn", {});
    expect((await runtime.run<unknown[]>("auth:listSessions", {})).value).toHaveLength(1); // its own table
    await runtime.run("messages:add", { body: "hi" }); // app fn, namespace ""
    await expect(runtime.run("auth:peekMessages", {})).rejects.toThrow(/unknown/); // can't reach app table
  });

  it("runSystem (privileged) can edit a component-namespaced document", async () => {
    const runtime = await makeRuntime();
    const id = (await runtime.run<string>("auth:signIn", {})).value;
    const patched = await runtime.runSystem<{ token: string }>("_system:patchDocument", { id, fields: { token: "edited" } });
    expect(patched.value.token).toBe("edited");
  });
});
