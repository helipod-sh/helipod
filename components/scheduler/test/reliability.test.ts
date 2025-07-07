// components/scheduler/test/reliability.test.ts
import { describe, it, expect } from "vitest";
import { mutation, createSeededRandom } from "@stackbase/executor";
import { computeBackoff } from "../src/backoff";
import { makeRuntimeWithScheduler, readTable } from "./helpers";

// `_complete`/`_reclaim` are always invoked with `options.seed` unset (the driver's
// `ctx.runFunction` never passes one — see `packages/runtime-embedded/src/runtime.ts`'s
// `driverCtx.runFunction` and `packages/executor/src/executor.ts`'s `options.seed ?? 0`), so
// every mutation call's `ctx.random()` is `createSeededRandom(0)`'s first draw — the SAME number
// every time. That's what makes the retry jitter independently computable here without any new
// test-only rng-injection plumbing: this constant IS the fixed rng the brief asks for.
const FIXED_RNG = createSeededRandom(0).next();

describe("scheduler reliability — retries/backoff/dead-letter, lease reclaim, cascading cancel", () => {
  it("a failing job retries with backoff up to maxFailures, then dead-letters", async () => {
    let clock = 8_000_000;
    let flakyRuns = 0;
    const { runtime, tick } = await makeRuntimeWithScheduler(
      {
        "app:sched": mutation(async (ctx: any) => { // eslint-disable-line @typescript-eslint/no-explicit-any
          return await ctx.scheduler.enqueue("app:flaky", {}, { retry: { maxFailures: 2 } });
        }),
        "app:flaky": mutation(async () => {
          flakyRuns++;
          throw new Error("boom");
        }),
      },
      { now: () => clock },
    );

    const res = await runtime.run<string>("app:sched", {});
    const jobId = res.value;

    await tick(); // 1st failure: attempts=1, retried (maxFailures=2)
    expect(flakyRuns).toBe(1);

    let jobs = await readTable(runtime, "scheduler/jobs");
    expect(jobs).toHaveLength(1);
    const expectedBackoff1 = computeBackoff(1, () => FIXED_RNG);
    expect(jobs[0]).toMatchObject({ _id: jobId, state: "pending", attempts: 1 });
    expect(jobs[0].nextTs).toBe(8_000_000 + expectedBackoff1);
    expect(jobs[0].leaseHolder).toBeUndefined();
    expect(typeof jobs[0].lastError).toBe("string");

    clock = jobs[0].nextTs as number; // advance the virtual clock exactly to the retry's due time
    await tick(); // 2nd failure: attempts=2 >= maxFailures=2 -> dead-letter

    expect(flakyRuns).toBe(2); // ran exactly maxFailures times, never again
    jobs = await readTable(runtime, "scheduler/jobs");
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ _id: jobId, state: "failed", attempts: 2 });
    expect(jobs[0].completedTs).toBe(clock);
    expect(typeof jobs[0].lastError).toBe("string");
    expect(jobs[0].leaseHolder).toBeUndefined();
    expect(jobs[0].leaseExpiresAt).toBeUndefined();

    // A dead-lettered job never runs again, even if ticked further.
    clock += 1_000_000;
    await tick();
    expect(flakyRuns).toBe(2);
  });

  it("an inProgress mutation job with an expired lease is reclaimed to pending with attempts+1", async () => {
    const clock = 9_000_000;
    const { runtime, sweep } = await makeRuntimeWithScheduler({}, { now: () => clock });

    const insertResult = await runtime.runSystem<string>("_system:insertJob", {
      fnPath: "app:work",
      kind: "mutation",
      nextTs: clock - 5000,
      args: {},
      state: "inProgress",
      leaseExpiresAt: clock - 1000, // already expired
      attempts: 1,
    });
    const jobId = insertResult.value;

    await sweep();

    const jobs = await readTable(runtime, "scheduler/jobs");
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ _id: jobId, state: "pending", attempts: 2, nextTs: clock });
    expect(jobs[0].leaseHolder).toBeUndefined();
    expect(jobs[0].leaseExpiresAt).toBeUndefined();
  });

  it("an inProgress action job with an expired lease is reclaimed to failed (at-most-once)", async () => {
    const clock = 9_500_000;
    const { runtime, sweep } = await makeRuntimeWithScheduler({}, { now: () => clock });

    const insertResult = await runtime.runSystem<string>("_system:insertJob", {
      fnPath: "app:sideEffect",
      kind: "action",
      nextTs: clock - 5000,
      args: {},
      state: "inProgress",
      leaseExpiresAt: clock - 1000,
      attempts: 0,
    });
    const jobId = insertResult.value;

    await sweep();

    const jobs = await readTable(runtime, "scheduler/jobs");
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ _id: jobId, state: "failed", attempts: 1, completedTs: clock });
    expect(typeof jobs[0].lastError).toBe("string");
    expect(jobs[0].leaseHolder).toBeUndefined();
  });

  it("a sweep with no expired leases is a no-op", async () => {
    const clock = 9_750_000;
    const { runtime, sweep } = await makeRuntimeWithScheduler({}, { now: () => clock });

    await runtime.runSystem<string>("_system:insertJob", {
      fnPath: "app:work",
      kind: "mutation",
      nextTs: clock - 5000,
      args: {},
      state: "inProgress",
      leaseExpiresAt: clock + 60_000, // still valid
      attempts: 0,
    });

    await sweep();

    const jobs = await readTable(runtime, "scheduler/jobs");
    expect(jobs[0]).toMatchObject({ state: "inProgress" });
  });

  it("canceling a parent cancels its pending children transitively", async () => {
    // The driver doesn't yet thread an ambient `currentJobId` through a running job (see the
    // Task 4 design note in `../src/facade.ts`), so this crafts the parent/child/grandchild chain
    // directly via the `_system:insertJob` escape hatch rather than having a running job schedule
    // a child for real — `cancel()`'s cascading walk is generic over `parentId` however it got
    // set, so this still exercises the real cascade logic. `nextTs` is far in the future so the
    // driver's reactive wake (fired by `_system:insertJob`'s own commit) never claims/dispatches
    // these rows out from under the test.
    const clock = 10_000_000;
    const { runtime } = await makeRuntimeWithScheduler(
      {
        "app:cancel": mutation(async (ctx: any, { id }: { id: string }) => { // eslint-disable-line @typescript-eslint/no-explicit-any
          await ctx.scheduler.cancel(id);
          return null;
        }),
      },
      { now: () => clock },
    );

    const far = clock + 60_000;
    const parent = await runtime.runSystem<string>("_system:insertJob", {
      fnPath: "app:parentWork",
      kind: "mutation",
      nextTs: far,
      args: {},
    });
    const parentId = parent.value;

    const child = await runtime.runSystem<string>("_system:insertJob", {
      fnPath: "app:childWork",
      kind: "mutation",
      nextTs: far,
      args: {},
      parentId,
    });
    const childId = child.value;

    const grandchild = await runtime.runSystem<string>("_system:insertJob", {
      fnPath: "app:grandchildWork",
      kind: "mutation",
      nextTs: far,
      args: {},
      parentId: childId,
    });
    const grandchildId = grandchild.value;

    // An unrelated pending job, NOT a descendant of `parentId` — must survive the cancel.
    const unrelated = await runtime.runSystem<string>("_system:insertJob", {
      fnPath: "app:unrelated",
      kind: "mutation",
      nextTs: far,
      args: {},
    });
    const unrelatedId = unrelated.value;

    await runtime.run("app:cancel", { id: parentId });

    const jobs = await readTable(runtime, "scheduler/jobs");
    const byId = new Map(jobs.map((j) => [j._id as string, j]));
    expect(byId.get(parentId)).toMatchObject({ state: "canceled" });
    expect(byId.get(childId)).toMatchObject({ state: "canceled" });
    expect(byId.get(grandchildId)).toMatchObject({ state: "canceled" });
    expect(byId.get(unrelatedId)).toMatchObject({ state: "pending" });

    const signals = await readTable(runtime, "scheduler/signals");
    const cancelSignalJobIds = signals.filter((s) => s.kind === "cancel").map((s) => s.jobId);
    expect(cancelSignalJobIds.sort()).toEqual([parentId, childId, grandchildId].sort());
  });
});
