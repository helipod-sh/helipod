import { describe, it, expect, afterEach } from "vitest";
import { defineComponent, type ComponentDefinition } from "@stackbase/component";
import { mutation, type RegisteredFunction } from "@stackbase/executor";
import type { PushProvider, PushSendResult } from "../src/provider";
import { notificationsSchema } from "../src/schema";
import { resolveNotificationsConfig } from "../src/config";
import { makeSendModules } from "../src/modules";
import { makePushModules } from "../src/push";
import { notificationsContext } from "../src/facade";
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
