import { describe, it, expect } from "vitest";
import { SqliteDocStore, NodeSqliteAdapter } from "@stackbase/docstore-sqlite";
import { composeComponents } from "@stackbase/component";
import { EmbeddedRuntime } from "@stackbase/runtime-embedded";
import { defineSchema } from "@stackbase/values";
import { query, mutation, type RegisteredFunction } from "@stackbase/executor";
import { auth } from "@stackbase/auth";
import { defineAuthz } from "../src/define-authz";

// The privileged built-in the real bootstrap uses (admin API / `stackbase` CLI) to seed the first
// admin directly — it bypasses the namespace boundary, so it can write `authz/role_assignments`
// without holding any role. This is the ONLY ungated way a role assignment is created.
function systemModules(): Record<string, RegisteredFunction> {
  return {
    "_system:insertDocument": mutation(async (ctx, args: { table: string; fields: Record<string, unknown> }) =>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await ctx.db.insert(args.table, args.fields as any)
    ),
  };
}

// `admin` grants `authz:manage` → may assign/revoke roles. `editor` is an ordinary app role.
const authz = defineAuthz({ roles: {
  editor: { documents: ["read", "update"] },
  admin: { authz: ["manage"] },
} });

async function makeRuntime() {
  const app = {
    "me:canEdit": query(async (ctx) => (ctx as unknown as { authz: { can(p: string): Promise<boolean> } }).authz.can("documents:update")),
    "me:roles": query(async (ctx) => (ctx as unknown as { authz: { roles(): Promise<string[]> } }).authz.roles()),
  };
  const { catalog, moduleMap, componentNames, contextProviders } = composeComponents(
    { schemaJson: defineSchema({}).export(), moduleMap: app }, [auth, authz]);
  return EmbeddedRuntime.create({ store: new SqliteDocStore(new NodeSqliteAdapter()), catalog, modules: moduleMap, systemModules: systemModules(), componentNames, contextProviders });
}

// Sign up a user and seed them as a global admin via the privileged path (the bootstrap).
async function makeAdmin(r: EmbeddedRuntime, email: string): Promise<{ token: string; userId: string }> {
  const who = (await r.run<{ token: string; userId: string }>("auth:signUp", { email, password: "pw" })).value;
  await r.runSystem("_system:insertDocument", { table: "authz/role_assignments", fields: { userId: who.userId, role: "admin", scopeType: "", scopeId: "" } });
  await r.runSystem("_system:insertDocument", { table: "authz/effective_permissions", fields: { userId: who.userId, scopeType: "", scopeId: "", permission: "authz:manage" } });
  return who;
}

describe("authz RBAC", () => {
  it("an admin assigns a permission; revoking removes it; anonymous is denied", async () => {
    const r = await makeRuntime();
    const admin = await makeAdmin(r, "admin@b.co");
    const { token, userId } = (await r.run<{ token: string; userId: string }>("auth:signUp", { email: "a@b.co", password: "pw" })).value;
    expect((await r.run<boolean>("me:canEdit", {}, { identity: token })).value).toBe(false); // no role
    await r.run("authz:assignRole", { userId, role: "editor" }, { identity: admin.token });
    expect((await r.run<boolean>("me:canEdit", {}, { identity: token })).value).toBe(true);
    await r.run("authz:revokeRole", { userId, role: "editor" }, { identity: admin.token });
    expect((await r.run<boolean>("me:canEdit", {}, { identity: token })).value).toBe(false);
    expect((await r.run<boolean>("me:canEdit", {})).value).toBe(false); // anonymous
  });

  it("a non-admin cannot assign roles — privilege escalation is blocked", async () => {
    const r = await makeRuntime();
    const { token, userId } = (await r.run<{ token: string; userId: string }>("auth:signUp", { email: "mallory@b.co", password: "pw" })).value;
    // Mallory tries to self-promote to admin — must be rejected (she holds no manage permission).
    await expect(r.run("authz:assignRole", { userId, role: "admin" }, { identity: token })).rejects.toThrow(/Forbidden/);
    // An anonymous caller is likewise rejected, on both write paths.
    await expect(r.run("authz:assignRole", { userId, role: "editor" })).rejects.toThrow(/Forbidden/);
    await expect(r.run("authz:revokeRole", { userId, role: "editor" }, { identity: token })).rejects.toThrow(/Forbidden/);
    // No assignment leaked through: Mallory holds no role at all (not the admin she attempted).
    expect((await r.run<string[]>("me:roles", {}, { identity: token })).value).toEqual([]);
    expect((await r.run<boolean>("me:canEdit", {}, { identity: token })).value).toBe(false);
  });

  it("an explicit scope with an empty type or id is rejected (global-sentinel collision)", async () => {
    const r = await makeRuntime();
    const admin = await makeAdmin(r, "admin2@b.co");
    const { userId } = (await r.run<{ token: string; userId: string }>("auth:signUp", { email: "b@b.co", password: "pw" })).value;
    await expect(r.run("authz:assignRole", { userId, role: "editor", scope: { type: "org", id: "" } }, { identity: admin.token })).rejects.toThrow(/non-empty/);
    await expect(r.run("authz:assignRole", { userId, role: "editor", scope: { type: "", id: "x" } }, { identity: admin.token })).rejects.toThrow(/non-empty/);
  });
});
