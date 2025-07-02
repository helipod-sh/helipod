import { describe, it, expect } from "vitest";
import { SqliteDocStore, NodeSqliteAdapter } from "@stackbase/docstore-sqlite";
import { composeComponents } from "@stackbase/component";
import { EmbeddedRuntime } from "@stackbase/runtime-embedded";
import { defineSchema, defineTable, v } from "@stackbase/values";
import { query, mutation, type RegisteredFunction } from "@stackbase/executor";
import { auth } from "@stackbase/auth";
import { defineAuthz } from "../src/define-authz";

function systemModules(): Record<string, RegisteredFunction> {
  return {
    "_system:insertDocument": mutation(async (ctx, a: { table: string; fields: Record<string, unknown> }) =>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await ctx.db.insert(a.table, a.fields as any)
    ),
    "_system:deleteDocument": mutation(async (ctx, a: { id: string }) => {
      await ctx.db.delete(a.id);
      return null;
    }),
  };
}
const authz = defineAuthz({ roles: { admin: { "*": ["*"] } } });

async function makeRuntime() {
  const c = composeComponents({ schemaJson: defineSchema({}).export(), moduleMap: {
    "me:objectsWith": query(async (ctx, { rel, type }: { rel: string; type: string }) =>
      (ctx as unknown as { authz: { objectsWith(r: string, t: string): Promise<string[]> } }).authz.objectsWith(rel, type)),
    "check:has": query(async (ctx, a: { subject: any; relation: string; object: any }) =>
      (ctx as unknown as { authz: { hasRelation(s: any, r: string, o: any): Promise<boolean> } }).authz.hasRelation(a.subject, a.relation, a.object)),
  } }, [auth, authz]);
  return EmbeddedRuntime.create({ store: new SqliteDocStore(new NodeSqliteAdapter()), catalog: c.catalog, modules: c.moduleMap,
    systemModules: systemModules(), componentNames: c.componentNames, contextProviders: c.contextProviders,
    policyRegistry: c.policyRegistry, policyProviders: c.policyProviders, relationRegistry: c.relationRegistry, bootSteps: c.bootSteps });
}
const seedRel = (r: EmbeddedRuntime, f: Record<string, string>) =>
  r.runSystem("_system:insertDocument", { table: "authz/relations", fields: { subjectRelation: "", ...f } });

describe("relations reads + single-level usersets", () => {
  it("objectsWith and hasRelation resolve direct + userset; removal drops them", async () => {
    const r = await makeRuntime();
    const alice = (await r.run<{ token: string; userId: string }>("auth:signUp", { email: "alice@b.co", password: "pw" })).value;
    // alice is a direct viewer of document 2
    await seedRel(r, { objectType: "document", objectId: "2", relation: "viewer", subjectType: "user", subjectId: alice.userId });
    // team eng#member is a viewer of document 1; alice is a member of team eng
    await seedRel(r, { objectType: "document", objectId: "1", relation: "viewer", subjectType: "team", subjectId: "eng", subjectRelation: "member" });
    const membershipId = (await r.runSystem<string>("_system:insertDocument", { table: "authz/relations", fields: { subjectRelation: "", objectType: "team", objectId: "eng", relation: "member", subjectType: "user", subjectId: alice.userId } })).value;

    // objectsWith (as alice) → doc 1 (via team) + doc 2 (direct)
    expect((await r.run<string[]>("me:objectsWith", { rel: "viewer", type: "document" }, { identity: alice.token })).value.sort()).toEqual(["1", "2"]);
    // hasRelation: alice is a viewer of doc 1 via the userset
    expect((await r.run<boolean>("check:has", { subject: { type: "user", id: alice.userId }, relation: "viewer", object: { type: "document", id: "1" } })).value).toBe(true);
    // a different user (bob) is not
    expect((await r.run<boolean>("check:has", { subject: { type: "user", id: "bob" }, relation: "viewer", object: { type: "document", id: "1" } })).value).toBe(false);

    // remove alice from team eng → she loses doc 1 (keeps direct doc 2)
    await r.runSystem("_system:deleteDocument", { id: membershipId });
    expect((await r.run<string[]>("me:objectsWith", { rel: "viewer", type: "document" }, { identity: alice.token })).value).toEqual(["2"]);
    // anonymous → []
    expect((await r.run<string[]>("me:objectsWith", { rel: "viewer", type: "document" })).value).toEqual([]);
  });
});

