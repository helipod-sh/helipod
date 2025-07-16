import type { ComponentContext, ActionApi } from "@stackbase/executor";
import { GuestDatabaseWriter } from "@stackbase/executor";
import type { JSONValue } from "@stackbase/values";
import type { FnRef, SchedulerContext } from "@stackbase/scheduler";
import { getFunctionPath } from "@stackbase/scheduler";
import { sendEventImpl } from "./events";

export type { FnRef } from "@stackbase/scheduler";

/** Bare (namespaced) table names `workflowContext.sendEvent` operates on — resolved to `"workflow/events"`/`"workflow/steps"` the same way every other `cctx.db` call on this facade already is. `./events.ts`'s `_sendEvent` (the action-mode delegate, dispatched non-privileged) uses this SAME shape via `ctx.workflow.sendEvent`, not a fully-qualified variant — see that module's doc comment. */
const FACADE_EVENT_TABLES = { events: "events", steps: "steps" };

/**
 * `ctx.workflow` — the durable multi-step orchestration facade. `status` is a QUERY module
 * instead (see `./modules.ts`) since it's read-only and needs no `contextWrite`.
 */
export interface WorkflowContext {
  /** Starts a new workflow run, returning its `runId` (the `workflows` row id). */
  start(ref: FnRef, args: JSONValue): Promise<string>;
  /**
   * Cancels a running workflow: bumps `generationNumber`, sets `state:"canceled"`, and cascades
   * cancel to any in-flight step jobs. A no-op if the run is already terminal. Full impl landed
   * Task 3 — see `workflowContext` below.
   */
  cancel(runId: string): Promise<void>;
  /**
   * Resolves a running workflow's `step.waitForEvent(name)` (`./replay.ts`) with `payload`. A
   * no-op if there's no matching `"waiting"` `events` row (already delivered / not reached yet /
   * unknown workflow) — see `./events.ts`'s `sendEventImpl` doc comment. Task 6.
   */
  sendEvent(runId: string, name: string, payload?: JSONValue): Promise<void>;
}

/** Action-mode counterpart to `WorkflowContext` — see `workflowActionContext` below. */
export interface WorkflowActionContext {
  start(ref: FnRef, args: JSONValue): Promise<string>;
  cancel(runId: string): Promise<void>;
  sendEvent(runId: string, name: string, payload?: JSONValue): Promise<void>;
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
    async cancel(runId) {
      // Task 3: the real cancel. Reads the `workflows` row, bumps `generationNumber` (this is
      // what makes any in-flight step's later `_stepDone` — which carries the OLD generation as
      // part of its `onComplete` context, stamped by `_advance` — self-discard rather than
      // resurrect the run; see `_stepDone`'s OCC guard in `./modules.ts`), and flips `state` to
      // `"canceled"`. Then cascades the cancel to every `steps` row still `"pending"` with a
      // `scheduledJobId` — the scheduler's own `cancel()` (`@stackbase/scheduler`'s
      // `schedulerContext`) further cascades to that job's own descendants (e.g. a retry chain),
      // so we only need to walk OUR direct step jobs here, not recurse ourselves.
      const wf = await db.get(runId);
      if (wf === null) throw new Error(`ctx.workflow.cancel: no such workflow ${runId}`);
      if (wf.state !== "running") return; // already terminal (completed/failed/canceled) — idempotent no-op
      const gen = wf.generationNumber as number;
      await db.replace(runId, { ...wf, state: "canceled", generationNumber: gen + 1, completedTs: now() });

      const scheduler = cctx.components.scheduler as SchedulerContext;
      const steps = await db.query("steps", "by_workflow").eq("workflowId", runId).collect();
      for (const s of steps) {
        if (s.state === "pending" && typeof s.scheduledJobId === "string") {
          await scheduler.cancel(s.scheduledJobId);
        }
      }
    },
    async sendEvent(runId, name, payload) {
      // Runs directly against the calling mutation's own `cctx.db` — same transaction, same
      // `contextWrite` story as `start`/`cancel` above. `sendEventImpl` (`./events.ts`) is the one
      // shared implementation; this just supplies the bare (namespaced) table names.
      const scheduler = cctx.components.scheduler as SchedulerContext;
      await sendEventImpl(db, scheduler, now, FACADE_EVENT_TABLES, { workflowId: runId, name, payload });
    },
  };
}

/**
 * The action-mode `ctx.workflow` — wired as `defineWorkflow()`'s `buildAction`. An action has no
 * `db`, so `start`/`cancel`/`sendEvent` can't touch `cctx.db` directly the way `workflowContext`
 * above does; each delegates to an internal `workflow:_start`/`_cancel`/`_sendEvent` mutation via
 * `api.runMutation`, exactly like `@stackbase/scheduler`'s `schedulerActionContext` delegates to
 * `scheduler:_enqueue`/`_cancel` (`components/scheduler/src/facade.ts`).
 *
 * `_start`/`_cancel` are registered in `./modules.ts`; `_sendEvent` in `./events.ts`. All three
 * are ordinary (non-privileged) mutations — the action `invoke` seam (`ActionApi`'s
 * `runQuery`/`runMutation`/`runAction`, `packages/executor/src/executor.ts`'s `runActionFn`)
 * never sets `privileged`, so each runs namespaced under `"workflow"`, exactly like a normal
 * mutation's own `ctx.workflow.start(...)` call — see `./modules.ts`'s doc comment on `_start`/
 * `_cancel` for why they delegate to the SAME `ctx.workflow` facade rather than hand-rolling
 * fully-qualified table access (that would double-prefix and throw `FunctionNotFoundError`; only
 * driver-dispatched modules like `_advance`/`_stepDone`, which run with `privileged: true`
 * unconditionally, use fully-qualified names).
 */
export function workflowActionContext(api: ActionApi): WorkflowActionContext {
  return {
    async start(ref, args) {
      return api.runMutation<string>("workflow:_start", { workflowFnPath: getFunctionPath(ref), args });
    },
    async cancel(runId) {
      await api.runMutation("workflow:_cancel", { runId });
    },
    async sendEvent(runId, name, payload) {
      await api.runMutation("workflow:_sendEvent", { workflowId: runId, name, payload });
    },
  };
}
