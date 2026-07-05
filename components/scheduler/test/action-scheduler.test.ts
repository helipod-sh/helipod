// components/scheduler/test/action-scheduler.test.ts
import { describe, it, expect } from "vitest";
import { mutation, action } from "@helipod/executor";
import { makeRuntimeWithScheduler } from "./helpers";

describe("ctx.scheduler in actions (buildAction → runMutation delegation)", () => {
  it("ctx.scheduler.runAfter from an action enqueues a job that the driver then runs", async () => {
    const ran: string[] = [];
    const { runtime, tick } = await makeRuntimeWithScheduler({
      "app:work": mutation(async (_c: unknown, a: { tag: string }) => {
        ran.push(a.tag);
        return null;
      }),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      "app:act": action(async (ctx: any) => {
        await ctx.scheduler.runAfter(0, "app:work", { tag: "from-action" });
        return "ok";
      }),
    });

    expect((await runtime.runAction("app:act", {})).value).toBe("ok");
    await tick();
    expect(ran).toEqual(["from-action"]);
  });
});
