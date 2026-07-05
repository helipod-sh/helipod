import { describe, it, expect } from "vitest";
import { SqliteDocStore, NodeSqliteAdapter } from "@helipod/docstore-sqlite";
import { composeComponents } from "@helipod/component";
import { EmbeddedRuntime } from "@helipod/runtime-embedded";
import { defineSchema, defineTable, v } from "@helipod/values";
import { mutation } from "@helipod/executor";
import { auth } from "../src/component";

async function makeRuntime() {
  // an app table to prove auth's tables are namespaced separately
  const appSchema = defineSchema({ notes: defineTable({ body: v.string() }) });
  const { catalog, moduleMap, componentNames } = composeComponents(
    { schemaJson: appSchema.export(), moduleMap: { "notes:add": mutation(async (ctx, a: { body: string }) => ctx.db.insert("notes", a)) } },
    [auth],
  );
  return EmbeddedRuntime.create({ store: new SqliteDocStore(new NodeSqliteAdapter()), catalog, modules: moduleMap, componentNames });
}

describe("auth: session lifecycle", () => {
  it("getUserId resolves a live token, returns null after signOut", async () => {
    const r = await makeRuntime();
    const { token, userId } = (await r.run<{ token: string; userId: string }>("auth:signUp", { email: "a@b.co", password: "pw" })).value;
    expect((await r.run<string | null>("auth:getUserId", { token })).value).toBe(userId);
    await r.run("auth:signOut", { token });
    expect((await r.run<string | null>("auth:getUserId", { token })).value).toBeNull();
  });

  it("auth tables are isolated from the app namespace", async () => {
    const r = await makeRuntime();
    await r.run("auth:signUp", { email: "a@b.co", password: "pw" });
    await r.run("notes:add", { body: "hi" }); // app fn, different namespace — no collision
    // auth's getUserId is a component function; it cannot read the app's notes (boundary). Smoke: app + auth coexist.
    expect((await r.run<unknown[]>("auth:getUserId", { token: "nope" })).value).toBeNull();
  });
});
