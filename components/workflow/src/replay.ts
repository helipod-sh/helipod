import type { JSONValue, Value } from "@stackbase/values";
import { valuesEqual } from "@stackbase/values";
import { getFunctionPath, type FnRef } from "@stackbase/scheduler";
import type { WorkflowHandler } from "./registry";

/**
 * `step.runMutation`/`step.runQuery`/`step.runAction`/`step.sleep`/`step.sleepUntil`/
 * `step.waitForEvent` — the object a workflow handler receives as its first argument.
 *
 * `runAction` dispatches a `kind:"action"` scheduler job — same journal/dispatch mechanism as
 * `runMutation`/`runQuery`, just a different target kind. Actions are AT-MOST-ONCE (the
 * scheduler's contract for `kind:"action"` jobs — a crash mid-flight dead-letters rather than
 * blind-retries, see `@stackbase/scheduler`'s `_reclaim`), so a step built on it inherits that
 * same at-most-once guarantee; nothing in this file adds action-specific retry-on-crash logic.
 *
 * `sleep`/`sleepUntil` are durable timers: a `NewStep` with `kind:"sleep"` whose dispatched
 * target is the trivial internal no-op mutation `workflow:_sleep` (registered in `./modules.ts`),
 * carrying `opts.runAt` — the step "completes" (and the replay proceeds past it) only once that
 * delayed job actually fires, riding the scheduler's own `runAt` semantics rather than any new
 * timer mechanism.
 *
 * `opts?.maxAttempts` (any step kind) threads into `NewStep.opts.maxAttempts`, which `_advance`
 * (`./modules.ts`) turns into the scheduler's `retry: { maxFailures }` — reusing the scheduler's
 * existing retry/backoff dispatch, not a new one.
 *
 * `opts?.compensate` (`runMutation`/`runAction`, saga slice) resolves to a function path via the
 * same `resolveRef` used for the step's own name, and threads into `NewStep.opts.compensateFnPath`
 * -> `_advance` stamps it onto the step's journal row at dispatch (`./modules.ts`). Purely additive
 * for now — nothing reads it back yet (Task 2 of the saga slice builds the reverse-order unwind
 * that does); a step declared with `{ compensate }` behaves identically to one without it.
 *
 * `waitForEvent` is THE differentiator (no scheduler job, no Convex/DBOS workflow engine has this):
 * a brand-new `waitForEvent` step is emitted as a `NewStep` exactly like every other step kind —
 * `requestStep` below doesn't special-case it at all — but `_advance` (`./modules.ts`), when it
 * sees `kind:"waitForEvent"` among the new steps to dispatch, does NOT call `sched.enqueue`; it
 * writes an `events` row (`{workflowId, name, state:"waiting"}`) instead and leaves the `steps` row
 * `scheduledJobId`-less. `ctx.workflow.sendEvent` (`./events.ts`) is what eventually flips that
 * `events` row to `"received"` and journals the step `"success"` with the payload as its result —
 * only THEN does the cached-step branch below resolve it, same as any other step.
 */
export interface StepApi {
  runMutation<T = unknown>(ref: FnRef, args?: Record<string, unknown>, opts?: { maxAttempts?: number; compensate?: FnRef }): Promise<T>;
  runQuery<T = unknown>(ref: FnRef, args?: Record<string, unknown>): Promise<T>;
  runAction<T = unknown>(ref: FnRef, args?: Record<string, unknown>, opts?: { maxAttempts?: number; compensate?: FnRef }): Promise<T>;
  /** Parks the workflow for `ms` milliseconds, computed from the current poll's fixed clock (not `Date.now()` — see `runReplay`'s `now` param). */
  sleep(ms: number): Promise<void>;
  /** Parks the workflow until wall-clock time `ts` (epoch ms). */
  sleepUntil(ts: number): Promise<void>;
  /**
   * Durably parks the workflow until `ctx.workflow.sendEvent(runId, name, payload)` is called —
   * resolves with that call's `payload`. No scheduler job is dispatched for this step (see this
   * interface's doc comment above); the workflow sits idle (no timer, no polling) until an
   * external signal arrives. `opts?.timeoutMs` is NOT implemented yet (Task 6 v1 scope is an
   * unbounded wait, matching the brief) — passing it throws rather than silently ignoring it.
   */
  waitForEvent<T = unknown>(name: string, opts?: { timeoutMs?: number }): Promise<T>;
}

/** A step kind — `"sleep"` is a durable timer (target `workflow:_sleep`), `"waitForEvent"` dispatches no job at all (parks on an `events` row instead — see `StepApi.waitForEvent`'s doc comment), the rest dispatch a real UDF. */
export type StepKind = "mutation" | "query" | "action" | "sleep" | "waitForEvent";

