# Slice-6 M2c — Global reactivity (poll-first) — Design Spec

**Date:** 2026-05-24
**Status:** Design (pre-plan). Brainstorming complete; awaiting user review before the implementation plan.
**Slice:** M2c of Slice-6 M2 (`.global()`/D1). Makes `.global()`-table subscriptions **live-update** — the reactivity M2b explicitly deferred. Parent spec `docs/superpowers/specs/2026-03-20-multishard-crossshard-slice6-design.md` §6.4 T7; builds on M2b (`m2b-shipped.md`) and M2a (`docstore-d1-m2a-shipped.md`).

> **Note on file:line references.** The seam locations below were mapped 2026-05-24 (grounding in `.superpowers/sdd/` from the M2c exploration) and are load-bearing, but point-in-time — the implementation plan must re-confirm each against current code.

## Goal

A `useQuery` on a `.global()` table auto-refreshes when the underlying D1 data changes — including a change written from a **different** Durable Object. Today (post-M2b) a global-table subscription returns correct data on each execution but is **structurally inert**: its read-set is empty, so no invalidation ever reaches it. M2c gives it a trigger.

## The core problem (why this needs polling)

Our reactivity keys off the **local** per-DO commit fan-out (`WriteFanout.publish` → `SyncProtocolHandler.notifyWrites` → re-run → push). A `.global()` write goes to **D1**, not the local MVCC store, so it never enters that fan-out. And D1 (like object storage) has **no push/change-feed primitive** — a subscriber DO cannot be notified by D1 that something changed. The only push-less option is **polling**: each DO periodically re-checks D1 and invalidates its global subscriptions when something changed. This is the "poll-first" mechanism the parent spec chose (§3.2); a CDC/notify upgrade is a deferred follow-on.

## Decisions (made as CTO; plain-language rationale)

1. **M1 real-Cloudflare proof — resolved by subsumption, not a separate prerequisite run.** The parent spec gates M2 reactivity on "prove Milestone-1 (multishard) reactivity on real Cloudflare first," which has never run (both rigs are deploy-ready-but-unrun). Resolution: **M2c's own real-Cloudflare ship gate IS that proof.** M2c pushes updates through the *exact same* `handler.notifyWrites` → WebSocket-`Transition` reactive machinery M1 uses, plus the new cross-DO-via-D1 path. So an M2c real-CF cross-DO run exercises both the core DO→client reactive push (the M1 concern) and the new global path. We build+prove the mechanism on miniflare (multiple DOs + real D1 — full logic coverage) and make the real-CF cross-DO run the ship gate that doubles as the deferred M1 reactive proof. No separate M1 run needed first.

2. **Mechanism: per-table version-counter poll (poll-first).** Each `.global()` write bumps a **per-table version counter** in D1 (atomic with the write). A boot-wired **GlobalReactivityPoller** on each DO reads the versions of the subscribed global tables on a short timer and, for any table whose version advanced, invalidates that table's subscriptions through the existing sync path. This is cheaper than re-running every subscribed query each tick (the poll reads a few small scalars, not query results) while catching every change (every global write bumps the version). CDC/notify deferred.

3. **Cost knob: ~2s interval, poll only while global subscribers exist.** A global change surfaces within the poll interval (near-live, not instant). Polling costs D1 reads, so a DO with **zero** global subscriptions does **not** poll at all (zero idle cost), and one with subscribers polls at ~2s (tunable). This is the right freshness/cost balance for v1.

4. **Wiring: boot-time against the concrete runtime** (the `ObjectStoreReplicaTailer`/`startReplicaReactiveTailer` precedent — `ee/packages/objectstore-substrate/src/replica-wiring.ts`), NOT the generic `ComponentDefinition.driver` seam (which has no path to `handler.notifyWrites` — `DriverContext` doesn't expose it). The poller needs the already-built runtime instance + the D1 store handle.

5. **Scope: equality-only global subscriptions become reactive.** Matches M2b's read scope. NOT cross-shard fan-out (M2d), NOT the read-replica bookmark optimization (deferred), NOT range/sorted global queries (deferred with M2b).

## Architecture

### 1. Per-table version counter in D1 (the write-side change signal)
- A reserved internal D1 table `_global_versions ("table" TEXT PRIMARY KEY, "version" INTEGER NOT NULL)`, created by `D1DocStore.applyDdl` alongside the app's global tables.
- M2b's global commit flush (`D1DocStore.commitBatch(ops)`, called from the executor's post-transaction flush) is extended: for each **distinct table** written in the batch, append an UPSERT `INSERT INTO "_global_versions"("table","version") VALUES(?,1) ON CONFLICT("table") DO UPDATE SET "version"="version"+1` to the **same atomic D1 batch**. So a global write and its version bump commit atomically — a poller can never see a write without its version bump or vice versa.
- This is a small additive change to M2b's `commitBatch` (or a thin `commitBatchWithVersionBump` the executor flush calls); the `ops`-only `commitBatch` stays for callers that don't need it.

