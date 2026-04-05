/**
 * Notifications N1 — E2E through the real `stackbase dev` server (e2e-through-shipped-entrypoint
 * rule). A REAL `@stackbase/client` over a REAL WebSocket to a REAL server with
 * `@stackbase/notifications` composed. The reactive-inbox proof is the headline:
 *  (1) a client mutation calls `ctx.notifications.send` for in_app + email;
 *  (2) a LIVE inbox subscription (opened BEFORE) sees the in_app notification appear reactively;
 *  (3) the driver delivers the email (capture provider records it, woken by the commit fan-out);
 *  (4) `markRead` fans out reactively — the live unread-count subscription drops to 0.
 * A second test proves the action-side `ctx.notifications.sendNow`: it delivers email synchronously
 * (returning the provider result), writes the in_app inbox row, and dedups on a repeated key.
 * No auth composed: the inbox resolves the caller via `ctx.notifications.identity()` (the setAuth
 * token), and the app mutation targets that same id.
 */
import { describe, it, expect, afterAll } from "vitest";
import { v, defineSchema, defineTable } from "@stackbase/values";
import { mutation, action } from "@stackbase/executor";
import { SqliteDocStore, NodeSqliteAdapter } from "@stackbase/docstore-sqlite";
import { createEmbeddedRuntime, type EmbeddedRuntime } from "@stackbase/runtime-embedded";
import { StackbaseClient, webSocketTransport, anyApi } from "@stackbase/client";
import { defineNotifications, type EmailMessage, type EmailProvider } from "@stackbase/notifications";
import { loadProject, startDevServer, type DevServer } from "../src/index";

async function waitFor(cond: () => boolean, timeoutMs = 5000, label = "waitFor"): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error(`${label} timed out`);
    await new Promise<void>((r) => setTimeout(r, 10));
  }
}

function captureEmail(): { sent: EmailMessage[]; provider: EmailProvider } {
  const sent: EmailMessage[] = [];
  return { sent, provider: { channel: "email", async send(m) { sent.push(m); return { providerMessageId: `cap-${sent.length}` }; } } };
}

const appSchema = defineSchema({ pings: defineTable({ by: v.string() }).index("by_by", ["by"]) });

const appModules = {
  notify: {
    // The app tells notifications who to notify (server-controlled recipient) — here the caller's own id.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ping: mutation(async (ctx: any, { userId }: { userId: string }) =>
      ctx.notifications.send({
        to: { userId, email: `${userId}@test` },
        channels: ["in_app", "email"],
        template: { in_app: { title: "Hi", body: "hello there" }, email: { subject: "Hi", text: "hello there" } },
      })),
    // Action-side sendNow: delivers email synchronously (returns the provider result) + writes the
    // in_app row; a repeated `key` dedups. Proves the crash-safe queued-drain sendNow (T3 review fix).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    pingNow: action(async (ctx: any, { userId, key }: { userId: string; key?: string }) =>
      ctx.notifications.sendNow({
        to: { userId, email: `${userId}@test` },
        channels: ["in_app", "email"],
        template: { in_app: { title: "Now", body: "sent now" }, email: { subject: "Now", text: "sent now" } },
        idempotencyKey: key,
      })),
  },
};

const api = anyApi as {
  notify: { ping: { __path: string }; pingNow: { __path: string } };
  notifications: { inbox: { __path: string }; unreadCount: { __path: string }; markRead: { __path: string } };
};

const servers: DevServer[] = [];
afterAll(async () => { for (const s of servers) await s.close(); });

async function bootServer(): Promise<{ server: DevServer; capture: ReturnType<typeof captureEmail>; wsUrl: string }> {
  const capture = captureEmail();
  const project = loadProject({ schema: appSchema, modules: appModules }, [
    defineNotifications({
      channels: { email: { provider: capture.provider, from: "no-reply@test" }, in_app: { enabled: true } },
      driverIntervalMs: 1000,
    }),
  ]);
  const runtime: EmbeddedRuntime = await createEmbeddedRuntime({
    store: new SqliteDocStore(new NodeSqliteAdapter()),
    catalog: project.catalog,
    modules: project.moduleMap,
    tableNumbers: project.tableNumbers,
    componentNames: project.componentNames,
    contextProviders: project.contextProviders,
    bootSteps: project.bootSteps,
    drivers: project.drivers,
  });
  const server = await startDevServer(runtime, { port: 0, ip: "127.0.0.1" });
  servers.push(server);
  return { server, capture, wsUrl: `ws://127.0.0.1:${server.port}/api/sync` };
}