/** A `steps` row as read back from the durable journal (`by_workflow`, ordered by `stepNumber`). */
export interface JournalRow {
  _id: string;
  workflowId: string;
  stepNumber: number;
  name: string;
  kind: StepKind;
  args: JSONValue;
  result?: JSONValue;
  error?: string;
  state: "pending" | "success" | "failed";
  scheduledJobId?: string;
  startedTs: number;
  completedTs?: number;
}

/** Options carried from `step.*` through to `_advance`'s `sched.enqueue` call (`./modules.ts`). */
export interface NewStepOpts {
  /** Absolute dispatch time (epoch ms) — set by `sleep`/`sleepUntil` (`now + ms` / `ts`); `runAction` never sets this (it only takes `{maxAttempts?}`, no delay option). */
  runAt?: number;
  /** -> `EnqueueOpts.retry.maxFailures`. */
  maxAttempts?: number;
  /** The step's `{ compensate }` option, resolved to a function path via `resolveRef` — stamped onto the journal row at dispatch (`./modules.ts`'s `_advance`); unread until the saga slice's Task 2 unwind. */
  compensateFnPath?: string;
}

/** A NOT-yet-journaled step the handler emitted this poll — `_advance` journals + dispatches these. */
export interface NewStep {
  stepNumber: number;
  name: string;
  kind: StepKind;
  args: JSONValue;
  opts?: NewStepOpts;
}

export type ReplayOutcome =
  | { kind: "completed"; result: unknown }
  | { kind: "failed"; error: string }
  | { kind: "suspended"; newSteps: NewStep[] };

/** `string | FnRef` → its string path. Replicates the executor's tiny ref-resolution helper. */
function resolveRef(ref: FnRef): string {
  return getFunctionPath(ref);
}

/** The dispatch target for every `step.sleep`/`step.sleepUntil` call — a trivial no-op mutation registered in `./modules.ts`; the step "completes" (and unblocks replay) once its delayed job fires. */
const SLEEP_FN = "workflow:_sleep";

/**
 * Structural equality for journal-arg validation (a cached step's replayed call must match the
 * journaled one exactly, or the handler has gone non-deterministic — see `requestStep` below).
 * Reuses `@stackbase/values`'s `valuesEqual` (the same canonical-order deep comparison the query
 * engine and OCC conflict detection use) rather than hand-rolling a second one.
 */
function deepEqual(a: JSONValue | undefined, b: JSONValue | undefined): boolean {
  return valuesEqual((a ?? null) as Value, (b ?? null) as Value);
}

/**
 * `drainMicrotasks()` — flushes the ENTIRE current microtask queue, however deep, before
 * returning. A cached step resolves via an already-settled `Promise.resolve(value)`, so a chain
 * of `await step.runMutation(...)` calls over N cached steps advances purely through microtasks
 * (no macrotask ever runs in between). Node/the JS spec guarantee the microtask queue is drained
 * to EMPTY — recursively, including microtasks scheduled by other microtasks — before any queued
 * macrotask (a timer) is allowed to fire. So a single `setTimeout(resolve, 0)` is a complete
 * barrier: by the time it fires, every synchronously-cached step the handler could possibly race
 * through has already resolved and the handler has either settled or blocked on a genuinely new
 * (never-resolving) step. This is what makes the drain deterministic regardless of how many
 * cached steps are in the journal — unlike a fixed count of `await Promise.resolve()` hops, which
 * would need re-tuning as the deepest journal grows.
 */
