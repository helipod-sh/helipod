import { describe, it, expect } from "vitest";
import { SqliteDocStore, NodeSqliteAdapter } from "@stackbase/docstore-sqlite";
import { composeComponents } from "@stackbase/component";
import { EmbeddedRuntime } from "@stackbase/runtime-embedded";
import { defineSchema } from "@stackbase/values";
import { query } from "@stackbase/executor";
import { auth } from "../src/component";

describe("auth: absolute session expiry", () => {
  it("getUserId returns null after the session expires (clock advanced)", async () => {
    let nowMs = 1_000_000_000_000; // fixed virtual clock
    const appModules = { "me:get": query(async (ctx) => (ctx as unknown as { auth: { getUserId(): Promise<string | null> } }).auth.getUserId()) };
    const { catalog, moduleMap, componentNames, contextProviders } = composeComponents(
      { schemaJson: defineSchema({}).export(), moduleMap: appModules }, [auth]);
    const r = await EmbeddedRuntime.create({
      store: new SqliteDocStore(new NodeSqliteAdapter()), catalog, modules: moduleMap, componentNames, contextProviders,
      now: () => nowMs,
    });
    const { token, userId } = (await r.run<{ token: string; userId: string }>("auth:signUp", { email: "a@b.co", password: "pw" })).value;
    expect((await r.run<string | null>("me:get", {}, { identity: token })).value).toBe(userId); // live
    nowMs += 31 * 24 * 60 * 60 * 1000; // +31 days
    expect((await r.run<string | null>("me:get", {}, { identity: token })).value).toBeNull(); // expired
  });
});
