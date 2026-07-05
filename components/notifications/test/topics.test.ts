import { describe, it, expect, afterEach } from "vitest";
import { defineComponent, type ComponentDefinition } from "@helipod/component";
import { mutation, action, type RegisteredFunction } from "@helipod/executor";
import { notificationsSchema } from "../src/schema";
import { resolveNotificationsConfig } from "../src/config";
import { makeSendModules } from "../src/modules";
import { makeTopicModules } from "../src/topics";
import { makePreferenceModules } from "../src/preferences";
import { notificationsContext, notificationsActionContext } from "../src/facade";
import { makeNotifRuntime, type BuiltNotifRuntime } from "./helpers";

function comp(): ComponentDefinition {
  const config = resolveNotificationsConfig({ channels: { in_app: { enabled: true, templates: { hi: () => ({ title: "T", body: "B" }) } } } });
  return defineComponent({
    name: "notifications", schema: notificationsSchema,
    modules: { ...makeSendModules(config), ...makeTopicModules(config) },
    context: (cctx) => notificationsContext(cctx, config), contextWrite: true,
  });
}
const appModules: Record<string, RegisteredFunction> = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  "app:sub": mutation(async (ctx: any, a: any) => ctx.notifications.subscribe(a)),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  "app:unsub": mutation(async (ctx: any, a: any) => ctx.notifications.unsubscribe(a)),
};
let built: BuiltNotifRuntime;
afterEach(async () => { await built?.close(); });

describe("notifications N3 — topics subscription", () => {
  it("subscribe is idempotent; unsubscribe removes; explicit userId is server-controlled", async () => {
    built = await makeNotifRuntime(comp(), appModules);
    await built.runtime.run("app:sub", { topic: "news", userId: "u1" });
    await built.runtime.run("app:sub", { topic: "news", userId: "u1" }); // idempotent
    await built.runtime.run("app:sub", { topic: "news", userId: "u2" });
    expect((await built.readTable("notifications/topicSubscriptions")).length).toBe(2);
    await built.runtime.run("app:unsub", { topic: "news", userId: "u1" });
    const rows = await built.readTable("notifications/topicSubscriptions");
    expect(rows.map((r) => r.userId)).toEqual(["u2"]);
  });

  it("subscribe defaults to the caller when userId is omitted", async () => {
    built = await makeNotifRuntime(comp(), appModules);
    await built.runtime.run("app:sub", { topic: "news" }, { identity: "u9" });
    expect((await built.readTable("notifications/topicSubscriptions"))[0]).toMatchObject({ topic: "news", userId: "u9" });
  });

  it("the client-callable subscribe/unsubscribe modules are SELF-ONLY — a forged userId arg is ignored (IDOR guard)", async () => {
    built = await makeNotifRuntime(comp(), appModules);
    // A client calls the REGISTERED module directly (`notifications:subscribe` is client-callable) with
    // a forged userId; it must subscribe the CALLER, never the arg'd victim (the userId override is
    // facade-only, reachable only from server-side app code).
    await built.runtime.run("notifications:subscribe", { topic: "news", userId: "victim" } as never, { identity: "attacker" });
    let rows = await built.readTable("notifications/topicSubscriptions");
    expect(rows.map((r) => r.userId)).toEqual(["attacker"]); // NOT "victim"
    // Seed victim (via the server facade) then try to unsubscribe them with a forged userId — must fail
    // to touch victim's row (it unsubscribes the caller instead).
    await built.runtime.run("app:sub", { topic: "news", userId: "victim" });
    await built.runtime.run("notifications:unsubscribe", { topic: "news", userId: "victim" } as never, { identity: "attacker" });
    rows = await built.readTable("notifications/topicSubscriptions");
    expect(rows.map((r) => r.userId)).toEqual(["victim"]); // attacker removed self; victim untouched
  });
});

describe("notifications N3 — sendToTopic fan-out", () => {
  it("fans out to subscribers, honors preferences, dedups on re-run", async () => {
    const config = resolveNotificationsConfig({ channels: { in_app: { enabled: true, templates: { hi: () => ({ title: "T", body: "B" }) } } } });
    const component = defineComponent({
      name: "notifications", schema: notificationsSchema,
      modules: { ...makeSendModules(config), ...makeTopicModules(config), ...makePreferenceModules(config) },
      context: (cctx) => notificationsContext(cctx, config), contextWrite: true,
      buildAction: (api) => notificationsActionContext(api, config),
    });
    built = await makeNotifRuntime(component, {
      ...appModules,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      "app:setPref": mutation(async (ctx: any, a: any) => ctx.notifications.setPreference(a)),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      "app:topicSend": action(async (ctx: any, a: any) => ctx.notifications.sendToTopic(a)),
    });
    for (const u of ["u1", "u2", "u3"]) await built.runtime.run("app:sub", { topic: "news", userId: u });
    await built.runtime.run("app:setPref", { category: "marketing", channel: "in_app", enabled: false }, { identity: "u2" });

    const r1 = (await built.runtime.runAction("app:topicSend", {
      topic: "news", channels: ["in_app"], template: "hi", category: "marketing", idempotencyKey: "b1",
    })).value as { recipientCount: number; sentCount: number; suppressedCount: number };
    expect(r1).toEqual({ recipientCount: 3, sentCount: 2, suppressedCount: 1 });
    const inbox = await built.readTable("notifications/notifications");
    expect(inbox.map((r) => r.userId).sort()).toEqual(["u1", "u3"]);

    // Re-run same key → per-subscriber dedup, no new rows.
    await built.runtime.runAction("app:topicSend", {
      topic: "news", channels: ["in_app"], template: "hi", category: "marketing", idempotencyKey: "b1",
    });
    expect((await built.readTable("notifications/notifications")).length).toBe(2);
  });

  it("rejects an email/SMS topic send fast (topics only know a userId, not an address) — no partial work", async () => {
    const config = resolveNotificationsConfig({ channels: { in_app: { enabled: true, templates: { hi: () => ({ title: "T", body: "B" }) } }, email: { provider: { channel: "email", async send() { return {}; } }, from: "x@test", templates: { hi: () => ({ subject: "S", text: "T" }) } } } });
    const component = defineComponent({
      name: "notifications", schema: notificationsSchema,
      modules: { ...makeSendModules(config), ...makeTopicModules(config) },
      context: (cctx) => notificationsContext(cctx, config), contextWrite: true,
      buildAction: (api) => notificationsActionContext(api, config),
    });
    built = await makeNotifRuntime(component, {
      ...appModules,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      "app:topicSend": action(async (ctx: any, a: any) => ctx.notifications.sendToTopic(a)),
    });
    await built.runtime.run("app:sub", { topic: "news", userId: "u1" });
    // Fails BEFORE any page/DB write (the guard is at the top of sendToTopic).
    await expect(built.runtime.runAction("app:topicSend", { topic: "news", channels: ["email"], template: "hi" }))
      .rejects.toThrow(/only "in_app"\/"push" channels/);
    expect((await built.readTable("notifications/messages")).length).toBe(0); // no partial work
  });
});
