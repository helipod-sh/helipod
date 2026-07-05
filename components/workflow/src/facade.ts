import type { ComponentContext, ActionApi } from "@helipod/executor";
import { GuestDatabaseWriter } from "@helipod/executor";
import type { JSONValue } from "@helipod/values";
import type { FnRef, SchedulerContext } from "@helipod/scheduler";
import { getFunctionPath } from "@helipod/scheduler";
import { sendEventImpl } from "./events";

export type { FnRef } from "@helipod/scheduler";

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
   * Cancels a running workflow. By DEFAULT, compensates first: bumps `generationNumber`, cascades
   * cancel to any in-flight step jobs (forward AND, if one's dispatched, an in-flight compensation
   * job), and — if any completed step still owes a `{ compensate }` handler a run — enters
   * `"compensating"` and walks the journal backwards exactly like a failure's unwind, reaching
   * `"canceled"` only once every owed compensation has run. Pass `{ compensate: false }` to skip
   * compensation and reach `"canceled"` immediately instead (or when there's nothing recorded to
   * undo, in which case this is the only path regardless of `opts`). A no-op if the run is already
   * terminal OR already `"compensating"` (idempotent — re-canceling a workflow that's already
   * mid-unwind doesn't restart or race it). See `workflowContext` below for the full impl.
   */
  cancel(runId: string, opts?: { compensate?: boolean }): Promise<void>;
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
  cancel(runId: string, opts?: { compensate?: boolean }): Promise<void>;
  sendEvent(runId: string, name: string, payload?: JSONValue): Promise<void>;
}

/**
 * Builds `ctx.workflow`. Requires `contextWrite: true` on `defineWorkflow()` (mirrors
 * `@helipod/scheduler`'s `schedulerContext`) — without it, `cctx.db` is read-only and `start`'s
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
    async cancel(runId, opts) {
      // Task 3: the real cancel — compensate-by-default, with an `{ compensate: false }` opt-out.
      //
      // Reads the `workflows` row; a non-`"running"` workflow (already terminal, OR already
      // `"compensating"` from a PRIOR cancel/failure) is an idempotent no-op — this guard must run
      // BEFORE any write. Critically, it's what keeps a second cancel arriving mid-unwind safe: if
      // it instead bumped `generationNumber` again, the in-flight `_compensateDone` (which carries
      // the gen captured when THIS unwind started) would self-discard via its own OCC guard
      // (`./modules.ts`) and strand the unwind forever with no one left to drive it forward.
      //
      // For a genuinely `"running"` workflow: bump `generationNumber` (this is what makes any
      // in-flight FORWARD step's later `_stepDone` — which carries the OLD generation as part of
      // its `onComplete` context, stamped by `_advance` — self-discard rather than resurrect the
      // run; see `_stepDone`'s OCC guard in `./modules.ts`), and cascade-cancel every `steps` row's
      // in-flight job: a `"pending"` forward step's `scheduledJobId`, AND (Task 3) any dispatched-
      // but-not-yet-`compensated` step's `compensationJobId`. Under the single-writer transactor a
      // step can't actually have a `compensationJobId` while `wf.state === "running"` (that field is
      // only ever stamped once a PRIOR failure has already flipped `state` to `"compensating"`, at
      // which point the guard above already returned) — this half of the loop is defense-in-depth
      // mirroring the `scheduledJobId` cascade, kept symmetric rather than load-bearing today. The
      // scheduler's own `cancel()` (`@helipod/scheduler`'s `schedulerContext`) further cascades to
      // that job's own descendants (e.g. a retry chain), so we only need to walk OUR direct jobs
      // here, not recurse ourselves.
      //
      // THEN: if the caller opted out (`{ compensate: false }`) or there's nothing recorded to
      // undo, go terminal `"canceled"` directly — the pre-Task-3 behavior, now also firing the
      // workflow's own `onComplete` (mirroring every other terminal transition in `./modules.ts`).
      // Otherwise, replicate the small compensating-entry write `failOrCompensate` (`./modules.ts`)
      // performs on a failure — see that function's doc comment for exactly why this can't just
      // call it directly (privileged fully-qualified vs. this facade's namespaced bare table names).
      // Passing the row with the ALREADY-BUMPED `generationNumber` here means `_compensate`, which
      // re-reads the row itself, captures gen+1 — the same generation `_compensateDone` will later
      // check, closing the loop with the no-op-if-already-`"compensating"` guard above.
      const wf = await db.get(runId);
      if (wf === null) throw new Error(`ctx.workflow.cancel: no such workflow ${runId}`);
      if (wf.state !== "running") return; // already terminal, or already compensating — idempotent no-op
      const gen = wf.generationNumber as number;

      const scheduler = cctx.components.scheduler as SchedulerContext;
      const steps = await db.query("steps", "by_workflow").eq("workflowId", runId).collect();
      for (const s of steps) {
        if (s.state === "pending" && typeof s.scheduledJobId === "string") {
          await scheduler.cancel(s.scheduledJobId);
        }
        if (typeof s.compensationJobId === "string" && !s.compensated) {
          await scheduler.cancel(s.compensationJobId);
        }
      }

      const hasComp = steps.some((s) => s.state === "success" && s.compensateFnPath && !s.compensated);
      if (opts?.compensate === false || !hasComp) {
        await db.replace(runId, { ...wf, state: "canceled", generationNumber: gen + 1, completedTs: now() });
        const onComplete = wf.onComplete as string | undefined;
        if (onComplete !== undefined) {
          const payload: Record<string, unknown> = { workflowId: runId, result: { kind: "canceled" } };
          if (wf.context !== undefined) payload.context = wf.context;
          await scheduler.enqueue(onComplete, payload as unknown as JSONValue, { runAt: now() });
        }
        return;
      }

      await db.replace(runId, {
        ...wf,
        state: "compensating",
        generationNumber: gen + 1,
        error: "canceled (by request)",
        compensationTarget: "canceled",
      });
      await scheduler.enqueue("workflow:_compensate", { workflowId: runId } as unknown as JSONValue, {});
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
 * `api.runMutation`, exactly like `@helipod/scheduler`'s `schedulerActionContext` delegates to
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
    async cancel(runId, opts) {
      // `compensate` is only included when the caller actually passed it — an explicit `undefined`
      // in the args object would throw when this in-process `api.runMutation` call serializes
      // through `convexToJson` (`packages/executor/src/executor.ts`'s `runActionFn`), same
      // discipline as `./modules.ts`'s `compact()` helper (not reachable from here).
      const args: Record<string, unknown> = { runId };
      if (opts?.compensate !== undefined) args.compensate = opts.compensate;
      await api.runMutation("workflow:_cancel", args);
    },
    async sendEvent(runId, name, payload) {
      await api.runMutation("workflow:_sendEvent", { workflowId: runId, name, payload });
    },
  };
}
