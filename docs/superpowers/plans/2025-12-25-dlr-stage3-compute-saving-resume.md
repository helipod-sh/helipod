# DLR Stage 3 — Compute-Saving Reconnect Resume Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** On reconnect, skip re-running a RERUN-classified subscription whose read-set nothing touched during the disconnect gap — answering `QueryUnchanged` **without** re-executing the query handler, instead of today's re-run-then-hash.

**Architecture:** The client echoes a scalar `sinceTs` (its `maxObservedTs`) per query on a resume `ModifyQuerySet`. The server maintains an in-memory **resume registry** keyed by `(identity, path, argsHash)` — `{ readRanges, tables, lastInvalidatedTs, wasDiffable, refCount }` — populated when a query executes and advanced by the existing commit fan-out (an extra `findAffectedByRanges` over the registry's own `IntervalIndex`, so a query's `lastInvalidatedTs` advances even with no live subscriber). On resubscribe, if the query is RERUN and `entry.lastInvalidatedTs <= sinceTs`, the server emits `QueryUnchanged` and re-registers the live sub from the retained ranges — **no `execSub`**. Everything else falls through to today's path.

**Tech Stack:** TypeScript, vitest, Bun. Packages: `@stackbase/sync` (protocol, the registry, the handler skip), `@stackbase/client` (echo `sinceTs`), `@stackbase/bench` (the A/B gate).

## Global Constraints

- **Correctness rests on the reactivity invariant.** A query's result changes ONLY if a committed write intersects its read-set. So `lastInvalidatedTs <= sinceTs` ⇒ provably unchanged ⇒ skip is sound. Any doubt → fall through to the re-run path.
- **Retained ranges STAY indexed for the TTL** (spec §4.2, load-bearing). A registry entry's ranges remain in its `IntervalIndex` from first subscribe until TTL eviction, decoupled from any session — else a gap-write would not advance `lastInvalidatedTs` and the skip would be wrong (stale data). A write-during-gap test pins this.
- **v1 = RERUN subs, single-node, skip-only.** Diffable subs (2a/2b/2c) keep their existing re-run resume path (their `byIdRowMap` needs re-materializing — out of scope). A cross-node fleet reconnect falls back to re-run (no `readLogSince` yet). Replaying a touched sub's log-tail as a diff is deferred.
- **Fully back-compatible.** No `sinceTs` (old client), no registry entry (cold/TTL-expired), a diffable sub, or any uncertainty → today's re-run path, byte-for-byte. `QueryUnchanged` is an existing wire message — the client already handles it identically.
- **No `Math.random`** in production code.

---

### Task 1: `sinceTs` on the resume `QueryRequest` + client echoes it

**Files:**
- Modify: `packages/sync/src/protocol.ts` (`QueryRequest` gains `sinceTs?: number`)
- Modify: `packages/client/src/client.ts` (`resync()` echoes `sinceTs` = `maxObservedTs`)
- Test: `packages/client/test/resume-client.test.ts` (extend) OR `packages/client/test/reconnect.test.ts`

