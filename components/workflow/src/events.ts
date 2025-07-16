// components/workflow/src/events.ts
//
// Task 6: `ctx.workflow.sendEvent` — the resolving half of `step.waitForEvent` (`./replay.ts`).
// `sendEventImpl` is the ONE implementation shared by both entry points that can fire it:
//
//  - `workflowContext.sendEvent` (`./facade.ts`) — the mutation-mode path, called directly by
//    `ctx.workflow.sendEvent(...)` from within a mutation. Runs against the CALLING mutation's own
//    `cctx.db` (namespaced/bare table names: "events"/"steps"), exactly like `start`/`cancel`.
//  - `_sendEvent` below — the privileged, registered-module counterpart (fully-qualified table
//    names: "workflow/events"/"workflow/steps"), reserved for action-mode delegation
//    (`workflowActionContext.sendEvent`, stubbed in `./facade.ts` for Task 7 — an action has no
//    direct `db`, so it will call this via `api.runMutation("workflow:_sendEvent", ...)`, the same
//    pattern `workflowActionContext.start`/`cancel` are stubbed for).
//
// Splitting the table names out into `EventTables` rather than hardcoding either variant is what
// lets both entry points share this one function instead of drifting.
import { mutation, type GuestDatabaseWriter } from "@stackbase/executor";
import type { JSONValue } from "@stackbase/values";
import type { SchedulerContext } from "@stackbase/scheduler";
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

/** Table names `sendEventImpl` operates on — differ between the privileged `_sendEvent` module (fully-qualified) and the namespaced `ctx.workflow.sendEvent` facade (bare). */
export interface EventTables {
  events: string;
  steps: string;
}

/** `_sendEvent`'s own (privileged) table names — mirrors `./modules.ts`'s `STEPS_TABLE` convention. */
export const PRIVILEGED_EVENT_TABLES: EventTables = { events: "workflow/events", steps: "workflow/steps" };

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
 * `workflow:_sendEvent` — the internal, privileged registered-module counterpart to
 * `ctx.workflow.sendEvent` (`./facade.ts`). Mutation-mode does NOT dispatch through this module —
 * `workflowContext.sendEvent` calls `sendEventImpl` directly against the calling mutation's own
 * `cctx.db`, exactly like `start`/`cancel` do. This module exists so a FUTURE action-mode
 * `ctx.workflow.sendEvent` (Task 7) has a real internal mutation to delegate to via
 * `api.runMutation`, without a second implementation of the event-resolution logic. Registered
 * privileged (dispatched the same way `_advance`/`_stepDone` are — see `./modules.ts`'s doc
 * comment on why those use fully-qualified table names), so it uses `PRIVILEGED_EVENT_TABLES`.
 */
export const _sendEvent = mutation(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async (ctx: any, a: { workflowId: string; name: string; payload?: JSONValue }): Promise<null> => {
    await sendEventImpl(ctx.db, ctx.scheduler as SchedulerContext, () => ctx.now(), PRIVILEGED_EVENT_TABLES, a);
    return null;
  },
);
