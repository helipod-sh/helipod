import { query, mutation } from "@stackbase/executor";
import type { QueryCtx, RegisteredFunction } from "@stackbase/executor";
import type { JSONValue } from "@stackbase/values";
import type { OnCompleteResult, SchedulerContext } from "@stackbase/scheduler";
import type { WorkflowRegistry } from "./registry";
import { runReplay, type JournalRow } from "./replay";

/**
 * `workflow:status` — a QUERY: reads a `workflows` row by id and projects it down to the
 * client-facing shape (`state`/`result`/`error`), or `null` if the run doesn't exist. Read-only,
 * so it needs no `contextWrite` — registered directly on `defineWorkflow()`'s `modules` map (see
 * `./index.ts`), reachable at `workflow:status`, and LIVE like any other query — a subscribed
 * client's view reactively re-runs/re-pushes on every write to this run's `workflows` row (the
 * commit fan-out this whole component's `_advance`/`_stepDone` cascade rides).
 *
 * `result`/`error` are OMITTED (not included as `undefined`) while the run hasn't reached that
 * outcome yet — an in-process `runtime.run("workflow:status", ...)` call (every unit test in this
 * package) never serializes its return value, so a raw `undefined` field passed silently; the real
 * client subscription path does NOT — `SyncProtocolHandler`'s `execSub` JSON-encodes every query
 * result via `convexToJson` before pushing it as a `QueryUpdated` modification, and `convexToJson`
 * throws `TypeError: Cannot encode value of type undefined` on an `undefined`-valued object key
 * (`packages/values/src/json.ts`). This was a real gap this component's Task 7 E2E
 * (`packages/cli/test/workflow-e2e.test.ts`) caught: subscribing to `workflow:status` for a
 * freshly-started (still-`"running"`, no `result`/`error` yet) run failed with `QueryFailed`
 * instead of `QueryUpdated` — every prior task's tests called `runtime.run(...)` directly and never
 * exercised the wire-serialization path. Mirrors the `compact()` helper every other component
 * (`@stackbase/scheduler`'s `facade.ts`/`modules.ts`) already uses before a `db.insert`/`replace`;
 * this is the same discipline applied to a QUERY's return value instead.
 */
export const status = query(async (ctx: QueryCtx, a: { runId: string }) => {
  const wf = await ctx.db.get(a.runId);
  if (wf === null) return null;
  const out: { state: string; result?: unknown; error?: string } = { state: wf.state as string };
  if (wf.result !== undefined) out.result = wf.result;
  if (wf.error !== undefined) out.error = wf.error as string;
  return out;
});

/**
 * `workflow:_sleep` — the dispatch target for every `step.sleep`/`step.sleepUntil` call (see
 * `./replay.ts`'s `SLEEP_FN`). A trivial no-op MUTATION: `step.sleep` doesn't need this function
 * to actually DO anything — the durability comes entirely from the scheduler's `runAt`, the same
 * way `runMutation`/`runAction` steps derive theirs from a real dispatched job. The step
 * "completes" (unblocking replay) the instant this job fires and its `onComplete:
 * "workflow:_stepDone"` callback journals the (uninteresting, always-`null`) result.
 */
export const _sleep = mutation(async () => null);