describe("notifications N1 — E2E through the real dev server", () => {
  it("in_app appears reactively, the driver delivers email, and markRead drops the unread count live", async () => {
    const { capture, wsUrl } = await bootServer();
    const c = new StackbaseClient(webSocketTransport(wsUrl, { reconnect: false }));
    try {
      c.setAuth("user-1"); // the ambient identity → the inbox recipient id
      const inbox: Array<Array<{ _id: string; body: string }>> = [];
      const unread: number[] = [];
      c.subscribe(api.notifications.inbox, {}, (v2) => inbox.push(v2 as Array<{ _id: string; body: string }>));
      c.subscribe(api.notifications.unreadCount, {}, (v2) => unread.push(v2 as number));
      await waitFor(() => inbox.length >= 1 && unread.length >= 1, 5000, "initial inbox");
      expect(inbox.at(-1)).toEqual([]);
      expect(unread.at(-1)).toBe(0);

      // Send: writes the in_app inbox row (reactive) + a queued email row (driver delivers).
      await c.mutation(api.notify.ping, { userId: "user-1" });

      await waitFor(() => (inbox.at(-1)?.length ?? 0) >= 1, 5000, "reactive in_app");
      expect(inbox.at(-1)![0]!.body).toBe("hello there");
      await waitFor(() => unread.at(-1) === 1, 5000, "unread=1");

      // The driver delivers the email, woken by the send's commit fan-out.
      await waitFor(() => capture.sent.length >= 1, 5000, "email delivered");
      expect(capture.sent[0]).toMatchObject({ to: "user-1@test", from: "no-reply@test", subject: "Hi" });

      // markRead fans out reactively — the unread-count subscription drops to 0.
      const id = inbox.at(-1)![0]!._id;
      await c.mutation(api.notifications.markRead, { id });
      await waitFor(() => unread.at(-1) === 0, 5000, "reactive markRead");
      expect(unread.at(-1)).toBe(0);
    } finally {
      c.close();
    }
  });

  it("sendNow delivers email synchronously (returns the provider result), writes the in_app row, and dedups on key", async () => {
    const { capture, wsUrl } = await bootServer();
    const c = new StackbaseClient(webSocketTransport(wsUrl, { reconnect: false }));
    try {
      c.setAuth("user-2");
      const inbox: Array<Array<{ _id: string; body: string }>> = [];
      c.subscribe(api.notifications.inbox, {}, (v2) => inbox.push(v2 as Array<{ _id: string; body: string }>));
      await waitFor(() => inbox.length >= 1, 5000, "initial inbox");

      // First sendNow: email delivered synchronously and its result returned in the action value.
      const r1 = (await c.action(api.notify.pingNow, { userId: "user-2", key: "otp-e2e" })) as { messageIds: string[]; results: Array<{ providerMessageId?: string }> };
      expect(r1.results.length).toBe(1);
      expect(r1.results[0]!.providerMessageId).toBe("cap-1");
      await waitFor(() => capture.sent.length >= 1, 5000, "sendNow email");
      expect(capture.sent[0]).toMatchObject({ to: "user-2@test", subject: "Now" });
      // The in_app row is live to the inbox subscription.
      await waitFor(() => (inbox.at(-1)?.length ?? 0) >= 1, 5000, "sendNow in_app");
      expect(inbox.at(-1)![0]!.body).toBe("sent now");

      // Repeat with the SAME key → dedup: no second email delivered, no new provider result.
      const r2 = (await c.action(api.notify.pingNow, { userId: "user-2", key: "otp-e2e" })) as { messageIds: string[]; results: unknown[] };
      expect(r2.results.length).toBe(0);
      expect(r2.messageIds).toEqual(r1.messageIds);
      // Give any (incorrect) async delivery a beat; capture must still be exactly one.
      await new Promise<void>((r) => setTimeout(r, 200));
      expect(capture.sent.length).toBe(1);
    } finally {
      c.close();
    }
  });
});
