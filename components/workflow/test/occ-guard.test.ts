// components/workflow/test/occ-guard.test.ts
import { describe, it, expect } from "vitest";
import { mutation } from "@helipod/executor";
import { jsonToConvex } from "@helipod/values";
import { workflow } from "@helipod/workflow"; // the authoring surface: workflow.define
import { _stepDone } from "../src/modules";
import { runReplay, type JournalRow } from "../src/replay";
import { makeRuntimeWithWorkflow, readTable } from "./helpers";

describe("workflow OCC guard / cancel / determinism", () => {
  it("a _stepDone carrying a stale generationNumber (after cancel) does not resurrect the workflow", async () => {
    const { runtime, tick, driver } = await makeRuntimeWithWorkflow(
      {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        "app:kick": mutation(async (ctx: any) => ctx.workflow.start("app:flow", {})),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        "app:cancel": mutation(async (ctx: any, a: { runId: string }) => {
          await ctx.workflow.cancel(a.runId);
          return null;
        }),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        "app:s": mutation(async () => "ran"),
      },
      {
        "app:flow": workflow.define({
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          handler: async (step: any) => step.runMutation("app:s", {}),
        }),
      },
    );
    // The driver is fully event-driven (`onCommit` reactively wakes it) — left running, a single
    // `tick()`/commit cascades a whole workflow to completion in one pass (each hop's commit
    // re-triggers the next). Stop it so `tick()` instead processes exactly one due-job wave by
    // hand, letting us observe step 0 while it's still genuinely `"pending"` (dispatched, not yet
    // claimed/run) rather than racing straight through to `"success"`.
    driver.stop?.();

    const runId = (await runtime.run("app:kick", {})).value as string;
    await tick(); // processes only "workflow:_advance": dispatches step 0 (journaled "pending" + a scheduler job), does NOT also run "app:s"

    const stepsBefore = await readTable(runtime, "workflow/steps");
    expect(stepsBefore).toHaveLength(1);
    expect(stepsBefore[0].state).toBe("pending");

    // cancel: gen 0 -> 1, state -> "canceled"
    await runtime.run("app:cancel", { runId });
    const afterCancel = (await runtime.run("workflow:status", { runId })).value as {
      state: string;
    };
    expect(afterCancel.state).toBe("canceled");

    // Hand-fire workflow:_stepDone the same way the scheduler driver would — a privileged,
    // fully-qualified-table-name call (mirrors `DriverContext.runFunction`; see
    // `components/scheduler/test/dispatch.test.ts`'s `_claim` precedent) — carrying the STALE
    // (pre-cancel) generationNumber 0.
    const result = await runtime.executor.run(
      _stepDone,
      jsonToConvex({
        jobId: "fake-job-id",
        context: { workflowId: runId, stepNumber: 0, generationNumber: 0 },
        result: { kind: "success", value: 42 },
      }),
      { path: "workflow:_stepDone", privileged: true },
    );
    expect(result.value).toBeNull(); // OCC guard: no-op

    // Still canceled — not resurrected.
    const st = (await runtime.run("workflow:status", { runId })).value as {
      state: string;
    };
    expect(st.state).toBe("canceled");

    // No new step was dispatched — the stale _stepDone never journaled step 0's result nor
    // re-enqueued `_advance`.
    const stepsAfter = await readTable(runtime, "workflow/steps");
    expect(stepsAfter).toHaveLength(1);
    expect(stepsAfter[0].state).toBe("pending");
  });

  it("cancel sets state canceled and cascades cancel to the in-flight step job", async () => {
    const { runtime, tick, driver } = await makeRuntimeWithWorkflow(
      {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        "app:kick": mutation(async (ctx: any) => ctx.workflow.start("app:flow", {})),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        "app:cancel": mutation(async (ctx: any, a: { runId: string }) => {
          await ctx.workflow.cancel(a.runId);
          return null;
        }),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        "app:s": mutation(async () => "ran"),
      },
      {
        "app:flow": workflow.define({
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          handler: async (step: any) => step.runMutation("app:s", {}),
        }),
      },
    );
    // See the previous test's comment: stop the reactive driver so `tick()` processes one due-job
    // wave at a time instead of cascading the whole workflow to completion in a single pass — we
    // need the step's scheduler job to still be genuinely "pending" (unclaimed) when we cancel, or
    // the scheduler's own `cancel()` (only cancels jobs still `"pending"`) would have nothing to do.
    driver.stop?.();

    const runId = (await runtime.run("app:kick", {})).value as string;
    await tick(); // dispatches step 0: a `steps` row "pending" + a scheduler job "pending"

    const stepsBefore = await readTable(runtime, "workflow/steps");
    expect(stepsBefore).toHaveLength(1);
    expect(stepsBefore[0].state).toBe("pending");
    const jobId = stepsBefore[0].scheduledJobId as string;
    expect(typeof jobId).toBe("string");

    const jobsBefore = await readTable(runtime, "scheduler/jobs");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const stepJobBefore = jobsBefore.find((j: any) => j._id === jobId);
    expect(stepJobBefore?.state).toBe("pending");

    await runtime.run("app:cancel", { runId });

    const st = (await runtime.run("workflow:status", { runId })).value as {
      state: string;
    };
    expect(st.state).toBe("canceled");

    const jobsAfter = await readTable(runtime, "scheduler/jobs");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const stepJobAfter = jobsAfter.find((j: any) => j._id === jobId);
    expect(stepJobAfter?.state).toBe("canceled");
  });

  it("a journal-entry mismatch throws (determinism violation)", async () => {
    // Drive a workflow to journal step 0 as app:s (crafted directly, no runtime needed — a direct
    // unit test of `runReplay`). Then simulate a non-deterministic handler by replaying with a
    // handler whose first step is app:OTHER.
    const journal: JournalRow[] = [
      {
        _id: "step0",
        workflowId: "wf1",
        stepNumber: 0,
        name: "app:s",
        kind: "mutation",
        args: {},
        state: "success",
        result: 1,
        startedTs: 0,
      },
    ];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mismatchingHandler = async (step: any) => step.runMutation("app:OTHER", {});

    // `requestStep` (`../src/replay.ts`) does hard-`throw` synchronously on a mismatch — but
    // since that throw happens inside the (async) handler, `runReplay`'s `settle` chain
    // (`handler(...).then(onFulfilled, onRejected)`) catches it like any other handler error and
    // normalizes it into a `"failed"` `ReplayOutcome`, the same path `_advance` (`../src/
    // modules.ts`) already uses to terminally fail a workflow and fire its `onComplete` — this is
    // what makes the hard-throw surface as a deterministic, non-retryable workflow failure rather
    // than an uncaught exception. So `runReplay` itself never REJECTS; assert on the outcome it
    // resolves to instead.
    const outcome = await runReplay(mismatchingHandler, {}, journal);
    expect(outcome.kind).toBe("failed");
    expect((outcome as { kind: "failed"; error: string }).error).toMatch(/Journal entry mismatch/);
  });

  it("a handler suspended on a non-step promise (no pending step) fails the workflow instead of hanging", async () => {
    const { runtime, tick } = await makeRuntimeWithWorkflow(
      {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        "app:kick": mutation(async (ctx: any) => ctx.workflow.start("app:flow", {})),
      },
      {
        "app:flow": workflow.define({
          handler: async () => {
            // A determinism violation: awaits something that isn't `step.*` — never journaled, so
            // no `steps` row will ever exist to wake `_advance` again. 50ms (rather than the
            // minimal possible delay) so this promise unambiguously resolves AFTER `runReplay`'s
            // own `drainMicrotasks()` barrier (a same-tick 0ms timer) — making the race
            // deterministic: the drain wins, and `runReplay` reports "suspended" with no new
            // steps, rather than racing the handler to a same-tick "completed".
            await new Promise((r) => setTimeout(r, 50));
            return "unreachable";
          },
        }),
      },
    );

    const runId = (await runtime.run("app:kick", {})).value as string;
    await tick(); // drives `_advance` once

    const st = (await runtime.run("workflow:status", { runId })).value as {
      state: string;
      error?: string;
    };
    expect(st.state).toBe("failed");
    expect(st.error).toMatch(/no pending step/);
  });
});
