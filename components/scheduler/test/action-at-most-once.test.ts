// components/scheduler/test/action-at-most-once.test.ts
//
// Task 3b: `kindOf()` (facade.ts) used to stamp EVERY facade-scheduled job `kind:"mutation"`,
// regardless of the target's real registered type — so a real action's job was mis-tagged and
// `_reclaim` (modules.ts) would blind-retry it on a lease-expiry crash, breaking at-most-once for
// the actual facade path (only the test-only `_system:insertJob` escape hatch could produce a
// correctly-tagged `kind:"action"` job). This suite proves the fix: `kindOf` now resolves the
// target's real kind via `cctx.functionKind` (threaded from the runtime's module registry through
// `ComponentContext`), so a facade-scheduled action is tagged `kind:"action"` and `_reclaim`'s
// already-correct action-branch (dead-letter, never retry) fires for real.
import { describe, it, expect } from "vitest";
import { action, mutation } from "@helipod/executor";
import { makeRuntimeWithScheduler, readTable } from "./helpers";

describe("scheduler — kindOf resolves the real function kind (at-most-once is truthful)", () => {
  it("a facade-scheduled action is tagged kind:\"action\"", async () => {
    const { runtime } = await makeRuntimeWithScheduler({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      "app:act": action(async (_c: any) => null),
      "app:sched": mutation(async (ctx: any) => { // eslint-disable-line @typescript-eslint/no-explicit-any
        await ctx.scheduler.runAfter(0, "app:act", {});
        return null;
      }),
    });

    await runtime.run("app:sched", {});

    const jobs = await readTable(runtime, "scheduler/jobs");
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ fnPath: "app:act", kind: "action" });
  });

  it("a facade-scheduled mutation is still tagged kind:\"mutation\" (no regression)", async () => {
    const { runtime } = await makeRuntimeWithScheduler({
      "app:work": mutation(async () => null),
      "app:sched": mutation(async (ctx: any) => { // eslint-disable-line @typescript-eslint/no-explicit-any
        await ctx.scheduler.runAfter(0, "app:work", {});
        return null;
      }),
    });

    await runtime.run("app:sched", {});

    const jobs = await readTable(runtime, "scheduler/jobs");
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ fnPath: "app:work", kind: "mutation" });
  });

  it("at-most-once end-to-end via the facade: a crashed facade-scheduled action is dead-lettered, not re-dispatched", async () => {
    const clock = 11_000_000;
    const ran: string[] = [];
    const { runtime, sweep } = await makeRuntimeWithScheduler(
      {
        "app:act": action(async (_c: any, a: { to: string }) => { // eslint-disable-line @typescript-eslint/no-explicit-any
          ran.push(a.to);
          return null;
        }),
        "app:sched": mutation(async (ctx: any) => // eslint-disable-line @typescript-eslint/no-explicit-any
          await ctx.scheduler.runAfter(0, "app:act", { to: "x@y.z" })),
      },
      { now: () => clock },
    );

    const res = await runtime.run<string>("app:sched", {});
    const jobId = res.value;

    // The facade already tagged this job kind:"action" (asserted above); sanity-check it here too
    // before crashing it, so a regression in `kindOf` would fail loudly at this line, not just
    // silently change which `_reclaim` branch fires below.
    let jobs = await readTable(runtime, "scheduler/jobs");
    expect(jobs.find((j) => j._id === jobId)).toMatchObject({ kind: "action", state: "pending" });

    // Simulate: the driver `_claim`ed this job (state -> inProgress, lease granted) and the
    // process died before `_complete` ran.
    await runtime.runSystem("_system:forceJobState", { jobId, state: "inProgress", leaseExpiresAt: clock - 1000 });

    await sweep(); // the lease-reclaim sweep, not the dispatch loop — the job must never dispatch

    expect(ran).toEqual([]); // at-most-once: the action never actually ran (nor re-ran)
    jobs = await readTable(runtime, "scheduler/jobs");
    expect(jobs.find((j) => j._id === jobId)).toMatchObject({ state: "failed" });
  });

  it("contrast: a crashed facade-scheduled mutation IS retried (back to pending)", async () => {
    const clock = 11_500_000;
    let workRuns = 0;
    const { runtime, sweep } = await makeRuntimeWithScheduler(
      {
        "app:work": mutation(async () => {
          workRuns++;
          return null;
        }),
        "app:sched": mutation(async (ctx: any) => await ctx.scheduler.runAfter(0, "app:work", {})), // eslint-disable-line @typescript-eslint/no-explicit-any
      },
      { now: () => clock },
    );

    const res = await runtime.run<string>("app:sched", {});
    const jobId = res.value;

    await runtime.runSystem("_system:forceJobState", { jobId, state: "inProgress", leaseExpiresAt: clock - 1000 });

    await sweep();

    expect(workRuns).toBe(0); // reclaim resets state, it doesn't dispatch
    const jobs = await readTable(runtime, "scheduler/jobs");
    expect(jobs.find((j) => j._id === jobId)).toMatchObject({ kind: "mutation", state: "pending", attempts: 1 });
  });
});
