import { describe, it, expect, afterEach } from "vitest";
import { defineComponent, type ComponentDefinition } from "@helipod/component";
import { mutation, type RegisteredFunction } from "@helipod/executor";
import { NotificationSendError, type PushProvider, type PushSendResult } from "../src/provider";
import { notificationsSchema } from "../src/schema";
import { resolveNotificationsConfig } from "../src/config";
import { makeSendModules } from "../src/modules";
import { makePushModules } from "../src/push";
import { notificationsContext } from "../src/facade";
import { notificationsDriver } from "../src/driver";
import { makeNotifRuntime, type BuiltNotifRuntime } from "./helpers";

describe("push channel — seam types", () => {
  it("a minimal PushProvider satisfies the interface", async () => {
    const captured: unknown[] = [];
    const provider: PushProvider = {
      channel: "push",
      async send(m): Promise<PushSendResult> { captured.push(m); return { providerMessageId: "x" }; },
    };
    const res = await provider.send({ to: ["tok1"], title: "T", body: "B" });
    expect(res.providerMessageId).toBe("x");
    expect(captured).toHaveLength(1);
  });
});

function comp(): ComponentDefinition {
  const config = resolveNotificationsConfig({ channels: {} });
  return defineComponent({
    name: "notifications", schema: notificationsSchema,
    modules: { ...makeSendModules(config), ...makePushModules(config) },
    context: (cctx) => notificationsContext(cctx, config), contextWrite: true,
  });
}
const appModules: Record<string, RegisteredFunction> = {};

describe("push channel — device-token registry", () => {
  let built: BuiltNotifRuntime;
  afterEach(async () => { await built?.close(); });

  it("registerPushToken is self-only and upserts by token", async () => {
    built = await makeNotifRuntime(comp(), appModules);
    await built.runtime.run("notifications:registerPushToken", { token: "tok1", provider: "expo" }, { identity: "u1" });
    let rows = await built.readTable("notifications/pushTokens");
    expect(rows).toMatchObject([{ userId: "u1", token: "tok1", provider: "expo" }]);

    // Re-registering the SAME token under a different caller reassigns it (device changed owner).
    await built.runtime.run("notifications:registerPushToken", { token: "tok1", provider: "fcm", platform: "android" }, { identity: "u2" });
    rows = await built.readTable("notifications/pushTokens");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ userId: "u2", token: "tok1", provider: "fcm", platform: "android" });
  });

  it("unregisterPushToken is ownership-checked (a foreign caller's unregister is a no-op)", async () => {
    built = await makeNotifRuntime(comp(), appModules);
    await built.runtime.run("notifications:registerPushToken", { token: "tok2", provider: "expo" }, { identity: "u1" });
    await built.runtime.run("notifications:unregisterPushToken", { token: "tok2" }, { identity: "u2" }); // foreign — no-op
    expect(await built.readTable("notifications/pushTokens")).toHaveLength(1);
    await built.runtime.run("notifications:unregisterPushToken", { token: "tok2" }, { identity: "u1" }); // owner — removes
    expect(await built.readTable("notifications/pushTokens")).toHaveLength(0);
  });

  it("a client-supplied userId arg is IGNORED on the registered module (self-only)", async () => {
    built = await makeNotifRuntime(comp(), appModules);
    // No `userId` field even accepted by the type — this proves the RUNTIME behavior: even if an
    // attacker's raw JSON smuggles one in past the type system, callerId (not the arg) wins.
    await built.runtime.run("notifications:registerPushToken", { token: "tok3", provider: "expo", userId: "victim" } as never, { identity: "attacker" });
    const rows = await built.readTable("notifications/pushTokens");
    expect(rows[0]!.userId).toBe("attacker"); // NOT "victim"
  });
});

function captureProvider(onSend: (m: { to: string[]; title: string; body: string }) => PushSendResult): PushProvider {
  return { channel: "push", async send(m) { return onSend(m); } };
}

