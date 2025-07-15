/**
 * The workflow authoring surface's registry types — mirrors `@stackbase/scheduler`'s job registry
 * shape, but for durable multi-step workflow handlers rather than one-shot scheduled functions.
 *
 * `WorkflowHandlerCtx` is deliberately `unknown`-shaped here — it's the `step` object a workflow
 * handler receives (`step.runMutation(...)`, `step.sleep(...)`, etc.), filled in by Task 2's
 * replay loop. Task 1 only needs the registry SHAPE (so `workflow.define({...})` type-checks and
 * `defineWorkflow({ workflows })` can look handlers up by path) — `_advance` never actually calls
 * a handler yet (see `./modules.ts`'s `makeAdvance` stub).
 */
export interface WorkflowHandlerCtx {
  // Filled in by Task 2 — the `step` object (`step.runMutation`/`step.runAction`/`step.sleep`/…).
}

export type WorkflowHandler = (step: WorkflowHandlerCtx, args: unknown) => Promise<unknown>;

export interface WorkflowDefinition {
  handler: WorkflowHandler;
}

export type WorkflowRegistry = Record<string, WorkflowDefinition>;

/** `workflow.define({ handler })` — the authoring surface an app's workflow module calls. */
export function define(def: { handler: WorkflowHandler }): WorkflowDefinition {
  return { handler: def.handler };
}
