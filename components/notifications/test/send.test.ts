import { describe, it, expect, afterEach } from "vitest";
import { defineComponent, type ComponentDefinition } from "@helipod/component";
import { mutation, type RegisteredFunction } from "@helipod/executor";
import { notificationsSchema } from "../src/schema";
import { resolveNotificationsConfig } from "../src/config";
import { makeSendModules } from "../src/modules";
import { notificationsContext } from "../src/facade";
import { makeNotifRuntime, captureEmail, type BuiltNotifRuntime } from "./helpers";

// Assemble a driver-less notifications component (send path only) so this test needs only T1+T3.
function sendOnlyComponent(): { component: ComponentDefinition; captured: ReturnType<typeof captureEmail> } {
  const captured = captureEmail();
  const config = resolveNotificationsConfig({
    channels: {
      email: { provider: captured.provider, from: "no-reply@test", templates: { welcome: () => ({ subject: "Welcome", text: "hi" }) } },
      in_app: { enabled: true, templates: { welcome: () => ({ title: "Welcome", body: "hi there", kind: "greeting" }) } },
    },
  });
  const component = defineComponent({
    name: "notifications",
    schema: notificationsSchema,
    modules: makeSendModules(config),
    context: (cctx) => notificationsContext(cctx, config),
    contextWrite: true,
  });
  return { component, captured };
}

const appModules: Record<string, RegisteredFunction> = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  "app:send": mutation(async (ctx: any, args: any) => ctx.notifications.send(args)),
};

let built: BuiltNotifRuntime;
afterEach(async () => { await built?.close(); });

describe("ctx.notifications.send — record path", () => {
  it("writes a messages row per channel; in_app also writes the inbox row instantly", async () => {
    const { component } = sendOnlyComponent();
    built = await makeNotifRuntime(component, appModules);
    const res = (await built.runtime.run("app:send", {
      to: { userId: "u1", email: "u1@test" }, channels: ["in_app", "email"], template: "welcome", data: { name: "Ann" },
    })).value as { messageIds: string[] };
    expect(res.messageIds.length).toBe(2);

    const messages = await built.readTable("notifications/messages");
    expect(messages.map((m) => `${m.channel}:${m.status}`).sort()).toEqual(["email:queued", "in_app:sent"]);

    const inbox = await built.readTable("notifications/notifications");
    expect(inbox.length).toBe(1);
    expect(inbox[0]).toMatchObject({ userId: "u1", title: "Welcome", body: "hi there", read: false });

    // email row carries the rendered payload for the driver; nothing sent yet (no driver here).
    const emailRow = messages.find((m) => m.channel === "email")!;
    expect(emailRow.payload).toEqual({ subject: "Welcome", text: "hi" });
  });

  it("is transactional — a mutation that throws after send leaves no rows", async () => {
    const { component } = sendOnlyComponent();
    built = await makeNotifRuntime(component, {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      "app:boom": mutation(async (ctx: any) => { await ctx.notifications.send({ to: { userId: "u1" }, channels: ["in_app"], template: "welcome" }); throw new Error("rollback"); }),
    });
    await expect(built.runtime.run("app:boom", {})).rejects.toThrow(/rollback/);
    expect((await built.readTable("notifications/messages")).length).toBe(0);
    expect((await built.readTable("notifications/notifications")).length).toBe(0);
  });

  it("idempotency: a replay with the same key returns the recorded ids and writes no new rows", async () => {
    const { component } = sendOnlyComponent();
    built = await makeNotifRuntime(component, appModules);
    const a = (await built.runtime.run("app:send", { to: { userId: "u1", email: "u1@test" }, channels: ["email"], template: "welcome", idempotencyKey: "otp-1" })).value as { messageIds: string[] };
    const b = (await built.runtime.run("app:send", { to: { userId: "u1", email: "u1@test" }, channels: ["email"], template: "welcome", idempotencyKey: "otp-1" })).value as { messageIds: string[] };
    expect(b.messageIds).toEqual(a.messageIds);
    expect((await built.readTable("notifications/messages")).length).toBe(1);
    expect((await built.readTable("notifications/sendReceipts")).length).toBe(1);
  });

  it("idempotency under concurrency: two same-key sends race to ONE winner (single-writer OCC)", async () => {
    const { component } = sendOnlyComponent();
    built = await makeNotifRuntime(component, appModules);
    const args = { to: { userId: "u1", email: "u1@test" }, channels: ["email"], template: "welcome", idempotencyKey: "otp-race" };
    const [a, b] = await Promise.all([
      built.runtime.run("app:send", args).then((r) => r.value as { messageIds: string[] }),
      built.runtime.run("app:send", args).then((r) => r.value as { messageIds: string[] }),
    ]);
    // Both callers observe the SAME single winning message id; the loser re-validated its stale
    // empty `sendReceipts` read under OCC and dedup'd rather than writing a second row.
    expect(a.messageIds).toEqual(b.messageIds);
    expect((await built.readTable("notifications/messages")).length).toBe(1);
    expect((await built.readTable("notifications/sendReceipts")).length).toBe(1);
  });

  it("dedupes duplicate channels — [\"email\",\"email\"] is one logical send, one row", async () => {
    const { component } = sendOnlyComponent();
    built = await makeNotifRuntime(component, appModules);
    const res = (await built.runtime.run("app:send", {
      to: { userId: "u1", email: "u1@test" }, channels: ["email", "email"], template: "welcome",
    })).value as { messageIds: string[] };
    expect(res.messageIds.length).toBe(1);
    expect((await built.readTable("notifications/messages")).length).toBe(1);
  });

  it("rejects a channel that is not configured", async () => {
    const { component } = sendOnlyComponent(); // no sms channel
    built = await makeNotifRuntime(component, appModules);
    await expect(built.runtime.run("app:send", { to: { phone: "+1" }, channels: ["sms"], template: "welcome" })).rejects.toThrow(/"sms" channel is not configured/);
  });
});
