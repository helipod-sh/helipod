import { describe, it, expect } from "vitest";
import { SqliteDocStore, NodeSqliteAdapter } from "@stackbase/docstore-sqlite";
import { composeComponents } from "@stackbase/component";
import { EmbeddedRuntime } from "@stackbase/runtime-embedded";
import { defineSchema } from "@stackbase/values";
import { query } from "@stackbase/executor";
import { auth } from "@stackbase/auth";
import { defineAuthz } from "../src/define-authz";

const authz = defineAuthz({ roles: { editor: { documents: ["read", "update"] } } });

async function makeRuntime() {
  const app = { "me:canEdit": query(async (ctx) => (ctx as unknown as { authz: { can(p: string): Promise<boolean> } }).authz.can("documents:update")) };
  const { catalog, moduleMap, componentNames, contextProviders } = composeComponents(
    { schemaJson: defineSchema({}).export(), moduleMap: app }, [auth, authz]);
  return EmbeddedRuntime.create({ store: new SqliteDocStore(new NodeSqliteAdapter()), catalog, modules: moduleMap, componentNames, contextProviders });
}

describe("authz RBAC", () => {
  it("assignRole grants a permission; revokeRole removes it; anonymous is denied", async () => {
    const r = await makeRuntime();
    const { token, userId } = (await r.run<{ token: string; userId: string }>("auth:signUp", { email: "a@b.co", password: "pw" })).value;
    expect((await r.run<boolean>("me:canEdit", {}, { identity: token })).value).toBe(false); // no role
    await r.run("authz:assignRole", { userId, role: "editor" });
    expect((await r.run<boolean>("me:canEdit", {}, { identity: token })).value).toBe(true);
    await r.run("authz:revokeRole", { userId, role: "editor" });
    expect((await r.run<boolean>("me:canEdit", {}, { identity: token })).value).toBe(false);
    expect((await r.run<boolean>("me:canEdit", {})).value).toBe(false); // anonymous
  });
});
