/**
 * Notifications N3 — E2E through the real dev server: a preference opt-out suppresses a category's
 * channel reactively, a critical category bypasses it, and sendToTopic honors each subscriber's prefs.
 */
import { describe, it, expect, afterAll } from "vitest";
import { v, defineSchema, defineTable } from "@helipod/values";
import { mutation, action } from "@helipod/executor";
import { SqliteDocStore, NodeSqliteAdapter } from "@helipod/docstore-sqlite";
import { createEmbeddedRuntime, type EmbeddedRuntime } from "@helipod/runtime-embedded";
import { HelipodClient, webSocketTransport, anyApi } from "@helipod/client";
import { defineNotifications } from "@helipod/notifications";
import { loadProject, startDevServer, type DevServer } from "../src/index";

async function waitFor(cond: () => boolean, ms = 5000, label = "waitFor"): Promise<void> {
  const start = Date.now();
  while (!cond()) { if (Date.now() - start > ms) throw new Error(`${label} timed out`); await new Promise<void>((r) => setTimeout(r, 10)); }
}
const appSchema = defineSchema({ pings: defineTable({ by: v.string() }).index("by_by", ["by"]) });
const appModules = {
  n: {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    send: mutation(async (ctx: any, a: any) => ctx.notifications.send(a)),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    topicSend: action(async (ctx: any, a: any) => ctx.notifications.sendToTopic(a)),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    sub: mutation(async (ctx: any, a: any) => ctx.notifications.subscribe(a)),
  },
};
const api = anyApi as {
  n: { send: { __path: string }; topicSend: { __path: string }; sub: { __path: string } };
  notifications: { inbox: { __path: string }; unreadCount: { __path: string }; getPreferences: { __path: string }; setPreference: { __path: string } };
};
const servers: DevServer[] = [];
afterAll(async () => { for (const s of servers) await s.close(); });

describe("notifications N3 — preferences + topics E2E", () => {
  it("opt-out suppresses a category channel reactively; critical bypasses; topic fan-out honors prefs", async () => {
    const project = loadProject({ schema: appSchema, modules: appModules }, [
      defineNotifications({ channels: { in_app: { enabled: true, templates: { hi: () => ({ title: "Hi", body: "hello" }) } } }, categories: { security: { critical: true } } }),
    ]);
    const runtime: EmbeddedRuntime = await createEmbeddedRuntime({
      store: new SqliteDocStore(new NodeSqliteAdapter()), catalog: project.catalog, modules: project.moduleMap,
      tableNumbers: project.tableNumbers, componentNames: project.componentNames, contextProviders: project.contextProviders,
      bootSteps: project.bootSteps, drivers: project.drivers,
    });
    const server = await startDevServer(runtime, { port: 0, ip: "127.0.0.1" }); servers.push(server);
    const c = new HelipodClient(webSocketTransport(`ws://127.0.0.1:${server.port}/api/sync`, { reconnect: false }));
    try {
      c.setAuth("user-1");
      const inbox: Array<Array<{ body: string }>> = [];
      const prefs: Array<Array<{ category: string }>> = [];
      c.subscribe(api.notifications.inbox, {}, (x) => inbox.push(x as never));
      c.subscribe(api.notifications.getPreferences, {}, (x) => prefs.push(x as never));
      await waitFor(() => inbox.length >= 1 && prefs.length >= 1, 5000, "initial");

      // Opt out of marketing in_app; the live getPreferences subscription reflects it.
      await c.mutation(api.notifications.setPreference, { category: "marketing", channel: "in_app", enabled: false });
      await waitFor(() => (prefs.at(-1) ?? []).some((p) => p.category === "marketing"), 5000, "pref reflected");

      // A marketing in_app send is suppressed — the inbox stays empty for it.
      const r = (await c.mutation(api.n.send, { to: { userId: "user-1" }, channels: ["in_app"], template: "hi", category: "marketing" })) as { suppressed: string[] };
      expect(r.suppressed).toEqual(["in_app"]);
      // A critical (security) send DOES arrive.
      await c.mutation(api.n.send, { to: { userId: "user-1" }, channels: ["in_app"], template: "hi", category: "security" });
      await waitFor(() => (inbox.at(-1)?.length ?? 0) >= 1, 5000, "critical arrives");
      expect(inbox.at(-1)!.length).toBe(1); // exactly the critical one; the marketing one was suppressed

      // Topic fan-out: user-1 (opted out of marketing in_app) is suppressed; user-2 is not subscribed.
      await c.mutation(api.n.sub, { topic: "news", userId: "user-1" });
      const t = (await c.action(api.n.topicSend, { topic: "news", channels: ["in_app"], template: "hi", category: "marketing" })) as { recipientCount: number; sentCount: number; suppressedCount: number };
      expect(t).toEqual({ recipientCount: 1, sentCount: 0, suppressedCount: 1 });
    } finally { c.close(); }
  });
});
