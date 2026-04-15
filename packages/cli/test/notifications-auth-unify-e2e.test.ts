/**
 * N4 — auth unification E2E: with `@stackbase/notifications` composed alongside `@stackbase/auth`,
 * an auth email flow (`auth:requestOtp`) is delivered through the NOTIFICATIONS driver — not auth's
 * own `EmailProvider` — proving the `requestAction` routing (`components/auth/src/functions.ts`)
 * takes the `ctx.notifications` branch when it's present. Auth's own capture provider must stay
 * completely empty: this is the "one delivery path" the whole slice is about. `requestOtp` (rather
 * than `requestEmailVerification`) is used because `otp`/`magic` are the only flows that send for an
 * UNKNOWN email under the default `createUsersOnEmailSignIn: true` (`shouldIssue` in functions.ts) —
 * no need to pre-create a user for this test to prove delivery.
 */
import { describe, it, expect, afterAll } from "vitest";
import { v, defineSchema, defineTable } from "@stackbase/values";
import { SqliteDocStore, NodeSqliteAdapter } from "@stackbase/docstore-sqlite";
import { createEmbeddedRuntime, type EmbeddedRuntime } from "@stackbase/runtime-embedded";
import { defineAuth } from "@stackbase/auth";
import { defineNotifications, type EmailMessage } from "@stackbase/notifications";
import { loadProject, startDevServer, type DevServer } from "../src/index";

const servers: DevServer[] = [];
afterAll(async () => { for (const s of servers) await s.close(); });

async function waitFor(cond: () => boolean, timeoutMs = 5000, label = "waitFor"): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error(`${label} timed out`);
    await new Promise<void>((r) => setTimeout(r, 10));
  }
}

describe("notifications N4 — auth unification E2E", () => {
  it("auth email routes through the notification driver, not auth's own provider", async () => {
    const authSent: EmailMessage[] = [];   // auth's OWN provider — must stay EMPTY
    const notifSent: EmailMessage[] = [];  // notifications' provider — must RECEIVE the OTP

    const project = loadProject({ schema: defineSchema({ _t: defineTable({ x: v.string() }) }), modules: {} }, [
      defineNotifications({
        channels: { email: { provider: { channel: "email", async send(m) { notifSent.push(m); return { providerMessageId: "n1" }; } }, from: "no-reply@app" } },
        driverIntervalMs: 200,
      }),
      defineAuth({ email: { provider: { async send(m) { authSent.push(m as unknown as EmailMessage); } }, from: "auth@app" } }),
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

    // Trigger the auth email flow via the real HTTP run endpoint — the actual registered action path
    // (`components/auth/src/functions.ts` ~line 687-690: `requestOtp: requestAction("otp")`).
    const res = await fetch(`${server.url}/api/run`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: "auth:requestOtp", args: { email: "u@test" } }),
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { value: { sent: true } }).value).toEqual({ sent: true }); // anti-enumeration, unchanged

    await waitFor(() => notifSent.length >= 1, 5000, "notifications delivered the auth OTP");
    expect(notifSent[0]!.to).toBe("u@test");
    expect(notifSent[0]!.from).toBe("no-reply@app"); // the NOTIFICATIONS provider's `from`, not auth's

    // Auth's own provider was never invoked — the routed path is exclusive, not a fan-out.
    await new Promise<void>((r) => setTimeout(r, 300)); // a beat for any (incorrect) fallback delivery
    expect(authSent.length).toBe(0);
  });
});
