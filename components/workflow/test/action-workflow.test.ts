// components/workflow/test/action-workflow.test.ts
//
// Task 7: `ctx.workflow` in ACTIONS (`workflowActionContext`, `./src/facade.ts`, wired as
// `defineWorkflow()`'s `buildAction`). Mirrors `components/scheduler/test/action-scheduler.test.ts`
// — proves `start`/`cancel`/`sendEvent` each work from an action (which has no `db` of its own) by
// delegating to the internal `workflow:_start`/`_cancel`/`_sendEvent` mutations (`./src/modules.ts`,
// `./src/events.ts`) via `ctx.runMutation`, exactly the way `ctx.scheduler`'s action-mode facade
// delegates to `scheduler:_enqueue`/`_cancel`.
import { describe, it, expect } from "vitest";
import { mutation, action } from "@stackbase/executor";
import { workflow } from "@stackbase/workflow";
import { makeRuntimeWithWorkflow, readTable } from "./helpers";

describe("ctx.workflow in actions (buildAction → runMutation delegation)", () => {
  it("ctx.workflow.start from an action starts a real run that the driver then advances", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const flow = workflow.define({
      handler: async (step: any) => {
        const r = await step.runMutation("app:step1", {});
        return r;
      },
    });
    const { runtime, tick } = await makeRuntimeWithWorkflow(
      {
        "app:step1": mutation(async () => "done"),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        "app:kickFromAction": action(async (ctx: any) => ctx.workflow.start("app:flow", {})),
      },
      { "app:flow": flow },
    );

    const runId = (await runtime.runAction("app:kickFromAction", {})).value as string;
    expect(typeof runId).toBe("string");
    await tick();
    await tick();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const st = (await runtime.run("workflow:status", { runId })).value as any;
    expect(st.state).toBe("completed");
    expect(st.result).toBe("done");
  });

  it("ctx.workflow.sendEvent from an action resolves a waitForEvent step", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const flow = workflow.define({
      handler: async (step: any) => {
        const approval = await step.waitForEvent("go");
        return approval;
      },
    });
    const { runtime, tick } = await makeRuntimeWithWorkflow(
      {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        "app:kick": mutation(async (ctx: any) => ctx.workflow.start("app:flow", {})),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        "app:sendFromAction": action(async (ctx: any, a: { runId: string }) => {
          await ctx.workflow.sendEvent(a.runId, "go", { ok: true });
          return null;
        }),
      },
      { "app:flow": flow },
    );

    const runId = (await runtime.run("app:kick", {})).value as string;
    await tick();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(((await runtime.run("workflow:status", { runId })).value as any).state).toBe("running"); // parked on waitForEvent

    await runtime.runAction("app:sendFromAction", { runId });
    await tick();
    await tick();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const st = (await runtime.run("workflow:status", { runId })).value as any;
    expect(st.state).toBe("completed");
    expect(st.result).toEqual({ ok: true });
  });

  it("ctx.workflow.cancel from an action bumps generationNumber and cascades to pending steps", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const flow = workflow.define({
      handler: async (step: any) => {
        await step.sleep(1_000_000); // never fires within this test — leaves a real pending step to cascade-cancel
        return "unreachable";
      },
    });
    const { runtime, tick } = await makeRuntimeWithWorkflow(
      {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        "app:kick": mutation(async (ctx: any) => ctx.workflow.start("app:flow", {})),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        "app:cancelFromAction": action(async (ctx: any, a: { runId: string }) => {
          await ctx.workflow.cancel(a.runId);
          return null;
        }),
      },
      { "app:flow": flow },
    );

    const runId = (await runtime.run("app:kick", {})).value as string;
    await tick(); // dispatches the sleep step (journals "pending" + a scheduler job)

    await runtime.runAction("app:cancelFromAction", { runId });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const st = (await runtime.run("workflow:status", { runId })).value as any;
    expect(st.state).toBe("canceled");

    const jobs = await readTable(runtime, "scheduler/jobs");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sleepJob = jobs.find((j: any) => j.fnPath === "workflow:_sleep");
    expect(sleepJob?.state).toBe("canceled");
  });
});