/**
 * `_advance`/`_stepDone` are dispatched EXCLUSIVELY by the scheduler driver (`workflow:_advance`
 * is enqueued as an ordinary scheduler job — `ctx.workflow.start`, `_stepDone`'s own re-enqueue at
 * the bottom of this file), so they always run PRIVILEGED (`DriverContext.runFunction` in
 * `packages/runtime-embedded/src/runtime.ts` sets `privileged: true` unconditionally) — exactly
 * like `@stackbase/scheduler`'s own `_cronTick`. Privileged mode bypasses namespace prefixing
 * entirely (`requireTable` in `packages/executor/src/kernel.ts`), so their OWN `ctx.db`
 * calls must use fully-qualified table names (`"workflow/workflows"`, `"workflow/steps"`), not the
 * bare names a normal namespaced mutation would use — mirroring `_cronTick`'s `CRON_TABLES`
 * convention in `components/scheduler/src/modules.ts`. `ctx.db.get`/`ctx.db.replace` don't need
 * this (the target table is resolved from the id itself), only `insert`/`query` do.
 *
 * `ctx.scheduler`, by contrast, is a per-component FACADE, always built with `privileged: false`
 * and its own namespace baked in regardless of the outer call's privileged flag (see
 * `InlineUdfExecutor.run`'s `pctx` in `packages/executor/src/executor.ts`) — so
 * `(ctx as any).scheduler.enqueue(...)`'s bare `"jobs"`/`"job_args"` resolve correctly to
 * `"scheduler/jobs"`/`"scheduler/job_args"` the same way they do from a normal mutation. Every
 * enabled component's `context` provider is attached to `ctx` unconditionally regardless of
 * privileged dispatch, so `(ctx as any).scheduler` reaches the scheduler component's facade —
 * reliable regardless of compose order because Task 1b made `composeComponents`
 * order-independent. `ctx: any` mirrors the scheduler's own internals (`_enqueue`/`_cancel`/
 * `_cronTick`): `ctx.scheduler` isn't part of the exported `MutationCtx` shape (it's a dynamic
 * per-component facade attached at run time).
 */
const STEPS_TABLE = "workflow/steps";

/** `_advance`'s privileged, fully-qualified `events` table — see `STEPS_TABLE`'s doc comment above; written when a new `waitForEvent` step dispatches (see `makeAdvance`'s dispatch loop). */
const EVENTS_TABLE = "workflow/events";

/** `makeAdvance`'s default fan-out cap when `defineWorkflow({ maxParallelism })` doesn't set one — see `makeAdvance`'s doc comment. */
const DEFAULT_MAX_PARALLELISM = 16;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function schedulerFacade(ctx: any): SchedulerContext {
  return ctx.scheduler as SchedulerContext;
}

/** Drop `undefined`-valued keys — the wire codec (`convexToJson`) rejects `undefined`; omit rather than null it out. Mirrors `@stackbase/scheduler`'s `compact` (not exported, so replicated here). */
function compact<T extends Record<string, unknown>>(obj: T): { [K in keyof T]: Exclude<T[K], undefined> } {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) if (v !== undefined) out[k] = v;
  return out as { [K in keyof T]: Exclude<T[K], undefined> };
}

/**
 * If `wf.onComplete` is set, enqueue it with the workflow's terminal outcome — the workflow-level
 * analog of `@stackbase/scheduler`'s `fireOnComplete` (`components/scheduler/src/facade.ts`).
 * `wf.context` is round-tripped verbatim (opaque to the workflow component, same contract as the
 * scheduler's). A no-op when `onComplete` is unset — the common case; a full workflow-of-workflows
 * slice (chaining a parent workflow's own `step` off a child's completion) is future work, this is
 * just the round-trip primitive.
 *
 * `result` already accepts a `{kind:"canceled"}` outcome — it's typed as the scheduler's full
 * `OnCompleteResult` union and passed through opaquely, so no change was needed here for the saga
 * slice's `"canceled"` compensation target (Task 3); every CALLER in this file passes `"failed"`
 * today, `"canceled"` is exercised once `ctx.workflow.cancel` routes through `failOrCompensate`.
 */
async function fireWorkflowOnComplete(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ctx: any,
  wf: Record<string, unknown>,
  result: OnCompleteResult,
): Promise<void> {
  const onComplete = wf.onComplete as string | undefined;
  if (onComplete === undefined) return;
  await schedulerFacade(ctx).enqueue(
    onComplete,
    compact({ workflowId: wf._id, context: wf.context, result }) as unknown as JSONValue,
    { runAt: ctx.now() },
  );
}

