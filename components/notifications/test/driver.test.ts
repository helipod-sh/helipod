import { describe, it, expect, afterEach } from "vitest";
import { defineComponent, type ComponentDefinition } from "@stackbase/component";
import { mutation, type RegisteredFunction } from "@stackbase/executor";
import { notificationsSchema } from "../src/schema";
import { resolveNotificationsConfig } from "../src/config";
import { makeSendModules } from "../src/modules";
import { notificationsContext } from "../src/facade";
import { notificationsDriver } from "../src/driver";
import { makeNotifRuntime, captureEmail, type BuiltNotifRuntime } from "./helpers";

function driverComponent(fail = false): { component: ComponentDefinition; captured: ReturnType<typeof captureEmail> } {
  const captured = captureEmail({ fail });
  const config = resolveNotificationsConfig({
    channels: { email: { provider: captured.provider, from: "no-reply@test", templates: { hi: () => ({ subject: "S", text: "T" }) } } },
    driverIntervalMs: 10_000, // long — the test drives via __tick, not the timer
  });
  const component = defineComponent({
    name: "notifications",
    schema: notificationsSchema,
    modules: makeSendModules(config),
    context: (cctx) => notificationsContext(cctx, config),
    contextWrite: true,
    driver: notificationsDriver(config),
  });
  return { component, captured };
}

const appModules: Record<string, RegisteredFunction> = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  "app:send": mutation(async (ctx: any, args: any) => ctx.notifications.send(args)),
};

let built: BuiltNotifRuntime;
afterEach(async () => { await built?.close(); });

describe("notifications driver — queued-send delivery", () => {
  it("delivers a queued email and marks the row sent with the provider id", async () => {
    const { component, captured } = driverComponent();
    built = await makeNotifRuntime(component, appModules);
    await built.runtime.run("app:send", { to: { email: "u@test" }, channels: ["email"], template: "hi" });

    await (built.driver as { __tick: () => Promise<void> }).__tick();

    expect(captured.sent.length).toBe(1);
    // Auto-derived provider Idempotency-Key = `msg:<rowId>` (defense-in-depth).
    expect(captured.sent[0]!.idempotencyKey).toMatch(/^msg:/);
    expect(captured.sent[0]).toMatchObject({ to: "u@test", from: "no-reply@test", subject: "S", text: "T" });
    const rows = await built.readTable("notifications/messages");
    expect(rows[0]).toMatchObject({ status: "sent", providerMessageId: "cap-1" });
    expect(rows[0]!.payload).toBeUndefined(); // transient payload cleared on delivery
  });

  it("marks the row failed (terminal in N1) when the provider throws", async () => {
    const { component, captured } = driverComponent(true);
    built = await makeNotifRuntime(component, appModules);
    await built.runtime.run("app:send", { to: { email: "u@test" }, channels: ["email"], template: "hi" });
    await (built.driver as { __tick: () => Promise<void> }).__tick();
    expect(captured.sent.length).toBe(1);
    const rows = await built.readTable("notifications/messages");
    expect(rows[0]!.status).toBe("failed");
    expect(String(rows[0]!.error)).toContain("forced failure");
    expect(rows[0]!.payload).toBeUndefined(); // transient payload cleared on failure too
  });

  it("a second tick does not re-deliver an already-sent row", async () => {
    const { component, captured } = driverComponent();
    built = await makeNotifRuntime(component, appModules);
    await built.runtime.run("app:send", { to: { email: "u@test" }, channels: ["email"], template: "hi" });
    await (built.driver as { __tick: () => Promise<void> }).__tick();
    await (built.driver as { __tick: () => Promise<void> }).__tick();
    expect(captured.sent.length).toBe(1); // _peekQueued only returns "queued"; the row is now "sent"
  });
});
