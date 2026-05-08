/**
 * Notifications — provider fallback E2E through the real dev server: a same-channel fallback masks
 * a transient primary outage with ZERO visible N2 retry (the walk happens within one delivery
 * attempt); the contrast case proves that without a configured fallback, the exact same fault still
 * eventually delivers via N2's existing retry/backoff path — fallback buys LATENCY, not just
 * eventual delivery (N2 already had that).
 */
import { describe, it, expect, afterAll } from "vitest";
import { v, defineSchema, defineTable } from "@stackbase/values";
import { mutation, query } from "@stackbase/executor";
import { SqliteDocStore, NodeSqliteAdapter } from "@stackbase/docstore-sqlite";
import { createEmbeddedRuntime, type EmbeddedRuntime } from "@stackbase/runtime-embedded";
import { StackbaseClient, webSocketTransport, anyApi } from "@stackbase/client";
import { defineNotifications, NotificationSendError, type EmailProvider } from "@stackbase/notifications";
import { loadProject, startDevServer, type DevServer } from "../src/index";

// A provider that ALWAYS throws a retryable failure — simulates a primary outage that never clears
// within this test's window (so a fallback-less config genuinely has to retry-and-eventually-succeed
// via a SEPARATE flaky provider in the contrast case below; this one just proves the fallback path
// never even touches N2's retry machinery).
function alwaysDownEmail(): EmailProvider {
  return { channel: "email", async send() { throw new NotificationSendError("primary outage", { retryable: true }); } };
}
// A provider that always succeeds, deterministically labeled.
function captureOkEmail(id: string): EmailProvider {
  return { channel: "email", name: "fallback-1", async send() { return { providerMessageId: id }; } };
}
// A provider that fails twice (retryable) then succeeds — the SAME fault shape as
// notifications-reliability-e2e.test.ts's `flakyResend`, reused here as the "no fallback configured"
// contrast case, proving N2 retry/backoff still delivers eventually.
function flakyEmail(): { calls: number; provider: EmailProvider } {
  const st = { calls: 0 };
  return {
    get calls() { return st.calls; },
    provider: {
      channel: "email",
      async send() {
        st.calls++;
        if (st.calls <= 2) throw new NotificationSendError("transient", { retryable: true });
        return { providerMessageId: "id-flaky-ok" };
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
    statuses: query(async (ctx: any) => (await ctx.db.query("notifications/messages", "byStatus").collect()).map((r: any) => ({
      status: r.status, attempts: r.attempts ?? 0, providerName: r.providerName ?? null, providerMessageId: r.providerMessageId ?? null,
    }))),
  },
};
const api = anyApi as { notify: { ping: { __path: string }; statuses: { __path: string } } };

const servers: DevServer[] = [];
afterAll(async () => { for (const s of servers) await s.close(); });

async function bootServer(project: ReturnType<typeof loadProject>): Promise<{ server: DevServer; client: StackbaseClient }> {
  const runtime: EmbeddedRuntime = await createEmbeddedRuntime({
    store: new SqliteDocStore(new NodeSqliteAdapter()),
    catalog: project.catalog, modules: project.moduleMap, tableNumbers: project.tableNumbers,
    componentNames: project.componentNames, contextProviders: project.contextProviders,
    bootSteps: project.bootSteps, drivers: project.drivers,
  });
  const server = await startDevServer(runtime, { port: 0, ip: "127.0.0.1" });
  servers.push(server);
  const client = new StackbaseClient(webSocketTransport(`ws://127.0.0.1:${server.port}/api/sync`, { reconnect: false }));
  return { server, client };
}

async function waitFor(cond: () => boolean, timeoutMs = 5000, label = "waitFor"): Promise<void> {
  const start = Date.now();
  while (!cond()) { if (Date.now() - start > timeoutMs) throw new Error(`${label} timed out`); await new Promise<void>((r) => setTimeout(r, 20)); }
}

describe("notifications — provider fallback E2E", () => {
  it("a fallback masks a transient primary outage on the FIRST attempt — zero visible N2 retry", async () => {
    const project = loadProject({ schema: appSchema, modules: appModules }, [
      defineNotifications({
        channels: { email: { provider: alwaysDownEmail(), from: "no-reply@test", fallbacks: [captureOkEmail("id-fb1")] } },
        driverIntervalMs: 500, retry: { initialBackoffMs: 10 },
      }),
    ]);
    const { client: c } = await bootServer(project);
    try {
      c.setAuth("user-fb-1");
      const statuses: Array<Array<{ status: string; attempts: number; providerName: string | null; providerMessageId: string | null }>> = [];
      c.subscribe(api.notify.statuses, {}, (v2) => statuses.push(v2 as never));
      await waitFor(() => statuses.length >= 1);

      await c.mutation(api.notify.ping, { userId: "user-fb-1" });
      await waitFor(() => (statuses.at(-1) ?? []).some((r) => r.status === "sent"), 5000, "fallback→sent");

      const row = (statuses.at(-1) ?? [])[0]!;
      expect(row.status).toBe("sent");
      expect(row.providerName).toBe("fallback-1");
      expect(row.providerMessageId).toBe("id-fb1");
      // Never visibly queued-with-backoff in between: attempts stays 0 — the fallback walk happened
      // entirely within the driver's FIRST claimed attempt, never re-entering N2's retry loop.
      expect(row.attempts).toBe(0);
    } finally {
      c.close();
    }
  });

  it("without a fallback, the SAME kind of retryable fault takes the N2 backoff path (attempts increments before sent)", async () => {
    const flaky = flakyEmail();
    const project = loadProject({ schema: appSchema, modules: appModules }, [
      defineNotifications({
        channels: { email: { provider: flaky.provider, from: "no-reply@test" } }, // no fallbacks configured
        driverIntervalMs: 300, retry: { initialBackoffMs: 10 },
      }),
    ]);
    const { client: c } = await bootServer(project);
    try {
      c.setAuth("user-fb-2");
      const statuses: Array<Array<{ status: string; attempts: number; providerName: string | null; providerMessageId: string | null }>> = [];
      c.subscribe(api.notify.statuses, {}, (v2) => statuses.push(v2 as never));
      await waitFor(() => statuses.length >= 1);

      await c.mutation(api.notify.ping, { userId: "user-fb-2" });
      // Eventual delivery still works exactly as before this slice: the row is seen `queued` with a
      // growing `attempts` count before it lands `sent` — N2's retry path is genuinely exercised.
      await waitFor(() => statuses.some((snap) => snap.some((r) => r.status === "queued" && r.attempts >= 1)), 5000, "queued-with-attempts");
      await waitFor(() => (statuses.at(-1) ?? []).some((r) => r.status === "sent"), 8000, "eventually→sent");

      const row = (statuses.at(-1) ?? [])[0]!;
      expect(row.status).toBe("sent");
      expect(row.providerName).toBe("primary");
      expect(flaky.calls).toBeGreaterThanOrEqual(3);
    } finally {
      c.close();
    }
  });
});
