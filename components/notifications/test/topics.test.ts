import { describe, it, expect, afterEach } from "vitest";
import { defineComponent, type ComponentDefinition } from "@stackbase/component";
import { mutation, type RegisteredFunction } from "@stackbase/executor";
import { notificationsSchema } from "../src/schema";
import { resolveNotificationsConfig } from "../src/config";
import { makeSendModules } from "../src/modules";
import { makeTopicModules } from "../src/topics";
import { notificationsContext } from "../src/facade";
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
});
