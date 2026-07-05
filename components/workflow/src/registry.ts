/**
 * The workflow authoring surface's registry types — mirrors `@helipod/scheduler`'s job registry
 * shape, but for durable multi-step workflow handlers rather than one-shot scheduled functions.
 *
 * `WorkflowHandlerCtx` is the `step` object a workflow handler receives (`step.runMutation(...)`,
 * `step.runQuery(...)`, …) — Task 2's replay loop (`./replay.ts`) fills it in as `StepApi`
 * (`runAction`/`sleep`/`waitForEvent` are added in Tasks 4/6). `import type` only, to avoid a
 * runtime circular import: `./replay.ts` imports `WorkflowHandler` from here.
 */
import type { StepApi as WorkflowHandlerCtx } from "./replay";
export type { WorkflowHandlerCtx };

export type WorkflowHandler = (step: WorkflowHandlerCtx, args: unknown) => Promise<unknown>;

export interface WorkflowDefinition {
  handler: WorkflowHandler;
}

export type WorkflowRegistry = Record<string, WorkflowDefinition>;

/** `workflow.define({ handler })` — the authoring surface an app's workflow module calls. */
export function define(def: { handler: WorkflowHandler }): WorkflowDefinition {
  return { handler: def.handler };
}
