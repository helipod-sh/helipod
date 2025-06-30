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
  // bootstrap: seed BOTH role_assignments AND effective_permissions atomically
  await r.run("authz:bootstrapFirstAdmin", { userId: admin.userId, role: "admin" });
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

describe("bootstrapFirstAdmin", () => {
  async function freshRuntime() {
    const c = composeComponents({ schemaJson: defineSchema({}).export(), moduleMap: {
      "me:can": query(async (ctx, { p }: { p: string }) => (ctx as unknown as { authz: { can(p: string): Promise<boolean> } }).authz.can(p)),
    } }, [auth, defineAuthz(cfg)]);
    const r = await EmbeddedRuntime.create({
      store: new SqliteDocStore(new NodeSqliteAdapter()), catalog: c.catalog, modules: c.moduleMap,
      systemModules: systemModules(), componentNames: c.componentNames, contextProviders: c.contextProviders,
      policyRegistry: c.policyRegistry, policyProviders: c.policyProviders, relationRegistry: c.relationRegistry,
    });
    return r;
  }

  it("seeds both tables atomically and can() sees the manage permission", async () => {
    const r = await freshRuntime();
    const alice = (await r.run<{ token: string; userId: string }>("auth:signUp", { email: "alice@b.co", password: "pw" })).value;
    await r.run("authz:bootstrapFirstAdmin", { userId: alice.userId, role: "admin" });
    expect((await r.run<boolean>("me:can", { p: "authz:manage" }, { identity: alice.token })).value).toBe(true);
  });

  it("self-disables: a second call throws 'already exists'", async () => {
    const r = await freshRuntime();
    const alice = (await r.run<{ token: string; userId: string }>("auth:signUp", { email: "alice@b.co", password: "pw" })).value;
    await r.run("authz:bootstrapFirstAdmin", { userId: alice.userId, role: "admin" });
    const bob = (await r.run<{ token: string; userId: string }>("auth:signUp", { email: "bob@b.co", password: "pw" })).value;
    await expect(r.run("authz:bootstrapFirstAdmin", { userId: bob.userId, role: "admin" })).rejects.toThrow(/already exists/);
  });

  it("rejects a role that does not grant authz:manage", async () => {
    const r = await freshRuntime();
    const alice = (await r.run<{ token: string; userId: string }>("auth:signUp", { email: "alice@b.co", password: "pw" })).value;
    await expect(r.run("authz:bootstrapFirstAdmin", { userId: alice.userId, role: "editor" })).rejects.toThrow(/does not grant/);
  });
});

// Seed a bootstrap admin (both tables) into a runtime `r`, returning the admin's token/userId.
async function seedAdmin(r: EmbeddedRuntime, email: string) {
  const a = (await r.run<{ token: string; userId: string }>("auth:signUp", { email, password: "pw" })).value;
  await r.run("authz:bootstrapFirstAdmin", { userId: a.userId, role: "admin" });
  return a;
}

describe("boot reconcile — config drift", () => {
  it("rebuilds the index at boot when the roles config changed", async () => {
    const store = new SqliteDocStore(new NodeSqliteAdapter());
    const build = async (buildConfig: Parameters<typeof defineAuthz>[0]) => {
      const c = composeComponents({ schemaJson: defineSchema({}).export(), moduleMap: {
        "me:can": query(async (ctx, { p }: { p: string }) => (ctx as unknown as { authz: { can(p: string): Promise<boolean> } }).authz.can(p)),
      } }, [auth, defineAuthz(buildConfig)]);
      return { c, r: await EmbeddedRuntime.create({ store, catalog: c.catalog, modules: c.moduleMap, systemModules: systemModules(),
        componentNames: c.componentNames, contextProviders: c.contextProviders, policyRegistry: c.policyRegistry,
        policyProviders: c.policyProviders, relationRegistry: c.relationRegistry, bootSteps: c.bootSteps }) };
    };
    const cfgOld = { roles: { editor: { documents: ["read"] }, admin: { authz: ["manage"] } } };
    const one = await build(cfgOld);
    const admin = await seedAdmin(one.r, "a@b.co");
    const bob = (await one.r.run<{ token: string; userId: string }>("auth:signUp", { email: "bob@b.co", password: "pw" })).value;
    await one.r.run("authz:assignRole", { userId: bob.userId, role: "editor" }, { identity: admin.token });
    expect((await one.r.run<boolean>("me:can", { p: "documents:delete" }, { identity: bob.token })).value).toBe(false);

    // redeploy: editor now also grants documents:delete → new config hash → boot rebuild over the SAME store
    const cfgNew = { roles: { editor: { documents: ["read", "delete"] }, admin: { authz: ["manage"] } } };
    const two = await build(cfgNew);
    expect((await two.r.run<boolean>("me:can", { p: "documents:delete" }, { identity: bob.token })).value).toBe(true);
  });
});

