# @stackbase/triggers Implementation Plan — onChange Server Triggers

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `defineTriggers({ messages: { handler: "notifications:onMessage" } })` runs the referenced internal mutation/action with `Change[]` batches when watched-table documents change — a durable cursor over the MVCC log (no queue), crash-safe by construction, bounded at-least-once with per-change dedup ids.

**Architecture:** Spec = `docs/superpowers/specs/2025-10-16-onchange-triggers-design.md` (post-review, c9f20c1 — the review's findings are REQUIREMENTS: the fleet stable-prefix bound (readLog's upper bound = min(frontier_ts) in fleet, maxTimestamp() elsewhere — the raw tail is NOT gap-free under the commit pool), the `load_documents` LIMIT seam (PG buffers the whole range), per-change `changeId` dedup, `options.store` explicitly (never queryStore), failureCount-persists/backoff-timer-in-memory, the byte budget, the tombstone-prev oldDoc edge).

**Tech Stack:** TypeScript; the component/driver seam; PGlite + SQLite units; real-dev-server E2E.

## Global Constraints

- Exact values: batchSize default **64** AND a **~1MB serialized byte budget** (cut early); consecutive-failure pause threshold **8**; circuit breaker **1000 deliveries / 10s window** (`maxDeliveriesPerWindow` config); `changeId = "<table>:<id>:<ts>"`; new triggers start at the **current tip** unless `fromStart: true`.
- The delivery contract verbatim (docs + code comments): bounded at-least-once — a crash between handler success and cursor advance redelivers the last changes (possibly inside a larger batch; every change's changeId is stable); per-document in-order within a trigger; no coalescing; handlers idempotent or dedup on changeId.
- Component conventions: the scheduler/workflow precedents exactly (component namespace tables, `defineTriggers()` in stackbase.config.ts, handler paths validated at boot fail-fast, driver with `__tick`/`__wake` test seams, opt-in per project).
- Existing tests NEVER modified; non-trigger projects byte-identical (no component composed = zero new code paths run). Node/vitest; full gate = build && typecheck && test; commit trailer `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.

**Verified ground truth (spec review — do not re-derive):** `load_documents(range: TimestampRange {minInclusive, maxExclusive}, order)` — NO limit param today; ts index exists on both backends (`documents_by_ts`, schema.ts:13 / sqlite-docstore.ts:43); the PG impl BUFFERS the whole range before yielding (postgres-docstore.ts:392-396) — the LIMIT must be pushed into the SQL. The commit pool is configured ONLY at `ee/packages/fleet/src/node.ts:654` → non-fleet PG serializes all commits on the pinned connection (gap-free tip); fleet's per-shard connections land out of order → the stable prefix is `min(shard_leases.frontier_ts)` (StablePrefixTs; the idle-closer keeps it unpinned); the oracle's lastCommitted is a max high-water, NOT a prefix. `get(id, ts)` revision reads + `previous_revisions` exist (types.ts:174,190); a tombstone prev yields null oldDoc with op "update" (documented edge). DriverContext = `runFunction/onCommit/setTimer/clearTimer` (define-component.ts:9-16) + B3's primaryRead inside runtime's runFunction; `tableNumberToName` lives on the runtime. `computeBackoff(attempts, random)` is standalone-importable (`components/scheduler/src/backoff.ts`). The scheduler driver's loop/`__tick`/`__wake` shape: `components/scheduler/src/driver.ts`. Boot steps: `ComponentDefinition.boot(ctx)` (defineScheduler:48-58 precedent).

**DAG:** T1 → T2 → T3 → T4 (serial; T2/T3 share the component package; T1 is core seams).

---

### Task 1: Core seams — `load_documents` LIMIT + `DriverContext.readLog`

**Files:**
- Modify: `packages/docstore/src/types.ts` (load_documents gains `limit?: number`), `packages/docstore-sqlite/src/sqlite-docstore.ts` + `packages/docstore-postgres/src/postgres-docstore.ts` (LIMIT pushed into SQL), `ee/packages/fleet/src/switchable-store.ts` (delegate), docstore conformance (limit semantics both stores), `packages/component/src/define-component.ts` (DriverContext.readLog type + the Change type), `packages/runtime-embedded/src/runtime.ts` (the readLog implementation on the driver context + `EmbeddedRuntimeOptions.stablePrefix?: () => Promise<bigint | null>` — the fleet accessor seam, null/absent = use maxTimestamp), `ee/packages/fleet/src/node.ts` (wire stablePrefix = read min(frontier_ts) — the LeaseManager read the tailer already uses)
- Test: docstore conformance + `packages/runtime-embedded/test/read-log.test.ts`

**Interfaces (produced):**
```ts
// docstore: load_documents(range, order, limit?)  — limit = max entries returned, SQL-pushed.
// component:
export interface LogChange { table: string; id: string; op: "insert" | "update" | "delete";
  newDoc: JSONValue | null; oldDoc: JSONValue | null; ts: number; changeId: string }
// DriverContext gains:
readLog(opts: { afterTs: number; tables?: string[]; limit?: number }): Promise<{
  changes: LogChange[]; maxScannedTs: number }>;
// runtime-embedded: EmbeddedRuntimeOptions.stablePrefix?: () => Promise<bigint | null>
//   — readLog's scan upper bound = (await stablePrefix()) ?? store.maxTimestamp();
//   reads options.store EXPLICITLY (never queryStore). Fleet wires it to min(frontier_ts).
```

- [ ] **Step 1 (failing tests):** conformance both stores — limit returns exactly N entries ASC from minInclusive, next call resumes; PG test proves the LIMIT is in the SQL (query-count/shape spy per the store's test conventions). readLog: op derivation (insert/update/delete incl. the tombstone-prev → oldDoc null + op "update" edge); oldDoc correctness via a 3-revision doc; component/system tables excluded from changes but counted in maxScannedTs; scanned-vs-matched (a quiet watched table on a busy log advances maxScannedTs with zero changes); the stable-prefix bound — with a stubbed stablePrefix returning F < tip, readLog never returns entries above F and maxScannedTs ≤ F (the fleet gap regression); without it, bound = maxTimestamp; changeId shape.
- [ ] **Steps 2–5:** fail → implement → docstore-sqlite + docstore-postgres + runtime-embedded + fleet suites green (existing unmodified) → full gate → commit `feat(core): load_documents LIMIT + DriverContext.readLog with the stable-prefix bound`.

---

### Task 2: The `@stackbase/triggers` component

**Files:**
- Create: `components/triggers/` (package: `src/index.ts` defineTriggers + schema (cursors table per the spec's D2 shape), `src/modules.ts` (internal fns: `_advanceCursor`, `_recordFailure`, `_pause`, `resume`, `_status` query), `src/driver.ts` (the loop), `src/boot.ts` (cursor-at-tip creation, fromStart, handler-path validation fail-fast), tests)
- Test: `components/triggers/test/` (driver loop against a fake DriverContext + PGlite integration via the component harness — mirror the scheduler's test layout)

**Interfaces (consumed):** T1's readLog/LogChange. **(produced):** `defineTriggers(opts: { [table]: { handler: string; batchSize?: number; fromStart?: boolean; maxDeliveriesPerWindow?: number } })`; handler receives `{ changes: LogChange[] }`.

- [ ] **Step 1 (failing tests):** boot (cursor at tip; fromStart at 0; unknown handler path / non-internal / wrong kind → fail-fast instructive); the loop (batch → handler → cursor at maxScannedTs; full-batch continuation; quiet-table advance; byte-budget cut (construct >1MB docs); sequential-per-trigger (a slow handler blocks its own trigger only — a second trigger progresses); failure → same changes redelivered (changeIds identical across redelivery even when the rescan window grew — THE dedup regression) → failureCount persists (simulated restart: new driver instance, counter intact) → pause at 8 + pausedReason; resume; the breaker (1001 deliveries in a window → paused "circuit-breaker"); backoff via computeBackoff (import, assert delays)).
- [ ] **Steps 2–5:** fail → implement → triggers + component suites → full gate → commit `feat(triggers): @stackbase/triggers — durable cursor-over-the-log onChange component`.

---

### Task 3: E2E through the real dev server

**Files:** `packages/cli/test/triggers-e2e.test.ts` (the shipped-entrypoint discipline; fixture app composing defineTriggers alongside defineScheduler)

- [ ] **Step 1 (failing scenarios):** (1) insert a message → the trigger's internal MUTATION handler writes a counter doc → a live subscription on the counter receives the update reactively (the full loop: commit → onCommit wake → readLog → handler → fan-out); (2) an internal ACTION handler receives changes and calls fetch against a local HTTP sink (both kinds proven); (3) **crash-resume, the headline:** stop the server with a backlog (write K changes with the driver deliberately stalled or the server killed first), restart → every change delivered, in order, none missed (assert the counter/sink totals + changeId sequence); (4) the recursion breaker: a fixture trigger writing its own watched table → paused with "circuit-breaker" + the operator error, server healthy; (5) existing cli scenarios unmodified.
- [ ] **Step 2:** `bun run build`; green ×2; full monorepo gate (known flakes isolated-rerun, report). Commit `test(cli): triggers E2E — reactive effect, action handler, crash-resume, breaker`.

---

### Task 4: Docs + finish

**Files:** `docs/enduser/triggers.md` (the API, the delivery contract VERBATIM from Global Constraints, idempotency/changeId guidance, recursion + fromStart cost + tombstone-prev + rename notes), `examples/` reference pattern (the chat app gains an audit-log or unread-counter trigger), CLAUDE.md what-works entry.
- [ ] Docs → full gate → commit `docs(triggers): onChange guide + reference pattern`.

## Execution notes

- Serial DAG. Models: T1 opus (the stable-prefix bound is protocol-adjacent core), T2 sonnet (well-specified component work on the scheduler's template; opus review), T3 opus (the E2E), T4 sonnet.
- Fleet spot-check (the spec's PGlite integration item) lives inside T1's stable-prefix regression + T2's restart test — a full fleet E2E scenario is NOT required for v1 (the driver lifecycle + chokepoint routing are shipped invariants); note it as a follow-up candidate if the final review disagrees.
