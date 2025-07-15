import type { ComponentContext, ActionApi } from "@stackbase/executor";
import { GuestDatabaseWriter } from "@stackbase/executor";
import type { JSONValue } from "@stackbase/values";
import type { FnRef, SchedulerContext } from "@stackbase/scheduler";
import { getFunctionPath } from "@stackbase/scheduler";

export type { FnRef } from "@stackbase/scheduler";

/**
 * `ctx.workflow` — the durable multi-step orchestration facade. Task 1 ships `start`/`cancel`
 * only; `sendEvent`/`status`-as-a-facade-method/etc. land in later tasks (`status` is a QUERY
 * module instead — see `./modules.ts` — since it's read-only and needs no `contextWrite`).
 */
export interface WorkflowContext {
  /** Starts a new workflow run, returning its `runId` (the `workflows` row id). */
  start(ref: FnRef, args: JSONValue): Promise<string>;
  /** Cancels a running workflow. STUB in Task 1 — full impl (cascading step/event cleanup) is Task 3. */
  cancel(runId: string): Promise<void>;
}

/** Action-mode counterpart to `WorkflowContext` — see `workflowActionContext` below. */
export interface WorkflowActionContext {
  start(ref: FnRef, args: JSONValue): Promise<string>;
  cancel(runId: string): Promise<void>;
}

/**
 * Builds `ctx.workflow`. Requires `contextWrite: true` on `defineWorkflow()` (mirrors
 * `@stackbase/scheduler`'s `schedulerContext`) — without it, `cctx.db` is read-only and `start`'s
 * `db.insert` throws `ForbiddenOperationError`. With it, and ONLY during a mutation call,
 * `start` writes the new `workflows` row in the CALLING mutation's own transaction — exactly like
 * `ctx.scheduler.runAfter` — so it commits (or rolls back) atomically with the rest of the caller's
 * mutation.
 *
 * Reaches the scheduler facade via `cctx.components.scheduler` — populated because `defineWorkflow`
 * declares `requires: ["scheduler"]` and `composeComponents` builds context facades in the order
 * components were composed (scheduler before workflow — see `test/helpers.ts`'s
 * `makeRuntimeWithWorkflow`), so by the time this facade builds, the scheduler's own facade is
 * already in `builtFacades` (see `ComponentContext.components`'s doc comment in
 * `packages/executor/src/executor.ts`).
 */
export function workflowContext(cctx: ComponentContext): WorkflowContext {
  const db = cctx.db as GuestDatabaseWriter;
  const now = (): number => cctx.now;

  return {
    async start(ref, args) {
      const workflowFnPath = getFunctionPath(ref);
      const workflowId = await db.insert("workflows", {
        workflowFnPath,
        args,
        state: "running",
        generationNumber: 0,
        recoveryAttempts: 0,
        startedTs: now(),
      });
      const scheduler = cctx.components.scheduler as SchedulerContext;
      await scheduler.enqueue("workflow:_advance", { workflowId }, { runAt: now() });
      return workflowId as string;
    },
    async cancel(_runId) {
      // Task 1 is the skeleton slice — cancel's cascading step/event cleanup is Task 3. Fail
      // loudly rather than silently no-op, so a caller can't mistake this for a real cancel.
      throw new Error("ctx.workflow.cancel: not implemented yet (Task 3)");
    },
  };
}

/**
 * The action-mode `ctx.workflow` — wired as `defineWorkflow()`'s `buildAction`. An action has no
 * `db`, so `start` can't insert the `workflows` row directly the way `workflowContext` above does;
 * a real implementation delegates to an internal `workflow:_start`-style mutation via
 * `api.runMutation`, exactly like `@stackbase/scheduler`'s `schedulerActionContext` delegates to
 * `scheduler:_enqueue`. Not built in Task 1 (no such internal mutation exists yet — `start` writes
 * directly in the facade, see `workflowContext`'s doc comment) — full impl is Task 7. Stubbed here
 * (rather than omitted) so `defineWorkflow()`'s `buildAction` wiring — and codegen's action-ctx
 * typing — is in place from the start.
 */
export function workflowActionContext(_api: ActionApi): WorkflowActionContext {
  return {
    async start() {
      throw new Error("ctx.workflow.start from an action is not supported yet (Task 7)");
    },
    async cancel() {
      throw new Error("ctx.workflow.cancel from an action is not supported yet (Task 7)");
    },
  };
}
