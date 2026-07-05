/**
 * Notifications N2 — E2E through the real dev server: retries land sent reactively, and a
 * signature-verified delivery webhook flips deliveryStatus reactively (invalid signature → 401).
 */
import { describe, it, expect, afterAll } from "vitest";
import { createHmac } from "node:crypto";
import { v, defineSchema, defineTable } from "@helipod/values";
import { mutation, query } from "@helipod/executor";
import { SqliteDocStore, NodeSqliteAdapter } from "@helipod/docstore-sqlite";
import { createEmbeddedRuntime, type EmbeddedRuntime } from "@helipod/runtime-embedded";
import { HelipodClient, webSocketTransport, anyApi } from "@helipod/client";
import { defineNotifications, type EmailProvider, type WebhookEvent } from "@helipod/notifications";
import { loadProject, startDevServer, type DevServer } from "../src/index";

const SECRET = "whsec_" + Buffer.from("n2-e2e-signing-key").toString("base64");
function svixHeaders(body: string): Record<string, string> {
  const id = "msg_e2e", ts = String(Math.floor(Date.now() / 1000));
  const key = Buffer.from(SECRET.slice("whsec_".length), "base64");
  const sig = createHmac("sha256", key).update(`${id}.${ts}.${body}`).digest("base64");
  return { "svix-id": id, "svix-timestamp": ts, "svix-signature": `v1,${sig}` };
}

// A provider that fails the first send then succeeds, and verifies Svix webhooks with SECRET.
function flakyResend(): { calls: number; provider: EmailProvider } {
  const st = { calls: 0 };
  return {
    get calls() { return st.calls; },
    provider: {
      channel: "email",
      async send() { st.calls++; if (st.calls === 1) throw new Error("transient"); return { providerMessageId: "re_e2e" }; },
      webhook: {
        verify: (a) => {
          const id = a.headers.get("svix-id"), ts = a.headers.get("svix-timestamp"), sig = a.headers.get("svix-signature");
          if (!id || !ts || !sig) return false;
          const key = Buffer.from(SECRET.slice("whsec_".length), "base64");
          const exp = `v1,${createHmac("sha256", key).update(`${id}.${ts}.${a.rawBody}`).digest("base64")}`;
          return sig === exp;
        },
        parse: (raw): WebhookEvent[] => { const e = JSON.parse(raw); return e.data?.email_id ? [{ providerMessageId: e.data.email_id, deliveryStatus: e.type === "email.delivered" ? "delivered" : "bounced" }] : []; },
      },
    },
  };
}

const appSchema = defineSchema({ pings: defineTable({ by: v.string() }).index("by_by", ["by"]) });
const appModules = {
  notify: {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ping: mutation(async (ctx: any, { userId }: { userId: string }) =>
      ctx.notifications.send({ to: { userId, email: `${userId}@test` }, channels: ["email"], template: { email: { subject: "Hi", text: "hi" } } })),
    // A query over the message rows' status so the client can subscribe reactively.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    statuses: query(async (ctx: any) => (await ctx.db.query("notifications/messages", "byStatus").collect()).map((r: any) => ({ status: r.status, deliveryStatus: r.deliveryStatus ?? null, providerMessageId: r.providerMessageId ?? null }))),
  },
};
const api = anyApi as { notify: { ping: { __path: string }; statuses: { __path: string } } };

const servers: DevServer[] = [];
afterAll(async () => { for (const s of servers) await s.close(); });

describe("notifications N2 — reliability E2E", () => {
  it("a transient failure retries and lands sent; a signed webhook flips deliveryStatus (bad sig → 401)", async () => {
    const flaky = flakyResend();
    const project = loadProject({ schema: appSchema, modules: appModules }, [
      defineNotifications({ channels: { email: { provider: flaky.provider, from: "no-reply@test", webhookSecret: SECRET } }, driverIntervalMs: 500, retry: { initialBackoffMs: 10 } }),
    ]);
    const runtime: EmbeddedRuntime = await createEmbeddedRuntime({
      store: new SqliteDocStore(new NodeSqliteAdapter()),
      catalog: project.catalog, modules: project.moduleMap, tableNumbers: project.tableNumbers,
      componentNames: project.componentNames, contextProviders: project.contextProviders,
      bootSteps: project.bootSteps, drivers: project.drivers,
    });
    // Bind the composed component's reserved httpRoutes exactly as boot.ts does — this low-level
    // loadProject()+createEmbeddedRuntime() path (not bootProject) doesn't auto-wire them, per
    // packages/cli/test/component-routes-e2e.test.ts / auth-external-e2e.test.ts.
    const componentRoutes = project.componentRoutes.map((r) => ({
      method: r.method, pathPrefix: r.pathPrefix,
      handler: (request: Request) => runtime.runHttpAction(r.handlerPath, request, { identity: null }),
    }));
    const server = await startDevServer(runtime, { port: 0, ip: "127.0.0.1", componentRoutes });
    servers.push(server);
    const base = `http://127.0.0.1:${server.port}`;
    const c = new HelipodClient(webSocketTransport(`ws://127.0.0.1:${server.port}/api/sync`, { reconnect: false }));
    try {
      c.setAuth("user-1");
      const statuses: Array<Array<{ status: string; deliveryStatus: string | null; providerMessageId: string | null }>> = [];
      c.subscribe(api.notify.statuses, {}, (v2) => statuses.push(v2 as never));
      await waitFor(() => statuses.length >= 1);

      await c.mutation(api.notify.ping, { userId: "user-1" });
      // Retry: first send throws (transient), driver retries within backoff+interval → sent.
      await waitFor(() => (statuses.at(-1) ?? []).some((r) => r.status === "sent"), 8000, "retry→sent");
      expect(flaky.calls).toBeGreaterThanOrEqual(2);

      // Invalid webhook signature → 401, no deliveryStatus change.
      const body = JSON.stringify({ type: "email.delivered", data: { email_id: "re_e2e" } });
      const bad = await fetch(`${base}/api/notifications/webhooks/email`, { method: "POST", headers: { "svix-id": "x", "svix-timestamp": "1", "svix-signature": "v1,bad" }, body });
      expect(bad.status).toBe(401);

      // Valid signature → 200, deliveryStatus flips to delivered reactively.
      const good = await fetch(`${base}/api/notifications/webhooks/email`, { method: "POST", headers: { "content-type": "application/json", ...svixHeaders(body) }, body });
      expect(good.status).toBe(200);
      await waitFor(() => (statuses.at(-1) ?? []).some((r) => r.deliveryStatus === "delivered"), 5000, "reactive deliveryStatus");
    } finally {
      c.close();
    }
  });
});

async function waitFor(cond: () => boolean, timeoutMs = 5000, label = "waitFor"): Promise<void> {
  const start = Date.now();
  while (!cond()) { if (Date.now() - start > timeoutMs) throw new Error(`${label} timed out`); await new Promise<void>((r) => setTimeout(r, 20)); }
}
