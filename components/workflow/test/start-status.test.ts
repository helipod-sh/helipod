import { describe, it, expect } from "vitest";
import { mutation, query } from "@helipod/executor";
import { workflow } from "@helipod/workflow"; // the authoring surface: workflow.define
import { makeRuntimeWithWorkflow } from "./helpers";

describe("workflow start + status", () => {
  it("start() creates a running workflow and status() reflects it", async () => {
    const noop = workflow.define({ handler: async () => "done" });
    const { runtime } = await makeRuntimeWithWorkflow(
      { "app:kick": mutation(async (ctx: any, a: { x: number }) => ctx.workflow.start("app:noopFlow", { x: a.x })) },
      { "app:noopFlow": noop },
    );
    const runId = (await runtime.run("app:kick", { x: 1 })).value as string;
    expect(typeof runId).toBe("string");
    const st = (await runtime.run("workflow:status", { runId })).value as any; // status is a query module
    expect(st.state).toBe("running");
  });
});
