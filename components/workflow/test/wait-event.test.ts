// components/workflow/test/wait-event.test.ts
//
// Task 6: `step.waitForEvent(name)` — a durable pause with NO scheduler job. A brand-new
// `waitForEvent` step parks on an `events` row (`state:"waiting"`) instead of dispatching through
// the scheduler the way every other step kind does. `ctx.workflow.sendEvent(runId, name, payload)`
// flips that row to `"received"`, journals the matching `steps` row `"success"` with the payload as
// its result, and re-enqueues `workflow:_advance` — the commit fan-out wakes the driver and replay
// resolves the now-cached step. See `./helpers.ts` for the runtime harness and `tick()`.
import { describe, it, expect } from "vitest";
import { mutation } from "@helipod/executor";
import { workflow } from "@helipod/workflow"; // the authoring surface: workflow.define
import { makeRuntimeWithWorkflow } from "./helpers";

describe("workflow step.waitForEvent + ctx.workflow.sendEvent", () => {
  it("waitForEvent parks the workflow until sendEvent resolves it", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const flow = workflow.define({
      handler: async (step: any) => {
        const approval = await step.waitForEvent("approved");
        return approval;
      },
    });
    const { runtime, tick } = await makeRuntimeWithWorkflow(
      {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        "app:kick": mutation(async (ctx: any) => ctx.workflow.start("app:flow", {})),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        "app:send": mutation(async (ctx: any, a: { runId: string }) => ctx.workflow.sendEvent(a.runId, "approved", { by: "mgr" })),
      },
      { "app:flow": flow },
    );
    const runId = (await runtime.run("app:kick", {})).value as string;
    await tick();
    await tick();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(((await runtime.run("workflow:status", { runId })).value as any).state).toBe("running"); // parked
    await runtime.run("app:send", { runId }); // resolve the event
    await tick();
    await tick();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const st = (await runtime.run("workflow:status", { runId })).value as any;
    expect(st.state).toBe("completed");
    expect(st.result).toEqual({ by: "mgr" });
  });
});
