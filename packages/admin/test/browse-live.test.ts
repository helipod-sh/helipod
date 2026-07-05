import { describe, it, expect } from "vitest";
import { SqliteDocStore, NodeSqliteAdapter } from "@helipod/docstore-sqlite";
import { composeComponents } from "@helipod/component";
import { EmbeddedRuntime } from "@helipod/runtime-embedded";
import { defineSchema, defineTable, v } from "@helipod/values";
import { mutation, query, type RegisteredFunction } from "@helipod/executor";
import { browseTableModule } from "../src/browse";

function systemModules(): Record<string, RegisteredFunction> {
  return { "_system:insertDocument": mutation(async (ctx, a: { table: string; fields: Record<string, unknown> }) =>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await ctx.db.insert(a.table, a.fields as any)) };
}

async function makeRuntime() {
  const schema = defineSchema({ notes: defineTable({ body: v.string() }) });
  const c = composeComponents({ schemaJson: schema.export(), moduleMap: {
    "notes:add": mutation(async (ctx, { body }: { body: string }) => ctx.db.insert("notes", { body })),
  } }, []);
  return EmbeddedRuntime.create({
    store: new SqliteDocStore(new NodeSqliteAdapter()), catalog: c.catalog, modules: c.moduleMap,
    systemModules: systemModules(), componentNames: c.componentNames, contextProviders: c.contextProviders,
    policyRegistry: c.policyRegistry, policyProviders: c.policyProviders, relationRegistry: c.relationRegistry, bootSteps: c.bootSteps,
    adminModules: { "_admin:browseTable": browseTableModule }, verifyAdmin: (k) => k === "SECRET",
  });
}

describe("admin live browse", () => {
  it("admin subscription to _admin:browseTable is live; non-admin is rejected", async () => {
    const r = await makeRuntime();
    await r.run("notes:add", { body: "one" });
    const sent: any[] = [];
    const sock = { sent, send: (x: string) => sent.push(JSON.parse(x)), bufferedAmount: 0, close: () => {} };
    const last = (): any => { for (let i = sent.length - 1; i >= 0; i--) for (const m of [...(sent[i]?.modifications ?? [])].reverse()) if (m.queryId === 1) return m; return undefined; };
    r.handler.connect("s1", sock);

    // no admin auth → rejected
    await r.handler.handleMessage("s1", JSON.stringify({ type: "ModifyQuerySet", add: [{ queryId: 1, udfPath: "_admin:browseTable", args: { table: "notes" } }], remove: [] }));
    expect(last().type).toBe("QueryFailed");

    // admin auth → live page
    await r.handler.handleMessage("s1", JSON.stringify({ type: "SetAdminAuth", key: "SECRET" }));
    await r.handler.handleMessage("s1", JSON.stringify({ type: "ModifyQuerySet", add: [{ queryId: 1, udfPath: "_admin:browseTable", args: { table: "notes" } }], remove: [] }));
    expect(last().value.documents.map((d: any) => d.body)).toEqual(["one"]);

    // a write to the table live-updates the subscription
    await r.run("notes:add", { body: "two" });
    await new Promise((res) => setTimeout(res, 50));
    expect(last().value.documents.map((d: any) => d.body).sort()).toEqual(["one", "two"]);
  });

  it("getTableData delegates to runAdmin (cursor + filter parity)", async () => {
    const r = await makeRuntime();
    await r.run("notes:add", { body: "a" });
    const page = await r.runAdmin("_admin:browseTable", { table: "notes" });
    expect((page.value as any).documents.map((d: any) => d.body)).toEqual(["a"]);
  });
});