function drainMicrotasks(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * The deterministic-replay drive loop — THE mechanism that makes workflows durable. Re-runs
 * `handler` from the top on every poll. Each `step.runMutation`/`step.runQuery` call consults
 * `journal[cursor]` (the durable record of the step at that position, if any):
 *
 *  - **Cached, `state:"success"`**: resolves synchronously (`Promise.resolve(cached.result)`) —
 *    no re-execution, no side effect re-run. The handler races forward through every such step in
 *    one microtask burst.
 *  - **Cached, `state:"failed"`**: rejects synchronously with the journaled error.
 *  - **Cached, `state:"pending"`**: already dispatched, not yet done — the handler suspends on it
 *    (a promise that never resolves this poll).
 *  - **Not yet journaled**: a genuinely new step. Recorded into `newSteps` for `_advance` to
 *    journal + dispatch, and the handler suspends on it the same way.
 *
 * `Promise.race(settle, drainMicrotasks().then(() => suspended))` distinguishes "the handler
 * completed/failed using only cached steps" from "the handler is blocked waiting on new/pending
 * work" — see `drainMicrotasks`'s doc comment for why the race is deterministic. Collects ALL
 * `newSteps` emitted before the handler blocks (not just the first) so a fan-out
 * (`Promise.all([...])`, Task 5) that issues several `requestStep` calls before its first await
 * yields is dispatched all at once, not one poll at a time.
 */
export async function runReplay(
  handler: WorkflowHandler,
  handlerArgs: unknown,
  journal: ReadonlyArray<JournalRow>,
  /**
   * The fixed per-invocation clock (`ctx.now()` from `_advance`'s calling mutation) — used ONLY to
   * compute `sleep`/`sleepUntil`'s `NewStep.opts.runAt` on first dispatch. Never `Date.now()`: a
   * mutation's clock must be deterministic across replay. Defaults to `0` for callers (e.g. the
   * `occ-guard` mismatch unit test) that construct a journal by hand and never call `step.sleep`.
   */
  now: number = 0,
): Promise<ReplayOutcome> {
  let cursor = 0;
  const newSteps: NewStep[] = [];

  const requestStep = (kind: StepKind, ref: FnRef, args: JSONValue, opts?: NewStepOpts): Promise<unknown> => {
    const name = resolveRef(ref);
    const idx = cursor++;
    const cached = journal[idx];
    if (cached) {
      if (cached.name !== name || cached.kind !== kind || !deepEqual(cached.args, args)) {
        throw new Error(
          `Journal entry mismatch at step ${idx}: expected ${cached.name}/${cached.kind}, got ${name}/${kind} — ` +
            `the workflow handler must be deterministic (no random/network/clock calls, no reordering steps).`,
        );
      }
      if (cached.state === "success") return Promise.resolve(cached.result);
      if (cached.state === "failed") return Promise.reject(new Error(cached.error ?? "step failed"));
      // "pending" — already dispatched, not yet done. Suspend on it; never resolves this poll.
      return new Promise(() => {});
    }
    // New step: record it for `_advance` to journal + dispatch, and suspend the handler here.
    newSteps.push({ stepNumber: idx, name, kind, args, ...(opts ? { opts } : {}) });
    return new Promise(() => {});
  };

  // Turns `{ maxAttempts?, compensate? }` into a `NewStepOpts` (or `undefined` if both are unset,
  // matching the pre-saga-slice behavior of omitting `opts` entirely for a plain step).
  const toNewStepOpts = (opts?: { maxAttempts?: number; compensate?: FnRef }): NewStepOpts | undefined => {
    if (opts?.maxAttempts === undefined && opts?.compensate === undefined) return undefined;
    return {
      ...(opts.maxAttempts !== undefined ? { maxAttempts: opts.maxAttempts } : {}),
      ...(opts.compensate !== undefined ? { compensateFnPath: resolveRef(opts.compensate) } : {}),
    };
  };

  const step: StepApi = {
    runMutation: <T>(ref: FnRef, args: Record<string, unknown> = {}, opts?: { maxAttempts?: number; compensate?: FnRef }) =>
      requestStep("mutation", ref, args as JSONValue, toNewStepOpts(opts)) as Promise<T>,
    runQuery: <T>(ref: FnRef, args: Record<string, unknown> = {}) =>
      requestStep("query", ref, args as JSONValue) as Promise<T>,
    runAction: <T>(ref: FnRef, args: Record<string, unknown> = {}, opts?: { maxAttempts?: number; compensate?: FnRef }) =>
      requestStep("action", ref, args as JSONValue, toNewStepOpts(opts)) as Promise<T>,
    sleep: (ms: number) => requestStep("sleep", SLEEP_FN, {} as JSONValue, { runAt: now + ms }) as Promise<void>,
    sleepUntil: (ts: number) => requestStep("sleep", SLEEP_FN, {} as JSONValue, { runAt: ts }) as Promise<void>,
    waitForEvent: <T>(name: string, opts?: { timeoutMs?: number }) => {
      if (opts?.timeoutMs !== undefined) {
        // Not built yet — see `StepApi.waitForEvent`'s doc comment. Throwing (rather than
        // silently dispatching an unbounded wait) keeps an unsupported option loud, not a footgun.
        throw new Error("step.waitForEvent's timeoutMs is not implemented yet (Task 6 scope: unbounded wait only)");
      }
      // `name` IS the event name, not a function path — but it's already a plain string, and
      // `resolveRef`/`getFunctionPath` pass a string straight through unchanged, so reusing
      // `requestStep`'s generic cursor/journal machinery (cached-success/failed/pending/new-step,
      // see `runReplay`'s doc comment) needs no special-casing at all: a `waitForEvent` step is
      // just a step whose "args" are always `{}` and whose "name" happens to be an event name.
      return requestStep("waitForEvent", name, {} as JSONValue) as Promise<T>;
    },
  };

  const settle: Promise<ReplayOutcome> = handler(step, handlerArgs).then(
    (result) => ({ kind: "completed", result }) as ReplayOutcome,
    (e) => ({ kind: "failed", error: String(e instanceof Error ? e.message : e) }) as ReplayOutcome,
  );

  const drained = await Promise.race([
    settle,
    drainMicrotasks().then(() => ({ kind: "suspended", newSteps }) as ReplayOutcome),
  ]);
  return drained.kind === "suspended" ? { kind: "suspended", newSteps } : drained;
}
