import { describe, it, expect, afterEach } from "vitest";
import { defineComponent, type ComponentDefinition } from "@stackbase/component";
import { mutation, type RegisteredFunction } from "@stackbase/executor";
import type { JSONValue } from "@stackbase/values";
import { notificationsSchema } from "../src/schema";
import { resolveNotificationsConfig } from "../src/config";
import { makeSendModules } from "../src/modules";
import { makeInboxModules } from "../src/inbox";
import { notificationsContext } from "../src/facade";
import { makeNotifRuntime, type BuiltNotifRuntime } from "./helpers";

function inboxComponent(): ComponentDefinition {
  const config = resolveNotificationsConfig({
    channels: { in_app: { enabled: true, templates: { note: (d: { body: string }) => ({ title: "Note", body: d.body }) } } },
  });
  return defineComponent({
    name: "notifications",
    schema: notificationsSchema,
    modules: { ...makeSendModules(config), ...makeInboxModules() },
    context: (cctx) => notificationsContext(cctx, config),
    contextWrite: true,
  });
}

// App mutation to send an in_app notification to an explicit user (server-controlled recipient).
const appModules: Record<string, RegisteredFunction> = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  "app:notify": mutation(async (ctx: any, args: { userId: string; body: string }) =>
    ctx.notifications.send({ to: { userId: args.userId }, channels: ["in_app"], template: "note", data: { body: args.body } })),
};

let built: BuiltNotifRuntime;
afterEach(async () => { await built?.close(); });

// No auth composed → callerId falls back to ctx.notifications.identity() (the ambient token). The
// runtime `run` invoke sets identity; use runtime.run with an identity option to model the caller.
async function runAs(identity: string | null, path: string, args: JSONValue): Promise<unknown> {
  return (await built.runtime.run(path, args, { identity })).value;
}

describe("notifications inbox — reactive feed + ownership", () => {
  it("inbox returns only the caller's rows; unread count is correct; markRead flips read", async () => {
    built = await makeNotifRuntime(inboxComponent(), appModules);
    // Server sends to u1 and u2.
    await built.runtime.run("app:notify", { userId: "u1", body: "for one" });
    await built.runtime.run("app:notify", { userId: "u2", body: "for two" });

    const u1Inbox = (await runAs("u1", "notifications:inbox", {})) as Array<{ _id: string; body: string; read: boolean }>;
    expect(u1Inbox.map((r) => r.body)).toEqual(["for one"]);
    expect(await runAs("u1", "notifications:unreadCount", {})).toBe(1);

    await runAs("u1", "notifications:markRead", { id: u1Inbox[0]!._id });
    expect(await runAs("u1", "notifications:unreadCount", {})).toBe(0);
    const after = (await runAs("u1", "notifications:inbox", {})) as Array<{ read: boolean }>;
    expect(after[0]!.read).toBe(true);
  });

  it("markRead is ownership-checked — a foreign row is rejected", async () => {
    built = await makeNotifRuntime(inboxComponent(), appModules);
    await built.runtime.run("app:notify", { userId: "u1", body: "secret" });
    const u1Inbox = (await runAs("u1", "notifications:inbox", {})) as Array<{ _id: string }>;
    await expect(runAs("u2", "notifications:markRead", { id: u1Inbox[0]!._id })).rejects.toThrow(/not found/);
  });

  it("markAllRead clears every unread row for the caller", async () => {
    built = await makeNotifRuntime(inboxComponent(), appModules);
    await built.runtime.run("app:notify", { userId: "u1", body: "a" });
    await built.runtime.run("app:notify", { userId: "u1", body: "b" });
    expect(await runAs("u1", "notifications:unreadCount", {})).toBe(2);
    await runAs("u1", "notifications:markAllRead", {});
    expect(await runAs("u1", "notifications:unreadCount", {})).toBe(0);
  });
});
