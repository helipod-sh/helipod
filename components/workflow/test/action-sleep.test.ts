// components/workflow/test/action-sleep.test.ts
//
// Task 4: `step.runAction` (external side-effect steps, dispatched through the scheduler's
// `kind:"action"` path — at-most-once, no blind retry-on-crash), `step.sleep`/`step.sleepUntil`
// (durable timers riding the scheduler's `runAt`), and per-step retry opts (`maxAttempts` ->
// `EnqueueOpts.retry.maxFailures`). No new mechanism: these are new `step` methods + `NewStep`
// kinds that thread through the same `_advance` dispatch loop / `_stepDone` journal Task 2/3 built.
import { describe, it, expect } from "vitest";
import { mutation, action } from "@stackbase/executor";
import { workflow } from "@stackbase/workflow"; // the authoring surface: workflow.define
import { makeRuntimeWithWorkflow, readTable } from "./helpers";

describe("workflow action steps + sleep + retries", () => {
  it("an action step runs and its result is journaled", async () => {
    const ran: string[] = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const flow = workflow.define({
      handler: async (step: any) => {
        const r = await step.runAction("app:act", { to: "x" });
        return r;
      },
    });
    const { runtime, tick } = await makeRuntimeWithWorkflow(
      {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        "app:kick": mutation(async (ctx: any) => ctx.workflow.start("app:flow", {})),
        "app:act": action(async (_c: any, a: { to: string }) => { // eslint-disable-line @typescript-eslint/no-explicit-any
          ran.push(a.to);
          return `sent:${a.to}`;
        }),
      },
      { "app:flow": flow },
    );
    const runId = (await runtime.run("app:kick", {})).value as string;
    await tick();
    await tick();
    await tick();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const st = (await runtime.run("workflow:status", { runId })).value as any;
    expect(ran).toEqual(["x"]);
    expect(st.state).toBe("completed");
    expect(st.result).toBe("sent:x");
  });

  it("step.sleep parks then resumes (a delayed step)", async () => {
    const clock = { t: 1_000_000 };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const flow = workflow.define({
      handler: async (step: any) => {
        await step.sleep(1000);
        return "done";
      },
    });
    const { runtime, tick } = await makeRuntimeWithWorkflow(
      {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        "app:kick": mutation(async (ctx: any) => ctx.workflow.start("app:flow", {})),
      },
      { "app:flow": flow },
      { now: () => clock.t },
    );

    const runId = (await runtime.run("app:kick", {})).value as string;
    await tick(); // dispatches the sleep step: journals "pending" + a scheduler job with runAt = now+1000 (not yet due)

    let st = (await runtime.run("workflow:status", { runId })).value as { state: string };
    expect(st.state).toBe("running");

    const steps = await readTable(runtime, "workflow/steps");
    expect(steps).toHaveLength(1);
    expect(steps[0].kind).toBe("sleep");
    expect(steps[0].name).toBe("workflow:_sleep");
    expect(steps[0].state).toBe("pending");

    const jobId = steps[0].scheduledJobId as string;
    const jobs = await readTable(runtime, "scheduler/jobs");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sleepJob = jobs.find((j: any) => j._id === jobId);
    expect(sleepJob?.nextTs).toBe(clock.t + 1000);
    expect(sleepJob?.state).toBe("pending");

    // The workflow does NOT complete before the sleep is due, however many times we poll.
    await tick();
    await tick();
    st = (await runtime.run("workflow:status", { runId })).value as { state: string };
    expect(st.state).toBe("running");

    // Advance the virtual clock past the sleep's runAt and drive the cascade: sleep job fires ->
    // _stepDone journals it -> _advance re-runs the handler, which now races straight through.
    clock.t += 1000;
    await tick();
    await tick();
    await tick();
    await tick();

    st = (await runtime.run("workflow:status", { runId })).value as { state: string; result?: unknown };
    expect(st.state).toBe("completed");
    expect((st as { result?: unknown }).result).toBe("done");
  });

  it("a crashed action step is at-most-once — the step fails, the workflow sees failure (not a blind re-run)", async () => {
    let sideEffects = 0;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const flow = workflow.define({
      handler: async (step: any) => {
        const r = await step.runAction("app:act", { to: "x" });
        return r;
      },
    });
    const { runtime, tick, sweep, driver } = await makeRuntimeWithWorkflow(
      {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        "app:kick": mutation(async (ctx: any) => ctx.workflow.start("app:flow", {})),
        "app:act": action(async (_c: any, a: { to: string }) => { // eslint-disable-line @typescript-eslint/no-explicit-any
          sideEffects++;
          return `sent:${a.to}`;
        }),
      },
      { "app:flow": flow },
    );
    // The driver is fully event-driven by default (a single tick()/commit cascades the whole
    // workflow to completion in one pass — see `occ-guard.test.ts`'s identical comment). Stop it
    // so `tick()` instead processes exactly one due-job wave by hand, letting us observe the
    // action step's scheduler job while it's still genuinely "pending" (dispatched, unclaimed) —
    // otherwise a single reactive tick() would race the action to "success" before we can crash it.
    driver.stop?.();

    const runId = (await runtime.run("app:kick", {})).value as string;
    await tick(); // processes only "workflow:_advance": dispatches the action step (journals "pending" + a scheduler job kind:"action"), does NOT also run "app:act"

    const stepsBefore = await readTable(runtime, "workflow/steps");
    expect(stepsBefore).toHaveLength(1);
    const jobId = stepsBefore[0].scheduledJobId as string;

    const jobsBefore = await readTable(runtime, "scheduler/jobs");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(jobsBefore.find((j: any) => j._id === jobId)).toMatchObject({ kind: "action", state: "pending" });

    // Simulate: the driver claimed this job (state -> inProgress, lease granted) and the process
    // died before completing it — an infra kill, not a clean action failure.
    await runtime.runSystem("_system:forceJobState", { jobId, state: "inProgress", leaseExpiresAt: Date.now() - 60_000 });

    await sweep(); // the lease-reclaim sweep: kind:"action" -> dead-lettered "failed" (at-most-once), never re-dispatched
    await tick();
    await tick();
    await tick();

    expect(sideEffects).toBe(0); // the action's side effect never ran (crash happened before it could)

    const jobsAfter = await readTable(runtime, "scheduler/jobs");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(jobsAfter.find((j: any) => j._id === jobId)).toMatchObject({ state: "failed" });

    const st = (await runtime.run("workflow:status", { runId })).value as { state: string; error?: string };
    expect(st.state).toBe("failed");

    // Not a blind re-run: driving further ticks doesn't resurrect the job or re-run the action.
    await tick();
    await tick();
    expect(sideEffects).toBe(0);
  });
});
