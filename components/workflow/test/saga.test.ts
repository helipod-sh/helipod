// components/workflow/test/saga.test.ts
//
// Task 1 of the saga/compensation slice: this test only asserts that a step declared with
// `{ compensate }` RECORDS its resolved `compensateFnPath` on the step's journal row when
// dispatched. No unwind logic exists yet (that's Task 2) — a workflow with a `compensate` option
// behaves exactly as it did before this slice; the recorded field just sits unused.
//
// Task 3 (bottom of this file) finishes the slice: halt-on-failed-compensation, `cancel` compensates
// by default (with a `{ compensate: false }` opt-out), and fan-out steps compensate in reverse
// `stepNumber` order regardless of forward completion order.
import { describe, it, expect } from "vitest";
import { mutation } from "@stackbase/executor";
import { jsonToConvex } from "@stackbase/values";
import { workflow } from "@stackbase/workflow";
import { _compensate } from "../src/modules";
import { makeRuntimeWithWorkflow, readTable } from "./helpers";

describe("saga — recording compensations", () => {
  it("a step declared with { compensate } stores compensateFnPath on its journal row", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const flow = workflow.define({
      handler: async (step: any) => { // eslint-disable-line @typescript-eslint/no-explicit-any
        await step.runMutation("app:charge", { amt: 10 }, { compensate: "app:refund" });
        return "ok";
      },
    });
    const { runtime, tick } = await makeRuntimeWithWorkflow(
      {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        "app:kick": mutation(async (ctx: any) => ctx.workflow.start("app:flow", {})),
        "app:charge": mutation(async () => "charged"),
        "app:refund": mutation(async () => "refunded"),
      },
      { "app:flow": flow },
    );
    const runId = (await runtime.run("app:kick", {})).value as string;
    await tick();
    await tick();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const steps = (await readTable(runtime, "workflow/steps")).filter((s: any) => s.workflowId === runId);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const charge = steps.find((s: any) => s.name === "app:charge");
    expect(charge.compensateFnPath).toBe("app:refund"); // recorded
    expect(charge.state).toBe("success");
  });

  it("a step declared WITHOUT { compensate } leaves compensateFnPath undefined (additivity)", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const flow = workflow.define({
      handler: async (step: any) => { // eslint-disable-line @typescript-eslint/no-explicit-any
        await step.runMutation("app:plain", { amt: 5 });
        return "ok";
      },
    });
    const { runtime, tick } = await makeRuntimeWithWorkflow(
      {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        "app:kick": mutation(async (ctx: any) => ctx.workflow.start("app:flow", {})),
        "app:plain": mutation(async () => "done"),
      },
      { "app:flow": flow },
    );
    const runId = (await runtime.run("app:kick", {})).value as string;
    await tick();
    await tick();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const steps = (await readTable(runtime, "workflow/steps")).filter((s: any) => s.workflowId === runId);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const plain = steps.find((s: any) => s.name === "app:plain");
    expect(plain.compensateFnPath).toBeUndefined();
  });
});

