/**
 * Notifications push channel — E2E through the real `stackbase dev` server (e2e-through-shipped-
 * entrypoint rule). A REAL `@stackbase/client` over a REAL WebSocket to a REAL server with
 * `@stackbase/notifications` composed with a `push` channel (capture `expo` adapter).
 *  (1) a client mutation registers a device push token (the same wire path `registerForPush`
 *      calls — `notifications:registerPushToken`);
 *  (2) an app mutation calls `ctx.notifications.send({ channels: ["push"] })`;
 *  (3) the driver delivers via the capture provider, woken by the commit fan-out — the capture
 *      provider records the exact `{to, title, body, data}`, and the `messages` row reaches
 *      `status: "sent"` (observed via a reactive app-level query, mirroring `notifications-
 *      reliability-e2e.test.ts`'s `statuses` pattern).
 * A second test proves invalid-token pruning end-to-end: the capture provider returns
 * `invalidTokens: [token]` on its first call; a SECOND send to the same user finds zero registered
 * tokens (pruned) and the capture provider is never called a second time (decision 6 — zero
 * devices is not a failure, skip-when-empty).
 */
import { describe, it, expect, afterAll } from "vitest";
import { v, defineSchema, defineTable } from "@stackbase/values";
import { mutation, query } from "@stackbase/executor";
import { SqliteDocStore, NodeSqliteAdapter } from "@stackbase/docstore-sqlite";
import { createEmbeddedRuntime, type EmbeddedRuntime } from "@stackbase/runtime-embedded";
import { StackbaseClient, webSocketTransport, anyApi } from "@stackbase/client";
import { defineNotifications, type PushMessage, type PushProvider } from "@stackbase/notifications";
import { loadProject, startDevServer, type DevServer } from "../src/index";

async function waitFor(cond: () => boolean, timeoutMs = 5000, label = "waitFor"): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error(`${label} timed out`);
    await new Promise<void>((r) => setTimeout(r, 10));
  }
}

function capturePush(opts?: { invalidateFirst?: string }): { sent: PushMessage[]; provider: PushProvider } {
  const sent: PushMessage[] = [];
  return {
    sent,
    provider: {
      channel: "push",
      async send(m) {
        sent.push(m);
        if (opts?.invalidateFirst && sent.length === 1) return { invalidTokens: [opts.invalidateFirst] };
        return { providerMessageId: `cap-${sent.length}` };
      },
    },
  };
}

const appSchema = defineSchema({ pings: defineTable({ by: v.string() }).index("by_by", ["by"]) });

function appModules() {
  return {
    notify: {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ping: mutation(async (ctx: any, { userId }: { userId: string }) =>
        ctx.notifications.send({
          to: { userId },
          channels: ["push"],
          template: { push: { title: "Hi", body: "hello there" } },
        })),
      // A query over the message rows' status so the client can subscribe reactively — mirrors
      // notifications-reliability-e2e.test.ts's `statuses` pattern.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      statuses: query(async (ctx: any) =>
        (await ctx.db.query("notifications/messages", "byStatus").collect())
          .filter((r: any) => r.channel === "push")
          .map((r: any) => ({ status: r.status as string }))),
    },
  };
}

const api = anyApi as {
  notify: { ping: { __path: string }; statuses: { __path: string } };
};

const servers: DevServer[] = [];
afterAll(async () => { for (const s of servers) await s.close(); });

async function bootServer(capture: ReturnType<typeof capturePush>): Promise<{ server: DevServer; wsUrl: string }> {
  const project = loadProject({ schema: appSchema, modules: appModules() }, [
    defineNotifications({
      channels: { push: { providers: { expo: capture.provider } } },
      driverIntervalMs: 200,
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
  return { server, wsUrl: `ws://127.0.0.1:${server.port}/api/sync` };
}

describe("notifications push channel — E2E through the real dev server", () => {
  it("registers a device token, sends, and the driver delivers via the capture provider", async () => {
    const capture = capturePush();
    const { wsUrl } = await bootServer(capture);
    const c = new StackbaseClient(webSocketTransport(wsUrl, { reconnect: false }));
    try {
      c.setAuth("user-1");
      // Same wire path `registerForPush` (packages/client/src/notifications.tsx) calls.
      await c.mutation("notifications:registerPushToken", { token: "device-tok-1", provider: "expo" });

      const statuses: Array<Array<{ status: string }>> = [];
      c.subscribe(api.notify.statuses, {}, (v2) => statuses.push(v2 as never));
      await waitFor(() => statuses.length >= 1, 5000, "initial statuses");

      await c.mutation(api.notify.ping, { userId: "user-1" });

      await waitFor(() => (statuses.at(-1) ?? []).some((r) => r.status === "sent"), 5000, "push delivered → sent");
      expect(capture.sent).toHaveLength(1);
      expect(capture.sent[0]).toMatchObject({ to: ["device-tok-1"], title: "Hi", body: "hello there" });
    } finally {
      c.close();
    }
  });

  it("prunes an invalid token after delivery — a second send finds no devices, provider not called again", async () => {
    const capture = capturePush({ invalidateFirst: "device-tok-2" });
    const { wsUrl } = await bootServer(capture);
    const c = new StackbaseClient(webSocketTransport(wsUrl, { reconnect: false }));
    try {
      c.setAuth("user-2");
      await c.mutation("notifications:registerPushToken", { token: "device-tok-2", provider: "expo" });

      const statuses: Array<Array<{ status: string }>> = [];
      c.subscribe(api.notify.statuses, {}, (v2) => statuses.push(v2 as never));
      await waitFor(() => statuses.length >= 1, 5000, "initial statuses");

      await c.mutation(api.notify.ping, { userId: "user-2" });
      await waitFor(() => (statuses.at(-1) ?? []).filter((r) => r.status === "sent").length >= 1, 5000, "first send → sent");
      expect(capture.sent).toHaveLength(1);

      // Second send: the token was pruned after the first (invalid) delivery — zero devices this
      // time, so recordSend still enqueues, but the driver marks it sent with NO provider call.
      await c.mutation(api.notify.ping, { userId: "user-2" });
      await waitFor(() => (statuses.at(-1) ?? []).filter((r) => r.status === "sent").length >= 2, 5000, "second send → sent (no devices)");
      expect(capture.sent).toHaveLength(1); // provider NOT called again
    } finally {
      c.close();
    }
  });
});
