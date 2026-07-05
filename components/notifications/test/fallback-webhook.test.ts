import { describe, it, expect, afterEach } from "vitest";
import { defineComponent, type ComponentDefinition } from "@helipod/component";
import { mutation, type RegisteredFunction } from "@helipod/executor";
import { notificationsSchema } from "../src/schema";
import { resolveNotificationsConfig } from "../src/config";
import { makeSendModules } from "../src/modules";
import { makeWebhookModules } from "../src/webhook";
import { notificationsContext } from "../src/facade";
import { notificationsDriver } from "../src/driver";
import type { EmailProvider, WebhookEvent } from "../src/provider";
import { makeNotifRuntime, type BuiltNotifRuntime } from "./helpers";

// The primary's `send` is deterministic (`providerMessageId: "re_1"`) so the test can seed a REAL
// `messages` row (via `ctx.notifications.send` + one driver tick — the same path
// `webhook-apply.test.ts`'s `seed()` helper uses) rather than a privileged test-only insert.
//
// `verify` deliberately never matches (`() => false`) — `webhookHttp` always supplies the
// channel-level `webhookSecret` as `args.secret` regardless of the request, so a verify keyed only
// off that constant could never legitimately fail and would defeat the point of this test (proving
// the walk falls through to — and, when it too doesn't match, past — the fallback candidate).
// Simulates a real-world case where the primary's own secret is unrelated to this callback (e.g.
// rotated) and only the fallback's own signing material (checked below, header-based like
// `twilioSms`) can authenticate it.
function primaryProvider(): EmailProvider {
  return {
    channel: "email",
    async send() { return { providerMessageId: "re_1" }; },
    webhook: { verify: () => false, parse: () => [] },
  };
}
// A contract-VIOLATING primary whose `verify` THROWS instead of returning false on an unrecognized
// signature (real risk for custom/third-party providers — e.g. a header split or base64 decode on
// absent material). The loop must treat the throw as "did not verify" and try the fallback, never
// abort and swallow a legitimately-signed fallback webhook.
function throwingPrimaryProvider(): EmailProvider {
  return {
    channel: "email",
    async send() { return { providerMessageId: "re_1" }; },
    webhook: { verify: () => { throw new Error("primary can't parse this body"); }, parse: () => [] },
  };
}
function fallbackProvider(events: WebhookEvent[]): EmailProvider {
  return {
    channel: "email", name: "fallback-1",
    async send() { return {}; },
    // Bakes its own secret in, ignoring the passed channel-level `secret` (decision 9's precedent).
    webhook: { verify: (args) => args.headers.get("x-fallback-secret") === "FALLBACK_SECRET", parse: () => events },
  };
}

function comp(fallback: EmailProvider, primary: EmailProvider = primaryProvider()): ComponentDefinition {
  const config = resolveNotificationsConfig({
    channels: { email: { provider: primary, from: "x@test", webhookSecret: "PRIMARY_SECRET", fallbacks: [fallback], templates: { hi: () => ({ subject: "S", text: "T" }) } } },
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
};
async function tick(b: BuiltNotifRuntime): Promise<void> { await (b.driver as { __tick: () => Promise<void> }).__tick(); }
/** Seed one `sent` messages row with `providerMessageId: "re_1"` via a real send + one driver tick
 *  (mirrors `webhook-apply.test.ts`'s `seed()`). */
async function seed(built: BuiltNotifRuntime): Promise<void> {
  await built.runtime.run("app:send", { to: { email: "u@test" }, channels: ["email"], template: "hi" });
  await tick(built);
  expect((await built.readTable("notifications/messages"))[0]).toMatchObject({ status: "sent", providerMessageId: "re_1" });
}

let built: BuiltNotifRuntime;
afterEach(async () => { await built?.close(); });

describe("notifications — fallback webhook verify loop", () => {
  it("verifies against the FALLBACK provider's own secret when the primary's doesn't match", async () => {
    built = await makeNotifRuntime(comp(fallbackProvider([{ providerMessageId: "re_1", deliveryStatus: "delivered" }])), appModules);
    await seed(built);
    const req = new Request("https://app.test/api/notifications/webhooks/email", {
      method: "POST", headers: { "x-fallback-secret": "FALLBACK_SECRET" }, body: "{}",
    });
    const res = await built.runtime.runHttpAction("notifications:webhookHttp", req);
    expect(res.status).toBe(200);
    expect((await built.readTable("notifications/messages"))[0]).toMatchObject({ deliveryStatus: "delivered" });
  });

  it("401s when NEITHER provider's verify matches", async () => {
    built = await makeNotifRuntime(comp(fallbackProvider([])), appModules);
    const req = new Request("https://app.test/api/notifications/webhooks/email", { method: "POST", headers: {}, body: "{}" });
    const res = await built.runtime.runHttpAction("notifications:webhookHttp", req);
    expect(res.status).toBe(401);
  });

  it("a THROWING primary verify does not swallow a legitimately-signed FALLBACK webhook — the loop continues past the throw", async () => {
    built = await makeNotifRuntime(
      comp(fallbackProvider([{ providerMessageId: "re_1", deliveryStatus: "delivered" }]), throwingPrimaryProvider()),
      appModules,
    );
    await seed(built);
    const req = new Request("https://app.test/api/notifications/webhooks/email", {
      method: "POST", headers: { "x-fallback-secret": "FALLBACK_SECRET" }, body: "{}",
    });
    const res = await built.runtime.runHttpAction("notifications:webhookHttp", req);
    expect(res.status).toBe(200); // NOT a 500 — the primary's throw was treated as "did not verify"
    expect((await built.readTable("notifications/messages"))[0]).toMatchObject({ deliveryStatus: "delivered" });
  });

  it("401s (never 500) when the only provider's verify THROWS and nothing else matches", async () => {
    built = await makeNotifRuntime(comp(fallbackProvider([]), throwingPrimaryProvider()), appModules);
    const req = new Request("https://app.test/api/notifications/webhooks/email", { method: "POST", headers: {}, body: "{}" });
    const res = await built.runtime.runHttpAction("notifications:webhookHttp", req);
    expect(res.status).toBe(401); // a throw fails CLOSED — never accepted, never a 500
  });
});
