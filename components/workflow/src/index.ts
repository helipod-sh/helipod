import { defineComponent, type ComponentDefinition } from "@stackbase/component";
import { workflowSchema } from "./schema";
import { workflowContext, workflowActionContext } from "./facade";
import { status, makeAdvance, _stepDone, _sleep } from "./modules";
import { define, type WorkflowRegistry } from "./registry";

export * from "./schema";
export type { WorkflowHandlerCtx, WorkflowHandler, WorkflowDefinition, WorkflowRegistry } from "./registry";
export type { WorkflowContext, WorkflowActionContext, FnRef } from "./facade";
export { workflowContext, workflowActionContext } from "./facade";
export type { StepApi, JournalRow, NewStep, ReplayOutcome } from "./replay";
export { runReplay } from "./replay";

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
 * Task 2 replaced `_advance`'s Task-1 no-op stub with the real deterministic-replay loop
 * (`makeAdvance` in `./modules.ts`, driving `./replay.ts`'s `runReplay`) and added `_stepDone`,
 * the scheduler `onComplete` callback that journals a finished step's result and re-enqueues
 * `_advance` — see those files' doc comments for the full mechanism.
 */
export function defineWorkflow(opts: { workflows: WorkflowRegistry }): ComponentDefinition {
  return defineComponent({
    name: "workflow",
    schema: workflowSchema,
    requires: ["scheduler"],
    modules: { _advance: makeAdvance(opts.workflows), _stepDone, _sleep, status },
    context: (cctx) => workflowContext(cctx),
    contextType: { import: "@stackbase/workflow", type: "WorkflowContext" },
    contextWrite: true,
    // Full impl (delegating `start`/`cancel` to an internal `_`-prefixed mutation, mirroring
    // `@stackbase/scheduler`'s `schedulerActionContext`) is Task 7; a minimal stub is fine now —
    // see `workflowActionContext`'s doc comment in `./facade.ts`.
    buildAction: (api) => workflowActionContext(api),
  });
}
