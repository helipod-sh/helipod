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
  const config = resolveNotificationsConfig({ channels: { in_app: { enabled: true, templates: { hi: () => ({ title: "T", body: "B" }) } } } });
  return defineComponent({
    name: "notifications", schema: notificationsSchema,
    modules: { ...makeSendModules(config), ...makePreferenceModules(config) },
    context: (cctx) => notificationsContext(cctx, config), contextWrite: true,
  });
}
const appModules: Record<string, RegisteredFunction> = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  "app:send": mutation(async (ctx: any, a: any) => ctx.notifications.send(a)),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  "app:setPref": mutation(async (ctx: any, a: any) => ctx.notifications.setPreference(a)),
};
async function runAs(b: BuiltNotifRuntime, id: string | null, p: string, a: JSONValue) { return (await b.runtime.run(p, a, { identity: id })).value; }
let built: BuiltNotifRuntime;
afterEach(async () => { await built?.close(); });

describe("notifications N4 — critical server-authority bypass", () => {
  it("critical:true delivers to an opted-out (category, channel)", async () => {
    built = await makeNotifRuntime(comp(), appModules);
    await runAs(built, "u1", "app:setPref", { category: "security", channel: "in_app", enabled: false });
    const res = (await runAs(built, "u1", "app:send", { to: { userId: "u1" }, channels: ["in_app"], template: "hi", category: "security", critical: true })) as { messageIds: string[]; suppressed: string[] };
    expect(res.suppressed).toEqual([]);            // NOT suppressed despite the opt-out
    expect((await built.readTable("notifications/messages")).length).toBe(1);
  });
  it("without critical, the same opt-out suppresses", async () => {
    built = await makeNotifRuntime(comp(), appModules);
    await runAs(built, "u1", "app:setPref", { category: "security", channel: "in_app", enabled: false });
    const res = (await runAs(built, "u1", "app:send", { to: { userId: "u1" }, channels: ["in_app"], template: "hi", category: "security" })) as { messageIds: string[]; suppressed: string[] };
    expect(res.suppressed).toEqual(["in_app"]);
  });
});