function compWithPush(providers: { expo?: PushProvider; fcm?: PushProvider }): ComponentDefinition {
  const config = resolveNotificationsConfig({
    channels: { push: { providers, templates: { hi: (d: { name: string }) => ({ title: "Hi", body: `Hello ${d.name}` }) } } },
  });
  return defineComponent({
    name: "notifications", schema: notificationsSchema,
    modules: { ...makeSendModules(config), ...makePushModules(config) },
    context: (cctx) => notificationsContext(cctx, config), contextWrite: true,
    driver: notificationsDriver(config),
  });
}

describe("push channel — send + driver delivery", () => {
  let built: BuiltNotifRuntime;
  afterEach(async () => { await built?.close(); });

  it("one messages row per send, fanned out across 2 providers, delivered by the driver", async () => {
    const calls: Array<{ to: string[] }> = [];
    const expo = captureProvider((m) => { calls.push({ to: m.to }); return { providerMessageId: "exp1" }; });
    const fcm = captureProvider((m) => { calls.push({ to: m.to }); return { providerMessageId: "fcm1" }; });
    built = await makeNotifRuntime(compWithPush({ expo, fcm }), {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      "app:send": mutation(async (ctx: any, a: any) => ctx.notifications.send(a)),
    });
    await built.runtime.run("notifications:registerPushToken", { token: "e1", provider: "expo" }, { identity: "u1" });
    await built.runtime.run("notifications:registerPushToken", { token: "f1", provider: "fcm" }, { identity: "u1" });
    await built.runtime.run("app:send", { to: { userId: "u1" }, channels: ["push"], template: "hi", data: { name: "Ada" } }, { identity: "u1" });

    expect((await built.readTable("notifications/messages")).filter((r) => r.channel === "push")).toHaveLength(1);
    await (built.driver as { __tick: () => Promise<void> }).__tick();
    expect(calls.map((c) => c.to).sort()).toEqual([["e1"], ["f1"]]);
    const row = (await built.readTable("notifications/messages")).find((r) => r.channel === "push")!;
    expect(row.status).toBe("sent");
  });

  it("zero registered devices: enqueued, then marked sent with NO provider call", async () => {
    const expo = captureProvider(() => { throw new Error("should not be called"); });
    built = await makeNotifRuntime(compWithPush({ expo }), {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      "app:send": mutation(async (ctx: any, a: any) => ctx.notifications.send(a)),
    });
    await built.runtime.run("app:send", { to: { userId: "ghost" }, channels: ["push"], template: "hi", data: { name: "X" } }, { identity: "ghost" });
    await (built.driver as { __tick: () => Promise<void> }).__tick();
    const row = (await built.readTable("notifications/messages")).find((r) => r.channel === "push")!;
    expect(row.status).toBe("sent");
  });

  it("invalid tokens are pruned after delivery", async () => {
    const expo = captureProvider(() => ({ invalidTokens: ["stale1"] }));
    built = await makeNotifRuntime(compWithPush({ expo }), {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      "app:send": mutation(async (ctx: any, a: any) => ctx.notifications.send(a)),
    });
    await built.runtime.run("notifications:registerPushToken", { token: "stale1", provider: "expo" }, { identity: "u1" });
    await built.runtime.run("app:send", { to: { userId: "u1" }, channels: ["push"], template: "hi", data: { name: "X" } }, { identity: "u1" });
    await (built.driver as { __tick: () => Promise<void> }).__tick();
    expect(await built.readTable("notifications/pushTokens")).toHaveLength(0);
  });

  it("invalid tokens identified before a FAILED attempt are still pruned (carried on the thrown error), not lost with the failure", async () => {
    // A provider that found one token permanently invalid but then hit a transient failure — it throws
    // retryably with the invalid token attached. The attempt re-queues AND the dead token is pruned.
    const expo: PushProvider = {
      channel: "push",
      async send() { throw new NotificationSendError("transient after finding a dead token", { retryable: true, invalidTokens: ["dead1"] }); },
    };
    built = await makeNotifRuntime(compWithPush({ expo }), {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      "app:send": mutation(async (ctx: any, a: any) => ctx.notifications.send(a)),
    });
    await built.runtime.run("notifications:registerPushToken", { token: "dead1", provider: "expo" }, { identity: "u1" });
    await built.runtime.run("app:send", { to: { userId: "u1" }, channels: ["push"], template: "hi", data: { name: "X" } }, { identity: "u1" });
    await (built.driver as { __tick: () => Promise<void> }).__tick();
    const row = (await built.readTable("notifications/messages")).find((r) => r.channel === "push")!;
    expect(row.status).toBe("queued"); // retryable failure → re-queued
    expect(await built.readTable("notifications/pushTokens")).toHaveLength(0); // dead token pruned despite the failure
  });

  it("one provider group has a RETRYABLE failure while another succeeds: the whole message re-queues (disjoint device sets — the failed group's devices must not be silently stranded)", async () => {
    const expo = captureProvider(() => ({ providerMessageId: "ok" }));
    // A plain Error is retryable-by-default. Push groups are DISJOINT devices, so expo succeeding does
    // NOT deliver the fcm device — the message must retry, not be marked sent.
    const fcm: PushProvider = { channel: "push", async send() { throw new Error("network down"); } };
    built = await makeNotifRuntime(compWithPush({ expo, fcm }), {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      "app:send": mutation(async (ctx: any, a: any) => ctx.notifications.send(a)),
    });
    await built.runtime.run("notifications:registerPushToken", { token: "e1", provider: "expo" }, { identity: "u1" });
    await built.runtime.run("notifications:registerPushToken", { token: "f1", provider: "fcm" }, { identity: "u1" });
    await built.runtime.run("app:send", { to: { userId: "u1" }, channels: ["push"], template: "hi", data: { name: "X" } }, { identity: "u1" });
    await (built.driver as { __tick: () => Promise<void> }).__tick();
    const row = (await built.readTable("notifications/messages")).find((r) => r.channel === "push")!;
    expect(row.status).toBe("queued"); // re-queued for retry (NOT silently sent with the fcm device dropped)
    expect(row.attempts).toBe(1);
  });

  it("one provider group has a PERMANENT failure while another succeeds: row is sent (retry can't help a permanent failure), no re-delivery on the next tick", async () => {
    let fcmCalls = 0;
    const expo = captureProvider(() => ({ providerMessageId: "ok" }));
    // A non-retryable NotificationSendError = a permanent failure (e.g. a bad app config for that
    // provider). Retrying won't help, and another group DID deliver, so the row is terminal-sent.
    const fcm: PushProvider = { channel: "push", async send() { fcmCalls++; throw new NotificationSendError("bad fcm config", { retryable: false }); } };
    built = await makeNotifRuntime(compWithPush({ expo, fcm }), {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      "app:send": mutation(async (ctx: any, a: any) => ctx.notifications.send(a)),
    });
    await built.runtime.run("notifications:registerPushToken", { token: "e1", provider: "expo" }, { identity: "u1" });
    await built.runtime.run("notifications:registerPushToken", { token: "f1", provider: "fcm" }, { identity: "u1" });
    await built.runtime.run("app:send", { to: { userId: "u1" }, channels: ["push"], template: "hi", data: { name: "X" } }, { identity: "u1" });
    await (built.driver as { __tick: () => Promise<void> }).__tick();
    const row = (await built.readTable("notifications/messages")).find((r) => r.channel === "push")!;
    expect(row.status).toBe("sent"); // only permanent failures remain + a success → terminal
    await (built.driver as { __tick: () => Promise<void> }).__tick();
    expect(fcmCalls).toBe(1); // no re-delivery
  });

  it("every provider group throws: retries per N2 backoff", async () => {
    const expo: PushProvider = { channel: "push", async send() { throw new Error("down"); } };
    built = await makeNotifRuntime(compWithPush({ expo }), {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      "app:send": mutation(async (ctx: any, a: any) => ctx.notifications.send(a)),
    });
    await built.runtime.run("notifications:registerPushToken", { token: "e1", provider: "expo" }, { identity: "u1" });
    await built.runtime.run("app:send", { to: { userId: "u1" }, channels: ["push"], template: "hi", data: { name: "X" } }, { identity: "u1" });
    await (built.driver as { __tick: () => Promise<void> }).__tick();
    const row = (await built.readTable("notifications/messages")).find((r) => r.channel === "push")!;
    expect(row.status).toBe("queued"); // retrying, not dead-lettered yet (matches N2's email/sms retry test shape)
    expect(row.attempts).toBe(1);
  });
});