describe("saga — reverse-order unwind on failure", () => {
  it("a failing 3-step saga compensates steps 2 then 1 in reverse, each receiving {args,result}", async () => {
    const log: string[] = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const flow = workflow.define({ handler: async (step: any) => {
      await step.runMutation("app:s1", { n: 1 }, { compensate: "app:c1" });
      await step.runMutation("app:s2", { n: 2 }, { compensate: "app:c2" });
      // maxAttempts: 1 — a throwing step's scheduler job otherwise blind-retries with real-time
      // exponential backoff (default maxFailures: 4, `computeBackoff` in
      // `components/scheduler/src/backoff.ts` — seconds of real wall-clock delay between retries),
      // which a synchronous `tick()`-driven test can never outlast without a controllable virtual
      // clock. Failing on the first attempt is what actually exercises the unwind promptly.
      await step.runMutation("app:s3", { n: 3 }, { maxAttempts: 1 });   // no compensation; this one throws
      return "unreached";
    }});
    const { runtime, tick } = await makeRuntimeWithWorkflow(
      { // eslint-disable-next-line @typescript-eslint/no-explicit-any
        "app:kick": mutation(async (ctx: any) => ctx.workflow.start("app:flow", {})),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        "app:s1": mutation(async (_c: any, a: any) => { log.push(`s1(${a.n})`); return "r1"; }),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        "app:s2": mutation(async (_c: any, a: any) => { log.push(`s2(${a.n})`); return "r2"; }),
        "app:s3": mutation(async () => { throw new Error("boom"); }),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        "app:c1": mutation(async (_c: any, a: any) => { log.push(`c1(args=${a.args.n},res=${a.result})`); return null; }),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        "app:c2": mutation(async (_c: any, a: any) => { log.push(`c2(args=${a.args.n},res=${a.result})`); return null; }) },
      { "app:flow": flow });
    const runId = (await runtime.run("app:kick", {})).value as string;
    for (let i = 0; i < 8; i++) await tick();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const st = (await runtime.run("workflow:status", { runId })).value as any;
    expect(st.state).toBe("failed");
    expect(st.error).toMatch(/boom/);                        // original failure preserved
    expect(log).toEqual(["s1(1)", "s2(2)", "c2(args=2,res=r2)", "c1(args=1,res=r1)"]);  // reverse unwind, args+result passed
  });

  it("a failing saga with NO compensations fails directly (no compensating phase)", async () => {
    const states: string[] = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    // maxAttempts: 1 — see the reverse-unwind test's comment above on why (blind retry backoff).
    const flow = workflow.define({ handler: async (step: any) => { await step.runMutation("app:s", {}, { maxAttempts: 1 }); return "x"; }});
    const { runtime, tick } = await makeRuntimeWithWorkflow(
      { // eslint-disable-next-line @typescript-eslint/no-explicit-any
        "app:kick": mutation(async (ctx: any) => ctx.workflow.start("app:flow", {})),
        "app:s": mutation(async () => { throw new Error("nope"); }) },
      { "app:flow": flow });
    const runId = (await runtime.run("app:kick", {})).value as string;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    for (let i = 0; i < 5; i++) { await tick(); states.push(((await runtime.run("workflow:status", { runId })).value as any).state); }
    expect(states).not.toContain("compensating");
    expect(states.at(-1)).toBe("failed");
  });
});

