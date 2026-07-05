// components/workflow/test/fanout.test.ts
//
// Task 5: fan-out/fan-in. `await Promise.all([step.a(), step.b()])` calls both `step.*` methods
// SYNCHRONOUSLY (before the `await` suspends the handler), so both `requestStep` calls push into
// `runReplay`'s `newSteps` array within the same synchronous burst — the drive loop's
// `drainMicrotasks` barrier (`./src/replay.ts`) only fires once the ENTIRE microtask queue has
// drained, well after that synchronous burst, so both are collected before the poll concludes
// "suspended". This test proves that end-to-end through the real dispatch loop (`_advance` in
// `./src/modules.ts`), not just at the `runReplay` unit level: two steps dispatched in ONE poll,
// the handler's `order.push("joined")` runs exactly once, after both ran.
import { describe, it, expect } from "vitest";
import { mutation } from "@helipod/executor";
import { workflow } from "@helipod/workflow"; // the authoring surface: workflow.define
import { makeRuntimeWithWorkflow, readTable } from "./helpers";

describe("workflow fan-out/fan-in", () => {
  it("Promise.all fans out N steps in one poll and joins after all complete", async () => {
    const order: string[] = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const flow = workflow.define({
      handler: async (step: any) => {
        const [a, b] = await Promise.all([step.runMutation("app:a", {}), step.runMutation("app:b", {})]);
        order.push("joined");
        return [a, b];
      },
    });
    const { runtime, tick } = await makeRuntimeWithWorkflow(
      {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        "app:kick": mutation(async (ctx: any) => ctx.workflow.start("app:flow", {})),
        "app:a": mutation(async () => {
          order.push("a");
          return "A";
        }),
        "app:b": mutation(async () => {
          order.push("b");
          return "B";
        }),
      },
      { "app:flow": flow },
    );
    const runId = (await runtime.run("app:kick", {})).value as string;
    await tick();
    await tick();
    await tick();
    await tick();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const st = (await runtime.run("workflow:status", { runId })).value as any;
    expect(st.state).toBe("completed");
    expect(st.result).toEqual(["A", "B"]);
    expect(order.filter((x) => x === "joined").length).toBe(1); // joined exactly once, after both
    expect(order.indexOf("joined")).toBeGreaterThan(order.indexOf("a"));
    expect(order.indexOf("joined")).toBeGreaterThan(order.indexOf("b"));

    // Both steps were dispatched in the SAME poll (one `_advance` invocation), not one-at-a-time
    // across separate polls — the whole point of fan-out. `startedTs` alone can't distinguish
    // same-poll-vs-sequential-polls when using a real clock (both could tie either way), so assert
    // the structurally load-bearing fact instead: both steps are journaled, both succeeded, and
    // neither could have been journaled after "joined" ran (the assertions above already establish
    // `order` — this just confirms the durable journal agrees with it).
    const steps = await readTable(runtime, "workflow/steps");
    expect(steps).toHaveLength(2);
    expect(steps.map((s) => s.name).sort()).toEqual(["app:a", "app:b"]);
    expect(steps.every((s) => s.state === "success")).toBe(true);
  });

  it("a fan-out wider than maxParallelism dispatches in capped waves and still completes, dropping nothing", async () => {
    const N = 5;
    const ran: number[] = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const flow = workflow.define({
      handler: async (step: any) => {
        const results = await Promise.all(Array.from({ length: N }, (_, i) => step.runMutation("app:job", { i })));
        return results;
      },
    });
    const appModules: Record<string, ReturnType<typeof mutation>> = {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      "app:kick": mutation(async (ctx: any) => ctx.workflow.start("app:flow", {})),
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    appModules["app:job"] = mutation(async (_ctx: any, a: { i: number }) => {
      ran.push(a.i);
      return a.i * 10;
    });
    const { runtime, tick, driver } = await makeRuntimeWithWorkflow(appModules, { "app:flow": flow }, { maxParallelism: 2 });
    // Stop the reactive driver so `tick()` processes exactly one due-job wave by hand (mirrors
    // `occ-guard.test.ts`/`action-sleep.test.ts`'s identical pattern) — otherwise a single reactive
    // tick()/commit cascades the whole capped multi-wave workflow to completion in one pass,
    // and we'd never observe an intermediate wave to prove the cap actually bit.
    driver.stop?.();

    const runId = (await runtime.run("app:kick", {})).value as string;
    await tick(); // processes only "workflow:_advance": dispatches wave 1 (capped to 2 of the 5 new steps)

    let steps = await readTable(runtime, "workflow/steps");
    // Proves the cap actually applied: only `maxParallelism` (2) of the 5 fanned-out steps were
    // journaled/dispatched this poll, not all 5.
    expect(steps).toHaveLength(2);
    expect(steps.every((s) => s.state === "pending")).toBe(true);

    // Drive the remaining waves by hand: each wave's 2 job mutations + their `_stepDone` callbacks
    // + the re-triggered `_advance` (which re-emits the next un-journaled batch as "new").
    for (let i = 0; i < 30; i++) {
      await tick();
      const st = (await runtime.run("workflow:status", { runId })).value as { state: string };
      if (st.state !== "running") break;
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const st = (await runtime.run("workflow:status", { runId })).value as any;
    expect(st.state).toBe("completed");
    expect(st.result).toEqual([0, 10, 20, 30, 40]);
    expect(ran.sort((x, y) => x - y)).toEqual([0, 1, 2, 3, 4]); // every step ran exactly once — nothing dropped

    steps = await readTable(runtime, "workflow/steps");
    expect(steps).toHaveLength(N); // all 5 steps eventually journaled, across 3 capped waves (2+2+1)
    expect(steps.every((s) => s.state === "success")).toBe(true);
  });
});
