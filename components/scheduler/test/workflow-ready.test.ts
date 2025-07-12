// components/scheduler/test/workflow-ready.test.ts
import { describe, it, expect } from "vitest";
import { mutation } from "@stackbase/executor";
import { makeRuntimeWithScheduler, readTable } from "./helpers";

/**
 * Task 6 — the workflow-ready `onComplete`/`context` primitives (`fireOnComplete` in
 * `../src/facade.ts`, wired into `_complete` in `../src/modules.ts`): a job's opaque `context`
 * (set at enqueue time, never interpreted by the scheduler) is round-tripped VERBATIM to its
 * `onComplete` mutation alongside the terminal `result`, keyed by the ORIGINAL job's `jobId` — the
 * primitive a future workflow component builds `{workflowId, generationNumber}` resumption on top
 * of.
 */
describe("workflow-ready: onComplete + context", () => {
  it("enqueue with onComplete + context calls onComplete (mutation) with the opaque context round-tripped verbatim", async () => {
    const seen: unknown[] = [];
    const clock = 1_000_000;
    let workJobId = "";

    const { runtime, tick } = await makeRuntimeWithScheduler(
      {
        "app:sched": mutation(async (ctx: any) => { // eslint-disable-line @typescript-eslint/no-explicit-any
          workJobId = await ctx.scheduler.enqueue(
            "app:work",
            { n: 21 },
            { onComplete: "app:done", context: { workflowId: "w1", generationNumber: 3 } },
          );
          return workJobId;
        }),
        "app:work": mutation(async (_ctx: any, a: { n: number }) => a.n * 2), // eslint-disable-line @typescript-eslint/no-explicit-any
        "app:done": mutation(async (_ctx: any, a: unknown) => { // eslint-disable-line @typescript-eslint/no-explicit-any
          seen.push(a);
          return null;
        }),
      },
      { now: () => clock },
    );

    await runtime.run("app:sched", {});

    // Drain: the onComplete re-enqueue (runAfter:0) happens INSIDE `_complete`'s own commit, which
    // the driver's reactive onCommit subscription wakes on — a single tick typically drains both
    // "app:work" and its "app:done" callback via the coalesced-wake do/while loop in `driver.ts`'s
    // `runPass`, but loop defensively rather than assume the exact number of internal passes.
    for (let i = 0; i < 5 && seen.length === 0; i++) await tick();

    expect(seen).toHaveLength(1);
    expect(seen[0]).toEqual({
      jobId: workJobId,
      context: { workflowId: "w1", generationNumber: 3 },
      result: { kind: "success", value: 42 },
    });

    // "app:work" itself is terminal success; its own onComplete job ("app:done") is a SEPARATE
    // jobs row with no onComplete of its own — exactly two jobs total, both success.
    const jobs = await readTable(runtime, "scheduler/jobs");
    expect(jobs).toHaveLength(2);
    expect(jobs.every((j) => j.state === "success")).toBe(true);
  });

  it("a job with no onComplete set never enqueues a callback", async () => {
    const clock = 1_500_000;
    const { runtime, tick } = await makeRuntimeWithScheduler(
      {
        "app:sched": mutation(async (ctx: any) => { // eslint-disable-line @typescript-eslint/no-explicit-any
          await ctx.scheduler.runAfter(0, "app:work", { n: 1 });
          return null;
        }),
        "app:work": mutation(async () => null),
      },
      { now: () => clock },
    );

    await runtime.run("app:sched", {});
    await tick();

    const jobs = await readTable(runtime, "scheduler/jobs");
    expect(jobs).toHaveLength(1); // no onComplete → no second job ever materializes
    expect(jobs[0]).toMatchObject({ state: "success" });
  });

  it("runAfter:0 re-enqueue is cheap and fires on the next tick", async () => {
    const clock = 2_000_000;
    let runs = 0;
    const { runtime, tick } = await makeRuntimeWithScheduler(
      {
        "app:sched": mutation(async (ctx: any) => { // eslint-disable-line @typescript-eslint/no-explicit-any
          await ctx.scheduler.runAfter(0, "app:work", {});
          return null;
        }),
        "app:work": mutation(async () => {
          runs++;
          return null;
        }),
      },
      { now: () => clock },
    );

    await runtime.run("app:sched", {});
    await tick(); // one deterministic pass — runAfter:0 must be due immediately, no extra wait

    expect(runs).toBe(1);
    const jobs = await readTable(runtime, "scheduler/jobs");
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ state: "success", nextTs: clock });
  });
});
