import { describe, it, expect } from "vitest";
import { SqliteDocStore, NodeSqliteAdapter } from "@stackbase/docstore-sqlite";
import { composeComponents } from "@stackbase/component";
import { EmbeddedRuntime } from "@stackbase/runtime-embedded";
import { defineSchema, defineTable, v } from "@stackbase/values";
import { query, mutation, type RegisteredFunction } from "@stackbase/executor";
import { auth } from "@stackbase/auth";
import { defineAuthz } from "../src/define-authz";

function systemModules(): Record<string, RegisteredFunction> {
  return { "_system:insertDocument": mutation(async (ctx, a: { table: string; fields: Record<string, unknown> }) =>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await ctx.db.insert(a.table, a.fields as any)) };
}

// documents are readable/writable only by a caller holding documents:read / documents:update.
const authz = defineAuthz({
  roles: { editor: { documents: ["read", "update"] }, admin: { authz: ["manage"] } },
  policies: {
    documents: {
      read: ({ auth }) => auth.can("documents:read"),         // true when the role grants it, else deny
      write: ({ auth }) => auth.can("documents:update"),
    },
  },
});

const appSchema = defineSchema({ documents: defineTable({ title: v.string() }) });

async function makeRuntime() {
  const { catalog, moduleMap, componentNames, contextProviders, policyRegistry, policyProviders } =
    composeComponents({ schemaJson: appSchema.export(), moduleMap: {
      "docs:list": query(async (ctx) => ctx.db.query("documents", "by_creation").collect()),
    } }, [auth, authz]);
  return EmbeddedRuntime.create({
    store: new SqliteDocStore(new NodeSqliteAdapter()),
    catalog, modules: moduleMap, systemModules: systemModules(), componentNames, contextProviders, policyRegistry, policyProviders,
  });
}

async function makeAdmin(r: EmbeddedRuntime, email: string) {
  const who = (await r.run<{ token: string; userId: string }>("auth:signUp", { email, password: "pw" })).value;
  await r.runSystem("_system:insertDocument", { table: "authz/role_assignments", fields: { userId: who.userId, role: "admin", scopeType: "", scopeId: "" } });
  await r.runSystem("_system:insertDocument", { table: "authz/effective_permissions", fields: { userId: who.userId, scopeType: "", scopeId: "", permission: "authz:manage" } });
  return who;
}

describe("authz row policies", () => {
  it("read policy filters by permission; write policy gates inserts", async () => {
    const r = await makeRuntime();
    const admin = await makeAdmin(r, "admin@b.co");
    await r.runSystem("_system:insertDocument", { table: "documents", fields: { title: "seeded" } });
    const { token, userId } = (await r.run<{ token: string; userId: string }>("auth:signUp", { email: "e@b.co", password: "pw" })).value;

    // No role → read policy denies → zero rows; write denied.
    expect((await r.run<any[]>("docs:list", {}, { identity: token })).value).toEqual([]);

    await r.run("authz:assignRole", { userId, role: "editor" }, { identity: admin.token });

    // Now editor → documents:read → sees the seeded doc.
    expect((await r.run<any[]>("docs:list", {}, { identity: token })).value.length).toBe(1);
  });

  it("REACTIVE: a subscribed docs:list re-runs and empties when the role is revoked", async () => {
    const r = await makeRuntime();
    const admin = await makeAdmin(r, "admin2@b.co");
    await r.runSystem("_system:insertDocument", { table: "documents", fields: { title: "d1" } });
    const { token, userId } = (await r.run<{ token: string; userId: string }>("auth:signUp", { email: "bob@b.co", password: "pw" })).value;
    await r.run("authz:assignRole", { userId, role: "editor" }, { identity: admin.token });

    const sent: any[] = [];
    const sock = { sent, send: (d: string) => sent.push(JSON.parse(d)), bufferedAmount: 0, close: () => {} };
    const last = (): unknown => {
      for (let i = sent.length - 1; i >= 0; i--)
        for (const m of [...(sent[i]?.modifications ?? [])].reverse())
          if (m.type === "QueryUpdated" && m.queryId === 1) return m.value;
      return undefined;
    };
    r.handler.connect("s1", sock);
    await r.handler.handleMessage("s1", JSON.stringify({ type: "SetAuth", token }));
    await r.handler.handleMessage("s1", JSON.stringify({ type: "ModifyQuerySet", add: [{ queryId: 1, udfPath: "docs:list", args: {} }], remove: [] }));
    expect((last() as any[]).length).toBe(1);                 // editor sees the doc

    await r.run("authz:revokeRole", { userId, role: "editor" }, { identity: admin.token });
    await new Promise((res) => setTimeout(res, 50));
    expect(last()).toEqual([]);                               // revoke → read policy denies → live empties
  });
});
