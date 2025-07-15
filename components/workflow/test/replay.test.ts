import { describe, it, expect } from "vitest";
import { mutation } from "@stackbase/executor";
import { workflow } from "@stackbase/workflow"; // the authoring surface: workflow.define
import { makeRuntimeWithWorkflow } from "./helpers";

describe("workflow replay loop", () => {
  it("a 3-step sequential workflow runs each step once and completes", async () => {
    const log: string[] = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const flow = workflow.define({
      handler: async (step: any) => {
        const a = await step.runMutation("app:s", { n: 1 });
        const b = await step.runMutation("app:s", { n: 2 });
        const c = await step.runMutation("app:s", { n: 3 });
        return [a, b, c];
      },
    });
    const { runtime, tick } = await makeRuntimeWithWorkflow(
      {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        "app:kick": mutation(async (ctx: any) => ctx.workflow.start("app:flow", {})),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        "app:s": mutation(async (_c: any, x: { n: number }) => {
          log.push(`run${x.n}`);
          return x.n * 10;
        }),
      },
      { "app:flow": flow },
    );
    const runId = (await runtime.run("app:kick", {})).value as string;
    await tick();
    await tick();
    await tick();
    await tick(); // drive the scheduler until the workflow settles
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const st = (await runtime.run("workflow:status", { runId })).value as any;
    expect(st.state).toBe("completed");
    expect(st.result).toEqual([10, 20, 30]);
    expect(log).toEqual(["run1", "run2", "run3"]); // each step ran exactly once (replay didn't re-run)
  });
});