/**
 * `failOrCompensate` — the shared decision point every failure path in this file routes through
 * (both `_advance`'s `outcome.kind === "failed"` branch and its silent-stall determinism-violation
 * branch below, plus — Task 3 — `ctx.workflow.cancel`). Reads the journal for ANY completed step
 * that still has an unwound compensation (`state:"success"`, `compensateFnPath` set, `!compensated`):
 *
 *  - None found → nothing to undo. Terminal directly, exactly the pre-saga-slice behavior: flip
 *    `workflows.state` to `target` (`"failed"`/`"canceled"`), record `error`, fire `onComplete`.
 *  - At least one found → the workflow does NOT go terminal yet. It enters `"compensating"`
 *    (`error` and `compensationTarget` recorded so the eventual terminal transition — once the
 *    unwind finishes, in `_compensate` below — knows both what to report and which terminal state
 *    to land in), and `workflow:_compensate` is enqueued to start walking the journal backwards.
 *
 * `target` is `"canceled"` only from Task 3's cancel path; every caller in this file passes
 * `"failed"`.
 *
 * NOT called from Task 3's `ctx.workflow.cancel` (`./facade.ts`) directly, even though cancel's
 * compensating branch is logically identical to this function's `hasComp` branch: this function
 * runs PRIVILEGED with fully-qualified table names (`STEPS_TABLE = "workflow/steps"`), while
 * `cancel` runs namespaced (as the calling mutation's own in-txn facade) with bare table names
 * (`"steps"`) — calling this helper from `cancel` would double-prefix and throw
 * `FunctionNotFoundError`. `cancel` instead replicates the small compensating-entry write inline,
 * against its own bare-name `cctx.db` — see `workflowContext.cancel`'s doc comment in `./facade.ts`.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function failOrCompensate(ctx: any, wf: any, originalError: string, target: "failed" | "canceled"): Promise<void> {
  const steps = (await ctx.db.query(STEPS_TABLE, "by_workflow").eq("workflowId", wf._id).collect()) as JournalRow[];
  const hasComp = steps.some((s) => s.state === "success" && s.compensateFnPath && !s.compensated);
  if (!hasComp) {
    // nothing to undo — terminal directly (unchanged behavior)
    await ctx.db.replace(wf._id, { ...wf, state: target, error: originalError, completedTs: ctx.now() });
    await fireWorkflowOnComplete(ctx, wf, target === "canceled" ? { kind: "canceled" } : { kind: "failed", error: originalError });
    return;
  }
  await ctx.db.replace(wf._id, { ...wf, state: "compensating", error: originalError, compensationTarget: target });
  await schedulerFacade(ctx).enqueue("workflow:_compensate", { workflowId: wf._id } as unknown as JSONValue, {});
}

/**
 * `workflow:_advance` — a MUTATION, (re-)enqueued every time a step's `onComplete` fires
 * (`_stepDone` below) or a workflow is freshly started (`ctx.workflow.start`, `./facade.ts`).
 * THE replay loop: re-runs the workflow's registered handler from the top through
 * `runReplay` (`./replay.ts`), using the durable `steps` journal (`by_workflow`, ordered by
 * `stepNumber`) to short-circuit already-completed steps rather than re-executing their side
 * effects. Three outcomes:
 *
 *  - `"completed"`/`"failed"` — the handler settled using only cached steps: transition
 *    `workflows.state` to the terminal state and fire the workflow's own `onComplete` (if any).
 *  - `"suspended"` — the handler blocked on one or more NEW steps: journal each as `"pending"`
 *    and dispatch it via the scheduler with `onComplete: "workflow:_stepDone"`, carrying
 *    `{workflowId, stepNumber, generationNumber}` as the opaque `context` — `_stepDone` reads
 *    that back to know which journal row to fill in and re-poll.
 *
 * No-ops if the workflow is missing or already terminal (`state !== "running"`) — a stale
 * `_advance` re-poll (e.g. racing a cancel) shouldn't resurrect a finished run.
 *
 * `maxParallelism` (Task 5, default `DEFAULT_MAX_PARALLELISM`) caps how many of `outcome.newSteps`
 * get journaled + dispatched THIS poll when a fan-out (`Promise.all([step.a(), step.b(), ...])`)
 * emits more new steps than that in one go. `runReplay` itself has no notion of a cap — it always
 * returns every synchronously-emitted new step (see `./replay.ts`'s doc comment) — so the cap is
 * enforced here, at dispatch time: only the first `maxParallelism` are journaled/enqueued; the rest
 * are left un-journaled and simply re-emitted (as "new" all over again, since `runReplay` replays
 * the handler from the top every poll) once `_stepDone` re-enqueues `_advance` after this wave's
 * steps complete. No steps are silently dropped — every one eventually dispatches, just spread
 * across `ceil(newSteps.length / maxParallelism)` polls instead of one.
 */
