# Fleet B4 Implementation Plan — Per-Shard Group Commit

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Under concurrent load, a shard's ready mutations flush as ONE store transaction (N consecutive ts's, one batch-shaped guard invocation, one fsync) via a stage-then-flush committer loop — idle latency identical (batch of 1), throughput ≥2× on real Postgres or the slice honestly concludes assessed-not-worth-it with the flag dark-off.

**Architecture:** Spec = `docs/superpowers/specs/2025-10-16-fleet-b4-group-commit-design.md` (post-review, 2567818 — the review's findings are REQUIREMENTS: the two-buffer write-visibility rule (pending → flushing → ring, never dropped; validate AND batch-cut consult all three), the batch-shaped guard contract (per-unit ts+meta idempotency INSERTs; fence once; frontier once at ts_N), retry-awaits-the-conflicting-unit's-promotion, STACKBASE_GROUP_COMMIT as the dark-off mechanism, the snapshot-retention pruning note, SQLite batching honestly inert).

**Tech Stack:** TypeScript; PGlite + real-container Postgres benchmarks; Docker-gated fleet E2E.

## Global Constraints

- **Flag-gated:** `STACKBASE_GROUP_COMMIT` — unset/off = the single-commit path byte-identical (existing suites prove; existing tests NEVER modified). The default flips to ON only in T5, only if the gate's real-PG concurrent-load win is ≥2×; on a miss it ships default-off with the numbers recorded.
- Exact values: benchmark mixes = insert-heavy (100% insert) and RMW 80/20 (80 insert / 20 read-modify-write same-doc-pool), at 1/8/64 concurrent clients, on 1 shard and 8 shards, PGlite AND real PG; the abort criterion reads the 64-client 8-shard real-PG insert-heavy row.
- The ordering invariant verbatim: publish/fan-out strictly in unit order within a batch; no unit of batch K publishes before K-1 fully published (single committer loop).
- The failure contract verbatim: flush error → EVERY unit rejects retryably, batch discarded, ring/oracle untouched; FencedError → every unit rejects with it, one relinquish (dispatcher already idempotent); a poisoned unit must not wedge the shard (loop re-enters on next stage).
- ee/ enterprise headers; core standards elsewhere; Node/vitest; full gate = build && typecheck && test; commit trailer `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.

**Verified ground truth (spec review — do not re-derive):** execution is off-mutex (`shard-writer.ts:187` runs `fn(ctx)`, `:194` takes the mutex only for `commit()`); the mutex-held section = validate (`:200-206` vs recentCommits) → `prev = await docStore.get(w.id)` per staged doc (`:229`, "race-free under the lock" comment) → `commitWrite` (`:238`) → ring push + `publishCommitted` (`:243-246`) → oplog + `fanout.publish` (`:250-259`). The B3 idempotency INSERT lives INSIDE the fleet guard (`node.ts:909-914`), invoked once per commitWrite txn (`postgres-docstore.ts:279`) — hence the batch-shaped guard. The tailer applies `(wm, F]` atomically per PG MVCC commit; density asserts per-doc prev_ts chains (`replica-tailer.ts:104-121`). SQLite commitWrite is synchronous (`sqlite-docstore.ts:165` `db.transaction`). Retain/release (`shard-writer.ts` retain/prune) pins pruning via minActiveSnapshot — in-flight units stay retained until resolve (bounded, noted).

**DAG:** {T1 ∥ T2} → T3 → T4 → T5 → T6. (T1 = benchmark, test-only, worktree-parallel with T2 = store contract. T3 = the committer loop. T4 = wiring/observability. T5 = E2E + the gate decision. T6 = docs.)

---

### Task 1 (parallel with T2): The commit-throughput benchmark

**Files:**
- Create: `ee/packages/fleet/test/bench-commit.test.ts` (PGlite variant always-on but marked slow; real-PG variant Docker-gated like fleet-e2e), `docs/dev/research/write-sharding/b4-benchmark.md` (the results table, updated at the gate)

**Interfaces (produced):** a `runCommitBench(opts: {store; numShards; clients; mix: "insert" | "rmw80"; seconds})` helper returning `{opsPerSec, p50Ms, p99Ms}` — T5 re-runs it verbatim post-batching.

- [ ] **Step 1:** Build the harness against the SHIPPED path: N concurrent client loops firing mutations through a real `EmbeddedRuntime` (insert-heavy = unique-doc inserts on a sharded table; rmw80 = 80% inserts + 20% RMW over a 64-doc pool routed per shard); measure committed ops/s over a fixed window (warmup 2s, measure 5s); assert only sanity (opsPerSec > 0, zero errors) — the numbers go to the report + b4-benchmark.md baseline table (1/8/64 clients × 1/8 shards × both mixes × PGlite/real-PG).
- [ ] **Step 2:** Record the baseline table in `b4-benchmark.md` (real numbers from a real run, labeled with the machine context). Full gate green (bench marked so it doesn't bloat CI time — follow the Docker-gate pattern). Commit `test(fleet): commit-throughput benchmark + B4 baseline`.

---

### Task 2 (parallel with T1): `commitWriteBatch` + the batch-shaped guard

**Files:**
- Modify: `packages/docstore/src/types.ts` (commitWriteBatch + the guard-contract type move), `packages/docstore-postgres/src/postgres-docstore.ts` (batch txn; `setCommitGuard` contract becomes batch-shaped; `commitWrite` delegates to a one-unit batch), `packages/docstore-sqlite/src/sqlite-docstore.ts` (one txn, consecutive MAX+1 per unit), `ee/packages/fleet/src/node.ts` (the guard implementation rewritten to the batch shape: epoch fence ONCE, frontier UPDATE ONCE at `GREATEST(frontier_ts, ts_N)`, per-unit `meta_i.idempotencyKey` INSERT at each `ts_i`), `ee/packages/fleet/src/switchable-store.ts` (delegate), conformance suite additions
- Test: conformance (both stores) + fleet guard tests

**Interfaces (produced):**
```ts
// docstore:
commitWriteBatch(units: Array<{ documents: DocumentLogEntry[]; indexUpdates: IndexWrite[];
  meta?: Record<string, string> }>, shardId?: ShardId): Promise<bigint[]>  // unit-order, strictly increasing
