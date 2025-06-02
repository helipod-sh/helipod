// packages/runtime-embedded/test/auth-reactive.test.ts
import { describe, it, expect } from "vitest";
import { SqliteDocStore, NodeSqliteAdapter } from "@stackbase/docstore-sqlite";
import { composeComponents } from "@stackbase/component";
import { defineSchema } from "@stackbase/values";
import { query } from "@stackbase/executor";
import type { SyncWebSocket } from "@stackbase/sync";
import { auth } from "@stackbase/auth";
import { EmbeddedRuntime } from "../src/index";

function mockSocket(): SyncWebSocket & { sent: any[] } {
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

describe("authenticated reactive query re-runs on signOut", () => {
  it("a protected subscription empties when the user signs out", async () => {
    const appModules = { "me:get": query(async (ctx) => (ctx as unknown as { auth: { getUserId(): Promise<string | null> } }).auth.getUserId()) };
    const { catalog, moduleMap, componentNames, contextProviders } = composeComponents(
      { schemaJson: defineSchema({}).export(), moduleMap: appModules }, [auth]);
    const r = await EmbeddedRuntime.create({ store: new SqliteDocStore(new NodeSqliteAdapter()), catalog, modules: moduleMap, componentNames, contextProviders });

    const { token, userId } = (await r.run<{ token: string; userId: string }>("auth:signUp", { email: "a@b.co", password: "pw" })).value;

    const sock = mockSocket();
    r.handler.connect("s1", sock);
    await r.handler.handleMessage("s1", JSON.stringify({ type: "SetAuth", token }));
    await r.handler.handleMessage("s1", JSON.stringify({ type: "ModifyQuerySet", add: [{ queryId: 1, udfPath: "me:get", args: {} }], remove: [] }));
    expect(lastQueryValue(sock, 1)).toBe(userId); // authenticated: sees self

    await r.run("auth:signOut", { token }); // commit deletes auth/sessions → fan-out → re-run sub
    // allow the async notify drain to flush
    await new Promise((res) => setTimeout(res, 10));
    expect(lastQueryValue(sock, 1)).toBeNull(); // session gone → getUserId() null → query empty
  });
});
