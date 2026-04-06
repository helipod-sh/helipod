import { describe, it, expect, afterEach } from "vitest";
import { defineComponent, type ComponentDefinition } from "@stackbase/component";
import { mutation, type RegisteredFunction } from "@stackbase/executor";
import { notificationsSchema } from "../src/schema";
import { resolveNotificationsConfig } from "../src/config";
import { makeSendModules } from "../src/modules";
import { notificationsContext } from "../src/facade";
import { notificationsDriver } from "../src/driver";
import { NotificationSendError, type EmailProvider } from "../src/provider";
import { makeNotifRuntime, type BuiltNotifRuntime } from "./helpers";

/** An email provider whose behavior is scripted per call. */
function scriptedEmail(script: Array<"ok" | "retryable" | "permanent">): { calls: number; provider: EmailProvider } {
  const state = { calls: 0 };
  return {
    get calls() { return state.calls; },
    provider: {
      channel: "email",
      async send() {
        const step = script[Math.min(state.calls, script.length - 1)];
        state.calls++;
        if (step === "ok") return { providerMessageId: `cap-${state.calls}` };
        if (step === "permanent") throw new NotificationSendError("bad recipient", { retryable: false });
        throw new Error("transient 503");
      },
    },
  };
}

function comp(provider: EmailProvider, opts?: { maxAttempts?: number; reclaimLeaseMs?: number }): ComponentDefinition {
  const config = resolveNotificationsConfig({
    channels: { email: { provider, from: "no-reply@test", templates: { hi: () => ({ subject: "S", text: "T" }) } } },
    driverIntervalMs: 10_000,
    retry: { maxAttempts: opts?.maxAttempts ?? 4, initialBackoffMs: 0, base: 2 },
    reclaimLeaseMs: opts?.reclaimLeaseMs ?? 60_000,
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

describe("notifications N2 — retry + reclaim", () => {
  it("retries a transient failure with backoff and lands sent", async () => {
    const s = scriptedEmail(["retryable", "retryable", "ok"]);
    built = await makeNotifRuntime(comp(s.provider), appModules);
    await built.runtime.run("app:send", { to: { email: "u@test" }, channels: ["email"], template: "hi" });
    await tick(built); // attempt 1 → retryable → queued (attempts=1)
    expect((await built.readTable("notifications/messages"))[0]).toMatchObject({ status: "queued", attempts: 1 });
    await tick(built); // attempt 2 → retryable → queued (attempts=2)
    await tick(built); // attempt 3 → ok → sent
    expect(s.calls).toBe(3);
    const row = (await built.readTable("notifications/messages"))[0]!;
    expect(row).toMatchObject({ status: "sent", providerMessageId: "cap-3" });
    expect(row.payload).toBeUndefined();
  });

  it("dead-letters after maxAttempts on persistent transient failure", async () => {
    const s = scriptedEmail(["retryable"]);
    built = await makeNotifRuntime(comp(s.provider, { maxAttempts: 3 }), appModules);
    await built.runtime.run("app:send", { to: { email: "u@test" }, channels: ["email"], template: "hi" });
    await tick(built); await tick(built); await tick(built);
    expect(s.calls).toBe(3);
    expect((await built.readTable("notifications/messages"))[0]).toMatchObject({ status: "failed", attempts: 3 });
  });

  it("fails immediately (no retry) on a non-retryable error", async () => {
    const s = scriptedEmail(["permanent"]);
    built = await makeNotifRuntime(comp(s.provider), appModules);
    await built.runtime.run("app:send", { to: { email: "u@test" }, channels: ["email"], template: "hi" });
    await tick(built);
    expect(s.calls).toBe(1);
    expect((await built.readTable("notifications/messages"))[0]).toMatchObject({ status: "failed", attempts: 1 });
  });

  it("reclaims a row stuck in `sending` past the lease", async () => {
    const s = scriptedEmail(["ok"]);
    built = await makeNotifRuntime(comp(s.provider, { reclaimLeaseMs: 0 }), appModules);
    await built.runtime.run("app:send", { to: { email: "u@test" }, channels: ["email"], template: "hi" });
    // Claim the row WITHOUT marking it (simulate a crash between claim and _markResult).
    const [row] = await built.readTable("notifications/messages");
    const claimed = (await built.runtime.runSystem<boolean>("_system:claim", { messageId: row!._id as string })).value;
    expect(claimed).toBe(true);
    expect((await built.readTable("notifications/messages"))[0]).toMatchObject({ status: "sending" });
    // With reclaimLeaseMs:0 the next pass reclaims it (→ queued), then delivers it (→ sent).
    await tick(built);
    expect((await built.readTable("notifications/messages"))[0]).toMatchObject({ status: "sent" });
    expect(s.calls).toBe(1);
  });
});
