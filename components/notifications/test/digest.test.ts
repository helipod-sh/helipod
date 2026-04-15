import { describe, it, expect, afterEach } from "vitest";
import { defineComponent, type ComponentDefinition } from "@stackbase/component";
import { mutation, type RegisteredFunction } from "@stackbase/executor";
import { notificationsSchema } from "../src/schema";
import { resolveNotificationsConfig } from "../src/config";
import { makeSendModules } from "../src/modules";
import { makeDigestModules } from "../src/digest";
import { notificationsContext } from "../src/facade";
import { notificationsDriver } from "../src/driver";
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

describe("notifications N4 — digest flush", () => {
  it("flushes buffered items past the window into one combined email; no re-flush", async () => {
    const captured: Array<{ subject: string; text: string }> = [];
    const config = resolveNotificationsConfig({
      channels: { email: { provider: { channel: "email", async send(m) { captured.push({ subject: m.subject, text: m.text }); return { providerMessageId: `cap-${captured.length}` }; } }, from: "x@test", templates: { hi: (d: { n: number }) => ({ subject: `S${d.n}`, text: `body ${d.n}` }) } } },
      categories: { updates: { digest: "hourly" } },
      driverIntervalMs: 10_000,
    });
    const component = defineComponent({
      name: "notifications", schema: notificationsSchema,
      modules: { ...makeSendModules(config), ...makeDigestModules(config) },
      context: (cctx) => notificationsContext(cctx, config), contextWrite: true,
      driver: notificationsDriver(config),
    });
    built = await makeNotifRuntime(component, {
      ...appModules,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      "app:sendN": mutation(async (ctx: any, a: any) => ctx.notifications.send({ to: { email: "u1@test" }, channels: ["email"], template: "hi", data: { n: a.n }, category: "updates" })),
    });
    for (const n of [1, 2, 3]) await built.runtime.run("app:sendN", { n });
    expect((await built.readTable("notifications/digestBuffer")).length).toBe(3);
    // Backdate all buffer rows so they're past the hourly window, then tick.
    await built.runtime.runSystem("_system:backdateDigest", {});
    await (built.driver as { __tick: () => Promise<void> }).__tick();  // flush → one queued email → delivered
    await (built.driver as { __tick: () => Promise<void> }).__tick();  // deliver the flushed email
    expect(captured.length).toBe(1);                                    // ONE combined email
    expect(captured[0]!.text).toContain("body 1");
    expect(captured[0]!.text).toContain("body 3");
    // All buffer rows are flushed; a second flush does not re-send.
    expect((await built.readTable("notifications/digestBuffer")).every((r) => r.flushedAt != null)).toBe(true);
    await (built.driver as { __tick: () => Promise<void> }).__tick();
    expect(captured.length).toBe(1);
  });

  it("a POISON digest group (throwing template) is isolated — it never blocks other delivery", async () => {
    const captured: Array<{ subject: string }> = [];
    const config = resolveNotificationsConfig({
      channels: { email: { provider: { channel: "email", async send(m) { captured.push({ subject: m.subject }); return { providerMessageId: `cap-${captured.length}` }; } }, from: "x@test", templates: { hi: () => ({ subject: "REGULAR", text: "t" }) } } },
      categories: { updates: { digest: "hourly" } },
      digestTemplates: { updates: () => { throw new Error("poison template"); } },  // throws for the due group
      driverIntervalMs: 10_000,
    });
    const component = defineComponent({
      name: "notifications", schema: notificationsSchema,
      modules: { ...makeSendModules(config), ...makeDigestModules(config) },
      context: (cctx) => notificationsContext(cctx, config), contextWrite: true,
      driver: notificationsDriver(config),
    });
    built = await makeNotifRuntime(component, {
      ...appModules,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      "app:digest": mutation(async (ctx: any) => ctx.notifications.send({ to: { email: "poison@test" }, channels: ["email"], template: "hi", category: "updates" })),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      "app:regular": mutation(async (ctx: any) => ctx.notifications.send({ to: { email: "ok@test" }, channels: ["email"], template: "hi", category: "default" })),
    });
    await built.runtime.run("app:digest", {});                 // buffers the poison-template digest
    await built.runtime.run("app:regular", {});                // a normal queued email (category "default")
    await built.runtime.runSystem("_system:backdateDigest", {}); // make the digest group due
    // The pass flushes the due group (its template throws — caught+isolated) AND still delivers the
    // regular queued email. Without per-group isolation the throw would abort the whole pass.
    await (built.driver as { __tick: () => Promise<void> }).__tick();
    expect(captured.map((c) => c.subject)).toEqual(["REGULAR"]); // the regular email WAS delivered
    // The poison group's buffered item stays un-flushed (its txn rolled back) — never claimed-and-dropped.
    expect((await built.readTable("notifications/digestBuffer")).every((r) => r.flushedAt == null)).toBe(true);
  });
});
