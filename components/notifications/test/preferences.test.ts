import { describe, it, expect, afterEach } from "vitest";
import { defineComponent, type ComponentDefinition } from "@stackbase/component";
import { mutation, type RegisteredFunction } from "@stackbase/executor";
import { notificationsSchema } from "../src/schema";
import { resolveNotificationsConfig } from "../src/config";
import { makeSendModules } from "../src/modules";
import { makePreferenceModules } from "../src/preferences";
import { notificationsContext } from "../src/facade";
import { makeNotifRuntime, type BuiltNotifRuntime } from "./helpers";
import type { JSONValue } from "@stackbase/values";

function comp(): ComponentDefinition {
  const config = resolveNotificationsConfig({
    channels: {
      email: { provider: { channel: "email", async send() { return {}; } }, from: "x@test", templates: { hi: () => ({ subject: "S", text: "T" }) } },
      in_app: { enabled: true, templates: { hi: () => ({ title: "Hi", body: "B" }) } },
    },
    categories: { security: { critical: true } },
  });
  return defineComponent({
    name: "notifications", schema: notificationsSchema,
    modules: { ...makeSendModules(config), ...makePreferenceModules(config) },
    context: (cctx) => notificationsContext(cctx, config), contextWrite: true,
  });
}

const appModules: Record<string, RegisteredFunction> = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  "app:send": mutation(async (ctx: any, args: any) => ctx.notifications.send(args)),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  "app:setPref": mutation(async (ctx: any, args: any) => ctx.notifications.setPreference(args)),
};
async function runAs(built: BuiltNotifRuntime, identity: string | null, path: string, args: JSONValue): Promise<unknown> {
  return (await built.runtime.run(path, args, { identity })).value;
}

let built: BuiltNotifRuntime;
afterEach(async () => { await built?.close(); });

describe("notifications N3 — preference gate", () => {
  it("suppresses a channel the user opted out of (and reports it)", async () => {
    built = await makeNotifRuntime(comp(), appModules);
    // u1 opts out of marketing email.
    await runAs(built, "u1", "app:setPref", { category: "marketing", channel: "email", enabled: false });
    const res = (await runAs(built, "u1", "app:send", {
      to: { userId: "u1", email: "u1@test" }, channels: ["in_app", "email"], template: "hi", category: "marketing",
    })) as { messageIds: string[]; suppressed: string[] };
    expect(res.suppressed).toEqual(["email"]);
    const rows = await built.readTable("notifications/messages");
    expect(rows.map((r) => r.channel).sort()).toEqual(["in_app"]); // no email row
  });

  it("default-allow: no preference row → the channel sends", async () => {
    built = await makeNotifRuntime(comp(), appModules);
    const res = (await runAs(built, "u1", "app:send", { to: { userId: "u1", email: "u1@test" }, channels: ["email"], template: "hi", category: "marketing" })) as { messageIds: string[]; suppressed: string[] };
    expect(res.suppressed).toEqual([]);
    expect((await built.readTable("notifications/messages")).length).toBe(1);
  });

  it("a critical category ignores an opt-out and delivers", async () => {
    built = await makeNotifRuntime(comp(), appModules);
    // Even if a stale opt-out row existed, a critical category bypasses it. (The setter refuses to
    // create one — tested in T2 — so we assert the gate side here via a non-critical opt-out that a
    // critical send is unaffected by: opt out of "security" email is impossible, so use the config.)
    const res = (await runAs(built, "u1", "app:send", { to: { userId: "u1", email: "u1@test" }, channels: ["email"], template: "hi", category: "security" })) as { messageIds: string[]; suppressed: string[] };
    expect(res.suppressed).toEqual([]);
    expect((await built.readTable("notifications/messages")).length).toBe(1);
  });

  it("a recipient with no userId is never gated", async () => {
    built = await makeNotifRuntime(comp(), appModules);
    const res = (await runAs(built, null, "app:send", { to: { email: "anon@test" }, channels: ["email"], template: "hi", category: "marketing" })) as { messageIds: string[]; suppressed: string[] };
    expect(res.suppressed).toEqual([]);
    expect((await built.readTable("notifications/messages")).length).toBe(1);
  });
});

describe("notifications N3 — preference API", () => {
  it("getPreferences returns only the caller's own rows", async () => {
    built = await makeNotifRuntime(comp(), appModules);
    await runAs(built, "u1", "app:setPref", { category: "marketing", channel: "sms", enabled: false });
    await runAs(built, "u2", "app:setPref", { category: "marketing", channel: "email", enabled: false });

    const u1Prefs = (await runAs(built, "u1", "notifications:getPreferences", {})) as Array<{ category: string; channel?: string; enabled: boolean }>;
    expect(u1Prefs).toEqual([{ category: "marketing", channel: "sms", enabled: false }]);

    const u2Prefs = (await runAs(built, "u2", "notifications:getPreferences", {})) as Array<{ category: string; channel?: string; enabled: boolean }>;
    expect(u2Prefs).toEqual([{ category: "marketing", channel: "email", enabled: false }]);
  });

  it("setting a critical category disabled throws", async () => {
    built = await makeNotifRuntime(comp(), appModules);
    await expect(runAs(built, "u1", "app:setPref", { category: "security", enabled: false })).rejects.toThrow(/critical/);
  });

  it("a channel-specific opt-out overrides a category-wide allow", async () => {
    built = await makeNotifRuntime(comp(), appModules);
    // Category-wide allow for marketing (explicit true), but email is specifically opted out.
    await runAs(built, "u1", "app:setPref", { category: "marketing", enabled: true });
    await runAs(built, "u1", "app:setPref", { category: "marketing", channel: "email", enabled: false });

    const res = (await runAs(built, "u1", "app:send", {
      to: { userId: "u1", email: "u1@test" }, channels: ["in_app", "email"], template: "hi", category: "marketing",
    })) as { messageIds: string[]; suppressed: string[] };
    expect(res.suppressed).toEqual(["email"]);
    const rows = await built.readTable("notifications/messages");
    expect(rows.map((r) => r.channel).sort()).toEqual(["in_app"]);
  });
});