// postgres-docstore:
setCommitGuard(guard: ((q: PgQuerier, units: Array<{ts: bigint; meta?: Record<string,string>}>,
  shardId: ShardId) => Promise<void>) | null): void   // BREAKING contract change — fleet guard updated in lockstep
```

- [ ] **Step 1 (failing tests):** conformance on BOTH stores: unit order = ts order (strictly increasing); atomicity (a poisoned unit — e.g. a guard that throws on unit 2's meta — aborts ALL, zero rows); `commitWrite` ≡ one-unit batch (byte-identical results incl. guard invocation shape); density across units (two units writing DIFFERENT docs chain correctly; the batch-cut rule means same-doc never occurs — assert the store does NOT need to handle it but document the contract comment). Fleet guard: N keyed units → N DISTINCT fleet_idempotency rows each at its own unit's ts (the spec's E2E-class assertion at unit level); fence once (0-row epoch match aborts everything); frontier lands at ts_N.
- [ ] **Steps 2–5:** fail → implement → docstore-sqlite + docstore-postgres + fleet + transactor suites green (existing guard call sites updated mechanically in lockstep — each documented) → full gate → commit `feat(docstore,fleet): commitWriteBatch + the batch-shaped commit guard`.

---

### Task 3: The ShardWriter committer loop

**Files:**
- Modify: `packages/transactor/src/shard-writer.ts` (the two-buffer stage-then-flush; constructor gains `groupCommit: boolean` — false = the shipped single-commit path UNTOUCHED, structurally separate branch), `packages/transactor/src/sharded-transactor.ts` (threads the option)
- Test: `packages/transactor/test/group-commit.test.ts`

**Interfaces (consumed):** T2's commitWriteBatch. **(produced):** `ShardedTransactorOptions.groupCommit?: boolean`; batch counters (`lastBatchSize/maxBatchSize/flushCount`) exposed for T4's health wiring.

**The implementation contract (the spec's D2, binding):**
- Two buffers: `pendingBatch` (staging) and `flushingBatch` (detached, in flight). Write-visibility: a unit's writeRanges are consulted from stage until its ts lands in the ring — validate AND batch-cut check `recentCommits ∪ flushingBatch ∪ pendingBatch`.
- Mutex-held stage step: validate (OccConflictError tagged with the conflicting buffer's flush promise) → batch-cut (same-doc id in flushing/pending → await that batch's promotion, then re-enter the stage step) → prev_ts via `docStore.get` (committed-only by the cut rule) → append unit + resolver → return promise.
- Committer loop: detach pending → flushing; `commitWriteBatch`; per unit IN ORDER: ring push, `publishCommitted(ts_i)`, oplog build, `fanout.publish`, resolve; clear flushing; loop while pending non-empty. Prune once per flush.
- Retry loop: OccConflictError with a flush-promise tag → await it, then retry (re-execute); untagged (ring conflict) → retry immediately as today.
- Failure: flush rejection → reject every unit (the store error verbatim), discard flushing, ring/oracle untouched, loop survives (next stage re-enters).
- Retention: units stay snapshot-retained until resolve (the existing retain/release wraps the whole runInTransaction — verify it already covers the await-flush suspension; if the release runs in the finally before the promise resolves... IT DOES (finally on runInTransaction) — trace precisely: the finally releases AFTER the awaited commit returns, and under group commit the stage returns a promise the caller awaits INSIDE runInTransaction → the finally still runs post-flush ✓ — verify and comment).

- [ ] **Step 1 (failing tests, in-memory/SQLite where possible + PGlite for real concurrency):** natural batching (fire 10 concurrent mutations with an artificially slow first flush (stub store latency) → exactly 2 flushes: 1 + 9; idle sequence → N flushes of 1); validate-vs-flushing (an RMW intersecting a FLUSHING unit's writes aborts + its retry lands AFTER promotion and sees the write — the lost-update regression); batch-cut-vs-flushing (blind write to a doc in the flushing batch → staged only after promotion, prev_ts = the flushed revision — the forked-chain regression: assert the chain via load_documents); ordering (fan-out publish order = unit order across 2 batches); failure contract (flush error → all N reject with it, ring clean, a subsequent mutation succeeds); fence-mid-batch (all reject FencedError); retry-awaits-the-right-batch (conflict vs a PENDING unit whose batch hasn't started flushing); groupCommit=false → byte-identical (the existing suites + an explicit same-sequence comparison test); pure reads never touch the batch machinery.
- [ ] **Steps 2–5:** fail → implement → transactor + executor + runtime-embedded + @stackbase/test + fleet suites ALL green (flag off everywhere — byte-identity) → full gate → commit `feat(transactor): per-shard group commit — two-buffer stage-then-flush committer`.

---

### Task 4: Wiring + observability

**Files:**
- Modify: `packages/runtime-embedded/src/runtime.ts` (EmbeddedRuntimeOptions.groupCommit → ShardedTransactor), `packages/cli/src/boot.ts`/`serve.ts` (STACKBASE_GROUP_COMMIT parse — default OFF at this task), `ee/packages/fleet/src/node.ts` (thread through fleet boot), health endpoint (`groupCommit: { lastBatchSize, maxBatchSize, flushesPerSec }` from T3's counters, fleet section)
- Test: extend cli + fleet tests (flag parse; counters visible on health; off = fields absent/zeroed)

- [ ] **Steps 1–5:** TDD → implement → cli + fleet suites → full gate → commit `feat(cli,fleet): STACKBASE_GROUP_COMMIT wiring + group-commit health counters`.

---

### Task 5: E2E + the gate decision

**Files:** `ee/packages/fleet/test/fleet-e2e.test.ts` (concurrent-load scenario), `ee/packages/fleet/test/bench-commit.test.ts` (re-run with the flag on), `docs/dev/research/write-sharding/b4-benchmark.md` (before/after table), the default-flip commit if the criterion passes

- [ ] **Step 1:** E2E (Docker-gated, hygiene): multi-writer fleet with STACKBASE_GROUP_COMMIT=1 — 64 concurrent clients hammering sharded inserts + RMWs through the sync node ~10s: zero errors; dense-chain SQL over the whole run; zero ts=0; a duplicate forward mid-storm replays (effectively-once under load); RYOW spot-checks; health shows `maxBatchSize > 1` (batching engaged); existing scenarios byte-unmodified and green.
- [ ] **Step 2:** Re-run the T1 benchmark with the flag ON (same machine-context caveats); write the before/after table to b4-benchmark.md. **The gate:** if 64-client/8-shard/real-PG/insert-heavy is ≥2× baseline → flip the default to ON (boot parse defaults true; flag remains the ops escape hatch) in its own commit; if < 2× → leave default OFF and record the honest conclusion in b4-benchmark.md + the report. Green ×2 consecutive; full monorepo gate. Commit(s): `test(fleet): B4 E2E — group commit under concurrent load` (+ `feat(cli): group commit default-on (gate: <numbers>)` if passed).

---

### Task 6: Docs + finish

**Files:** `docs/enduser/deploy/fleet.md` (a short throughput note with the gate's real numbers + the STACKBASE_GROUP_COMMIT escape hatch, phrased per the gate outcome), `docs/dev/architecture/write-sharding-research.md` (B4 SHIPPED-or-assessed with the table; B5 reshard design-doc remains).
- [ ] Docs → full gate → commit `docs(fleet): group commit — B4 status + numbers`.

## Execution notes

- Waves: **{T1 ∥ T2}** (worktrees: bench test-only vs store contract) → T3 (opus — the concurrency core) → T4 (sonnet) → T5 (opus — the gate) → T6 (sonnet). T1 sonnet, T2 opus (store txn + BREAKING guard contract in lockstep).
- The soul constraint: flag-off byte-identity — existing tests never modified; the single-commit path stays a structurally separate branch in ShardWriter, not a batch-of-1 rewrite (byte-identity by construction, not by hope).
