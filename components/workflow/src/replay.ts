import type { JSONValue, Value } from "@stackbase/values";
import { valuesEqual } from "@stackbase/values";
import { getFunctionPath, type FnRef } from "@stackbase/scheduler";
import type { WorkflowHandler } from "./registry";

/**
 * `step.runMutation`/`step.runQuery` — the object a workflow handler receives as its first
 * argument. `runAction`/`sleep`/`waitForEvent` are added in Tasks 4/6; this task only needs the
 * two synchronous-dispatch step kinds.
 */
export interface StepApi {
  runMutation<T = unknown>(ref: FnRef, args?: Record<string, unknown>): Promise<T>;
  runQuery<T = unknown>(ref: FnRef, args?: Record<string, unknown>): Promise<T>;
}

/** A `steps` row as read back from the durable journal (`by_workflow`, ordered by `stepNumber`). */
export interface JournalRow {
  _id: string;
  workflowId: string;
  stepNumber: number;
  name: string;
  kind: "mutation" | "query";
  args: JSONValue;
  result?: JSONValue;
  error?: string;
  state: "pending" | "success" | "failed";
  scheduledJobId?: string;
  startedTs: number;
  completedTs?: number;
}

/** A NOT-yet-journaled step the handler emitted this poll — `_advance` journals + dispatches these. */
export interface NewStep {
  stepNumber: number;
  name: string;
  kind: "mutation" | "query";
  args: JSONValue;
}

export type ReplayOutcome =
  | { kind: "completed"; result: unknown }
  | { kind: "failed"; error: string }
  | { kind: "suspended"; newSteps: NewStep[] };

/** `string | FnRef` → its string path. Replicates the executor's tiny ref-resolution helper. */
function resolveRef(ref: FnRef): string {
  return getFunctionPath(ref);
}

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
): Promise<ReplayOutcome> {
  let cursor = 0;
  const newSteps: NewStep[] = [];

  const requestStep = (kind: "mutation" | "query", ref: FnRef, args: JSONValue): Promise<unknown> => {
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
    newSteps.push({ stepNumber: idx, name, kind, args });
    return new Promise(() => {});
  };

  const step: StepApi = {
    runMutation: <T>(ref: FnRef, args: Record<string, unknown> = {}) =>
      requestStep("mutation", ref, args as JSONValue) as Promise<T>,
    runQuery: <T>(ref: FnRef, args: Record<string, unknown> = {}) =>
      requestStep("query", ref, args as JSONValue) as Promise<T>,
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
