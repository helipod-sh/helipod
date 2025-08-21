// components/scheduler/test/failfast-and-void.test.ts
// Two small-fix regressions:
//  1. A scheduled function with no explicit `return` yields `undefined`; the driver now coerces it
//     to `null` (Convex parity) so `scheduler:_complete` doesn't crash on the wire codec — the job
//     completes as "success" instead of getting stuck.
//  2. A non-retryable error (a StackbaseError with `retryable:false`, e.g. a schema-validation or
//     forbidden-operation failure) dead-letters on the FIRST failure rather than burning every
//     retry — while a plain error still retries (covered by reliability.test.ts).
import { describe, it, expect } from "vitest";
import { mutation } from "@stackbase/executor";
import { ForbiddenOperationError } from "@stackbase/errors";
import { makeRuntimeWithScheduler, readTable } from "./helpers";

describe("scheduler small fixes — void return + fail-fast on non-retryable errors", () => {
  it("a scheduled function returning undefined completes as success (undefined coerced to null)", async () => {
    let ran = 0;
    const { runtime, tick } = await makeRuntimeWithScheduler({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      "app:sched": mutation(async (ctx: any) => ctx.scheduler.enqueue("app:void", {}, {})),
      "app:void": mutation(async () => {
        ran++;
        /* no explicit return -> the handler resolves with undefined */
      }),
    });

    const jobId = (await runtime.run<string>("app:sched", {})).value;
    await tick();

    expect(ran).toBe(1);
    const jobs = await readTable(runtime, "scheduler/jobs");
    expect(jobs.find((j) => j._id === jobId)).toMatchObject({ state: "success" });
  });

  it("a non-retryable error dead-letters on the first failure instead of retrying to maxFailures", async () => {
    let ran = 0;
    const { runtime, tick } = await makeRuntimeWithScheduler({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      "app:sched": mutation(async (ctx: any) => ctx.scheduler.enqueue("app:denied", {}, { retry: { maxFailures: 5 } })),
      "app:denied": mutation(async () => {
        ran++;
        throw new ForbiddenOperationError("denied"); // a UserError -> retryable:false
      }),
    });

    const jobId = (await runtime.run<string>("app:sched", {})).value;
    await tick();

    // Ran exactly once and was dead-lettered immediately (attempts=1), NOT retried up to maxFailures=5.
    expect(ran).toBe(1);
    const jobs = await readTable(runtime, "scheduler/jobs");
    expect(jobs.find((j) => j._id === jobId)).toMatchObject({ state: "failed", attempts: 1 });
  });
});
