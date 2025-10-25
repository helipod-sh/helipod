---
title: onChange Triggers
---

# onChange Triggers

> React to committed data changes server-side, durably — no queue, no dropped events, at-least-once
> delivery with a stable per-change id for dedup.

`@stackbase/triggers` runs a function of your choosing whenever documents in a table you're watching
are inserted, updated, or deleted. It fills the gap between mutations (synchronous, run inside the
writer's own transaction) and [workflows](/build/backend-functions) (explicit, caller-initiated
orchestration): denormalized counters, audit logs, notification fan-out, kicking off a durable
workflow, syncing to an external system.

Like `@stackbase/scheduler` and `@stackbase/workflow`, triggers are an **opt-in component** — there's
no CLI `init` command that installs it for you. You compose it in `stackbase.config.ts`;
`examples/chat/stackbase.config.ts` is the reference pattern real projects copy from.

## How it works: a trigger is a durable cursor over the log, not a queue

Every write in Stackbase lands in an append-only MVCC log — that log **is** the change feed. A
trigger owns one durable cursor row (`cursorTs`) recording how far it's read; a background driver
loop wakes on every commit, reads the committed revisions after the cursor for the trigger's watched
table, runs your handler with the batch, and only then advances the cursor. There's no separate queue
table anything could be dropped from — the log is the single source of truth, so a missed change is
impossible by construction. The only thing a crash can do is **redeliver** a batch that already ran
but whose cursor advance never landed — see [The delivery contract](#the-delivery-contract) below.

## Configuring a trigger

```ts
// stackbase.config.ts
import { defineConfig } from "@stackbase/component";
import { defineTriggers } from "@stackbase/triggers";

export default defineConfig({
  components: [
    defineTriggers({
      messages: { handler: "notifications:_onMessage" }, // an internal mutation or action
      users: { handler: "audit:_onUserChange", fromStart: true },
    }),
  ],
});
```

Each top-level key is a **watched table name** (the app-visible name, as it appears in `schema.ts`).
Its value:

| Field | Type | Default | Meaning |
|---|---|---|---|
| `handler` | `string` (required) | — | The app function path to run on every batch — see [Handlers](#handlers) below. |
| `batchSize` | `number` | `64` | Max changes per handler invocation. A batch is also cut early — mid-batch, never mid-commit — once its serialized size crosses a **~1MB byte budget** (so one giant commit can't blow up a single delivery). |
| `fromStart` | `boolean` | `false` | Replay the table's *entire* history from log position 0 instead of starting at the current tip. See [The cost of `fromStart`](#the-cost-of-fromstart). |
| `maxDeliveriesPerWindow` | `number` | `1000` | The circuit breaker's threshold — see [Recursion and the circuit breaker](#recursion-and-the-circuit-breaker). |

A brand-new trigger (no `fromStart`) starts at the log's **current tip** — it only sees changes
committed *after* it was configured, not the table's pre-existing rows. This is deliberate: silently
replaying a table's entire past through a newly-added handler the first time it boots would be a
surprising, unbounded-cost default.

## Handlers

A `handler` is an ordinary registered `mutation` or `action` (from `./_generated/server`, same as any
other function) whose path is **internal** — Stackbase's convention for "internal" is a `_`-prefixed
function or module-segment name in the path (e.g. `notifications:_onMessage`, or a whole module named
`_internal`), the same convention `@stackbase/scheduler` job targets use. There's no separate
`internalMutation`/`internalAction` factory to import; you write it with the same `mutation`/`action`
builder you'd use for anything else — the `_` prefix alone is what makes it internal (not directly
client-callable), which the boot step enforces: an unregistered path, a non-internal path, or a path
that resolves to a query instead of a mutation/action all fail **at boot**, with an instructive error,
before the driver ever tries to dispatch to it.

The handler receives exactly one argument:

```ts
{ changes: LogChange[] }
```

```ts
interface LogChange {
  table: string;                          // the watched table's app-visible name
  id: string;                             // the document's id (as a string)
  op: "insert" | "update" | "delete";
  newDoc: unknown | null;                 // the revision's value (null for a delete)
  oldDoc: unknown | null;                 // the prior revision (null for an insert — see below)
  ts: number;                             // this revision's commit timestamp
  changeId: string;                       // "<table>:<id>:<ts>" — stable across redelivery
}
```

An example mutation handler — a denormalized per-table audit log:

```ts
// convex/audit.ts
import { v } from "@stackbase/values";
import { mutation } from "./_generated/server";
import type { LogChange } from "@stackbase/component";

export const _onChange = mutation({
  handler: async (ctx, { changes }: { changes: LogChange[] }) => {
    for (const change of changes) {
      // Idempotency: dedup on changeId (see "The delivery contract" below) — a redelivered
      // change is a stable no-op rather than a duplicate audit row.
      const dup = await ctx.db.query("auditLog", "by_changeId").eq("changeId", change.changeId).take(1).collect();
      if (dup.length > 0) continue;
      await ctx.db.insert("auditLog", {
        changeId: change.changeId,
        table: change.table,
        docId: change.id,
        op: change.op,
      });
    }
  },
});
```

An **action** handler works the same way but runs outside the transaction — no `ctx.db`, native
`fetch`/clock, exactly like any other [action](/build/backend-functions) — the shape for
notification fan-out or syncing to an external system:

```ts
// convex/notifications.ts
import { action } from "./_generated/server";
import type { LogChange } from "@stackbase/component";

export const _onMessage = action({
  handler: async (_ctx, { changes }: { changes: LogChange[] }) => {
    await fetch("https://hooks.example.com/new-message", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ changes }),
    });
  },
});
```

## The delivery contract

This is the guarantee, stated precisely — read it before writing a handler:

> Bounded **at-least-once**: a crash between a handler succeeding and its cursor advance landing
> redelivers the last batch's changes — possibly *inside a larger batch* if new commits landed in the
> meantime (the batch boundary is not stable), but every change's `changeId` is. Delivery is
> **in-order per document**, within a trigger (global commit-timestamp order, one delivery in flight
> per trigger at a time — a slow handler backs up its own trigger's backlog, never another trigger's).
> There is no coalescing: a document written twice before the cursor reaches it produces the
> revisions the log holds, both of them. There is no ordering guarantee **across** triggers.
> **Handlers must be idempotent, or dedup on `changeId`.**

In practice: your handler will occasionally see a change it already processed (after a crash, or a
default-shard failover in a multi-node deployment) — treat `changeId` as that change's permanent,
stable identity and either make writing it twice harmless (an upsert keyed by something derived from
the document, e.g. "set counter to X" rather than "increment by 1") or explicitly check-and-skip a
seen `changeId`, as the audit-log example above does.

## Failure handling, pausing, and resuming

If a handler throws, the same batch (the identical `changeId`s, possibly widened by new commits) is
retried with exponential backoff. The cursor **never advances past an undelivered batch** — that's
what makes redelivery, not loss, the failure mode. `failureCount` persists on the trigger's cursor row
(restart-safe); the in-memory backoff delay itself does not, so a process restart mid-backoff retries
immediately rather than waiting out the remaining delay — an accepted, documented gap.

After **8 consecutive failures**, the trigger pauses itself (`state: "paused"`, with an
operator-visible error log and a `pausedReason`) rather than retrying forever. A paused trigger stops
consuming its backlog entirely until you call the `triggers:resume` mutation — directly, or from the
dashboard's function runner — which clears the failure count and flips it back to `"running"`.
Because resuming isn't itself a write to the watched table, the driver doesn't learn about it
instantly; a resumed trigger is picked back up within its periodic backstop, **eventually, within
about 30 seconds** — not the instant `triggers:resume` returns.

## Recursion and the circuit breaker

A trigger's own handler writing back to its **own watched table** is delivered like any other
write — this is intentional (DB-trigger semantics), because legitimate patterns need it: recomputing
a field, normalizing a value on write, chaining a state machine forward. It also means a handler that
unconditionally writes to its watched table on every delivery will recurse — each of its own writes
becomes a new change it delivers to itself.

As a safety net (not a substitute for writing a well-behaved handler), each trigger tracks its own
deliveries per rolling window — default **1000 deliveries per 10-second window**, configurable via
`maxDeliveriesPerWindow`. Tripping it pauses the trigger with `pausedReason: "circuit-breaker"`
instead of spinning the node — recognizable as distinct from a `"max-failures"` pause (the handler may
have been succeeding every single time; it was just running far too often). Fix the recursive write
pattern, then `triggers:resume`.

## The cost of `fromStart`

Setting `fromStart: true` replays a table's **entire existing history** — every revision ever
committed, in order, with the same one-`oldDoc`-point-read-per-update/delete cost as ordinary live
delivery — through your handler, honestly documented as potentially expensive: on a large table this
can be **minutes of catch-up**, not seconds, throttled by the same `batchSize`/byte budget as live
delivery so it never becomes an unbounded single delivery. Reach for it deliberately — a new audit
table that needs to backfill from day one, for example — not by default.

## Edge cases worth knowing about

- **Tombstone-prev (delete → re-insert):** re-inserting a document id that was previously deleted is
  **not** classified as a fresh `"insert"` — its log entry's `prev_ts` still points at the tombstone
  row the delete left behind, so `op` is `"update"`, but `oldDoc` reads back `null` (the tombstone),
  not the value the document held before the delete. If your handler diffs `oldDoc`/`newDoc`, treat a
  `null` `oldDoc` on an `"update"` the same as a fresh document, not as "nothing changed."
- **Renamed or dropped watched tables:** a cursor row is keyed by the table's **name**. Since Stackbase
  deploys are additive-only (no table renames/drops via `stackbase deploy`), this mostly can't happen
  in the ordinary flow — but if a table a trigger watches does disappear from the schema (e.g. a local
  schema edit + restart), there's no name-resolution error: the trigger simply stops matching any
  changes for that name. It goes quiet rather than pausing — its cursor keeps advancing along with the
  log (a watched-but-now-nonexistent table just never contributes a change to scan), so nothing is
  flagged as broken. If a trigger seems to have stopped delivering, check that its watched table names
  still exist in the current schema.

## Composition pattern: a trigger that starts a workflow

Triggers pair naturally with [`@stackbase/workflow`](/build/backend-functions): react to a data change
by kicking off a durable, multi-step, resumable workflow, instead of doing the multi-step work inline
in the handler itself.

```ts
// stackbase.config.ts
import { defineConfig } from "@stackbase/component";
import { defineScheduler } from "@stackbase/scheduler";
import { defineWorkflow, workflow } from "@stackbase/workflow";
import { defineTriggers } from "@stackbase/triggers";

const fulfillOrder = workflow.define({
  handler: async (step, { orderId }: { orderId: string }) => {
    await step.runMutation("orders:_reserveStock", { orderId });
    await step.runAction("payments:_charge", { orderId });
    await step.runMutation("orders:_markFulfilled", { orderId });
  },
});

export default defineConfig({
  components: [
    defineScheduler(),
    defineWorkflow({ workflows: { "workflows:fulfillOrder": fulfillOrder } }),
    defineTriggers({ orders: { handler: "orders:_onOrderChange" } }),
  ],
});
```

```ts
// convex/orders.ts
import { mutation } from "./_generated/server";
import type { LogChange } from "@stackbase/component";

export const _onOrderChange = mutation({
  handler: async (ctx, { changes }: { changes: LogChange[] }) => {
    for (const change of changes) {
      if (change.op !== "insert") continue;
      // ctx.workflow.start is idempotent-by-changeId here only if you make it so (e.g. checking
      // a "workflowStarted" flag on the order) — the same at-least-once guidance applies: this
      // handler can, per the delivery contract above, see the same insert twice.
      await ctx.workflow.start("workflows:fulfillOrder", { orderId: change.id });
    }
  },
});
```

Every new order insert reactively kicks off a durable `fulfillOrder` run — the trigger is the
reactive edge (data change → workflow start), the workflow is the durable multi-step body (retries,
resumability, and — if a step declares `compensate` — saga-style rollback on failure all come from
`@stackbase/workflow` itself, not from anything triggers-specific).

## What triggers are *not*

- **Not effectively-once.** Delivery is bounded at-least-once; co-committing a mutation handler's
  cursor advance with its own effects in the exact same transaction would need a same-transaction
  sub-call seam that doesn't exist yet — dedup on `changeId` in the meantime.
- **Not field-level or predicate filters.** A trigger watches an entire table; if you only care about
  some changes, check inside the handler.
- **Not ordered across tables**, only within one trigger's own watched table.
- **Not dynamically registerable at runtime.** Like crons, triggers are declared in
  `stackbase.config.ts` and fixed for the life of the deployment (adding/removing one needs a
  restart).

## Related

- [`examples/chat/stackbase.config.ts`](../../examples/chat/stackbase.config.ts) — a small, working
  reference: an audit-log trigger on the chat app's `messages` table.
- The repo `CLAUDE.md` has the one-line architecture summary under "What works", and the design spec
  lives at `docs/superpowers/specs/2025-10-16-onchange-triggers-design.md` for the full internals
  (the fleet stable-prefix bound, the `readLog` seam, the driver loop shape).
