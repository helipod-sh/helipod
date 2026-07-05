import { defineComponent, type ComponentDefinition } from "@helipod/component";
import { workflowSchema } from "./schema";
import { workflowContext, workflowActionContext } from "./facade";
import { status, makeAdvance, _stepDone, _sleep, _start, _cancel, _compensate, _compensateDone } from "./modules";
import { _sendEvent } from "./events";
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
 * `defineWorkflow({ workflows })` — the `@helipod/workflow` component: the `workflows`/`steps`/
 * `events` journal schema, the `ctx.workflow` facade (`start`/`cancel`), and the internal
 * `workflow:_advance` mutation the scheduler dispatches to drive a run forward.
 *
 * `requires: ["scheduler"]` — `ctx.workflow.start` enqueues `workflow:_advance` via the scheduler
 * facade (`cctx.components.scheduler`, see `./facade.ts`'s `workflowContext`), so an app composing
 * `defineWorkflow()` must also compose `defineScheduler()` (`composeComponents` throws otherwise —
 * see `packages/component/src/compose.ts`'s `requires` check).
 *
 * `contextWrite: true` is load-bearing the same way it is for `@helipod/scheduler`: it's what
 * lets `start` write (via the calling mutation's own transaction) instead of only reading — see
 * `workflowContext` in `./facade.ts`.
 *
 * Task 2 replaced `_advance`'s Task-1 no-op stub with the real deterministic-replay loop
 * (`makeAdvance` in `./modules.ts`, driving `./replay.ts`'s `runReplay`) and added `_stepDone`,
 * the scheduler `onComplete` callback that journals a finished step's result and re-enqueues
 * `_advance` — see those files' doc comments for the full mechanism.
 *
 * `maxParallelism` (Task 5, default 16 — see `./modules.ts`'s `DEFAULT_MAX_PARALLELISM`) caps how
 * many new steps a `Promise.all([step.a(), step.b(), ...])` fan-out dispatches in a single
 * `_advance` poll; see `makeAdvance`'s doc comment for why exceeding it is safe (spread across more
 * polls, nothing dropped) rather than an error.
 *
 * Task 6 added `step.waitForEvent` (`./replay.ts`) + `ctx.workflow.sendEvent` (`./facade.ts`) + the
 * internal `_sendEvent` module (`./events.ts`) — the durable-signal differentiator: a
 * `waitForEvent` step parks with NO scheduler job (an `events` row instead), and `sendEvent`
 * resolves it by journaling the step and re-enqueuing `_advance`, riding the same commit-fan-out
 * wake every other step already does.
 *
 * Task 7 added the action-mode `ctx.workflow` (`workflowActionContext`, wired below as
 * `buildAction`) plus its two remaining internal delegate targets, `_start`/`_cancel`
 * (`./modules.ts`; `_sendEvent` already existed from Task 6) — `ctx.workflow.start`/`cancel`/
 * `sendEvent` now work from an ACTION, not just a mutation, exactly like `ctx.scheduler` does.
 *
 * The saga/compensation slice's Task 2 added `_compensate`/`_compensateDone` (`./modules.ts`) —
 * the reverse-order unwind loop: on failure, `_advance`'s `failOrCompensate` helper reroutes into
 * a `"compensating"` state instead of terminal-failing whenever a completed step still owes a
 * `{ compensate }` handler a run; `_compensate`/`_compensateDone` then walk the `steps` journal
 * backwards, dispatching each owed compensation via the scheduler, mirroring `_advance`/
 * `_stepDone`'s dispatch-then-re-enqueue shape exactly (see those functions' doc comments).
 *
 * Task 3 finished the saga/compensation slice: a compensation that itself exhausts its retries
 * HALTS the unwind (terminal `"failed"`, preserving the original error alongside the halt reason —
 * `_compensateDone`'s failure branch); `ctx.workflow.cancel` (`./facade.ts`) now compensates by
 * default (opt out with `{ compensate: false }`), is idempotent against a workflow that's already
 * `"compensating"`, and cascade-cancels an in-flight compensation job the same way it already
 * cascade-canceled a pending forward step job. A step's own `{ maxAttempts }` now also caps its
 * compensation's retries (journaled `steps.maxAttempts` -> `_compensate`'s `retry.maxFailures`).
 */
export function defineWorkflow(opts: { workflows: WorkflowRegistry; maxParallelism?: number }): ComponentDefinition {
  return defineComponent({
    name: "workflow",
    schema: workflowSchema,
    requires: ["scheduler"],
    modules: {
      _advance: makeAdvance(opts.workflows, opts.maxParallelism),
      _stepDone,
      _compensate,
      _compensateDone,
      _sleep,
      _sendEvent,
      _start,
      _cancel,
      status,
    },
    context: (cctx) => workflowContext(cctx),
    contextType: { import: "@helipod/workflow", type: "WorkflowContext" },
    contextWrite: true,
    // Task 7: the action-mode `ctx.workflow` — `start`/`cancel`/`sendEvent` each delegate to one
    // of the internal `_start`/`_cancel`/`_sendEvent` mutations above via `api.runMutation`,
    // mirroring `@helipod/scheduler`'s `schedulerActionContext` — see `workflowActionContext`'s
    // doc comment in `./facade.ts`.
    buildAction: (api) => workflowActionContext(api),
  });
}