### 2. Making a global subscription matchable (the read-set fix)
Today a global-only query records no read-set (`kernel.ts` `handleDbQuery`/`handleDbGet` global branches return without `recordScanReads`/`collectTrace`), so the subscription lands in `SubscriptionManager` with `tables: []` / `readRanges: []` and is **never** indexed in `byTable`/`byRange` — invalidation can't reach it.
- M2c has the kernel's global read branches **record the global table name(s)** the query/get touched, surfaced on the `UdfResult` as a new `globalTables: string[]` field (parallel to `readRanges`, which stays empty for global reads — the local range matcher must NOT try to match global tables).
- The sync handler (`doModifyQuerySet`, where subscriptions register) adds those `globalTables` to the subscription's `tables` set, so `SubscriptionManager` indexes the sub under each global table name in `byTable`. Now a `notifyWrites({ tables: [globalTable] })` matches it via the existing table-fallback path — **zero new matcher machinery**, full reuse of the local invalidation/re-run/push pipeline.
- Because a global read records **no ranges**, a local MVCC commit's range/table invalidation still never spuriously matches a global sub unless a *local* table of the same bare name is written — global table names are app-scoped and distinct, and the poller is the only intended trigger; the plan must confirm no local table shares a global table's name (schema-load already dedups table names across the app).

