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
 */
export function makeAdvance(workflows: WorkflowRegistry): RegisteredFunction {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return mutation(async (ctx: any, a: { workflowId: string }): Promise<null> => {
    const wf = await ctx.db.get(a.workflowId);
    if (!wf || wf.state !== "running") return null; // terminal/canceled — no-op
    const gen = wf.generationNumber as number;
    const def = workflows[wf.workflowFnPath as string];
    if (!def) throw new Error(`unknown workflow ${wf.workflowFnPath as string}`);

    const journal = (await ctx.db.query(STEPS_TABLE, "by_workflow").eq("workflowId", a.workflowId).collect()) as JournalRow[];
    const outcome = await runReplay(def.handler, wf.args, journal);
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
      const error =
        "workflow suspended with no pending step — the handler likely awaited a non-step promise (determinism violation)";
      await ctx.db.replace(a.workflowId, { ...fresh, state: "failed", error, completedTs: ctx.now() });
      await fireWorkflowOnComplete(ctx, fresh, { kind: "failed", error });
    } else {
      for (const ns of outcome.newSteps) {
        const stepId = await ctx.db.insert(STEPS_TABLE, {
          workflowId: a.workflowId,
          stepNumber: ns.stepNumber,
          name: ns.name,
          kind: ns.kind,
          args: ns.args,
          state: "pending",
          startedTs: ctx.now(),
        });
        const jobId = await sched.enqueue(ns.name, ns.args, {
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
