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

// A document is readable if it is shared with the caller (a document_shares row names them).
const authz = defineAuthz({
  policies: { documents: { read: ({ auth }) => ({ sharedWith: { some: { userId: auth.userId } } }) } },
});

const appSchema = defineSchema({
  documents: defineTable({ title: v.string() }).relation("sharedWith", { table: "document_shares", field: "documentId" }),
  document_shares: defineTable({ documentId: v.id("documents"), userId: v.string() }),
});

async function makeRuntime() {
  const composed = composeComponents({ schemaJson: appSchema.export(), moduleMap: {
    "docs:list": query(async (ctx) => ctx.db.query("documents", "by_creation").collect()),
  } }, [auth, authz]);
  return EmbeddedRuntime.create({
    store: new SqliteDocStore(new NodeSqliteAdapter()),
    catalog: composed.catalog, modules: composed.moduleMap, systemModules: systemModules(),
    componentNames: composed.componentNames, contextProviders: composed.contextProviders,
    policyRegistry: composed.policyRegistry, policyProviders: composed.policyProviders,
    relationRegistry: composed.relationRegistry,
  });
}

describe("authz relation policy (sharing)", () => {
  it("only shared documents are visible", async () => {
    const r = await makeRuntime();
    const { token, userId } = (await r.run<{ token: string; userId: string }>("auth:signUp", { email: "u@b.co", password: "pw" })).value;
    const d1 = (await r.runSystem<string>("_system:insertDocument", { table: "documents", fields: { title: "shared" } })).value;
    await r.runSystem("_system:insertDocument", { table: "documents", fields: { title: "secret" } });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((await r.run<any[]>("docs:list", {}, { identity: token })).value).toEqual([]); // nothing shared yet
    await r.runSystem("_system:insertDocument", { table: "document_shares", fields: { documentId: d1, userId } });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const seen = (await r.run<any[]>("docs:list", {}, { identity: token })).value;
    expect(seen.map((d) => d.title)).toEqual(["shared"]);
  });

  it("REACTIVE: sharing/unsharing live-updates a subscribed docs:list", async () => {
    const r = await makeRuntime();
    const { token, userId } = (await r.run<{ token: string; userId: string }>("auth:signUp", { email: "bob@b.co", password: "pw" })).value;
    const d1 = (await r.runSystem<string>("_system:insertDocument", { table: "documents", fields: { title: "d1" } })).value;

    const sent: unknown[] = [];
    const sock = { sent, send: (x: string) => sent.push(JSON.parse(x) as unknown), bufferedAmount: 0, close: () => {} };
    const last = (): unknown => {
      for (let i = sent.length - 1; i >= 0; i--) {
        const msg = sent[i] as Record<string, unknown> | undefined;
        const mods = (msg?.modifications ?? []) as Array<Record<string, unknown>>;
        for (let j = mods.length - 1; j >= 0; j--) {
          const m = mods[j];
          if (m?.type === "QueryUpdated" && m.queryId === 1) return m.value;
        }
      }
      return undefined;
    };
    r.handler.connect("s1", sock);
    await r.handler.handleMessage("s1", JSON.stringify({ type: "SetAuth", token }));
    await r.handler.handleMessage("s1", JSON.stringify({ type: "ModifyQuerySet", add: [{ queryId: 1, udfPath: "docs:list", args: {} }], remove: [] }));
    expect(last()).toEqual([]);                                              // unshared → empty

    const shareId = (await r.runSystem<string>("_system:insertDocument", { table: "document_shares", fields: { documentId: d1, userId } })).value;
    await new Promise((res) => setTimeout(res, 50));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((last() as any[]).length).toBe(1);                               // share → appears live

    await r.runSystem("_system:deleteDocument", { id: shareId });
    await new Promise((res) => setTimeout(res, 50));
    expect(last()).toEqual([]);                                             // unshare → disappears live
  });
});

describe("authz multi-level relation policy (team sharing)", () => {
  // documents --sharedWith--> document_shares --team(v.id)--> teams --members--> team_members
  const authzTeam = defineAuthz({
    policies: { documents: { read: ({ auth }) => ({
      sharedWith: { some: { team: { is: { members: { some: { userId: auth.userId } } } } } },
    }) } },
  });
  const schema = defineSchema({
    documents: defineTable({ title: v.string() }).relation("sharedWith", { table: "document_shares", field: "documentId" }),
    document_shares: defineTable({ documentId: v.id("documents"), team: v.id("teams") }),
    teams: defineTable({ name: v.string() }).relation("members", { table: "team_members", field: "teamId" }),
    team_members: defineTable({ teamId: v.id("teams"), userId: v.string() }),
  });
  async function makeRuntime() {
    const c = composeComponents({ schemaJson: schema.export(), moduleMap: {
      "docs:list": query(async (ctx) => ctx.db.query("documents", "by_creation").collect()),
    } }, [auth, authzTeam]);
    return EmbeddedRuntime.create({
      store: new SqliteDocStore(new NodeSqliteAdapter()),
      catalog: c.catalog, modules: c.moduleMap, systemModules: systemModules(),
      componentNames: c.componentNames, contextProviders: c.contextProviders,
      policyRegistry: c.policyRegistry, policyProviders: c.policyProviders, relationRegistry: c.relationRegistry,
    });
  }

  it("a doc shared with a team the caller belongs to is visible; reactively on membership change", async () => {
    const r = await makeRuntime();
    const { token, userId } = (await r.run<{ token: string; userId: string }>("auth:signUp", { email: "u@b.co", password: "pw" })).value;
    const team = (await r.runSystem<string>("_system:insertDocument", { table: "teams", fields: { name: "eng" } })).value;
    const doc = (await r.runSystem<string>("_system:insertDocument", { table: "documents", fields: { title: "spec" } })).value;
    await r.runSystem("_system:insertDocument", { table: "document_shares", fields: { documentId: doc, team } });

    // Not a member yet → not visible.
    expect((await r.run<any[]>("docs:list", {}, { identity: token })).value).toEqual([]);

    // Subscribe, then add the caller to the team → the doc appears live (inner-relation reactivity).
    const sent: any[] = [];
    const sock = { sent, send: (x: string) => sent.push(JSON.parse(x)), bufferedAmount: 0, close: () => {} };
    const last = (): unknown => {
      for (let i = sent.length - 1; i >= 0; i--)
        for (const m of [...(sent[i]?.modifications ?? [])].reverse())
          if (m.type === "QueryUpdated" && m.queryId === 1) return m.value;
      return undefined;
    };
    r.handler.connect("s1", sock);
    await r.handler.handleMessage("s1", JSON.stringify({ type: "SetAuth", token }));
    await r.handler.handleMessage("s1", JSON.stringify({ type: "ModifyQuerySet", add: [{ queryId: 1, udfPath: "docs:list", args: {} }], remove: [] }));
    expect(last()).toEqual([]);

    const membership = (await r.runSystem<string>("_system:insertDocument", { table: "team_members", fields: { teamId: team, userId } })).value;
    await new Promise((res) => setTimeout(res, 50));
    expect((last() as any[]).map((d) => d.title)).toEqual(["spec"]);   // joined team → doc revealed live

    await r.runSystem("_system:deleteDocument", { id: membership });
    await new Promise((res) => setTimeout(res, 50));
    expect(last()).toEqual([]);                                        // left team → doc hidden live
  });
});
