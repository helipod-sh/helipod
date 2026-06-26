// components/scheduler/test/retry-safety.test.ts
//
// The three 2026-07-20 fixes, each with the failing shape it repairs:
//  1. `EnqueueOpts.runAfter` was dead — `enqueueInternal` computed `nextTs: opts.runAt ?? now()`
//     and never read `runAfter`, so `enqueue(fn, args, { runAfter: 60_000 })` ran immediately.
//  2. A CLEANLY-failed action (its own code threw) blind-retried through `_complete`'s mutation
//     backoff path, re-running non-transactional side effects. Now `kind:"action"` jobs default
//     `maxFailures: 1` (dead-letter on first failure) unless the caller explicitly opts into
//     `retry: { maxFailures }` (the workflow-step `maxAttempts` path).
//  3. `_reclaim` had no attempts cap for mutations — a mutation that crash-looped its host was
//     reclaimed to `pending` forever. Now it dead-letters once `attempts >= maxFailures`.
import { describe, it, expect } from "vitest";
import { action, mutation } from "@stackbase/executor";
import { makeRuntimeWithScheduler, readTable } from "./helpers";

describe("EnqueueOpts.runAfter is honored", () => {
  it("enqueue with runAfter delays nextTs by the given ms from the mutation's now()", async () => {
    const clock = 5_000_000;
    const { runtime } = await makeRuntimeWithScheduler(
      {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        "app:sched": mutation(async (ctx: any) => {
          await ctx.scheduler.enqueue("app:work", { x: 1 }, { runAfter: 60_000 });
          return null;
        }),
        "app:work": mutation(async () => null),
      },
      { now: () => clock },
    );

    await runtime.run("app:sched", {});
    const jobs = await readTable(runtime, "scheduler/jobs");
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ fnPath: "app:work", state: "pending" });
    expect(jobs[0].nextTs).toBe(clock + 60_000);
  });

  it("runAt wins when both runAt and runAfter are set; negative runAfter clamps to now", async () => {
    const clock = 5_000_000;
    const { runtime } = await makeRuntimeWithScheduler(
      {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        "app:sched": mutation(async (ctx: any) => {
          await ctx.scheduler.enqueue("app:work", {}, { runAt: 9_999_999, runAfter: 60_000, name: "both" });
          await ctx.scheduler.enqueue("app:work", {}, { runAfter: -5, name: "negative" });
          return null;
        }),
        "app:work": mutation(async () => null),
      },
      { now: () => clock },
    );

    await runtime.run("app:sched", {});
    const jobs = await readTable(runtime, "scheduler/jobs");
    expect(jobs.find((j) => j.name === "both")?.nextTs).toBe(9_999_999);
    expect(jobs.find((j) => j.name === "negative")?.nextTs).toBe(clock);
  });
});

describe("cleanly-failed actions are at-most-once by default", () => {
  it("an action whose own code throws dead-letters on the first failure (no blind retry)", async () => {
    let clock = 6_000_000;
    let runs = 0;
    const { runtime, tick } = await makeRuntimeWithScheduler(
      {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        "app:boomAction": action(async () => {
          runs += 1;
          throw new Error("side effect ran partway");
        }),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        "app:sched": mutation(async (ctx: any) => {
          await ctx.scheduler.runAfter(0, "app:boomAction", {});
          return null;
        }),
      },
      { now: () => clock },
    );

    await runtime.run("app:sched", {});
    await tick();
    expect(runs).toBe(1);

    let jobs = await readTable(runtime, "scheduler/jobs");
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ kind: "action", state: "failed", attempts: 1 });
    expect(jobs[0].lastError).toContain("side effect ran partway");

    // Even with time passing and more ticks, it stays dead-lettered.
    clock += 60_000;
    await tick();
    expect(runs).toBe(1);
    jobs = await readTable(runtime, "scheduler/jobs");
    expect(jobs[0].state).toBe("failed");
  });

  it("an explicit retry opt-in restores backoff retries for actions", async () => {
    let clock = 7_000_000;
    let runs = 0;
    const { runtime, tick } = await makeRuntimeWithScheduler(
      {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        "app:flakyAction": action(async () => {
          runs += 1;
          throw new Error("still failing");
        }),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        "app:sched": mutation(async (ctx: any) => {
          await ctx.scheduler.enqueue("app:flakyAction", {}, { retry: { maxFailures: 2 } });
          return null;
        }),
      },
      { now: () => clock },
    );

    await runtime.run("app:sched", {});
    await tick();
    expect(runs).toBe(1);

    // First failure: 1 < maxFailures 2, so it's back to pending with a backoff nextTs.
    let jobs = await readTable(runtime, "scheduler/jobs");
    expect(jobs[0]).toMatchObject({ kind: "action", state: "pending", attempts: 1 });

    // Advance past the jittered backoff (attempts=1 backs off at most 1000ms) and re-dispatch.
    clock += 2_000;
    await tick();
    expect(runs).toBe(2);
    jobs = await readTable(runtime, "scheduler/jobs");
    expect(jobs[0]).toMatchObject({ state: "failed", attempts: 2 });
  });
});

describe("_reclaim dead-letters a crash-looping mutation at maxFailures", () => {
  it("a reclaimed mutation retries while attempts remain, then dead-letters", async () => {
    const clock = 8_000_000;
    const { runtime, sweep } = await makeRuntimeWithScheduler(
      { "app:work": mutation(async () => null) },
      { now: () => clock },
    );

    // One attempt left: reclaim retries it to pending.
    const retryable = await runtime.runSystem<string>("_system:insertJob", {
      fnPath: "app:work",
      kind: "mutation",
      nextTs: clock - 10_000,
      args: {},
      state: "inProgress",
      leaseExpiresAt: clock - 1_000,
      attempts: 2,
      maxFailures: 4,
    });
    // Budget spent after this reclaim: attempts 3 + 1 = 4 >= maxFailures 4 → dead-letter.
    const exhausted = await runtime.runSystem<string>("_system:insertJob", {
      fnPath: "app:work",
      kind: "mutation",
      nextTs: clock - 10_000,
      args: {},
      state: "inProgress",
      leaseExpiresAt: clock - 1_000,
      attempts: 3,
      maxFailures: 4,
    });

    await sweep();

    const jobs = await readTable(runtime, "scheduler/jobs");
    const byId = (id: unknown): Record<string, unknown> => jobs.find((j) => j._id === id) as Record<string, unknown>;
    expect(byId(retryable.value)).toMatchObject({ state: "pending", attempts: 3, nextTs: clock });
    expect(byId(exhausted.value)).toMatchObject({ state: "failed", attempts: 4 });
    expect(byId(exhausted.value).completedTs).toBe(clock);
    expect(String(byId(exhausted.value).lastError)).toContain("lease expired");
  });
});
