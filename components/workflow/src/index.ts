import { defineComponent, type ComponentDefinition } from "@stackbase/component";
import { workflowSchema } from "./schema";
import { workflowContext, workflowActionContext } from "./facade";
import { status, makeAdvance } from "./modules";
import { define, type WorkflowRegistry } from "./registry";

export * from "./schema";
export type { WorkflowHandlerCtx, WorkflowHandler, WorkflowDefinition, WorkflowRegistry } from "./registry";
export type { WorkflowContext, WorkflowActionContext, FnRef } from "./facade";
export { workflowContext, workflowActionContext } from "./facade";

/** `workflow.define({ handler })` — the authoring surface an app's workflow module calls. */
export const workflow = { define };

/**
 * `defineWorkflow({ workflows })` — the `@stackbase/workflow` component: the `workflows`/`steps`/
 * `events` journal schema, the `ctx.workflow` facade (`start`/`cancel`), and the internal
 * `workflow:_advance` mutation the scheduler dispatches to drive a run forward.
 *
 * `requires: ["scheduler"]` — `ctx.workflow.start` enqueues `workflow:_advance` via the scheduler
 * facade (`cctx.components.scheduler`, see `./facade.ts`'s `workflowContext`), so an app composing
 * `defineWorkflow()` must also compose `defineScheduler()` (`composeComponents` throws otherwise —
 * see `packages/component/src/compose.ts`'s `requires` check).
 *
 * `contextWrite: true` is load-bearing the same way it is for `@stackbase/scheduler`: it's what
 * lets `start` write (via the calling mutation's own transaction) instead of only reading — see
 * `workflowContext` in `./facade.ts`.
 *
 * Task 1 is the skeleton slice: `_advance` (`makeAdvance` in `./modules.ts`) is a deliberate
 * no-op stub — the real replay loop that actually runs a workflow's registered handler forward
 * through the durable `steps` journal is Task 2.
 */
export function defineWorkflow(opts: { workflows: WorkflowRegistry }): ComponentDefinition {
  return defineComponent({
    name: "workflow",
    schema: workflowSchema,
    requires: ["scheduler"],
    modules: { _advance: makeAdvance(opts.workflows), status },
    context: (cctx) => workflowContext(cctx),
    contextType: { import: "@stackbase/workflow", type: "WorkflowContext" },
    contextWrite: true,
    // Full impl (delegating `start`/`cancel` to an internal `_`-prefixed mutation, mirroring
    // `@stackbase/scheduler`'s `schedulerActionContext`) is Task 7; a minimal stub is fine now —
    // see `workflowActionContext`'s doc comment in `./facade.ts`.
    buildAction: (api) => workflowActionContext(api),
  });
}
