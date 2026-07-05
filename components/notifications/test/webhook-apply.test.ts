import { describe, it, expect, afterEach } from "vitest";
import { defineComponent, type ComponentDefinition } from "@helipod/component";
import { mutation, action, type ActionCtx, type RegisteredFunction } from "@helipod/executor";
import { notificationsSchema } from "../src/schema";
import { resolveNotificationsConfig } from "../src/config";
import { makeSendModules } from "../src/modules";
import { makeWebhookModules } from "../src/webhook";
import { notificationsContext } from "../src/facade";
import { notificationsDriver } from "../src/driver";
import type { EmailProvider, WebhookEvent } from "../src/provider";
import { makeNotifRuntime, type BuiltNotifRuntime } from "./helpers";

/** A combined provider: a deterministic `send` (always lands `providerMessageId: "re_1"`) plus a
 *  toggleable `webhook` (verify/parse scripted per test). Lets a test seed a REAL `messages` row
 *  (via `ctx.notifications.send` + one driver tick, the same path every other N1/N2 test uses)
 *  and then drive `_applyWebhookEvent`/`webhookHttp` against it — no privileged test-only seed
 *  helper needed. */
function provider(opts: { verifyOk: boolean; events: WebhookEvent[] }): EmailProvider {
  return {
    channel: "email",
    async send() { return { providerMessageId: "re_1" }; },
    webhook: { verify: () => opts.verifyOk, parse: () => opts.events },
  };
}

function comp(p: EmailProvider): ComponentDefinition {
  const config = resolveNotificationsConfig({
    channels: { email: { provider: p, from: "x@test", webhookSecret: "whsec_x", templates: { hi: () => ({ subject: "S", text: "T" }) } } },
    driverIntervalMs: 10_000,
  });
  return defineComponent({
    name: "notifications", schema: notificationsSchema,
    modules: { ...makeSendModules(config), ...makeWebhookModules(config) },
    context: (cctx) => notificationsContext(cctx, config), contextWrite: true,
    driver: notificationsDriver(config),
  });
}

const appModules: Record<string, RegisteredFunction> = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  "app:send": mutation(async (ctx: any, args: any) => ctx.notifications.send(args)),
  // `_applyWebhookEvent` is `_`-prefixed (component-internal) — the runtime's public `run()` gate
  // blocks any `_`-prefixed path, exactly like a real client. The ONLY legitimate way to reach it is
  // the same one `webhookHttp` itself uses: an action's `ctx.runMutation`. This tiny test-only action
  // exercises that IDENTICAL invoke path, so these two tests prove `_applyWebhookEvent`'s own
  // correctness (monotonic apply, unknown-id no-op) independent of `webhookHttp`'s verify/parse glue.
  "app:applyEvent": action(async (ctx, args: { providerMessageId: string; deliveryStatus: string; detail?: string }) =>
    (ctx as ActionCtx).runMutation("notifications:_applyWebhookEvent", args)),
};
async function tick(b: BuiltNotifRuntime): Promise<void> { await (b.driver as { __tick: () => Promise<void> }).__tick(); }
/** Seed one `sent` messages row with `providerMessageId: "re_1"` via a real send + one driver tick. */
async function seed(built: BuiltNotifRuntime): Promise<void> {
  await built.runtime.run("app:send", { to: { email: "u@test" }, channels: ["email"], template: "hi" });
  await tick(built);
  expect((await built.readTable("notifications/messages"))[0]).toMatchObject({ status: "sent", providerMessageId: "re_1" });
}

let built: BuiltNotifRuntime;
afterEach(async () => { await built?.close(); });

// (webhookHttp is an httpAction; driven here via the embedded runtime's `runHttpAction` — the same
//  direct-invoke seam the public HTTP router uses — so both the 401-before-any-write path and the
//  apply-on-verified-event path are provable at the component level, in addition to the full
//  E2E-through-the-real-server proof in T5.)

