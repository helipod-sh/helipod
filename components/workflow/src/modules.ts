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
 * `./index.ts`), reachable at `workflow:status`.
 */
export const status = query(async (ctx: QueryCtx, a: { runId: string }) => {
  const wf = await ctx.db.get(a.runId);
  if (wf === null) return null;
  return { state: wf.state as string, result: wf.result, error: wf.error as string | undefined };
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
      await ctx.db.replace(a.workflowId, { ...fresh, state: "failed", error: outcome.error, completedTs: ctx.now() });
      await fireWorkflowOnComplete(ctx, fresh, { kind: "failed", error: outcome.error });
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
      const error =
        "workflow suspended with no pending step — the handler likely awaited a non-step promise (determinism violation)";
      await ctx.db.replace(a.workflowId, { ...fresh, state: "failed", error, completedTs: ctx.now() });
      await fireWorkflowOnComplete(ctx, fresh, { kind: "failed", error });
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
        const stepId = await ctx.db.insert(STEPS_TABLE, {
          workflowId: a.workflowId,
          stepNumber: ns.stepNumber,
          name: ns.name,
          kind: ns.kind,
          args: ns.args,
          state: "pending",
          startedTs: ctx.now(),
        });

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
        // (`enqueueInternal` defaults `runAt` to `now()` and `retry.maxFailures` to 4).
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
