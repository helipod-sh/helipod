import type { JSONValue, Value } from "@stackbase/values";
import { valuesEqual } from "@stackbase/values";
import { getFunctionPath, type FnRef } from "@stackbase/scheduler";
import type { WorkflowHandler } from "./registry";

/**
 * `step.runMutation`/`step.runQuery`/`step.runAction`/`step.sleep`/`step.sleepUntil` — the object
 * a workflow handler receives as its first argument. `waitForEvent` is added in Task 6.
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
 */
export interface StepApi {
  runMutation<T = unknown>(ref: FnRef, args?: Record<string, unknown>): Promise<T>;
  runQuery<T = unknown>(ref: FnRef, args?: Record<string, unknown>): Promise<T>;
  runAction<T = unknown>(ref: FnRef, args?: Record<string, unknown>, opts?: { maxAttempts?: number }): Promise<T>;
  /** Parks the workflow for `ms` milliseconds, computed from the current poll's fixed clock (not `Date.now()` — see `runReplay`'s `now` param). */
  sleep(ms: number): Promise<void>;
  /** Parks the workflow until wall-clock time `ts` (epoch ms). */
  sleepUntil(ts: number): Promise<void>;
}

/** A step kind — `"sleep"` is a durable timer (target `workflow:_sleep`), the rest dispatch a real UDF. */
export type StepKind = "mutation" | "query" | "action" | "sleep";

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

  const step: StepApi = {
    runMutation: <T>(ref: FnRef, args: Record<string, unknown> = {}) =>
      requestStep("mutation", ref, args as JSONValue) as Promise<T>,
    runQuery: <T>(ref: FnRef, args: Record<string, unknown> = {}) =>
      requestStep("query", ref, args as JSONValue) as Promise<T>,
    runAction: <T>(ref: FnRef, args: Record<string, unknown> = {}, opts?: { maxAttempts?: number }) =>
      requestStep(
        "action",
        ref,
        args as JSONValue,
        opts?.maxAttempts !== undefined ? { maxAttempts: opts.maxAttempts } : undefined,
      ) as Promise<T>,
    sleep: (ms: number) => requestStep("sleep", SLEEP_FN, {} as JSONValue, { runAt: now + ms }) as Promise<void>,
    sleepUntil: (ts: number) => requestStep("sleep", SLEEP_FN, {} as JSONValue, { runAt: ts }) as Promise<void>,
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