describe("notifications N2 — webhook apply (status normalization)", () => {
  it("_applyWebhookEvent correlates by providerMessageId and is monotonic", async () => {
    built = await makeNotifRuntime(comp(provider({ verifyOk: true, events: [] })), appModules);
    await seed(built);
    await built.runtime.runAction("app:applyEvent", { providerMessageId: "re_1", deliveryStatus: "delivered" });
    expect((await built.readTable("notifications/messages"))[0]).toMatchObject({ deliveryStatus: "delivered" });
    // A lower-rank event (bounced=2 < delivered=3) is a no-op.
    await built.runtime.runAction("app:applyEvent", { providerMessageId: "re_1", deliveryStatus: "bounced" });
    expect((await built.readTable("notifications/messages"))[0]!.deliveryStatus).toBe("delivered");
    // A higher-rank event (opened=4) applies.
    await built.runtime.runAction("app:applyEvent", { providerMessageId: "re_1", deliveryStatus: "opened" });
    expect((await built.readTable("notifications/messages"))[0]!.deliveryStatus).toBe("opened");
  });

  it("records a spam complaint that arrives AFTER delivered (not dropped by the monotonic rank)", async () => {
    built = await makeNotifRuntime(comp(provider({ verifyOk: true, events: [] })), appModules);
    await seed(built);
    await built.runtime.runAction("app:applyEvent", { providerMessageId: "re_1", deliveryStatus: "delivered" });
    // A complaint (rank 2 < delivered 3) would be lost under a pure monotonic rank — it must be
    // captured in its own `complainedAt` field, unconditionally, without regressing deliveryStatus.
    await built.runtime.runAction("app:applyEvent", { providerMessageId: "re_1", deliveryStatus: "complained" });
    const row = (await built.readTable("notifications/messages"))[0]!;
    expect(row.deliveryStatus).toBe("delivered");            // delivery status unchanged…
    expect(typeof row.complainedAt).toBe("number");          // …but the complaint IS recorded.
    // Idempotent: a redelivered complaint doesn't rewrite it.
    const first = row.complainedAt;
    await built.runtime.runAction("app:applyEvent", { providerMessageId: "re_1", deliveryStatus: "complained" });
    expect((await built.readTable("notifications/messages"))[0]!.complainedAt).toBe(first);
  });

  it("_applyWebhookEvent is a no-op for an unknown providerMessageId", async () => {
    built = await makeNotifRuntime(comp(provider({ verifyOk: true, events: [] })), appModules);
    await seed(built);
    await built.runtime.runAction("app:applyEvent", { providerMessageId: "nope", deliveryStatus: "delivered" });
    expect((await built.readTable("notifications/messages"))[0]!.deliveryStatus).toBeUndefined();
  });

  it("webhookHttp returns 401 before any write on a failed verify", async () => {
    built = await makeNotifRuntime(comp(provider({ verifyOk: false, events: [{ providerMessageId: "re_1", deliveryStatus: "delivered" }] })), appModules);
    await seed(built);
    const res = await built.runtime.runHttpAction(
      "notifications:webhookHttp",
      new Request("http://x/api/notifications/webhooks/email", { method: "POST", body: "{}" }),
    );
    expect(res.status).toBe(401);
    expect((await built.readTable("notifications/messages"))[0]!.deliveryStatus).toBeUndefined();
  });

  it("webhookHttp applies parsed events on a verified request", async () => {
    built = await makeNotifRuntime(comp(provider({ verifyOk: true, events: [{ providerMessageId: "re_1", deliveryStatus: "delivered" }] })), appModules);
    await seed(built);
    const res = await built.runtime.runHttpAction(
      "notifications:webhookHttp",
      new Request("http://x/api/notifications/webhooks/email", { method: "POST", body: "{}" }),
    );
    expect(res.status).toBe(200);
    expect((await built.readTable("notifications/messages"))[0]).toMatchObject({ deliveryStatus: "delivered" });
  });

  it("verifies against the proxy-forwarded PUBLIC url (URL-signing providers behind TLS termination)", async () => {
    let seenUrl = "";
    const capturing: EmailProvider = {
      channel: "email",
      async send() { return { providerMessageId: "re_1" }; },
      webhook: { verify: (a) => { seenUrl = a.url; return true; }, parse: () => [] },
    };
    built = await makeNotifRuntime(comp(capturing), appModules);
    await seed(built);
    const res = await built.runtime.runHttpAction(
      "notifications:webhookHttp",
      new Request("http://internal-host:8080/api/notifications/webhooks/email", {
        method: "POST", body: "{}",
        headers: { "x-forwarded-proto": "https", "x-forwarded-host": "app.example.com" },
      }),
    );
    expect(res.status).toBe(200);
    // Twilio signs over the PUBLIC https URL, not the internal http one the proxy forwards to.
    expect(seenUrl).toBe("https://app.example.com/api/notifications/webhooks/email");
  });
});