export function makeAdvance(workflows: WorkflowRegistry, maxParallelism: number = DEFAULT_MAX_PARALLELISM): RegisteredFunction {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return mutation(async (ctx: any, a: { workflowId: string }): Promise<null> => {
    const wf = await ctx.db.get(a.workflowId);
    if (!wf || wf.state !== "running") return null; // terminal/canceled — no-op
    const gen = wf.generationNumber as number;
    const def = workflows[wf.workflowFnPath as string];
    if (!def) throw new Error(`unknown workflow ${wf.workflowFnPath as string}`);

    const journal = (await ctx.db.query(STEPS_TABLE, "by_workflow").eq("workflowId", a.workflowId).collect()) as JournalRow[];
    const outcome = await runReplay(def.handler, wf.args, journal, ctx.now());
    const sched = schedulerFacade(ctx);

    // OCC guard (double-advance case): `runReplay` drains the handler through a REAL microtask/
    // timer barrier (`drainMicrotasks` in `./replay.ts`) that can take real wall-clock time, during
    // which another transaction — e.g. `ctx.workflow.cancel` — could have committed and bumped
    // `generationNumber` (or moved `state` off `"running"` entirely). Re-read the row and recheck
    // before writing anything, so a stale replay outcome can't clobber a since-canceled/restarted
    // run. `wf.state !== "running"` at the top of this function only catches a cancel that landed
    // BEFORE this poll started; this catches one that lands DURING it.
    const fresh = await ctx.db.get(a.workflowId);
    if (!fresh || fresh.state !== "running" || fresh.generationNumber !== gen) return null;

    if (outcome.kind === "completed") {
      await ctx.db.replace(a.workflowId, { ...fresh, state: "completed", result: outcome.result, completedTs: ctx.now() });
      await fireWorkflowOnComplete(ctx, fresh, { kind: "success", value: outcome.result });
    } else if (outcome.kind === "failed") {
      // Saga slice: a failure no longer terminal-fails unconditionally — `failOrCompensate` checks
      // the journal for any completed step still owed a compensation and, if so, reroutes into the
      // `"compensating"` unwind instead (see its doc comment above).
      await failOrCompensate(ctx, fresh, outcome.error, "failed");
    } else if (outcome.newSteps.length === 0 && !journal.some((row) => row.state === "pending")) {
      // Silent-stall guard: the handler suspended (didn't return/throw) but journaled no new step
      // AND no previously-dispatched step is still in flight to ever re-enqueue `_advance`. The
      // only way to reach this state is a handler that `await`ed something other than `step.*` —
      // a raw promise/timer/etc — a determinism violation (see `step.ts`'s determinism discipline).
      // Left alone this would hang forever with no error; fail loudly instead.
      //
      // Task 6 note: a workflow parked on `step.waitForEvent` is NOT this case, even though it too
      // has no scheduler job in flight. Its `waitForEvent` step's `steps` row is `"pending"` (see
      // the dispatch loop below), so `journal.some(pending)` is true and this branch is correctly
      // skipped — the row itself (not a scheduler job) is what's "in flight": `ctx.workflow.
      // sendEvent` (`./events.ts`) is what eventually re-enqueues `_advance`, not a job callback.
      // A determinism-violation failure should still roll back any already-completed work, same
      // as an ordinary handler-thrown failure — route through `failOrCompensate` too.
      const error =
        "workflow suspended with no pending step — the handler likely awaited a non-step promise (determinism violation)";
      await failOrCompensate(ctx, fresh, error, "failed");
    } else {
      // Task 5 fan-out cap: dispatch at most `maxParallelism` of this poll's new steps. The
      // remainder (if any) are simply left un-journaled — `runReplay` will emit them again as
      // "new" on the NEXT `_advance` poll (triggered once this wave's steps `_stepDone`), so
      // nothing is dropped, it's just spread across more polls. See `makeAdvance`'s doc comment.
      const toDispatch = outcome.newSteps.slice(0, maxParallelism);
      if (outcome.newSteps.length > maxParallelism) {
        console.warn(
          `[workflow] fan-out of ${outcome.newSteps.length} new steps exceeded maxParallelism (${maxParallelism}) — dispatched the first ${maxParallelism} this poll, the remaining ${outcome.newSteps.length - maxParallelism} will dispatch on subsequent polls.`,
        );
      }
      for (const ns of toDispatch) {
        const stepId = await ctx.db.insert(
          STEPS_TABLE,
          compact({
            workflowId: a.workflowId,
            stepNumber: ns.stepNumber,
            name: ns.name,
            kind: ns.kind,
            args: ns.args,
            state: "pending",
            startedTs: ctx.now(),
            // Saga slice: recorded for every step kind (including "waitForEvent", which never
            // dispatches a scheduler job below) — unread until Task 2's unwind loop exists.
            compensateFnPath: ns.opts?.compensateFnPath,
            // Task 3: journal the author's declared retry cap so it also governs this step's
            // eventual compensation dispatch — see `./schema.ts`'s `steps.maxAttempts` doc comment.
            maxAttempts: ns.opts?.maxAttempts,
          }),
        );

        if (ns.kind === "waitForEvent") {
          // Task 6: THE differentiator — no scheduler job. The step just parks: write an `events`
          // row (`state:"waiting"`) and leave `scheduledJobId` unset. `ctx.workflow.sendEvent`
          // (`./events.ts`'s `sendEventImpl`) is what later flips this row `"received"`, journals
          // this `steps` row `"success"`, and re-enqueues `_advance` itself — nothing to dispatch
          // here. (Also means `ctx.workflow.cancel`'s cascade below correctly skips it: it only
          // cancels `pending` steps that carry a `scheduledJobId`.)
          await ctx.db.insert(EVENTS_TABLE, {
            workflowId: a.workflowId,
            name: ns.name,
            state: "waiting",
            createdTs: ctx.now(),
          });
          continue;
        }

        // Task 4: thread `ns.opts` through — `runAt` (an action's caller-supplied delay, or a
        // `sleep`/`sleepUntil` step's due time) and `maxAttempts` (-> the scheduler's own
        // `retry.maxFailures` backoff/dead-letter dispatch; not a new retry mechanism). Both are
        // `undefined` for a plain `runMutation`/`runQuery` step, matching the pre-Task-4 behavior
        // (`enqueueInternal` defaults `runAt` to `now()` and `retry.maxFailures` to 4 for
        // mutations, 1 for actions — an undeclared `maxAttempts` on an action step means
        // at-most-once, per the scheduler's clean-failure contract).
        const jobId = await sched.enqueue(ns.name, ns.args, {
          runAt: ns.opts?.runAt,
          retry: ns.opts?.maxAttempts !== undefined ? { maxFailures: ns.opts.maxAttempts } : undefined,
          onComplete: "workflow:_stepDone",
          context: { workflowId: a.workflowId, stepNumber: ns.stepNumber, generationNumber: gen } as unknown as JSONValue,
        });
        // Stamp the dispatched job's id back onto the journal row so `ctx.workflow.cancel`
        // (`./facade.ts`) can cascade-cancel it later via `ctx.scheduler.cancel(scheduledJobId)`.
        const stepRow = await ctx.db.get(stepId);
        await ctx.db.replace(stepId, { ...stepRow, scheduledJobId: jobId });
      }
    }
    return null;
  });
}

