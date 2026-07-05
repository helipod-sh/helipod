// components/workflow/src/events.ts
//
// Task 6: `ctx.workflow.sendEvent` — the resolving half of `step.waitForEvent` (`./replay.ts`).
// `sendEventImpl` is the ONE implementation shared by both entry points that can fire it:
//
//  - `workflowContext.sendEvent` (`./facade.ts`) — the mutation-mode path, called directly by
//    `ctx.workflow.sendEvent(...)` from within a mutation. Runs against the CALLING mutation's own
//    `cctx.db` (namespaced/bare table names: "events"/"steps"), exactly like `start`/`cancel`.
//  - `_sendEvent` below — the registered-module counterpart backing action-mode delegation
//    (`workflowActionContext.sendEvent`, `./facade.ts`, Task 7): an action has no direct `db`, so
//    it calls this via `api.runMutation("workflow:_sendEvent", ...)`. That's the `ActionApi`/
//    `invoke` seam, which NEVER sets `privileged` (see `packages/executor/src/executor.ts`'s
//    `runActionFn`) — so `_sendEvent` runs namespaced under `"workflow"`, exactly like any normal
//    mutation, NOT privileged like `_advance`/`_stepDone` (which are dispatched exclusively by the
//    scheduler driver, the only call site that sets `privileged: true`). Consequently `_sendEvent`
//    below delegates to the namespaced `ctx.workflow.sendEvent(...)` facade — the SAME bare-table
//    in-txn path `workflowContext.sendEvent` uses — rather than calling `sendEventImpl` directly
//    against fully-qualified table names (which would double-prefix under non-privileged
//    namespaced dispatch and throw `FunctionNotFoundError`; see `./modules.ts`'s `_start`/
//    `_cancel` doc comment for the identical reasoning).
//
// Splitting the table names out into `EventTables` rather than hardcoding either variant is what
// lets `sendEventImpl`'s two remaining callers (the mutation-mode facade here doc-commented above,
// and any future privileged caller) share this one function instead of drifting.
import { mutation, type GuestDatabaseWriter } from "@helipod/executor";
import type { JSONValue } from "@helipod/values";
import type { SchedulerContext } from "@helipod/scheduler";
import type { JournalRow } from "./replay";

/** An `events` row as read back from the durable journal (`by_workflow_name`, `[workflowId, name]`). */
interface EventRow {
  _id: string;
  workflowId: string;
  name: string;
  payload?: JSONValue;
  state: "waiting" | "received";
  createdTs: number;
}

/** Table names `sendEventImpl` operates on — bare (namespaced-by-the-executor), matching every other in-txn `cctx.db` call this component makes. `_sendEvent` below no longer needs a fully-qualified variant — see its doc comment for why. */
export interface EventTables {
  events: string;
  steps: string;
}

/**
 * Resolves a running workflow's `step.waitForEvent(name)`: finds the `"waiting"` `events` row for
 * `(workflowId, name)`, flips it `"received"` with `payload`, journals the matching `waitForEvent`
 * `steps` row `"success"` with `result: payload`, then re-enqueues `workflow:_advance` — the commit
 * fan-out wakes the driver, and the re-enqueued `_advance` replays the handler, which now resolves
 * `step.waitForEvent` from the cached journal row (see `runReplay`'s cached-step branch in
 * `./replay.ts`).
 *
 * A no-op (does not throw) when there's no matching `"waiting"` events row — mirrors the rest of
 * the component's idempotent-no-op-on-stale-state style (`_stepDone`'s OCC guard, `cancel`'s
 * already-terminal check in `./facade.ts`): sending an event that was already delivered, or to a
 * workflow that hasn't reached that `waitForEvent` yet, or to an unknown workflow, shouldn't throw.
 */
export async function sendEventImpl(
  db: GuestDatabaseWriter,
  scheduler: SchedulerContext,
  now: () => number,
  tables: EventTables,
  a: { workflowId: string; name: string; payload?: JSONValue },
): Promise<void> {
  const events = (await db
    .query(tables.events, "by_workflow_name")
    .eq("workflowId", a.workflowId)
    .eq("name", a.name)
    .collect()) as unknown as EventRow[];
  const waiting = events.find((e) => e.state === "waiting");
  if (!waiting) return; // no matching waiting event — idempotent no-op (see doc comment above)

  const payload = a.payload ?? null;
  await db.replace(waiting._id, { ...waiting, state: "received", payload });

  const steps = (await db.query(tables.steps, "by_workflow").eq("workflowId", a.workflowId).collect()) as unknown as JournalRow[];
  const stepRow = steps.find((s) => s.kind === "waitForEvent" && s.name === a.name && s.state === "pending");
  if (stepRow) {
    await db.replace(stepRow._id, { ...stepRow, state: "success", result: payload, completedTs: now() });
  }

  await scheduler.enqueue("workflow:_advance", { workflowId: a.workflowId } as unknown as JSONValue, {});
}

/**
 * `workflow:_sendEvent` — the internal, `_`-prefixed (client-blocked) registered-module
 * counterpart to `ctx.workflow.sendEvent` (`./facade.ts`), Task 7's action-mode delegate target
 * (`workflowActionContext.sendEvent` calls `api.runMutation("workflow:_sendEvent", ...)`).
 * Mutation-mode does NOT dispatch through this module — `workflowContext.sendEvent` calls
 * `sendEventImpl` directly against the calling mutation's own `cctx.db`, exactly like
 * `start`/`cancel` do.
 *
 * Delegates to `ctx.workflow.sendEvent(...)` (the SAME namespaced in-txn facade a normal
 * mutation's own `ctx.workflow.sendEvent` call reaches) rather than calling `sendEventImpl`
 * directly: the action `invoke` seam that dispatches this module never sets `privileged`, so
 * `ctx.db` here is namespaced under `"workflow"`, not privileged — see this file's module doc
 * comment above for the full reasoning (mirrors `./modules.ts`'s `_start`/`_cancel`). `ctx: any`
 * because `ctx.workflow` isn't part of the exported `MutationCtx` shape (it's a dynamic
 * per-component facade attached at run time).
 */
export const _sendEvent = mutation(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async (ctx: any, a: { workflowId: string; name: string; payload?: JSONValue }): Promise<null> => {
    await ctx.workflow.sendEvent(a.workflowId, a.name, a.payload);
    return null;
  },
);
