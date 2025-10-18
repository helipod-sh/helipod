# @stackbase/triggers — onChange Server Triggers

**Status:** approved design (brainstormed 2025-10-16; user delegated design calls)
**Builds on:** main `400cea3`+ — the recurring driver seam (`ComponentDefinition.driver`/`boot`,
`DriverContext.onCommit`/`runFunction`/`setTimer`), the scheduler's driver-loop pattern,
`DocStore.load_documents(range, order)` (the shipped log-tail primitive), the MVCC log's
`prev_ts` chains, drivers-run-on-the-default-shard-holder (B2b/B5 rule).

## Goal

React to data changes server-side, durably: `defineTriggers({ messages: { handler:
"notifications:onMessage" } })` runs the referenced function when documents in a watched
table are inserted, updated, or deleted — denormalized counters, audit logs, notification
fan-out via actions, external syncs. Fills the gap between mutations (synchronous,
in-transaction) and workflows (explicit orchestration).

## The architecture: a trigger is a durable log consumer (no queue)

The MVCC log IS the change feed. Each trigger owns a durable cursor row; the driver loop
reads committed revisions `(cursorTs, tip]`, filters to the watched table, builds `Change[]`
batches, runs the handler, and advances the cursor AFTER success. Missed changes are
impossible by construction (the log is the source of truth — nothing is enqueued that could
be dropped); a crash redelivers at most the last batch. No queue table, no per-change claim
machinery.

## Non-goals (v1)

Field-level / predicate filters (per-table only; filter in the handler) · effectively-once
delivery (bounded at-least-once + idempotency guidance; co-committing cursor+effects for
mutation handlers needs a sub-call-in-same-transaction seam that doesn't exist — noted
fast-follow) · provenance-based self-write exclusion (commitMeta reaches the guard, not the
log rows — DB-trigger semantics instead, below) · cross-table ordering guarantees beyond
global ts order · dynamic runtime registration (config-declared, like crons).

## Design

### D1. The one core seam: `DriverContext.readLog`

```ts
// packages/component (the seam type) + packages/runtime-embedded (the implementation):
readLog(opts: { afterTs: number; tables?: string[]; limit?: number }): Promise<{
  changes: Array<{ table: string; id: string; op: "insert" | "update" | "delete";
                   newDoc: JSONValue | null; oldDoc: JSONValue | null; ts: number }>;
  maxScannedTs: number;   // advance the cursor to THIS, not to the last change's ts —
                          // scanned-but-unmatched ranges must not be rescanned forever
}>;
```
- Implemented over `store.load_documents({ start: afterTs, exclusive }, "asc")` with a
  bounded scan (limit applies to SCANNED entries, not matched — a quiet watched table on a
  busy log must still make cursor progress); `tableNumberToName` (already on the runtime)
  maps ids to app-visible table names; component-internal tables (namespaced) and app-root
  system tables (`_storage`) are EXCLUDED from `changes` but still advance `maxScannedTs`.
- `op` derivation: entry `value === null` → delete; `prev_ts === null` → insert; else
  update. `oldDoc`: the prev revision via the `prev_ts` chain (one point read per
  update/delete in the batch; insert → null). `newDoc`: the entry's value (null on delete).
- Reads the runtime's WRITE store (the primary — complete at commit; drivers run only on
  the default-shard holder, so no replica/frontier bounds apply; on hybrids this is the
  pgStore by construction).
- Ts serialization: the driver seam's existing number-typed commitTs convention (safe below
  2^53 per the shipped B2b analysis) — keep consistent, document the bound.

### D2. The `@stackbase/triggers` component

- **Config:** `defineTriggers(opts: { [table: string]: { handler: string /* app fn path,
  internalMutation or internalAction */; batchSize?: number /* default 64 */ } })` in
  `stackbase.config.ts` — the defineScheduler/crons precedent (handlers referenced by path;
  the boot step validates the paths exist and the kinds are internal mutation/action,
  failing fast with an instructive error).
- **Table (component namespace):** `cursors { name: string /* = watched table */, cursorTs:
  number, state: "running" | "paused", failureCount: number, lastError: string | null,
  pausedReason: string | null }` — one row per trigger, created by the boot step at the
  CURRENT log tip (a NEW trigger starts from now, not from history — replaying a table's
  entire past through a new handler is surprising; document; a `fromStart: true` config
  escape hatch is v1-cheap and included).
