import { describe, it, expect } from "vitest";
import { SqliteDocStore, NodeSqliteAdapter } from "@stackbase/docstore-sqlite";
import { composeComponents } from "@stackbase/component";
import { EmbeddedRuntime } from "@stackbase/runtime-embedded";
import { defineSchema } from "@stackbase/values";
import { query } from "@stackbase/executor";
import { auth } from "../src/component";

async function makeRuntime() {
  const appModules = { "me:get": query(async (ctx) => (ctx as unknown as { auth: { getUserId(): Promise<string | null> } }).auth.getUserId()) };
  const { catalog, moduleMap, componentNames, contextProviders } = composeComponents(
    { schemaJson: defineSchema({}).export(), moduleMap: appModules },
    [auth],
  );
  return EmbeddedRuntime.create({ store: new SqliteDocStore(new NodeSqliteAdapter()), catalog, modules: moduleMap, componentNames, contextProviders });
}

describe("ctx.auth in an app function", () => {
  it("resolves the ambient identity to the signed-up user, and re-reads auth/sessions (reactivity)", async () => {
    const r = await makeRuntime();
    const { token, userId } = (await r.run<{ token: string; userId: string }>("auth:signUp", { email: "a@b.co", password: "pw" })).value;

    const me = await r.run<string | null>("me:get", {}, { identity: token });
    expect(me.value).toBe(userId);
    expect(me.readRanges.length).toBeGreaterThan(0); // facade's read of auth/sessions landed in this query's read-set

    const anon = await r.run<string | null>("me:get", {}, { identity: "bad-token" });
    expect(anon.value).toBeNull();
  });
});
