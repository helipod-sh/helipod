// components/workflow/test/saga.test.ts
//
// Task 1 of the saga/compensation slice: this test only asserts that a step declared with
// `{ compensate }` RECORDS its resolved `compensateFnPath` on the step's journal row when
// dispatched. No unwind logic exists yet (that's Task 2) — a workflow with a `compensate` option
// behaves exactly as it did before this slice; the recorded field just sits unused.
import { describe, it, expect } from "vitest";
import { mutation } from "@stackbase/executor";
import { workflow } from "@stackbase/workflow";
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