- **The driver loop** (the scheduler's shape: `onCommit`-woken + a periodic beat, `__tick`/
  `__wake` test seams): per trigger with state "running": `readLog({ afterTs: cursorTs,
  tables: [name], limit: batchSize })` → if changes: run the handler via
  `runFunction(handlerPath, { changes, deliveryId })` (`deliveryId` = `"<name>:<maxScannedTs>"`
  — stable across redelivery, the app-side dedup key) → on success: advance the cursor to
  `maxScannedTs` via an internal mutation → loop while the batch was full. If NO changes but
  `maxScannedTs > cursorTs`: advance the cursor (quiet-table progress). One delivery in
  flight per trigger (sequential per trigger; concurrent across triggers).
- **Failure handling:** handler error → retry with the scheduler's backoff discipline
  (bounded attempts); after N consecutive failures (default 8): `state = "paused"`,
  `pausedReason` recorded, one operator-visible error log. Un-pause = an internal mutation
  (`triggers:resume`), callable from the dashboard function runner. The cursor NEVER
  advances past an undelivered batch (retries redeliver the same batch — at-least-once,
  in-order preserved).
- **The circuit breaker (cascade safety net):** DB-trigger semantics — a trigger's own
  handler writes to its watched table ARE delivered (legitimate patterns need it; the
  recursion footgun is documented with the auth-style plain example). Safety net: a
  per-trigger deliveries-per-window counter (default 1000 deliveries / 10s window, config
  `maxDeliveriesPerWindow`); tripping it pauses the trigger with `pausedReason:
  "circuit-breaker"` instead of melting the node.

### D3. Delivery contract (documented verbatim)

Bounded at-least-once: a crash between handler success and cursor advance redelivers
exactly the last batch (same `deliveryId`); handlers must be idempotent or dedup on
`deliveryId`. Per-document in-order within a trigger (global ts order, sequential
delivery). Changes are observed at commit granularity — a document written twice before the
cursor reaches it yields the revisions the log holds (both — the log is append-only; no
coalescing in v1). Ordering across triggers: none. New triggers start at the current tip
unless `fromStart`.

### D4. Fleet/topology

Nothing new: the driver runs only on the default-shard holder (shipped rule; stops/starts
with the shipped driver lifecycle on default moves); `readLog` reads the primary; handler
mutations route via the executor chokepoint (B2b); handler actions run local to the driver
node as scheduled actions do. Tier-0/dev: identical (the driver seam is topology-agnostic).

## Error handling summary

| Failure | Behavior |
|---|---|
| Handler throws | Backoff retries; same batch redelivered (same deliveryId); after N → paused + operator error |
| Crash between handler success and cursor advance | Last batch redelivers (the documented bound) |
| Trigger writes its own watched table | Delivered (DB-trigger semantics); runaway → circuit breaker pauses |
| Handler path missing/wrong kind at boot | Boot fails fast, instructive error |
| Default shard moves (fleet) | Driver stops on the old holder, starts on the new; the cursor row is shared state — resumes exactly |
| Quiet watched table on a busy log | maxScannedTs advances the cursor without deliveries (no rescan creep) |

## Testing

- **Unit:** readLog (op derivation incl. delete/insert/update; oldDoc via prev chain;
  scanned-vs-matched limit semantics; system/component-table exclusion; maxScannedTs on
  empty match) · the loop (batch → success → cursor advance; full-batch continuation;
  failure → same batch redelivered → pause after N; resume; breaker trips + pauses;
  quiet-table advance; sequential-per-trigger) · boot (cursor created at tip; fromStart;
  path validation fail-fast).
- **E2E through the real dev server** (the shipped-entrypoint discipline): insert →
  trigger's mutation handler writes a counter → the counter's change reaches a live
  subscription reactively; an ACTION handler calls fetch (a local test HTTP sink) —
  proving both kinds; **crash-resume: kill the server with a backlog of undelivered
  changes → restart → the cursor resumes and every change is delivered exactly-in-order
  with no misses** (the design's headline claim, proven); the breaker: a deliberately
  self-recursive trigger pauses with the operator error instead of spinning; existing
  scenarios unmodified.
- Fleet spot-check (PGlite integration): the cursor survives a simulated default-shard
  move (driver stop/start) without redelivery beyond the bound.

## Docs

`docs/enduser/triggers.md` (the API, the delivery contract verbatim, the idempotency +
recursion guidance, fromStart, the breaker); `examples/` reference pattern; CLAUDE.md's
what-works entry.
