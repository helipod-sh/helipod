# Fleet B3 Implementation Plan — Hybrid Nodes + Effectively-Once Forwarding

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Multi-writer writer nodes serve queries/subscriptions from their local replica at F while committing to the primary (the read-offload cliff closes; B2b's promotion-tailer-stop and its handoff seed vanish), and forwarded writes become effectively-once via an idempotency key recorded atomically with the commit.

**Architecture:** Spec = `docs/superpowers/specs/2025-10-01-fleet-b3-hybrid-design.md` (post-review, 9f4215f — the review's findings are REQUIREMENTS: the paired `queryPath` seam (transactor + QueryRuntime selected together by fn.type), the separate query oracle fed only by the tailer's post-apply sink, per-store startTs, the `beforeNotify` drain seam, the unique_violation→replay conversion, setup rows carrying the MAX(ts) seed, the pause window bounded below probe exhaustion).

**Tech Stack:** TypeScript; PGlite units; Docker-gated fleet E2E.

## Global Constraints

- **Single-writer fleet, sync nodes, and non-fleet are byte-identical** (hybrid is multi-writer-only behavior; no new knob; existing tests NEVER modified — sanctioned mechanical updates only where signatures change, each documented; if a behavioral test fails, STOP: design problem).
- Exact values: idempotency value cap **64KB** (`oversized=true`, value NULL beyond); sweep TTL **1h** on the balancer beat; `fleet_idempotency(key TEXT PK, commit_ts BIGINT NOT NULL, value_json TEXT, oversized BOOLEAN NOT NULL DEFAULT false, created_at TIMESTAMPTZ NOT NULL DEFAULT now())` one-statement-per-element DDL; replica-lag warning threshold ~5s (mirror the shipped pinning-shard warning shape); offload-proof pause ≤ ~10s at default 15s TTL with a did-NOT-exit assertion.
- The honest contracts (docs verbatim): handler-body execution is **at-least-once under concurrent retry; the durable write and its fan-out are exactly-once**; a crash between commit and value-record → replay returns success + commitTs + `valueMissing`; keys expire after 1h (very-late retries may re-execute — retries are seconds-scale).
- ee/ enterprise headers; core held to core standards; Node/vitest no Bun APIs; `bun run build` before cross-package tests; full gate = build && typecheck && test; commit trailer `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.

**Verified ground truth (spec review — do not re-derive):** query snapshotTs = `oracle.getLastCommittedTimestamp()` (`shard-writer.ts:178`); a sync node's oracle advances ONLY via the tailer's post-apply sink (`drainOnce` applies → `onInvalidation` → `runtime.observeTimestamp(inv.newMaxTs)` at `node.ts:1007` → wm advances `replica-tailer.ts:490-493`) — that ordering is the snapshot≤wm invariant. `runtime.observeTimestamp` targets the single transactor (`runtime.ts:703-704`). Kernel scans go through `kctx.queryRuntime` (`kernel.ts:422` collect, `:448` paginate), set unconditionally at `executor.ts:311`; mutations' point reads (`ctx.txn.get`) follow the TRANSACTOR — so transactor+QueryRuntime must switch together. `create()` binds one store: transactor + startTs from `options.store` (`runtime.ts:192-209`), `new QueryRuntime(options.store)` at `:209`. Fan-out: `adapter.subscribe` → `queue.push` → serial `drain()` → `handler.notifyWrites` (`runtime.ts:416-418, 339-346`) — `beforeNotify` hooks in `drain()`. `commitWrite` has NO opts param (`postgres-docstore.ts:245-249`); guard is 3-arg, runs on the pooled shard connection INSIDE the commit txn (`:270-281`). Admin browse + paginate flow through `executor.run` with fn.type "query" — no query path bypasses the seam. `setup()` creates no rows (`lease.ts:157-167` explains why); `tryAcquire`'s INSERT-time seed = `documentsTableExists` probe + `(SELECT COALESCE(MAX(ts),0) FROM documents)` (`lease.ts:351`). LeaseMonitor: probe hangs under a paused primary → exit at 4 misses (~20s at default TTL 15s; ~8s at the 6s test TTL — the offload scenario must NOT reuse the 6s TTL). Slice-2's pause proof is at `fleet-e2e.test.ts:777-880` (sync node — no monitor). B2b's invalidateOnly listener + promotion seed (`2742456`) get superseded on hybrids.

**DAG:** T1 → T2 → T3 → T4 → T5 → T6 (serial: T2/T3/T4 all touch `node.ts`/`lease.ts`; T1 is core-only).

---

### Task 1: Core seams — queryPath, commitMeta, beforeNotify

**Files:**
- Modify: `packages/executor/src/executor.ts` (ExecutorDeps.queryPath; RunOptions.commitMeta; kctx.queryRuntime selection), `packages/runtime-embedded/src/runtime.ts` (EmbeddedRuntimeOptions.queryStore? + beforeNotify?; construction; observeTimestamp routing), `packages/transactor/src/types.ts` + `single-writer-transactor.ts` + `sharded-transactor.ts` + `shard-writer.ts` (RunInTransactionOptions.commitMeta → commitWrite opts), `packages/docstore/src/types.ts` + `packages/docstore-sqlite/src/sqlite-docstore.ts` + `packages/docstore-postgres/src/postgres-docstore.ts` (commitWrite opts + 4-arg guard)
- Test: extend executor + transactor + docstore tests

**Interfaces (produced):**
```ts
// executor:
// ExecutorDeps gains queryPath?: { transactor: Transactor; queryRuntime: QueryRuntime }
//   — run() for fn.type === "query" uses queryPath.transactor for runInTransaction AND
//   queryPath.queryRuntime for kctx.queryRuntime (BOTH or NEITHER — one seam, selected
//   together; mutations/actions always use deps.transactor + deps.queryRuntime).
// RunOptions gains commitMeta?: Record<string, string> (mutations only; threaded through).
// transactor: RunInTransactionOptions.commitMeta?: Record<string,string>;
//   ShardWriter.commit passes it: docStore.commitWrite(entries, indexWrites, shardId, { meta }).
// docstore: commitWrite(documents, indexUpdates, shardId?, opts?: { meta?: Record<string,string> })
//   — SQLite ignores opts; Postgres passes meta to the guard.
// postgres-docstore: setCommitGuard signature (q, commitTs, shardId, meta?) — additive 4th param.
// runtime-embedded: EmbeddedRuntimeOptions gains
//   queryStore?: DocStore   // when set: query transactor seeded from queryStore.maxTimestamp(),
//                           // QueryRuntime over queryStore; observeTimestamp routes tailer
//                           // observations to the QUERY oracle (write oracle untouched by it);
//   beforeNotify?: (commitTs: bigint) => Promise<void>  // awaited in drain() before notifyWrites.
// runtime.observeTimestamp(ts): with queryStore set → advances the QUERY path's oracle
//   (its purpose: tailer post-apply); without → shipped behavior (write transactor fan-out).
```

- [ ] **Step 1 (failing tests):** (a) queryPath: a query runs on the query transactor + query QueryRuntime (stub stores, assert store identity per call); a mutation in the SAME executor uses the primary pair (the split-brain regression: mutation scan store === mutation point-read store === primary); no queryPath → byte-identical. (b) commitMeta: RunOptions → guard receives meta (PGlite, 4-arg guard); SQLite commitWrite accepts + ignores opts; no meta → guard gets undefined; existing 3-arg guard installers updated mechanically (each documented). (c) beforeNotify: drain awaits it BEFORE notifyWrites (ordering spy); rejection is contained (logged, drain continues — one bad wait must not wedge the queue); unset → zero change. (d) observeTimestamp routing: with queryStore, observe advances the query oracle (a query's snapshot rises) and NOT via own local commits (a local commit advances only the write oracle — assert query snapshot unchanged until observe fires).
- [ ] **Steps 2–5:** fail → implement → executor + transactor + docstore-sqlite + docstore-postgres + runtime-embedded + @stackbase/test + fleet suites ALL green (byte-identity) → full gate → commit `feat(core): queryPath split-read seam, commitMeta channel, beforeNotify drain hook`.

---

### Task 2: Fleet hybrid mode (node.ts rework)

**Files:**
- Modify: `ee/packages/fleet/src/node.ts` (multi-writer writer-ish boot: replica+tailer FIRST (sync machinery), then the writer half; promotion ADDS the writer half without stopping the tailer — the B2b stop + handoff-seed path removed for hybrids; runtime constructed with queryStore=switchable replica + beforeNotify=tailer.waitFor; the invalidateOnly listener NOT started on hybrids; single-writer topology unchanged — no replica on its writer, sync nodes as shipped), `ee/packages/fleet/src/replica-tailer.ts` (whatever the keep-alive-through-promotion needs), `ee/packages/fleet/src/forwarder.ts` (attachTailer on hybrids — forwarded RYOW as on sync nodes)
- Test: `ee/packages/fleet/test/hybrid.test.ts`

**Interfaces (consumed):** T1's queryStore/beforeNotify/observeTimestamp routing.

- [ ] **Step 1 (failing tests, PGlite + sqlite replica):** hybrid boot: queries served from the replica (write a row DIRECTLY to primary; a query on the hybrid does NOT see it until the tailer applies; then does — the snapshot≤wm proof); mutations commit to the primary (immediately visible to a primary read); own-commit RYOW: a local commit's subscription re-run gated until wm ≥ commitTs (beforeNotify wired — assert the re-run's result CONTAINS the write, never a stale intermediate); forwarded RYOW via attachTailer; promotion keeps the tailer running (wm advances across a promotion; no invalidation gap — the B2b-F1 scenario re-run against hybrid: commits landing during promotion ARE invalidated); the listener not started (spy); single-writer boot byte-identical (no replica machinery — existing scenarios prove).
- [ ] **Steps 2–5:** fail → implement → fleet suite + the Docker E2E scenarios UNMODIFIED green (run them) → full gate → commit `feat(fleet): hybrid nodes — replica reads on multi-writer writers`.

---

### Task 3: Effectively-once forwarding

**Files:**
- Modify: `ee/packages/fleet/src/lease.ts` (fleet_idempotency DDL + sweep query), `ee/packages/fleet/src/node.ts` (the guard writes the row when meta.idempotencyKey present; unique_violation inside the guard → the commit aborts (existing atomicity) — no guard-side handling needed beyond letting it throw), `packages/cli/src/http-handler.ts` (/_fleet/run: SELECT-first replay; run with commitMeta; post-run best-effort value UPDATE (64KB cap, oversized flag); CATCH unique_violation-shaped failures from the run → re-SELECT → replay — NOT a 500), `ee/packages/fleet/src/forwarder.ts` (mint ONE UUID per logical write before the first attempt, reused across retry + reroute), `ee/packages/fleet/src/balancer.ts` (sweep on the beat: DELETE WHERE created_at < now() - interval '1 hour')
- Test: extend fleet tests + cli fleet-run tests

**Interfaces (consumed):** T1's commitMeta chain. **(produced):** the replay response shape `{ replayed: true, commitTs, value?|valueMissing: true }` (additive) T5 asserts.

- [ ] **Step 1 (failing tests, PGlite):** guard INSERT atomic with commit (a guard-thrown error aborts BOTH — row absent AND writes absent); duplicate SELECT-hit replays without executing (spy: handler body not called); **the concurrent race:** simulate the loser (insert the key committed, then run with the same key → the guard's INSERT violates → the commit aborts → the handler catches → re-SELECT → replay with the winner's commitTs — assert the app table has ONE row and the response is the replay, not an error); value recorded post-run; oversized → flag + NULL; crash-window shape (row with NULL value + not oversized → replay says valueMissing); sweep deletes only >1h rows; forwarder reuses the SAME key across its retry-once (spy on both POSTs' bodies); non-forwarded writes carry no meta (assert guard meta undefined on a local commit).
- [ ] **Steps 2–5:** fail → implement → fleet + cli suites → full gate → commit `feat(fleet): effectively-once forwarding — idempotency key atomic with the commit`.

---

### Task 4: Polish — driver chain, seeded setup rows, replica-lag warning

**Files:**
- Modify: `ee/packages/fleet/src/node.ts` (serialize startDrivers/stopDriversOnly through a promise chain — last call wins; replica-lag warning: tailer wm > ~5s behind F → one operator warning naming the node's replica, same shape as the pinning-shard warning), `ee/packages/fleet/src/lease.ts` (setup() creates all N shard_leases rows WITH the documentsTableExists + MAX(ts) seed — the same SQL tryAcquire uses (extract shared helper); update the :157-167 comment to the new reasoning)
- Test: extend fleet tests

- [ ] **Step 1 (failing tests):** driver chain (an interleaved start/stop/start storm resolves to started; stop-after-start ordering guaranteed — deterministic with awaited chain); setup rows: fresh DB → N rows frontier 0; PRE-LOADED store → N rows born ≥ MAX(ts) (**the F1×N regression re-check at setup-time creation**); count-gate satisfied immediately after setup (no acquire needed); tryAcquire ON CONFLICT still preserves live frontiers; replica-lag warning fires once past threshold, names the replica, silent below.
- [ ] **Steps 2–5:** fail → implement → fleet suite → full gate → commit `fix(fleet): driver-chain serialization, seeded setup rows, replica-lag warning`.

---

### Task 5: E2E ship gate

**Files:** `ee/packages/fleet/test/fleet-e2e.test.ts` (new scenarios; existing byte-unmodified)

- [ ] **Step 1:** Docker-gated (all hygiene): (1) **writer-replica offload:** multi-writer fleet at DEFAULT 15s TTL (NOT the 6s the other multi-writer scenario uses — the writer self-exits ~8s under pause at 6s): subscription served by a writer node keeps receiving (from its replica) while `docker pause` freezes the primary ≤ ~10s — during the pause a write FAILS visibly, reads keep flowing, **assert the node did NOT exit**; unpause → writes resume, subscription converges; (2) RYOW-on-hybrid: local + forwarded commits immediately readable via the committing node's own subscription; (3) **effectively-once:** raw /_fleet/run POST with the same idempotencyKey twice → ONE app row, second response replays the same commitTs; (4) concurrent multi-writer boot (two writers + sync started simultaneously) → converges, count-gate never wedges, both writers hold disjoint non-empty sets; (5) existing scenarios (incl. B2b's multi-writer) green UNMODIFIED.
- [ ] **Step 2:** `bun run build`; green ×2 consecutive; FULL monorepo gate (known flakes → isolated re-runs, report). Commit `test(fleet): B3 E2E — writer-replica offload, hybrid RYOW, effectively-once, concurrent boot`.

---

### Task 6: Docs + finish

**Files:** `docs/enduser/deploy/fleet.md` (REPLACE the multi-writer ops-cliff paragraph: writer nodes now serve reads from their replica; disk note; effectively-once + the valueMissing/1h contracts verbatim from Global Constraints), `docs/dev/architecture/write-sharding-research.md` (B3 shipped; fast path assessed-not-built with the one-UPDATE reasoning; B4 group commit next).
- [ ] Docs → full gate → commit `docs(fleet): hybrid reads + effectively-once guide, B3 status`.

## Execution notes

- Serial DAG (T2/T3/T4 share node.ts/lease.ts). Models: T1 sonnet (mechanical, fully-specified seams; opus review), T2 opus (the correctness core), T3 sonnet (precisely-specified race handling; opus review), T4 sonnet, T5 opus, T6 sonnet. The soul constraint: existing tests never modified; hybrid must vanish entirely outside multi-writer mode.