/**
 * `workflow:_stepDone` — the scheduler's `onComplete` callback for a step job (dispatched by
 * `makeAdvance` above via `sched.enqueue(..., { onComplete: "workflow:_stepDone", context })`).
 * Receives exactly `{ jobId, context: {workflowId, stepNumber, generationNumber}, result }` —
 * see `fireOnComplete` in `@stackbase/scheduler`'s `facade.ts` for that shape's origin.
 *
 * Journals the step's terminal result (`"success"`/`"failed"`, canceled maps to `"failed"` with a
 * synthetic error) into its `steps` row, then re-enqueues `workflow:_advance` so the handler is
 * re-run and races forward through the now-cached step.
 *
 * `wf.generationNumber !== a.context.generationNumber` is an OCC guard: hardened further in Task
 * 3 (its own dedicated test), included here because `makeAdvance` already stamps a
 * `generationNumber` into every step's `onComplete` context, so this check has real data to guard
 * on even before Task 3 lands.
 */
export const _stepDone = mutation(
  async (
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ctx: any,
    a: { jobId: string; context: { workflowId: string; stepNumber: number; generationNumber: number }; result: OnCompleteResult },
  ): Promise<null> => {
    const wf = await ctx.db.get(a.context.workflowId);
    if (!wf || wf.generationNumber !== a.context.generationNumber) return null; // OCC guard (Task 3 hardens/tests this)
    const rows = (await ctx.db.query(STEPS_TABLE, "by_workflow").eq("workflowId", a.context.workflowId).collect()) as JournalRow[];
    const row = rows.find((s) => s.stepNumber === a.context.stepNumber);
    if (!row) return null;

    if (a.result.kind === "success") {
      await ctx.db.replace(row._id, { ...row, state: "success", result: a.result.value, completedTs: ctx.now() });
    } else {
      await ctx.db.replace(row._id, {
        ...row,
        state: "failed",
        error: a.result.kind === "failed" ? a.result.error : "canceled",
        completedTs: ctx.now(),
      });
    }
    await schedulerFacade(ctx).enqueue("workflow:_advance", { workflowId: a.context.workflowId } as unknown as JSONValue, {});
    return null;
  },
);

