/**
 * Notifications N4 — digest E2E through the real `stackbase dev` server (e2e-through-shipped-
 * entrypoint rule, mirroring `notifications-e2e.test.ts`'s N1 boot — no `componentRoutes` wiring,
 * since digest adds no `httpRoutes`).
 *
 * Proves the wire-observable half of digest: a `send` on a digest-configured category BUFFERS
 * instead of delivering — the reactive DEFERRAL, not the flush. Three `updates` emails to one
 * recipient each return `deferred: ["email"]`, the capture provider receives NOTHING (the hourly
 * window hasn't elapsed), and the buffer holds all three rows, observed via a live app query over
 * the namespaced `notifications/digestBuffer` table. The flush mechanics (claim, combine, one
 * outbound email, preference re-check) are already proven at the T3 component-unit level
 * (`components/notifications/test/digest.test.ts`) — a live flush needs time-travel past the
 * rolling window, which isn't available over the wire, so it's out of scope here.
 */
import { describe, it, expect, afterAll } from "vitest";
import { v, defineSchema, defineTable } from "@stackbase/values";
import { mutation, query } from "@stackbase/executor";
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
  digest: {
    // The app tells notifications who to notify — an `updates`-category email on a digest-configured
    // category. Returns the raw `send` result so the caller can assert `deferred` over the wire.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    send: mutation(async (ctx: any, { n }: { n: number }) =>
      ctx.notifications.send({
        to: { userId: "user-1", email: "user-1@test" },
        channels: ["email"],
        template: { email: { subject: `Update ${n}`, text: `update body ${n}` } },
        category: "updates",
      })),
    // A live query over the buffered digest rows — the wire-observable proof of buffering. Every
    // optional key is null-coalesced (the N1 inbox lesson: an `undefined` key over the wire throws).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    bufferRows: query(async (ctx: any) =>
      (await ctx.db.query("notifications/digestBuffer", "byRecipientCategory").collect()).map((r: any) => ({
        email: r.email,
        category: r.category,
        subject: r.subject,
        userId: r.userId ?? null,
        html: r.html ?? null,
        flushedAt: r.flushedAt ?? null,
      }))),
  },
};

const api = anyApi as {
  digest: { send: { __path: string }; bufferRows: { __path: string } };
};

const servers: DevServer[] = [];
afterAll(async () => { for (const s of servers) await s.close(); });

describe("notifications N4 — digest E2E", () => {
  it("a digest-category email BUFFERS (deferred, no delivery) instead of being sent immediately", async () => {
    const capture = captureEmail();
    const project = loadProject({ schema: appSchema, modules: appModules }, [
      defineNotifications({
        channels: { email: { provider: capture.provider, from: "no-reply@test" } },
        categories: { updates: { digest: "hourly" } },
        driverIntervalMs: 500,
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

    const c = new StackbaseClient(webSocketTransport(`ws://127.0.0.1:${server.port}/api/sync`, { reconnect: false }));
    try {
      c.setAuth("user-1");
      const buffers: Array<Array<{ email: string; category: string; subject: string }>> = [];
      c.subscribe(api.digest.bufferRows, {}, (v2) => buffers.push(v2 as never));
      await waitFor(() => buffers.length >= 1, 5000, "initial bufferRows");
      expect(buffers.at(-1)).toEqual([]);

      // Three sends to the same recipient on the digest-configured "updates" category — each is
      // buffered (deferred), not delivered.
      for (const n of [1, 2, 3]) {
        const res = (await c.mutation(api.digest.send, { n })) as { messageIds: string[]; suppressed: string[]; deferred: string[] };
        expect(res.deferred).toEqual(["email"]);
        expect(res.messageIds).toEqual([]);  // buffered, not queued as an outbound message
        expect(res.suppressed).toEqual([]);
      }

      // Reactive proof: the buffer fills to 3 rows for this recipient/category.
      await waitFor(() => (buffers.at(-1)?.length ?? 0) >= 3, 5000, "reactive digest buffer");
      expect(buffers.at(-1)!.length).toBe(3);
      expect(buffers.at(-1)!.every((r) => r.email === "user-1@test" && r.category === "updates")).toBe(true);
      expect(buffers.at(-1)!.map((r) => r.subject).sort()).toEqual(["Update 1", "Update 2", "Update 3"]);

      // NO delivery: the driver has run several passes (driverIntervalMs: 500) but the hourly window
      // hasn't elapsed, so the capture provider must stay completely empty.
      await new Promise<void>((r) => setTimeout(r, 1200));
      expect(capture.sent.length).toBe(0);
    } finally {
      c.close();
    }
  });
});
