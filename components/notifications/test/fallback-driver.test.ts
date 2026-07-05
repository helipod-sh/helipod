import { describe, it, expect, afterEach } from "vitest";
import { defineComponent, type ComponentDefinition } from "@helipod/component";
import { mutation, type RegisteredFunction } from "@helipod/executor";
import { notificationsSchema } from "../src/schema";
import { resolveNotificationsConfig } from "../src/config";
import { makeSendModules } from "../src/modules";
import { notificationsContext } from "../src/facade";
import { notificationsDriver } from "../src/driver";
import { NotificationSendError, type EmailProvider } from "../src/provider";
import { makeNotifRuntime, type BuiltNotifRuntime } from "./helpers";

function failing(label: string, retryable = true): EmailProvider {
  return { channel: "email", name: label, async send() { throw new NotificationSendError(`${label} down`, { retryable }); } };
}
function okOn(label: string, id: string): EmailProvider {
  return { channel: "email", name: label, async send() { return { providerMessageId: id }; } };
}

function comp(provider: EmailProvider, fallbacks: EmailProvider[], maxAttempts = 4): ComponentDefinition {
  const config = resolveNotificationsConfig({
    channels: { email: { provider, from: "no-reply@test", fallbacks, templates: { hi: () => ({ subject: "S", text: "T" }) } } },
    driverIntervalMs: 10_000,
    retry: { maxAttempts, initialBackoffMs: 0, base: 2 },
  });
  return defineComponent({
    name: "notifications", schema: notificationsSchema, modules: makeSendModules(config),
    context: (cctx) => notificationsContext(cctx, config), contextWrite: true, driver: notificationsDriver(config),
  });
}

const appModules: Record<string, RegisteredFunction> = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  "app:send": mutation(async (ctx: any, args: any) => ctx.notifications.send(args)),
};
async function tick(b: BuiltNotifRuntime) { await (b.driver as { __tick: () => Promise<void> }).__tick(); }

let built: BuiltNotifRuntime;
afterEach(async () => { await built?.close(); });

describe("notifications — fallback in the driver", () => {
  it("delivers via the fallback on the FIRST attempt (no N2 retry ever triggers)", async () => {
    built = await makeNotifRuntime(comp(failing("primary"), [okOn("fallback-1", "id-fb1")]), appModules);
    await built.runtime.run("app:send", { to: { email: "u@test" }, channels: ["email"], template: "hi" });
    await tick(built);
    const row = (await built.readTable("notifications/messages"))[0]!;
    expect(row).toMatchObject({ status: "sent", providerMessageId: "id-fb1", providerName: "fallback-1" });
    expect(row.attempts ?? 0).toBe(0); // never entered N2's retry loop
  });

  it("dead-letters immediately when every provider is non-retryable", async () => {
    built = await makeNotifRuntime(comp(failing("primary", false), [failing("fallback-1", false)]), appModules);
    await built.runtime.run("app:send", { to: { email: "u@test" }, channels: ["email"], template: "hi" });
    await tick(built);
    expect((await built.readTable("notifications/messages"))[0]).toMatchObject({ status: "failed", attempts: 1 });
  });

  it("retries via N2 backoff when primary is 5xx and fallback is 4xx, then restarts from primary next attempt", async () => {
    let primaryCalls = 0;
    const primary: EmailProvider = {
      channel: "email", name: "primary",
      async send() { primaryCalls++; if (primaryCalls === 1) throw new NotificationSendError("down", { retryable: true }); return { providerMessageId: "id-primary-2" }; },
    };
    built = await makeNotifRuntime(comp(primary, [failing("fallback-1", false)]), appModules);
    await built.runtime.run("app:send", { to: { email: "u@test" }, channels: ["email"], template: "hi" });
    await tick(built); // attempt 1: primary 5xx, fallback 4xx → overall retryable → queued, attempts=1
    expect((await built.readTable("notifications/messages"))[0]).toMatchObject({ status: "queued", attempts: 1 });
    await tick(built); // attempt 2: restarts from primary → ok
    expect((await built.readTable("notifications/messages"))[0]).toMatchObject({ status: "sent", providerName: "primary" });
    expect(primaryCalls).toBe(2);
  });
});