/**
 * `workflow:_compensate` — the reverse-walk driver, MIRRORING `_advance` exactly, run backwards:
 * where `_advance` replays the handler forward from the top through `runReplay`, `_compensate`
 * instead reads the durable `steps` journal directly and walks it BACKWARDS — no handler replay
 * here, since the handler already threw (or the workflow was canceled); re-running it would just
 * re-throw (or re-run already-completed side effects). Compensation is purely a journal walk.
 *
 * (Re-)enqueued by `failOrCompensate` (on entering `"compensating"`) and by `_compensateDone`
 * below (after each compensation lands, to advance to the next one) — the same "dispatch one unit
 * of work, let its `onComplete` re-enqueue the driver" shape `_advance`/`_stepDone` use.
 *
 * No-ops if the workflow is missing or has left `"compensating"` (terminal/superseded) — mirrors
 * `_advance`'s `wf.state !== "running"` guard.
 *
 * Finds the HIGHEST-`stepNumber` step that is `state:"success"`, has a `compensateFnPath`, and
 * isn't yet `compensated` — the innermost not-yet-undone success, i.e. reverse order. If none
 * remain, the unwind is complete: transition to the terminal state recorded in
 * `wf.compensationTarget` (`"failed"`/`"canceled"`, defaulting to `"failed"` if somehow unset),
 * preserving the ORIGINAL error (`wf.error`, stamped by `failOrCompensate` before compensation
 * started — never overwritten by anything in this file), and fire `onComplete`.
 *
 * Otherwise, dispatch that step's compensation via the scheduler, passing `{ args: step.args,
 * result: step.result }` — the original step's own inputs AND output, so the undo handler knows
 * exactly what to reverse (e.g. a refund needs the charge amount AND the charge's id/receipt).
 * `onComplete: "workflow:_compensateDone"` carries `{workflowId, stepNumber, generationNumber}`,
 * the same context shape `_advance` stamps for a forward step, read back by `_compensateDone`.
 * The dispatched job's id is stamped onto the step row as `compensationJobId` (distinct from the
 * forward step's own `scheduledJobId`, which belongs to a job that's already terminal by now) —
 * unread until Task 3's cascade-cancel.
 */
