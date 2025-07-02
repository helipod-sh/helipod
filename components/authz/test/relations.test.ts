import { describe, it, expect } from "vitest";
import { SqliteDocStore, NodeSqliteAdapter } from "@stackbase/docstore-sqlite";
import { composeComponents } from "@stackbase/component";
import { EmbeddedRuntime } from "@stackbase/runtime-embedded";
import { defineSchema } from "@stackbase/values";
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
