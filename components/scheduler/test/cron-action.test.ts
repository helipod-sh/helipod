// components/scheduler/test/cron-action.test.ts
//
// Task 3c: `_cronTick`'s WORK-job enqueue (`modules.ts`, the `for (const fireTs of toFire)` loop)
// bypassed the facade's `kindOf` resolution entirely — it called `enqueueInternal(...)` with no
// `kindOf` arg, so it always defaulted to `kind:"mutation"`, even when `cron.workFnPath` is a
// registered ACTION. That meant a cron-scheduled action's work job was mis-tagged, and `_reclaim`
// (modules.ts) would blind-retry it on a lease-expiry crash instead of dead-lettering it —
// breaking at-most-once (spec §5) for cron-scheduled actions specifically (Task 3b already fixed
// the same bug class for the *facade* enqueue path — see `action-at-most-once.test.ts`).
//
// This suite proves the fix: `_cronTick`'s work-job enqueue now resolves the target's REAL
// registered kind (via the scheduler's own `ctx.scheduler` facade, which already closes over
// `cctx.functionKind`), so a cron targeting an action is tagged `kind:"action"` and `_reclaim`'s
// already-correct action branch (dead-letter, never retry) fires for real.
import { describe, it, expect } from "vitest";
import { action, mutation } from "@stackbase/executor";
import { cronJobs } from "../src/index";
import { makeRuntimeWithScheduler, readTable } from "./helpers";

async function drain(tick: () => Promise<void>, times = 4): Promise<void> {
  for (let i = 0; i < times; i++) await tick();
}

describe("cron-scheduled actions honor at-most-once (Task 3c)", () => {
  it('a cron targeting a registered action tags its WORK job kind:"action" (not the cadence job)', async () => {
    let clock = 30_000_000;
    const crons = cronJobs();
    crons.interval("syncCron", { seconds: 10 }, "app:syncAction", {});

    const { tick, runtime } = await makeRuntimeWithScheduler(
      { "app:syncAction": action(async () => null) },
      { now: () => clock, crons },
    );

    clock += 10_000; // one period elapses — the cron fires once
    await drain(tick);

    const jobs = await readTable(runtime, "scheduler/jobs");
    const workJob = jobs.find((j) => j.fnPath === "app:syncAction"); // the WORK job, not "scheduler:_cronTick"
    expect(workJob).toBeDefined();
    // Pre-fix this was "mutation" (enqueueInternal's default `kindOf`) — the whole point of this test.
    expect(workJob!.kind).toBe("action");
  });

  it('a cron targeting a MUTATION still tags its work job kind:"mutation" (no regression)', async () => {
    let clock = 31_000_000;
    const crons = cronJobs();
    crons.interval("mutCron", { seconds: 10 }, "app:mutWork", {});

    const { tick, runtime } = await makeRuntimeWithScheduler(
      { "app:mutWork": mutation(async () => null) },
      { now: () => clock, crons },
    );

    clock += 10_000;
    await drain(tick);

    const jobs = await readTable(runtime, "scheduler/jobs");
    const workJob = jobs.find((j) => j.fnPath === "app:mutWork");
    expect(workJob).toBeDefined();
    expect(workJob!.kind).toBe("mutation");
  });

  it("at-most-once end-to-end: a cron-scheduled action's work job, force-crashed (inProgress + expired lease), is dead-lettered — not re-dispatched", async () => {
    let clock = 32_000_000;
    let runs = 0;
    const crons = cronJobs();
    crons.interval("syncCron2", { seconds: 10 }, "app:syncAction2", {});

    const { tick, runtime, sweep } = await makeRuntimeWithScheduler(
      {
        "app:syncAction2": action(async () => {
          runs++;
          return null;
        }),
      },
      { now: () => clock, crons },
    );

    clock += 10_000;
    await drain(tick); // the cron fires and the driver dispatches the work job through to completion

    let jobs = await readTable(runtime, "scheduler/jobs");
    const workJob = jobs.find((j) => j.fnPath === "app:syncAction2")!;
    expect(workJob.kind).toBe("action"); // the fix — sanity-check before simulating the crash
    expect(runs).toBe(1); // ran exactly once so far

    // Simulate an infra kill: the driver claimed this job (state -> inProgress, lease granted) and
    // the process died before `_complete` ran. `_system:forceJobState` is a test-only escape hatch
    // (same one `action-at-most-once.test.ts`/`crons.test.ts` use) that overwrites state/lease
    // directly, regardless of the job's current (already-terminal) state — that's fine here: we're
    // not re-deriving history, just constructing the exact row shape `_reclaim`'s sweep must handle
    // correctly for a `kind:"action"` job.
    await runtime.runSystem("_system:forceJobState", {
      jobId: workJob._id as string,
      state: "inProgress",
      leaseExpiresAt: clock - 1000,
    });

    await sweep(); // scheduler:_reclaim — NOT the dispatch loop; the job must never be re-dispatched

    jobs = await readTable(runtime, "scheduler/jobs");
    const after = jobs.find((j) => j._id === workJob._id)!;
    expect(after.state).toBe("failed"); // dead-lettered by _reclaim's action branch, not retried to "pending"
    expect(runs).toBe(1); // never re-dispatched — the action did not run again
  });
});
