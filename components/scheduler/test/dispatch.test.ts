// components/scheduler/test/dispatch.test.ts
import { describe, it, expect } from "vitest";
import { mutation } from "@stackbase/executor";
import { makeRuntimeWithScheduler, readTable } from "./helpers";

describe("schedulerDriver — event-driven dispatch", () => {
  it("a due mutation runs on the next tick; a future one does not until the clock advances", async () => {
    let clock = 1_000_000;
    const ran: string[] = [];
    const { runtime, tick } = await makeRuntimeWithScheduler(
      {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        "app:sched": mutation(async (ctx: any) => {
          await ctx.scheduler.runAfter(0, "app:work", { tag: "now" });
          await ctx.scheduler.runAfter(5000, "app:work", { tag: "later" });
          return null;
        }),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        "app:work": mutation(async (_ctx: any, a: { tag: string }) => {
          ran.push(a.tag);
          return null;
        }),
      },
      { now: () => clock },
    );

    await runtime.run("app:sched", {});
    await tick(); // drive one loop iteration at clock=1_000_000
    expect(ran).toEqual(["now"]); // due-now ran; "later" did not

    clock += 5000;
    await tick();
    expect(ran.sort()).toEqual(["later", "now"]); // "later" ran once the clock reached its nextTs

    const jobs = await readTable(runtime, "scheduler/jobs");
    expect(jobs).toHaveLength(2);
    expect(jobs.every((j) => j.state === "success")).toBe(true);
    expect(jobs.every((j) => j.leaseHolder === undefined)).toBe(true);
    expect(jobs.every((j) => typeof j.completedTs === "number")).toBe(true);
  });

  it("claims are single-run: two concurrent ticks never double-run a job", async () => {
    const clock = 2_000_000;
    let runs = 0;
    const { runtime, tick } = await makeRuntimeWithScheduler(
      {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        "app:sched": mutation(async (ctx: any) => {
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

    // Fire two ticks back-to-back without awaiting the first — `iterate()`'s in-process `running`
    // guard is set synchronously (before any `await`), so the second call, issued in the same
    // synchronous turn, observes `running === true` and no-ops. `_claim`'s snapshot-read +
    // exact-match check (components/scheduler/src/modules.ts) is what makes this correct even if
    // that in-process collapsing weren't there.
    const p1 = tick();
    const p2 = tick();
    await Promise.all([p1, p2]);

    expect(runs).toBe(1);
    const jobs = await readTable(runtime, "scheduler/jobs");
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ state: "success" });
  });

  it("a kind:'action' job fails with 'unsupported' instead of running", async () => {
    const clock = 3_000_000;
    let ran = false;
    const { runtime, tick } = await makeRuntimeWithScheduler(
      {
        "app:work": mutation(async () => {
          ran = true;
          return null;
        }),
      },
      { now: () => clock },
    );

    const insertResult = await runtime.runSystem<string>("_system:insertJob", {
      fnPath: "app:work",
      kind: "action",
      nextTs: clock,
      args: {},
    });
    const jobId = insertResult.value;

    await tick();

    expect(ran).toBe(false); // never dispatched — actions aren't runnable yet
    const jobs = await readTable(runtime, "scheduler/jobs");
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ _id: jobId, state: "failed" });

    const signals = await readTable(runtime, "scheduler/signals");
    const complete = signals.find((s) => s.kind === "complete" && s.jobId === jobId);
    expect(complete?.payload).toMatchObject({ kind: "failed", error: "unsupported: action runtime not built" });
  });
});