describe("surgical invalidation", () => {
  it("revoking a role re-runs only subscriptions checking an affected permission", async () => {
    const cfg2 = { roles: { ra: { a: ["read"] }, rb: { b: ["read"] }, admin: { authz: ["manage"] } } };
    const c = composeComponents({ schemaJson: defineSchema({}).export(), moduleMap: {
      "me:canA": query(async (ctx) => (ctx as unknown as { authz: { can(p: string): Promise<boolean> } }).authz.can("a:read")),
      "me:canB": query(async (ctx) => (ctx as unknown as { authz: { can(p: string): Promise<boolean> } }).authz.can("b:read")),
    } }, [auth, defineAuthz(cfg2)]);
    const r = await EmbeddedRuntime.create({ store: new SqliteDocStore(new NodeSqliteAdapter()), catalog: c.catalog, modules: c.moduleMap,
      systemModules: systemModules(), componentNames: c.componentNames, contextProviders: c.contextProviders,
      policyRegistry: c.policyRegistry, policyProviders: c.policyProviders, relationRegistry: c.relationRegistry, bootSteps: c.bootSteps });
    const admin = await seedAdmin(r, "a@b.co");
    const bob = (await r.run<{ token: string; userId: string }>("auth:signUp", { email: "bob@b.co", password: "pw" })).value;
    await r.run("authz:assignRole", { userId: bob.userId, role: "ra" }, { identity: admin.token });
    await r.run("authz:assignRole", { userId: bob.userId, role: "rb" }, { identity: admin.token });

    const sent: unknown[] = [];
    const sock = { sent, send: (x: string) => sent.push(JSON.parse(x)), bufferedAmount: 0, close: () => {} };
    r.handler.connect("s1", sock);
    await r.handler.handleMessage("s1", JSON.stringify({ type: "SetAuth", token: bob.token }));
    await r.handler.handleMessage("s1", JSON.stringify({ type: "ModifyQuerySet", add: [
      { queryId: 1, udfPath: "me:canA", args: {} }, { queryId: 2, udfPath: "me:canB", args: {} },
    ], remove: [] }));
    const updates = (qid: number) => sent.flatMap((m) => (m as { modifications?: unknown[] }).modifications ?? []).filter((x) => (x as { type: string; queryId: number }).type === "QueryUpdated" && (x as { type: string; queryId: number }).queryId === qid);
    expect((updates(1).at(-1) as { value: boolean } | undefined)?.value).toBe(true);
    expect((updates(2).at(-1) as { value: boolean } | undefined)?.value).toBe(true);
    const before2 = updates(2).length;

    await r.run("authz:revokeRole", { userId: bob.userId, role: "ra" }, { identity: admin.token });
    await new Promise((res) => setTimeout(res, 50));
    expect((updates(1).at(-1) as { value: boolean } | undefined)?.value).toBe(false);   // a:read revoked → its subscription re-runs, now false
    expect(updates(2).length).toBe(before2);        // b:read subscription did NOT re-run (its read keys don't intersect the deleted a:read row)
  });
});