export const _compensate = mutation(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async (ctx: any, a: { workflowId: string }): Promise<null> => {
    const wf = await ctx.db.get(a.workflowId);
    if (!wf || wf.state !== "compensating") return null; // terminal/superseded
    const gen = wf.generationNumber as number;
    const steps = (await ctx.db.query(STEPS_TABLE, "by_workflow").eq("workflowId", a.workflowId).collect()) as JournalRow[];
    // highest stepNumber, success, has a compensation, not yet compensated
    const next = steps
      .filter((s) => s.state === "success" && s.compensateFnPath && !s.compensated)
      .sort((x, y) => (y.stepNumber as number) - (x.stepNumber as number))[0];
    if (!next) {
      // unwind complete → terminal
      const target = (wf.compensationTarget as string) === "canceled" ? "canceled" : "failed";
      await ctx.db.replace(a.workflowId, { ...wf, state: target, completedTs: ctx.now() });
      await fireWorkflowOnComplete(
        ctx,
        wf,
        target === "canceled" ? { kind: "canceled" } : { kind: "failed", error: wf.error as string },
      );
      return null;
    }
    const jobId = await schedulerFacade(ctx).enqueue(
      next.compensateFnPath as string,
      { args: next.args, result: next.result } as unknown as JSONValue,
      {
        // Task 3: the forward step's own journaled `maxAttempts` (if declared) also caps its
        // compensation's retries — see `./schema.ts`'s `steps.maxAttempts` doc comment. Without
        // this, a throwing compensation would blind-retry with the scheduler's default
        // `maxFailures: 4` real-wall-clock exponential backoff, which a synchronous `tick()`-driven
        // test (or a caller who explicitly capped the forward step) can't outlast/doesn't want.
        retry: next.maxAttempts !== undefined ? { maxFailures: next.maxAttempts } : undefined,
        onComplete: "workflow:_compensateDone",
        context: { workflowId: a.workflowId, stepNumber: next.stepNumber, generationNumber: gen } as unknown as JSONValue,
      },
    );
    // For cascade-cancel (Task 3) — a distinct field from the forward step's `scheduledJobId`.
    await ctx.db.replace(next._id, { ...next, compensationJobId: jobId });
    return null;
  },
);

/**
 * `workflow:_compensateDone` — the scheduler's `onComplete` callback for a compensation job
 * (dispatched by `_compensate` above). Receives exactly `{ jobId, context: {workflowId,
 * stepNumber, generationNumber}, result }`, same shape as `_stepDone`'s.
 *
 * On success: marks the step row `compensated: true` and re-enqueues `workflow:_compensate` to
 * advance the walk to the next (lower-`stepNumber`) not-yet-compensated success — mirroring
 * `_stepDone`'s own re-enqueue-to-continue of `_advance`.
 *
 * On failure: HALTS the unwind — a compensation itself failing means the saga can't safely
 * continue undoing (Task 3 finalizes this branch's exact terminal-error text and adds its
 * dedicated test; this is a placeholder that still reaches a terminal `"failed"` state rather than
 * leaving the workflow stuck `"compensating"` forever).
 *
 * `wf.generationNumber !== a.context.generationNumber` is the same OCC guard `_stepDone` uses.
 */