### 3. The GlobalReactivityPoller (the poll-side)
A new component (`packages/runtime-cloudflare` or a small shared module), wired at DO boot, structurally mirroring `startReplicaReactiveTailer`:
- **Inputs (a narrow `GlobalReactivityRuntime` interface):** the D1 store handle (to read `_global_versions`), `runtime.handler.notifyWrites`, and a way to enumerate the **global tables that currently have ≥1 subscriber**. Pin this as a **refcount the sync handler maintains** — incremented when a subscription registers with non-empty `globalTables`, decremented when it drops — exposing `subscribedGlobalTables(): string[]`. (Chosen over deriving it from `SubscriptionManager`'s internal `byTable` each tick: the refcount is O(1) per sub-change and gives the poller a clean "any global subs? which tables?" signal without walking the index.)
- **Loop:** its own `setTimeout`/DO-alarm timer (via `DoAlarmWakeHost`/the multiplex, matching the tailer). Each tick, **only if** there is ≥1 subscribed global table:
  1. Read the current versions of the subscribed global tables (one `SELECT "table","version" FROM "_global_versions" WHERE "table" IN (…)`).
  2. For each table whose version `>` the poller's last-seen value: `runtime.handler.notifyWrites({ tables: [table], ranges: [], commitTs: <synthetic monotone ts> })`, then update last-seen.
  3. Re-arm the timer at `now + intervalMs` (default ~2s). When the subscribed-global-table set becomes empty, stop arming (idle → zero polling).
- **The push itself is entirely the existing path:** `notifyWrites` → `findAffectedByRanges(..., tables)` matches the global subs (step 2 above) → `sendSessionTransition` re-runs each affected sub (`execSub`, which re-reads D1 for the current result) → sends a `QueryUpdated` (or `QueryUnchanged` on the resume-fingerprint path). No new push/diff code.

### 4. Change granularity (v1: table-level; a documented over-invalidation)
A version bump is **per table**, so a write to table `T` re-runs **every** subscription on `T`, even ones whose specific equality-slice didn't change (they re-run against D1 and get a `QueryUpdated` with identical data — correctness-neutral, a minor inefficiency). This matches the existing local reactive path's own table-fallback behavior when a precise range isn't available. A finer per-`(table, indexed-key)` version (to invalidate only the affected slices) is a **deferred optimization**, not v1.

**Same-DO global subscriptions also update via the poll**, not the local fan-out — because a global write never enters the local commit fan-out on any DO, including the writer's. So a subscription on the *writer's own* DO (other than the mutating client, whose immediacy is covered by the mutation response + optimistic update) also reflects the change on the next poll tick. The ~2s poll latency therefore applies uniformly to same-DO and cross-DO global subscriptions — there is no faster same-DO path in v1, which keeps the mechanism single and simple.

## Data flow (M2c)

```
GLOBAL WRITE (mutation on DO-A):
  ...M2b flush... D1DocStore.commitBatch(ops)  ──►  same atomic batch ALSO upserts _global_versions[T] += 1

GLOBAL SUBSCRIPTION (useQuery on DO-B):
  query reads .global() table T  ──►  UdfResult.globalTables = [T]  ──►  sub registered in SubscriptionManager under table T

POLL (on DO-B, every ~2s while ≥1 global sub):
  read _global_versions for subscribed tables  ──►  T's version advanced?
    └─ yes ──► runtime.handler.notifyWrites({ tables: [T], ranges: [], commitTs })
                 └─ existing path: match subs on T ──► execSub re-run (re-reads D1) ──► QueryUpdated pushed to DO-B's clients
    └─ no  ──► nothing (idle, no push)

idle DO (no global subs)  ──►  poller does not arm a timer (zero cost)
```

## Error handling
- **Poll read failure** (D1 transient error): log + skip the tick, retry next interval (never crash the DO; mirror the tailer's fire-and-forget error posture). A missed tick just delays a push by one interval.
- **Version-bump failure**: impossible to observe partially — it's in the same atomic D1 batch as the write, so a failed bump fails the whole write (the write didn't commit either).
- **`notifyWrites` throw**: caught per-table so one bad table's invalidation doesn't stop the others (mirror `doNotifyWrites`'s existing per-session resilience).
- **Synthetic `commitTs`**: monotone per DO (e.g. `max(lastSeen, now)`); it is only a fan-out tag for the global push and must not collide with / regress the local MVCC oracle — the plan must source it so it never rewinds a session's observed frontier (reuse the tailer's `observeTimestamp` discipline if needed).

## Testing
- **Unit:** the version-bump appended to `commitBatch` (a batch touching 2 tables bumps both, once each; atomic with the write); the kernel recording `globalTables` on a global query/get; the handler registering a global sub under its table; the poller's version-diff logic (advanced → notifyWrites called; unchanged → not; empty subscribed-set → no poll).
- **In-process integration:** a `.global()` write bumps the version; the poller tick invalidates and a subscribed query re-runs and pushes `QueryUpdated`; an unchanged tick pushes nothing; a DO with no global subs never polls.
- **Gate — miniflare MULTI-DO + D1 E2E (serial `*-e2e.test.ts`):** two real DOs on miniflare sharing one D1 binding — a `.global()` write via DO-A is observed by a live global subscription on DO-B within the poll interval (the cross-DO propagation, the heart of M2c); a global-unique violation still rejects; read-your-writes on the writer's own DO. This is the mechanism proof.
- **Ship gate — real Cloudflare (also the deferred M1 reactive proof):** the same cross-DO scenario on a real `*.workers.dev` deployment. Documented as the release gate (like M2a/M2b's real-substrate gates); it clears the "prove M1 reactivity in production" blocker.
- **Regression:** no D1 binding / no global table → no poller, behavior byte-identical; the full local reactive suite unchanged.

## Package layout / files touched
- `packages/docstore-d1` — the `_global_versions` DDL in `applyDdl`; the version-bump UPSERT in `commitBatch` (or a `commitBatchWithVersionBump`); a `readVersions(tables)` accessor for the poller.
- `packages/executor` — the kernel global read branches record `globalTables`; `UdfResult`/the run result carries `globalTables`.
- `packages/sync` — `doModifyQuerySet` adds `globalTables` to the sub's `tables`; a `SubscriptionManager` accessor for "global tables with ≥1 subscriber" (or a handler-maintained refcount).
- `packages/runtime-embedded` — thread the global store's `readVersions` + the subscribed-global-tables accessor to the boot layer (the poller needs them).
- `packages/runtime-cloudflare` (+ maybe a small shared `global-reactivity` module) — the `GlobalReactivityPoller` + its boot-time wiring in `durable-object.ts`/`boot.ts` (near the M2b globalStore construction), and the miniflare multi-DO+D1 E2E gate.
- **Untouched:** the MVCC transactor/commit core, the client SDK/wire protocol (the poller reuses the existing `Transition`/`QueryUpdated` frames — no new client message), the local reactive path.

## Grounding-driven refinements (added 2026-05-24 after mapping the sync/executor/wake seams)

Full verbatim shapes in `.superpowers/sdd/m2c-grounding.md`. Two points tightened the design:

1. **Global-table matching needs a dedicated `byGlobalTable` index, not a merge into `sub.tables`.** `SubscriptionManager.findAffectedByRanges`'s table-fallback loop only matches subs in `tableFallbackKeys`, which is populated *only* when `sub.readRanges.length === 0`. So a query that reads BOTH a local range-indexed table AND a `.global()` table (non-empty read-ranges) would never be matched by a global-table `notifyWrites` — a silent miss. Fix: `Subscription` gets its own `globalTables?: string[]` field; `SubscriptionManager` gets a `byGlobalTable: Map<string, Set<string>>` index populated from it (independent of `readRanges`/`tableFallbackKeys`), and `findAffectedByRanges` gets a THIRD, ungated match loop over `writeTables` against `byGlobalTable`. This also gives the poller its "which global tables have subscribers" signal for free (`byGlobalTable.keys()` where the set is non-empty), via a `subscribedGlobalTables(): string[]` accessor.

2. **The poller is alarm-driven, not a free-running `setTimeout`.** A DO with idle-but-open global subscriptions can hibernate (Cloudflare WebSocket Hibernation — the WS survives, the DO wakes on the alarm), and a free-running timer would *prevent* that hibernation (keeping the DO resident = real cost). So the poll cadence must ride the **DO alarm seam** (`DoAlarmWakeHost`/`fireDueTimers`), the same one the scheduler/triggers/storage-reaper use — the alarm wakes the (possibly hibernated) DO, it polls D1, invalidates (pushing to the open WS), and re-arms the alarm. The `startReplicaReactiveTailer` `setTimeout`-chain is the right shape for a long-lived Node/Bun `serve`/`dev` process but the WRONG shape for a DO. The M2c poller is wired at CF boot (inside `bootDurableObjectRuntime`, where `globalStore` + `runtime.handler` are in scope) with its cadence driven by the runtime's alarm/timer multiplex — implemented as a driver on the wake seam, or a boot-wired closure scheduled through the runtime's timer seam; the plan pins which after re-confirming the timer API. Only-while-subscribers-exist still holds: no subscribed global tables → re-arm nothing → DO hibernates fully.

3. **The poller does NOT touch the local MVCC oracle.** `.global()` reads never consult `ctx.txn`/`snapshotTs`/the local timestamp oracle, so the poller must NOT call `observeTimestamp` (that would corrupt the oracle every local snapshot read depends on). It calls only `runtime.handler.notifyWrites({ tables: [changedGlobalTable], ranges: [], commitTs })`, where `commitTs` is a plain monotone wall-clock/counter used solely by the resume-registry's own `advanceOnCommit` bookkeeping (compared only against the poller's own prior values, never the MVCC `ts` domain). `notifyExternalCommit`/driver-wake is optional and only if a composed driver needs to wake on a global write (verify `translateTableIds` passes a global name through unchanged first).

## Non-goals (explicit — deferred)
- **Cross-shard `fanOut` reads** — M2d.
- **CDC / push-based global invalidation** (replacing the poll) — a later upgrade (parent §3.2).
- **Per-`(table, key)` fine-grained version** (less over-invalidation) — deferred optimization.
- **Range / sorted / paginated global subscriptions** — deferred with M2b's equality-only read scope.
- **The `x-d1-bookmark` read-replica optimization** — deferred scaling slice.
- **Reactivity for global data on the non-Cloudflare (SQLite/Postgres) runtimes** — M2c's poller is a Cloudflare-DO concern (global tables are D1-only, a CF feature); the local runtimes have no `.global()` tables to make reactive.