**Interfaces:**
- Produces: `QueryRequest.sinceTs?: number` (the client's `maxObservedTs` at resubscribe — the resume watermark). Present only on a resume (`resync`), absent on a fresh subscribe.

- [ ] **Step 1: Write the failing test**

In `packages/client/test/reconnect.test.ts` (or resume-client), assert that after a disconnect+reconnect, the resubscribe `ModifyQuerySet.add[*]` entries carry `sinceTs` equal to the client's max observed ts (exposed via `client.__maxObservedTs`, `client.ts:730`). A FRESH first subscribe must NOT carry `sinceTs`.

```ts
it("a resume resubscribe echoes sinceTs = maxObservedTs; a fresh subscribe does not", () => {
  const t = new MockTransport();
  const client = new StackbaseClient(t);
  client.subscribe("notes:list", { box: "a" }, () => {});
  const firstAdd = (t.sent.find((m) => m.type === "ModifyQuerySet") as any).add[0];
  expect(firstAdd.sinceTs).toBeUndefined();            // fresh subscribe: no sinceTs
  // ...emit a Transition advancing observedTs to e.g. 7...
  t.emit({ type: "Transition", startVersion: { querySet: 1, ts: 0 }, endVersion: { querySet: 1, ts: 7 }, modifications: [{ type: "QueryUpdated", queryId: 1, value: [] }] });
  const before = t.sent.length;
  t.emitReopen();
  const resumeAdd = (t.sent.slice(before).find((m) => m.type === "ModifyQuerySet") as any).add[0];
  expect(resumeAdd.sinceTs).toBe(7);                   // resume: sinceTs = maxObservedTs
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun run --filter @stackbase/client test reconnect`
Expected: FAIL — `sinceTs` undefined on the resume add.

- [ ] **Step 3: Implement**

In `packages/sync/src/protocol.ts`, add `sinceTs?: number` to the `QueryRequest` interface (~line 45-48, next to `resultHash?`), with a doc comment: "DLR Stage 3 — the client's `maxObservedTs` at resume time; lets the server skip the re-run when nothing touched the query's read-set since." In `packages/client/src/client.ts#resync` (~line 825-853), on each resumed `add` entry, set `sinceTs: this.reconciler.maxObservedTs` alongside the existing `resultHash` echo. The FRESH subscribe path (`subscribe()`, ~line 473) does NOT set `sinceTs`.

- [ ] **Step 4: Run to green**

Run: `bun run --filter @stackbase/client test reconnect resume-client` → PASS. `bun run --filter @stackbase/client test` → PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/sync/src/protocol.ts packages/client/src/client.ts packages/client/test/reconnect.test.ts
git commit -m "feat(sync,client): resume QueryRequest carries sinceTs = maxObservedTs (DLR 3)"
```

---

### Task 2: The `ResumeRegistry` (read-set + lastInvalidatedTs, TTL-retained)

**Files:**
- Create: `packages/sync/src/resume-registry.ts`
- Modify: `packages/sync/src/index.ts` (export it if needed for tests)
- Test: `packages/sync/test/resume-registry.test.ts`

**Interfaces:**
- Produces:
  - `regKey(identity: string | null, path: string, argsJson: JSONValue): string` — the dedup key.
  - `class ResumeRegistry` with:
    - `upsert(key: string, readRanges: readonly SerializedKeyRange[], tables: readonly string[], atTs: number, wasDiffable: boolean): void` — (re)record a query's read-set + classification; sets `lastInvalidatedTs = max(existing, atTs)` (a fresh exec at `atTs` means "known-current as of atTs"); indexes the ranges; `refCount++` semantics handled by `retain`/`release`.
    - `advanceOnCommit(writtenRanges: readonly SerializedKeyRange[], writtenTables: readonly string[], commitTs: number): void` — for each registry entry whose ranges/tables intersect (via the internal `IntervalIndex` + table match, mirroring `SubscriptionManager.findAffectedByRanges`), set `entry.lastInvalidatedTs = max(., commitTs)`.
    - `lookup(key: string): { readRanges, tables, lastInvalidatedTs, wasDiffable } | undefined`.
    - `retain(key)` / `release(key, nowMs)` — refcount; `release` to 0 stamps an `expiresAtMs = nowMs + TTL_MS`.
    - `sweep(nowMs)` — evict entries with `refCount === 0 && expiresAtMs <= nowMs` (removes ranges from the index).
  - `TTL_MS = 60_000` (exported const).

- [ ] **Step 1: Write the failing tests**

`packages/sync/test/resume-registry.test.ts`:
```ts
import { ResumeRegistry, regKey } from "../src/resume-registry";
// helper to build a SerializedKeyRange point/range in an index keyspace...
describe("ResumeRegistry", () => {
  it("upsert then a NON-intersecting commit leaves lastInvalidatedTs; an intersecting commit advances it", () => {
    const r = new ResumeRegistry();
    const k = regKey("u1", "notes:list", { box: "a" });
    r.upsert(k, [rangeFor("box","a")], ["notes"], 3, false);
    r.advanceOnCommit([rangeFor("box","b")], ["notes"], 5);   // different box → no intersect
    expect(r.lookup(k)!.lastInvalidatedTs).toBe(3);
    r.advanceOnCommit([rangeFor("box","a")], ["notes"], 7);   // same box → intersect
    expect(r.lookup(k)!.lastInvalidatedTs).toBe(7);
  });
  it("retain/release + TTL sweep evicts a query with no live subs after TTL, not before", () => {
    const r = new ResumeRegistry();
    const k = regKey("u1", "notes:list", { box: "a" });
    r.upsert(k, [rangeFor("box","a")], ["notes"], 1, false); r.retain(k);
    r.release(k, 1000); r.sweep(1000 + 59_000); expect(r.lookup(k)).toBeDefined();   // within TTL
    r.sweep(1000 + 61_000); expect(r.lookup(k)).toBeUndefined();                     // past TTL
  });
  it("a retained (released) entry still advances on an intersecting commit (gap invalidation)", () => {
    const r = new ResumeRegistry();
    const k = regKey("u1","notes:list",{box:"a"});
    r.upsert(k, [rangeFor("box","a")], ["notes"], 1, false); r.retain(k); r.release(k, 1000);
    r.advanceOnCommit([rangeFor("box","a")], ["notes"], 9);  // commit during the "gap"
    expect(r.lookup(k)!.lastInvalidatedTs).toBe(9);          // advanced even with 0 live subs
  });
  it("wasDiffable is recorded", () => { /* upsert with true, lookup reflects it */ });
});
```

- [ ] **Step 2: Run to verify failure** — `bun run --filter @stackbase/sync test resume-registry` → FAIL (no module).

- [ ] **Step 3: Implement `ResumeRegistry`**

`packages/sync/src/resume-registry.ts` — model the range indexing/matching on `packages/sync/src/subscription-manager.ts` (`byRange = new IntervalIndex<string>()`, `deserializeKeyRange`, the table-match). `regKey` = `` `${identity ?? ""} ${path} ${JSON.stringify(argsJson)}` ``. `advanceOnCommit` = the same match logic as `SubscriptionManager.findAffectedByRanges` but over the registry's own index, keyed by `regKey`, advancing `lastInvalidatedTs`. Entries: `Map<string, { readRanges; tables; lastInvalidatedTs; wasDiffable; refCount; expiresAtMs? }>` + `IntervalIndex<string>` + a `byTable: Map<table, Set<key>>` (mirroring the subscription manager's table matching for range-less/table-level reads). `sweep` removes both from the entry map and the indexes.

- [ ] **Step 4: Run to green** — `bun run --filter @stackbase/sync test resume-registry` → PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/sync/src/resume-registry.ts packages/sync/src/index.ts packages/sync/test/resume-registry.test.ts
git commit -m "feat(sync): ResumeRegistry — per-query read-set + lastInvalidatedTs, TTL-retained (DLR 3)"
```

---

### Task 3: Populate + advance the registry from the handler

**Files:**
- Modify: `packages/sync/src/handler.ts` (own a `ResumeRegistry`; upsert on `execSub`; `advanceOnCommit` in `doNotifyWrites`; retain/release on subscribe/unsubscribe/disconnect; a periodic sweep)
- Test: `packages/sync/test/resume-registry-handler.test.ts` (create) OR extend an existing handler test

**Interfaces:**
- Consumes: `ResumeRegistry` (Task 2), the existing `doModifyQuerySet`/`doNotifyWrites`/`disconnect` in the handler.
- Produces: after any `execSub` in `doModifyQuerySet`, the registry has an up-to-date entry for `(identity, path, args)` with the run's `readRanges`/`tables`/`wasDiffable` and `lastInvalidatedTs` = the session's current version ts; after any commit, affected entries' `lastInvalidatedTs` is advanced.

- [ ] **Step 1: Write the failing handler test**

A test driving the real `SyncProtocolHandler` with a fake executor: subscribe (populates the registry — assert `lookup(regKey).lastInvalidatedTs`), then a `notifyWrites` intersecting the query's ranges (assert `lastInvalidatedTs` advanced to the commit ts), then a non-intersecting `notifyWrites` (assert unchanged). Also: disconnect the session (assert the entry persists, `refCount === 0` with an `expiresAtMs`), and a subsequent intersecting `notifyWrites` still advances it (the gap-invalidation guard).

- [ ] **Step 2: Run to verify failure** — FAIL (no registry wiring).

- [ ] **Step 3: Implement the wiring**

In `handler.ts`: add `private readonly resumeRegistry = new ResumeRegistry();`. In `doModifyQuerySet`, after each `execSub`, compute `wasDiffable = !!(diffableRange || diffablePage || byId)` and `resumeRegistry.upsert(regKey(session.identity, q.udfPath, q.args), readRanges, tables, Number(session.version.ts), wasDiffable)` + `retain(key)`. In `doNotifyWrites`, after computing the invalidation's `writtenRanges`/`writtenTables`/`commitTs`, call `resumeRegistry.advanceOnCommit(invalidation.ranges ?? [], invalidation.tables, Number(invalidation.commitTs))` — ONCE per commit, independent of `bySession` (so it advances entries with no live session too). On unsubscribe (the `remove` path) and on `disconnect`, `release(key, Date.now())` for the affected queries. Add a periodic `sweep` (e.g. a timer, or piggyback on `doNotifyWrites`, calling `resumeRegistry.sweep(Date.now())` opportunistically). Guard: `Date.now()` is a wall-clock read — acceptable HERE (this is the sync tier, not a deterministic UDF; the existing gate-timer already uses `Date.now()` in the sync layer).

- [ ] **Step 4: Run to green + full package** — `bun run --filter @stackbase/sync test` → PASS (nothing else regressed; the registry is populated but not yet consulted for skipping).

- [ ] **Step 5: Commit**

```bash
git add packages/sync/src/handler.ts packages/sync/test/resume-registry-handler.test.ts
git commit -m "feat(sync): populate + advance the ResumeRegistry from subscribe/commit/disconnect (DLR 3)"
```

---

### Task 4: The reconnect compute-skip (handler)

**Files:**
- Modify: `packages/sync/src/handler.ts` (`doModifyQuerySet`: the skip branch, before `execSub`)
- Test: `packages/sync/test/resume-registry-handler.test.ts` (extend) — the skip + the gap-write must-re-run guard

**Interfaces:**
- Consumes: `ResumeRegistry.lookup`, the resume `sinceTs` (Task 1) on the `QueryRequest`.
- Produces: for a resubscribe carrying `sinceTs`, a RERUN query whose `entry.lastInvalidatedTs <= sinceTs` → a `QueryUnchanged` modification WITHOUT calling `execSub`; the sub is registered in the `SubscriptionManager` from the retained `readRanges`/`tables`.

- [ ] **Step 1: Write the failing tests**

Extend the handler test. Scenario A (the skip): subscribe (registry populated, `lastInvalidatedTs = 3`); disconnect; reconnect and resubscribe with `sinceTs = 3` (nothing happened during the gap) → assert the pushed modification is `QueryUnchanged`, assert `execSub` was NOT called (spy/count the fake executor's `runQuery` calls — it must not increment), and assert the new sub IS registered (a subsequent intersecting write produces a Transition for it). Scenario B (the gap-write guard, CRITICAL): subscribe; disconnect; a `notifyWrites` intersecting the query's ranges at ts=9 (a gap write); reconnect+resubscribe with `sinceTs = 3` → assert `execSub` WAS called (re-run, not skipped) because `lastInvalidatedTs (9) > sinceTs (3)`. Scenario C (diffable excluded): a diffable sub resubscribes with a matching `sinceTs` → assert it takes the existing re-run path (execSub called), NOT the skip.

- [ ] **Step 2: Run to verify failure** — FAIL (no skip branch).

- [ ] **Step 3: Implement the skip branch**

In `doModifyQuerySet`, for each `add` entry, BEFORE `execSub`:
```ts
if (q.sinceTs !== undefined) {
  const entry = this.resumeRegistry.lookup(regKey(session.identity, q.udfPath, q.args));
  if (entry && !entry.wasDiffable && entry.lastInvalidatedTs <= q.sinceTs) {
    // Provably unchanged since the client last saw it (reactivity invariant). Skip the re-run.
    this.subscriptions.add({ sessionId: session.sessionId, queryId: q.queryId, udfPath: q.udfPath, args: q.args, tables: entry.tables, readRanges: entry.readRanges, byId: undefined });
    this.resumeRegistry.retain(regKey(session.identity, q.udfPath, q.args));
    modifications.push({ type: "QueryUnchanged", queryId: q.queryId });
    continue; // NO execSub
  }
}
// ...existing execSub + classification + QueryUpdated/QueryUnchanged-by-hash/QueryDiff path...
```
The re-run path (after) must, as today, `resumeRegistry.upsert(...)` with the fresh read-set (Task 3). Note: the skipped sub registers with the RETAINED ranges (correct — the result is unchanged, so the read-set is unchanged too).

- [ ] **Step 4: Run to green + full package + typecheck**

Run: `bun run --filter @stackbase/sync test` → PASS (incl. the skip + gap-guard + diffable-excluded). `bun run typecheck --filter @stackbase/sync --filter @stackbase/client` → clean.

- [ ] **Step 5: Commit**

```bash
git add packages/sync/src/handler.ts packages/sync/test/resume-registry-handler.test.ts
git commit -m "feat(sync): skip the reconnect re-run when the read-set is untouched since sinceTs (DLR 3)"
```

---

### Task 5: E2E — a real reconnect skips the re-run

**Files:**
- Test: `packages/cli/test/resume-compute-e2e.test.ts` (create)

**Interfaces:**
- Consumes: the whole pipeline through a real `stackbase dev` server + a real `@stackbase/client` over a real WebSocket. Model on `packages/cli/test/resume-e2e.test.ts` (the existing resume E2E) + the reconnect/tcpProxy idiom from `optimistic-e2e.test.ts` (to kill+reopen the socket).

- [ ] **Step 1: Write the E2E**

`packages/cli/test/resume-compute-e2e.test.ts` — a schema `notes:{box,text}` index `by_box`, a RERUN query `count = ...` (a query that is NOT diffable — e.g. returns an aggregate/scalar, or a `.collect()` that is post-processed so it's RERUN; pick a shape that classifies RERUN so the skip applies) and a mutation `add`. Instrument the server to COUNT query re-executions (e.g. a counter incremented in the query handler, readable via a separate query or an admin hook — or wrap the runtime's `runQuery`). Assertions:
1. Subscribe to the RERUN query; get the initial result. Record the handler-execution count.
2. Kill the socket (tcpProxy) WITHOUT any intervening write; reconnect. Assert: the client receives `QueryUnchanged` for the query AND the server's handler-execution count did NOT increase (the re-run was skipped).
3. Now: disconnect, perform an intersecting `add` during the gap, reconnect → assert the handler-execution count DID increase (re-run) and the client gets the fresh value.
4. (Optional) A diffable query in the same app still re-runs on reconnect (v1 boundary) — assert its handler count increases even on an unchanged reconnect.

> Instrumenting the re-execution count: simplest is a module-level counter the query handler bumps, exposed via a second query (`execCount`) — read it before/after. Confirm the count reflects ONLY the RERUN query's handler, not the counter-reader.

- [ ] **Step 2: Build + run**

Run: `bun run build && bunx vitest run --dir packages/cli/test resume-compute-e2e` → PASS.

- [ ] **Step 3: Commit**

```bash
git add packages/cli/test/resume-compute-e2e.test.ts
git commit -m "test(cli): reconnect skips the re-run on an unchanged read-set; re-runs on a gap write (DLR 3 E2E)"
```

---

### Task 6: Benchmark gate — the A/B `resume-compute` scenario

**Files:**
- Modify: `benchmarks/runner/src/cores/` (+ `scenarios/reactive.ts`) — a `resume-compute` scenario measuring server query re-executions across a reconnect
- Measurement note (commit)

**Interfaces:**
- Consumes: the bench harness + a real client reconnect. Reports **query re-executions on reconnect** (the compute metric) for Stage-3-skip ON vs a forced-re-run baseline.

- [ ] **Step 1: Add the scenario**

A `resume-compute` scenario: N (~50) RERUN subscriptions over distinct keys; a measurement that (a) subscribes all N, (b) reconnects with NO intervening writes, (c) counts server query re-executions during the reconnect. Instrument the server-side handler-exec count (a counter the bench query bumps, or wrap the runtime `runQuery`). Run it A/B: **skip ON** (default) vs **skip OFF** (force the re-run — e.g. an env flag `BENCH_RESUME_NOSKIP=1` that makes the handler ignore the registry / the client omit `sinceTs`). Also a **partial-change** variant: 1 of N queries touched during the gap → expect exactly 1 re-execution.

- [ ] **Step 2: Run the gate**

Run: `bun run bench:reactive` (or a dedicated `bench:resume` if the scenario needs a different runner). Confirm: **skip ON = ≈0 re-executions on an unchanged reconnect** (vs N with skip OFF); partial-change = exactly 1. Report the re-executions-saved and, if measurable, the reconnect-storm CPU/wall-time delta.

- [ ] **Step 3: Full-suite gate + measurement note**

Run: `bun run build && bun run typecheck && bun run test` → all green. Record the A/B re-execution numbers in the commit body.

```bash
git add benchmarks/runner/src/
git commit -m "feat(bench): resume-compute A/B — DLR 3 gate (reconnect re-executions N -> ~0 when unchanged)"
```

---

## Self-Review

**Spec coverage:**
- §4.1 resume token (`sinceTs` = maxObservedTs) → Task 1. ✅
- §4.2 the registry (read-set + lastInvalidatedTs, retained ranges stay indexed, TTL) → Tasks 2 (structure) + 3 (populate/advance/retain from the handler). ✅
- §4.3 the reconnect skip (RERUN-only, no execSub, re-arm from retained ranges) → Task 4. ✅
- §4.4 fallback/back-compat (no sinceTs / no entry / diffable → re-run) → Task 4 (the skip is gated; everything else falls through). ✅
- §3 correctness (the gap-write must re-run) → Tasks 2/3/4 tests (the gap-invalidation guard) + Task 5 E2E scenario 3. ✅
- §6 gate (A/B ≈0 re-executions) → Task 6. ✅
- §5 out-of-scope: diffable-skip (Task 4 excludes via `wasDiffable`), readLogSince/fleet (not built — single-node registry only), catch-up-as-diff (not built). ✅
- §7 risks: keying determinism (regKey by identity+path+args), memory (TTL + refcount + eviction — Task 2), lastInvalidatedTs advance for retained entries (Task 3, the CRITICAL constraint — pinned by the gap-write tests in Tasks 2/3/4/5). ✅

**Placeholder scan:** The Task 5/6 "instrument the server re-execution count" is a concrete instruction with a stated simplest approach (a module-level counter the handler bumps, exposed via a second query), not hand-waving. The RERUN-query-shape choice in Task 5 is a real decision (pick a shape that classifies RERUN, not diffable) with the reasoning stated.

**Type consistency:** `sinceTs?: number` (protocol) ← `maxObservedTs: number` (client). `regKey(identity, path, argsJson) → string` used identically in Tasks 2/3/4. `ResumeRegistry` methods (`upsert`/`advanceOnCommit`/`lookup`/`retain`/`release`/`sweep`) consistent across Tasks 2→4. `wasDiffable: boolean` recorded in Task 3, read in Task 4's gate. `lastInvalidatedTs`/`sinceTs` both `number` (the ts as a JS number, matching the existing `session.version.ts` numeric handling on the wire).