export const _compensateDone = mutation(
  async (
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ctx: any,
    a: { jobId: string; context: { workflowId: string; stepNumber: number; generationNumber: number }; result: OnCompleteResult },
  ): Promise<null> => {
    const wf = await ctx.db.get(a.context.workflowId);
    if (!wf || wf.generationNumber !== a.context.generationNumber) return null; // OCC guard
    const steps = (await ctx.db.query(STEPS_TABLE, "by_workflow").eq("workflowId", a.context.workflowId).collect()) as JournalRow[];
    const row = steps.find((s) => s.stepNumber === a.context.stepNumber);
    if (!row) return null;
    if (a.result.kind === "success") {
      await ctx.db.replace(row._id, { ...row, compensated: true });
      await schedulerFacade(ctx).enqueue("workflow:_compensate", { workflowId: a.context.workflowId } as unknown as JSONValue, {});
    } else {
      // Compensation itself failed → HALT (Task 3 finalizes this branch's terminal-error text and
      // its dedicated test).
      const cerr = a.result.kind === "failed" ? a.result.error : "canceled";
      await ctx.db.replace(a.context.workflowId, {
        ...wf,
        state: "failed",
        completedTs: ctx.now(),
        error: `compensation failed at step ${a.context.stepNumber}: ${cerr}; original workflow error: ${(wf.error as string | undefined) ?? ""}`,
      });
      await fireWorkflowOnComplete(ctx, wf, { kind: "failed", error: `compensation failed at step ${a.context.stepNumber}` });
    }
    return null;
  },
);

/**
 * `workflow:_start` / `workflow:_cancel` — internal (`_`-prefixed, so not client-callable)
 * MUTATIONS backing the action-mode `ctx.workflow` facade (`workflowActionContext` in
 * `./facade.ts`, Task 7): an action has no `db`, so it can't write a new `workflows` row or
 * cascade-cancel one itself — instead it calls `ctx.runMutation("workflow:_start"/"_cancel", ...)`,
 * a fresh top-level mutation the trusted `invoke` seam resolves (see `ExecutorDeps.invoke`'s doc
 * comment in `packages/executor/src/executor.ts` — it resolves ANY registered path, `_`-prefixed
 * included, unlike the public `runtime.run`/`runAction`, which block `_` via `isInternalPath`).
 * Mirrors `@stackbase/scheduler`'s `_enqueue`/`_cancel` (`components/scheduler/src/modules.ts`)
 * exactly: both run namespaced (NOT privileged) — the action `invoke` seam
 * (`ActionApi.runMutation`, `packages/executor/src/executor.ts`'s `runActionFn`) never sets
 * `privileged` (defaults `false`), so `ctx.workflow` here is the SAME namespaced, bare-table-name
 * in-txn facade `workflowContext` builds for a normal mutation's own `ctx.workflow.start(...)`
 * call — delegating to it (rather than reimplementing against fully-qualified `"workflow/..."`
 * table names the way privileged, driver-dispatched `_advance`/`_stepDone` do) is what keeps this
 * correct regardless of dispatch site: fully-qualified names would double-prefix under this
 * non-privileged namespaced dispatch and throw `FunctionNotFoundError`.
 *
 * `ctx: any` because `ctx.workflow` isn't part of the exported `MutationCtx` shape (it's a dynamic
 * per-component facade attached at run time — see `InlineUdfExecutor.run`'s `guestCtx` loop).
 */
export const _start = mutation(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async (ctx: any, a: { workflowFnPath: string; args: JSONValue }): Promise<string> => ctx.workflow.start(a.workflowFnPath, a.args),
);

export const _cancel = mutation(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async (ctx: any, a: { runId: string; compensate?: boolean }): Promise<null> => {
    await ctx.workflow.cancel(a.runId, a.compensate !== undefined ? { compensate: a.compensate } : undefined);
    return null;
  },
);