describe("saga — Task 3: halt on failed compensation, cancel compensates, fan-out reverse order", () => {
  it("a compensation that exhausts retries HALTS the unwind — terminal failed with a clear error", async () => {
    const log: string[] = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const flow = workflow.define({ handler: async (step: any) => {
      // maxAttempts: 1 on s1 — journaled onto s1's step row (Task 3) and threaded into its
      // compensation's (c1's) own retry cap, so c1 dead-letters on its FIRST failure instead of
      // blind-retrying with the scheduler's default real-wall-clock exponential backoff (see
      // `./src/schema.ts`'s `steps.maxAttempts` doc comment). s1 itself succeeds first try, so the
      // cap never bites its FORWARD dispatch — only its compensation's.
      await step.runMutation("app:s1", {}, { compensate: "app:c1", maxAttempts: 1 });
      await step.runMutation("app:s2", {}, { compensate: "app:c2" });
      await step.runMutation("app:s3", {}, { maxAttempts: 1 }); // no compensation; this one throws
      return "unreached";
    }});
    const { runtime, tick } = await makeRuntimeWithWorkflow(
      { // eslint-disable-next-line @typescript-eslint/no-explicit-any
        "app:kick": mutation(async (ctx: any) => ctx.workflow.start("app:flow", {})),
        "app:s1": mutation(async () => { log.push("s1"); return "r1"; }),
        "app:s2": mutation(async () => { log.push("s2"); return "r2"; }),
        "app:s3": mutation(async () => { throw new Error("boom"); }),
        "app:c1": mutation(async () => { log.push("c1"); throw new Error("c1 always fails"); }),
        "app:c2": mutation(async () => { log.push("c2"); return null; }) },
      { "app:flow": flow });
    const runId = (await runtime.run("app:kick", {})).value as string;
    for (let i = 0; i < 12; i++) await tick();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const st = (await runtime.run("workflow:status", { runId })).value as any;
    expect(st.state).toBe("failed");
    expect(st.error).toMatch(/compensation failed at step 0/); // s1 is stepNumber 0
    expect(st.error).toMatch(/boom/); // original failure preserved alongside the halt reason
    expect(log).toEqual(["s1", "s2", "c2", "c1"]); // c2 ran (success), c1 attempted then halted
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const steps = (await readTable(runtime, "workflow/steps")).filter((s: any) => s.workflowId === runId);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const s1Step = steps.find((s: any) => s.name === "app:s1");
    expect(s1Step.compensated).toBeFalsy(); // c1 never succeeded, so never marked compensated
  });

  it("cancel(runId) mid-saga compensates then reaches canceled", async () => {
    const log: string[] = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const flow = workflow.define({ handler: async (step: any) => {
      await step.runMutation("app:s1", {}, { compensate: "app:c1" });
      await step.runMutation("app:s2", {}, { compensate: "app:c2" });
      await step.sleep(1_000_000); // never fires within this test — parks the run so it's still "running" when we cancel it
      return "unreached";
    }});
    const { runtime, tick } = await makeRuntimeWithWorkflow(
      { // eslint-disable-next-line @typescript-eslint/no-explicit-any
        "app:kick": mutation(async (ctx: any) => ctx.workflow.start("app:flow", {})),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        "app:cancel": mutation(async (ctx: any, a: { runId: string }) => { await ctx.workflow.cancel(a.runId); return null; }),
        "app:s1": mutation(async () => { log.push("s1"); return "r1"; }),
        "app:s2": mutation(async () => { log.push("s2"); return "r2"; }),
        "app:c1": mutation(async () => { log.push("c1"); return null; }),
        "app:c2": mutation(async () => { log.push("c2"); return null; }) },
      { "app:flow": flow });
    const runId = (await runtime.run("app:kick", {})).value as string;
    for (let i = 0; i < 8; i++) await tick(); // runs s1, s2, then parks on the sleep
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(((await runtime.run("workflow:status", { runId })).value as any).state).toBe("running");

    await runtime.run("app:cancel", { runId });
    for (let i = 0; i < 12; i++) await tick(); // drives the compensate-by-default unwind to completion

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const st = (await runtime.run("workflow:status", { runId })).value as any;
    expect(st.state).toBe("canceled");
    expect(log).toEqual(["s1", "s2", "c2", "c1"]); // reverse-order compensation ran before reaching canceled
  });

  it("cancel(runId, { compensate: false }) skips compensation — canceled immediately, no undo runs", async () => {
    const log: string[] = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const flow = workflow.define({ handler: async (step: any) => {
      await step.runMutation("app:s1", {}, { compensate: "app:c1" });
      await step.sleep(1_000_000); // parks the run so it's still "running" when we cancel it
      return "unreached";
    }});
    const { runtime, tick } = await makeRuntimeWithWorkflow(
      { // eslint-disable-next-line @typescript-eslint/no-explicit-any
        "app:kick": mutation(async (ctx: any) => ctx.workflow.start("app:flow", {})),
        "app:cancelNoCompensate": mutation(
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          async (ctx: any, a: { runId: string }) => { await ctx.workflow.cancel(a.runId, { compensate: false }); return null; },
        ),
        "app:s1": mutation(async () => { log.push("s1"); return "r1"; }),
        "app:c1": mutation(async () => { log.push("c1"); return null; }) },
      { "app:flow": flow });
    const runId = (await runtime.run("app:kick", {})).value as string;
    for (let i = 0; i < 6; i++) await tick(); // runs s1, then parks on the sleep
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(((await runtime.run("workflow:status", { runId })).value as any).state).toBe("running");

    await runtime.run("app:cancelNoCompensate", { runId });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const st = (await runtime.run("workflow:status", { runId })).value as any;
    expect(st.state).toBe("canceled"); // immediate — no "compensating" phase, no extra ticks needed
    expect(log).toEqual(["s1"]); // c1 never ran
  });

  it("fan-out steps compensate in reverse stepNumber order, regardless of forward completion order", async () => {
    const log: string[] = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const flow = workflow.define({ handler: async (step: any) => {
      // `step.runMutation("app:a", ...)` is called (and assigned its stepNumber) before
      // `step.runMutation("app:b", ...)` — both synchronously, while building the `Promise.all`
      // array — so "app:a" is stepNumber 0 and "app:b" is stepNumber 1 regardless of which of the
      // two jobs the scheduler happens to complete first.
      await Promise.all([
        step.runMutation("app:a", {}, { compensate: "app:ca" }),
        step.runMutation("app:b", {}, { compensate: "app:cb" }),
      ]);
      await step.runMutation("app:fail", {}, { maxAttempts: 1 }); // no compensation; throws
      return "unreached";
    }});
    const { runtime, tick } = await makeRuntimeWithWorkflow(
      { // eslint-disable-next-line @typescript-eslint/no-explicit-any
        "app:kick": mutation(async (ctx: any) => ctx.workflow.start("app:flow", {})),
        "app:a": mutation(async () => { log.push("a"); return "ra"; }),
        "app:b": mutation(async () => { log.push("b"); return "rb"; }),
        "app:fail": mutation(async () => { throw new Error("boom"); }),
        "app:ca": mutation(async () => { log.push("ca"); return null; }),
        "app:cb": mutation(async () => { log.push("cb"); return null; }) },
      { "app:flow": flow });
    const runId = (await runtime.run("app:kick", {})).value as string;
    for (let i = 0; i < 14; i++) await tick();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const st = (await runtime.run("workflow:status", { runId })).value as any;
    expect(st.state).toBe("failed");
    expect(log.filter((x) => x === "a")).toHaveLength(1);
    expect(log.filter((x) => x === "b")).toHaveLength(1);
    expect(log.filter((x) => x === "ca")).toHaveLength(1);
    expect(log.filter((x) => x === "cb")).toHaveLength(1);
    // Reverse stepNumber order: b (stepNumber 1) compensates before a (stepNumber 0), independent
    // of whether "a" or "b" itself ran first forward.
    expect(log.indexOf("cb")).toBeLessThan(log.indexOf("ca"));
  });

  it("_compensate does not re-run an already-compensated step (crash-resume safety)", async () => {
    const log: string[] = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const flow = workflow.define({ handler: async (step: any) => {
      await step.runMutation("app:s1", {}, { compensate: "app:c1" });
      await step.runMutation("app:s2", {}, { maxAttempts: 1 }); // no compensation; throws
      return "unreached";
    }});
    const { runtime, tick, driver } = await makeRuntimeWithWorkflow(
      { // eslint-disable-next-line @typescript-eslint/no-explicit-any
        "app:kick": mutation(async (ctx: any) => ctx.workflow.start("app:flow", {})),
        "app:s1": mutation(async () => "r1"),
        "app:s2": mutation(async () => { throw new Error("boom"); }),
        "app:c1": mutation(async () => { log.push("c1"); return null; }) },
      { "app:flow": flow });
    // Stop the reactive driver so we can drive by hand and stop the INSTANT the workflow enters
    // "compensating" — before the newly-enqueued `workflow:_compensate` job (which would dispatch
    // c1 for real) gets its own turn (mirrors `occ-guard.test.ts`'s identical stop()+tick() pattern).
    driver.stop?.();
    const runId = (await runtime.run("app:kick", {})).value as string;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let state = "running";
    for (let i = 0; i < 12 && state === "running"; i++) {
      await tick();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      state = ((await runtime.run("workflow:status", { runId })).value as any).state;
    }
    expect(state).toBe("compensating"); // failOrCompensate has committed; workflow:_compensate is queued but NOT yet run

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const steps = (await readTable(runtime, "workflow/steps")).filter((s: any) => s.workflowId === runId);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const s1Step = steps.find((s: any) => s.name === "app:s1");
    expect(s1Step.compensated).toBeFalsy(); // not yet compensated by the natural flow

    // Simulate: this step's compensation already ran and journaled in a prior process (crash-resume
    // scenario) — force `compensated: true` directly, bypassing the real `_compensateDone` path.
    await runtime.runSystem("_system:patchDoc", { id: s1Step._id, patch: { compensated: true } });

    // Drive `_compensate` directly (privileged, fully-qualified — mirrors `occ-guard.test.ts`'s
    // direct `_stepDone` call) rather than via `tick()`, so this test's outcome doesn't depend on
    // exactly which scheduler-job wave would have picked up the already-queued one.
    await runtime.executor.run(
      _compensate,
      jsonToConvex({ workflowId: runId }),
      { path: "workflow:_compensate", privileged: true },
    );

    expect(log).toEqual([]); // c1 never ran — the already-compensated step was correctly skipped
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const st = (await runtime.run("workflow:status", { runId })).value as any;
    expect(st.state).toBe("failed"); // nothing left to compensate — unwind completed straight to terminal
  });
});