describe("addRelation/removeRelation (gated) + reactive sharing", () => {
  it("share gate: only a caller with <type>:share on the object may add/remove", async () => {
    const r = await makeRuntime();
    const admin = (await r.run<{ token: string; userId: string }>("auth:signUp", { email: "admin@b.co", password: "pw" })).value;
    // bootstrap admin with the superadmin role "admin" ({"*":["*"]}) → holds document:share (via *:*)
    await r.run("authz:bootstrapFirstAdmin", { userId: admin.userId, role: "admin" });
    const mallory = (await r.run<{ token: string; userId: string }>("auth:signUp", { email: "m@b.co", password: "pw" })).value;

    // mallory has no document:share → rejected
    await expect(r.run("authz:addRelation", { subject: { type: "user", id: "x" }, relation: "viewer", object: { type: "document", id: "9" } }, { identity: mallory.token })).rejects.toThrow(/Forbidden/);
    // admin can share
    await expect(r.run("authz:addRelation", { subject: { type: "user", id: "x" }, relation: "viewer", object: { type: "document", id: "9" } }, { identity: admin.token })).resolves.toBeDefined();
    expect((await r.run<boolean>("check:has", { subject: { type: "user", id: "x" }, relation: "viewer", object: { type: "document", id: "9" } })).value).toBe(true);
    await r.run("authz:removeRelation", { subject: { type: "user", id: "x" }, relation: "viewer", object: { type: "document", id: "9" } }, { identity: admin.token });
    expect((await r.run<boolean>("check:has", { subject: { type: "user", id: "x" }, relation: "viewer", object: { type: "document", id: "9" } })).value).toBe(false);
  });

  it("REACTIVE headline: adding a caller to a viewer-team live-reveals the shared doc (zero per-doc writes)", async () => {
    // A `documents` read policy filtered by the caller's objectsWith("viewer","document").
    // `read` may be async and return a WhereInput; `RuleAuth.objectsWith` is added in Step 3.
    const appSchema = defineSchema({ documents: defineTable({ title: v.string() }) });
    const c = composeComponents({ schemaJson: appSchema.export(), moduleMap: {
      "docs:list": query(async (ctx) => ctx.db.query("documents", "by_creation").collect()),
    } }, [auth, defineAuthz({ roles: { admin: { "*": ["*"] } }, policies: {
      documents: { read: async ({ auth }) => ({ _id: { in: await auth.objectsWith("viewer", "document") } }) },
    } })]);
    const r = await EmbeddedRuntime.create({ store: new SqliteDocStore(new NodeSqliteAdapter()), catalog: c.catalog, modules: c.moduleMap,
      systemModules: systemModules(), componentNames: c.componentNames, contextProviders: c.contextProviders, policyRegistry: c.policyRegistry,
      policyProviders: c.policyProviders, relationRegistry: c.relationRegistry, bootSteps: c.bootSteps });
    const admin = (await r.run<{ token: string; userId: string }>("auth:signUp", { email: "admin@b.co", password: "pw" })).value;
    await r.run("authz:bootstrapFirstAdmin", { userId: admin.userId, role: "admin" });
    const alice = (await r.run<{ token: string; userId: string }>("auth:signUp", { email: "alice@b.co", password: "pw" })).value;
    const doc1 = (await r.runSystem<string>("_system:insertDocument", { table: "documents", fields: { title: "spec" } })).value;
    await r.run("authz:addRelation", { subject: { type: "team", id: "eng", relation: "member" }, relation: "viewer", object: { type: "document", id: doc1 } }, { identity: admin.token });

    const sent: any[] = [];
    const sock = { sent, send: (x: string) => sent.push(JSON.parse(x)), bufferedAmount: 0, close: () => {} };
    const last = (): unknown => {
      for (let i = sent.length - 1; i >= 0; i--)
        for (const m of [...(sent[i]?.modifications ?? [])].reverse())
          if (m.type === "QueryUpdated" && m.queryId === 1) return m.value;
      return undefined;
    };
    r.handler.connect("s1", sock);
    await r.handler.handleMessage("s1", JSON.stringify({ type: "SetAuth", token: alice.token }));
    await r.handler.handleMessage("s1", JSON.stringify({ type: "ModifyQuerySet", add: [{ queryId: 1, udfPath: "docs:list", args: {} }], remove: [] }));
    expect(last()).toEqual([]); // alice not on the team yet

    await r.run("authz:addRelation", { subject: { type: "user", id: alice.userId }, relation: "member", object: { type: "team", id: "eng" } }, { identity: admin.token });
    await new Promise((res) => setTimeout(res, 50));
    expect((last() as any[]).map((d) => d.title)).toEqual(["spec"]); // joined team → doc appears live

    await r.run("authz:removeRelation", { subject: { type: "user", id: alice.userId }, relation: "member", object: { type: "team", id: "eng" } }, { identity: admin.token });
    await new Promise((res) => setTimeout(res, 50));
    expect(last()).toEqual([]); // left team → doc hidden live
  });
});
