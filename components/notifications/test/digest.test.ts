import { describe, it, expect, afterEach } from "vitest";
import { defineComponent, type ComponentDefinition } from "@stackbase/component";
import { mutation, type RegisteredFunction } from "@stackbase/executor";
import { notificationsSchema } from "../src/schema";
import { resolveNotificationsConfig } from "../src/config";
import { makeSendModules } from "../src/modules";
import { notificationsContext } from "../src/facade";
import { makeNotifRuntime, type BuiltNotifRuntime } from "./helpers";

function comp(): ComponentDefinition {
  const config = resolveNotificationsConfig({
    channels: {
      email: { provider: { channel: "email", async send() { return {}; } }, from: "x@test", templates: { hi: () => ({ subject: "S", text: "T" }) } },
      in_app: { enabled: true, templates: { hi: () => ({ title: "Ti", body: "B" }) } },
    },
    categories: { updates: { digest: "daily" } },
  });
  return defineComponent({
    name: "notifications", schema: notificationsSchema, modules: makeSendModules(config),
    context: (cctx) => notificationsContext(cctx, config), contextWrite: true,
  });
}
const appModules: Record<string, RegisteredFunction> = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  "app:send": mutation(async (ctx: any, a: any) => ctx.notifications.send(a)),
};
let built: BuiltNotifRuntime;
afterEach(async () => { await built?.close(); });

describe("notifications N4 — email digest buffering", () => {
  it("a digest-category email is buffered (no messages row) and reported deferred", async () => {
    built = await makeNotifRuntime(comp(), appModules);
    const res = (await built.runtime.run("app:send", { to: { userId: "u1", email: "u1@test" }, channels: ["email"], template: "hi", category: "updates" })).value as { messageIds: string[]; deferred: string[] };
    expect(res.deferred).toEqual(["email"]);
    expect((await built.readTable("notifications/messages")).length).toBe(0);   // NOT enqueued
    expect((await built.readTable("notifications/digestBuffer")).length).toBe(1);
    expect((await built.readTable("notifications/digestBuffer"))[0]).toMatchObject({ email: "u1@test", category: "updates", subject: "S" });
  });
  it("in_app on a digest category is immediate (not buffered)", async () => {
    built = await makeNotifRuntime(comp(), appModules);
    await built.runtime.run("app:send", { to: { userId: "u1", email: "u1@test" }, channels: ["in_app"], template: "hi", category: "updates" });
    expect((await built.readTable("notifications/digestBuffer")).length).toBe(0);
    expect((await built.readTable("notifications/notifications")).length).toBe(1);   // inbox row, immediate
  });
  it("a critical digest-category email is immediate (not buffered)", async () => {
    built = await makeNotifRuntime(comp(), appModules);
    await built.runtime.run("app:send", { to: { userId: "u1", email: "u1@test" }, channels: ["email"], template: "hi", category: "updates", critical: true });
    expect((await built.readTable("notifications/digestBuffer")).length).toBe(0);
    expect((await built.readTable("notifications/messages")).length).toBe(1);        // queued, immediate
  });
});
