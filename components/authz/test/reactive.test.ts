// components/authz/test/reactive.test.ts
import { describe, it, expect } from "vitest";
import { SqliteDocStore, NodeSqliteAdapter } from "@stackbase/docstore-sqlite";
import { composeComponents } from "@stackbase/component";
import { EmbeddedRuntime } from "@stackbase/runtime-embedded";
import { defineSchema } from "@stackbase/values";
import { query, mutation, type RegisteredFunction } from "@stackbase/executor";
import { auth } from "@stackbase/auth";
import { defineAuthz } from "../src/define-authz";

// Privileged bootstrap built-in — seeds the first admin directly (bypasses the namespace boundary).
function systemModules(): Record<string, RegisteredFunction> {
  return {
    "_system:insertDocument": mutation(async (ctx, args: { table: string; fields: Record<string, unknown> }) =>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await ctx.db.insert(args.table, args.fields as any)
    ),
  };
}

function mockSocket(): { send(d: string): void; bufferedAmount: number; close(): void; sent: any[] } {
  const sent: any[] = [];
  return { sent, send: (d: string) => sent.push(JSON.parse(d)), bufferedAmount: 0, close: () => {} };
}

const lastQueryValue = (sock: { sent: any[] }, queryId: number): unknown => {
  for (let i = sock.sent.length - 1; i >= 0; i--) {
    const mods = sock.sent[i]?.modifications ?? [];
    const m = [...mods].reverse().find((x: any) => x.type === "QueryUpdated" && x.queryId === queryId);
    if (m) return m.value;
  }
  return undefined;
};

const authz = defineAuthz({ roles: { editor: { documents: ["update"] }, admin: { authz: ["manage"] } } });

describe("authz reactivity", () => {
  it("a subscribed can()-query re-runs when a role is assigned and revoked", async () => {
    const app = {
      "me:canEdit": query(async (ctx) =>
        (ctx as unknown as { authz: { can(p: string): Promise<boolean> } }).authz.can("documents:update")
      ),
    };
    const { catalog, moduleMap, componentNames, contextProviders } = composeComponents(
      { schemaJson: defineSchema({}).export(), moduleMap: app },
      [auth, authz]
    );
    const r = await EmbeddedRuntime.create({
      store: new SqliteDocStore(new NodeSqliteAdapter()),
      catalog,
      modules: moduleMap,
      systemModules: systemModules(),
      componentNames,
      contextProviders,
    });

    // Bootstrap a global admin (the only party permitted to assign roles), then the ordinary user.
    const admin = (await r.run<{ token: string; userId: string }>("auth:signUp", { email: "admin@b.co", password: "pw" })).value;
    await r.run("authz:bootstrapFirstAdmin", { userId: admin.userId, role: "admin" });
    const { token, userId } = (await r.run<{ token: string; userId: string }>("auth:signUp", { email: "a@b.co", password: "pw" })).value;

    const sock = mockSocket();
    r.handler.connect("s1", sock);
    await r.handler.handleMessage("s1", JSON.stringify({ type: "SetAuth", token }));
    await r.handler.handleMessage("s1", JSON.stringify({
      type: "ModifyQuerySet",
      add: [{ queryId: 1, udfPath: "me:canEdit", args: {} }],
      remove: [],
    }));
    expect(lastQueryValue(sock, 1)).toBe(false); // no role assigned yet

    await r.run("authz:assignRole", { userId, role: "editor" }, { identity: admin.token }); // grant → subscription re-runs
    await new Promise((res) => setTimeout(res, 50));
    expect(lastQueryValue(sock, 1)).toBe(true);

    await r.run("authz:revokeRole", { userId, role: "editor" }, { identity: admin.token }); // revoke → subscription re-runs (headline)
    await new Promise((res) => setTimeout(res, 50));
    expect(lastQueryValue(sock, 1)).toBe(false);
  });
});
