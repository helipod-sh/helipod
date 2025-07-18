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
});
