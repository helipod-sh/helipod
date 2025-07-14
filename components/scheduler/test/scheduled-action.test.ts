// components/scheduler/test/scheduled-action.test.ts
import { describe, it, expect } from "vitest";
import { action, mutation } from "@stackbase/executor";
import { makeRuntimeWithScheduler, readTable } from "./helpers";

describe("schedulerDriver — scheduled actions execute", () => {
  it("a scheduled action runs (not unsupported)", async () => {
    const ran: string[] = [];
    const { runtime, tick } = await makeRuntimeWithScheduler({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      "app:sendish": action(async (_c: any, a: { to: string }) => {
        ran.push(a.to);
        return null;
      }),
      "app:sched": mutation(async (ctx: any) => { // eslint-disable-line @typescript-eslint/no-explicit-any
        await ctx.scheduler.runAfter(0, "app:sendish", { to: "x@y.z" });
        return null;
      }),
    });
    await runtime.run("app:sched", {});
    await tick();
    expect(ran).toEqual(["x@y.z"]);

    // Since Task 3b, `ctx.scheduler.runAfter`'s `kindOf()` (facade.ts) resolves the target's REAL
    // registered kind via `cctx.functionKind` (threaded from the runtime's module registry) — so
    // `app:sendish`, a real action, is correctly tagged `kind:"action"` here. (Prior to Task 3b
    // this was always `kind:"mutation"`, a documented stub — see `action-at-most-once.test.ts` for
    // the dedicated at-most-once coverage this fix unlocks.)
    const jobs = await readTable(runtime, "scheduler/jobs");
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ state: "success", kind: "action" });
  });

  it("a crash mid-action (inProgress + expired lease) is at-most-once — failed, not re-run", async () => {
    const clock = 10_500_000;
    const ran: string[] = [];
    const { runtime, sweep } = await makeRuntimeWithScheduler(
      {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        "app:sideEffect": action(async (_c: any, a: { to: string }) => {
          ran.push(a.to);
          return null;
        }),
      },
      { now: () => clock },
    );

    // Simulate: the driver `_claim`ed this job (state -> inProgress, lease granted) and the
    // process died before `_complete` ran — crafted directly via the test-only escape hatch
    // rather than a real crash, since the driver's `runFunction` dispatch can't be interrupted
    // mid-flight deterministically from a test.
    const insertResult = await runtime.runSystem<string>("_system:insertJob", {
      fnPath: "app:sideEffect",
      kind: "action",
      nextTs: clock - 5000,
      args: { to: "x@y.z" },
      state: "inProgress",
      leaseExpiresAt: clock - 1000, // already expired
      attempts: 0,
    });
    const jobId = insertResult.value;

    await sweep(); // the lease-reclaim sweep, not the dispatch loop — the job must never dispatch

    expect(ran).toEqual([]); // at-most-once: the action never actually ran
    const jobs = await readTable(runtime, "scheduler/jobs");
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ _id: jobId, state: "failed", attempts: 1, completedTs: clock });
    expect(typeof jobs[0].lastError).toBe("string");
    expect(jobs[0].leaseHolder).toBeUndefined();
  });
});
