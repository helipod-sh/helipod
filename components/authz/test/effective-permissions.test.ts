import { describe, it, expect } from "vitest";
import { expandRolePatterns, candidateKeys, configHash } from "../src/effective-permissions";
import type { AuthzConfig } from "../src/roles";
import { SqliteDocStore, NodeSqliteAdapter } from "@stackbase/docstore-sqlite";
import { composeComponents } from "@stackbase/component";
import { EmbeddedRuntime } from "@stackbase/runtime-embedded";
import { defineSchema } from "@stackbase/values";
import { query, mutation, type RegisteredFunction } from "@stackbase/executor";
import { auth } from "@stackbase/auth";
import { defineAuthz } from "../src/define-authz";

const config: AuthzConfig = {
  roles: {
    viewer: { documents: ["read"] },
    editor: { inherits: "viewer", documents: ["update"] },
    admin: { documents: ["*"], authz: ["manage"] },
  },
};

describe("expandRolePatterns", () => {
  it("expands a role to its permission patterns (with inheritance)", () => {
    expect(expandRolePatterns(config, "editor").sort()).toEqual(["documents:read", "documents:update"]);
  });
  it("keeps wildcards as patterns", () => {
    expect(expandRolePatterns(config, "admin").sort()).toEqual(["authz:manage", "documents:*"]);
  });
});

describe("candidateKeys", () => {
  it("returns the <=4 keys that could match a permission", () => {
    expect(candidateKeys("documents:read")).toEqual(["documents:read", "documents:*", "*:read", "*:*"]);
  });
});

describe("configHash", () => {
  it("is stable across key ordering and differs when a grant changes", () => {
    const a = configHash({ roles: { r: { a: ["x"], b: ["y"] } } });
    const b = configHash({ roles: { r: { b: ["y"], a: ["x"] } } });
    expect(a).toBe(b);
    expect(a).not.toBe(configHash({ roles: { r: { a: ["x", "z"], b: ["y"] } } }));
  });
});

function systemModules(): Record<string, RegisteredFunction> {
  return { "_system:insertDocument": mutation(async (ctx, a: { table: string; fields: Record<string, unknown> }) =>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await ctx.db.insert(a.table, a.fields as any)) };
}
const cfg = { roles: { editor: { documents: ["read", "update"] }, viewer: { documents: ["read"] }, admin: { authz: ["manage"] }, superadmin: { "*": ["*"] } } };
const authz = defineAuthz(cfg);

async function runtimeWithAdmin() {
  const c = composeComponents({ schemaJson: defineSchema({}).export(), moduleMap: {
    "eff:list": query(async (ctx) => ctx.db.query("authz/effective_permissions", "by_creation").collect()),
    "me:can": query(async (ctx, { p }: { p: string }) => (ctx as unknown as { authz: { can(p: string): Promise<boolean> } }).authz.can(p)),
    "me:scopes": query(async (ctx, { p, t }: { p: string; t?: string }) => (ctx as unknown as { authz: { scopesWith(p: string, t?: string): Promise<string[]> } }).authz.scopesWith(p, t)),
  } }, [auth, authz]);
  const r = await EmbeddedRuntime.create({
    store: new SqliteDocStore(new NodeSqliteAdapter()), catalog: c.catalog, modules: c.moduleMap,
    systemModules: systemModules(), componentNames: c.componentNames, contextProviders: c.contextProviders,
    policyRegistry: c.policyRegistry, policyProviders: c.policyProviders, relationRegistry: c.relationRegistry,
  });
  const admin = (await r.run<{ token: string; userId: string }>("auth:signUp", { email: "a@b.co", password: "pw" })).value;
  // bootstrap: seed BOTH role_assignments AND effective_permissions for the admin's manage grant
  await r.runSystem("_system:insertDocument", { table: "authz/role_assignments", fields: { userId: admin.userId, role: "admin", scopeType: "", scopeId: "" } });
  await r.runSystem("_system:insertDocument", { table: "authz/effective_permissions", fields: { userId: admin.userId, scopeType: "", scopeId: "", permission: "authz:manage" } });
  return { r, admin };
}
const effFor = async (r: EmbeddedRuntime, userId: string) =>
  (await r.run<any[]>("eff:list", {})).value.filter((e) => e.userId === userId).map((e) => e.permission).sort();

describe("assign/revoke maintain effective_permissions", () => {
  it("assign materializes patterns; revoke reconciles; a shared pattern survives", async () => {
    const { r, admin } = await runtimeWithAdmin();
    const bob = (await r.run<{ userId: string }>("auth:signUp", { email: "bob@b.co", password: "pw" })).value;
    await r.run("authz:assignRole", { userId: bob.userId, role: "editor" }, { identity: admin.token });
    expect(await effFor(r, bob.userId)).toEqual(["documents:read", "documents:update"]);
    await r.run("authz:assignRole", { userId: bob.userId, role: "viewer" }, { identity: admin.token });
    await r.run("authz:revokeRole", { userId: bob.userId, role: "editor" }, { identity: admin.token });
    // viewer still grants documents:read → it survives; documents:update is gone
    expect(await effFor(r, bob.userId)).toEqual(["documents:read"]);
  });
});

describe("can()/scopesWith read the index", () => {
  it("exact + wildcard grants answer via the index; anonymous denied", async () => {
    const { r, admin } = await runtimeWithAdmin();
    const carol = (await r.run<{ token: string; userId: string }>("auth:signUp", { email: "carol@b.co", password: "pw" })).value;
    await r.run("authz:assignRole", { userId: carol.userId, role: "editor" }, { identity: admin.token });
    expect((await r.run<boolean>("me:can", { p: "documents:read" }, { identity: carol.token })).value).toBe(true);
    expect((await r.run<boolean>("me:can", { p: "billing:view" }, { identity: carol.token })).value).toBe(false);
    expect((await r.run<boolean>("me:can", { p: "documents:read" })).value).toBe(false); // anonymous
    await r.run("authz:assignRole", { userId: carol.userId, role: "superadmin" }, { identity: admin.token });
    expect((await r.run<boolean>("me:can", { p: "anything:goes" }, { identity: carol.token })).value).toBe(true); // *:*
  });

  it("scopesWith returns the scope ids where a permission is held", async () => {
    const { r, admin } = await runtimeWithAdmin();
    const dave = (await r.run<{ token: string; userId: string }>("auth:signUp", { email: "dave@b.co", password: "pw" })).value;
    await r.run("authz:assignRole", { userId: dave.userId, role: "editor", scope: { type: "org", id: "o1" } }, { identity: admin.token });
    await r.run("authz:assignRole", { userId: dave.userId, role: "editor", scope: { type: "org", id: "o2" } }, { identity: admin.token });
    expect((await r.run<string[]>("me:scopes", { p: "documents:read", t: "org" }, { identity: dave.token })).value.sort()).toEqual(["o1", "o2"]);
  });
});
