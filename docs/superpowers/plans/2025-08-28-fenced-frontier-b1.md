# Fenced Frontier B1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The Fenced Frontier protocol at one shard: store-allocated commit timestamps (no allocated-but-unlanded window), epoch-fenced commits on a `shard_leases` row that is lease+fence+frontier, fencing-first eviction with wedged-writer takeover, and a frontier-targeting tailer with density assertions — behavior-identical to users.

**Architecture:** Spec = `docs/superpowers/specs/2025-08-28-fenced-frontier-b1-design.md` (D1–D6). Protocol basis = `docs/dev/research/write-sharding/verdict.md` §b. Core gains `DocStore.commitWrite` (store allocates + stamps ts inside its own atomicity domain); Postgres adds a commit-guard seam the fleet uses for the epoch-fenced frontier UPDATE; the fleet's lease evolves into `shard_leases` with a TTL heartbeat (= the existing LeaseMonitor probe) enabling wedged-writer failover via fencing-first eviction + `pg_terminate_backend`.

**Tech Stack:** TypeScript; Postgres sequence (`stackbase_ts`) + row-lock-serialized fencing; PGlite + SQLite for units/conformance; Docker-gated E2E with SIGSTOP.

## Global Constraints

- **Behavior-identical:** client protocol, Tier-0 SQLite semantics, non-fleet serve, RYOW timing — all unchanged. The existing fleet E2E scenarios must pass **UNMODIFIED** (never edit them to make this true), and all existing core suites (transactor, executor, runtime-embedded, docstore conformance, @stackbase/test conformance) must stay green — they are the proof.
- Exact values (spec): lease TTL **15s** (heartbeat every 5s = the existing probe cadence); `idle_in_transaction_session_timeout` **5s** + `statement_timeout` **10s** (fleet writer connections only); fencer `lock_timeout` **2s** + retry next tick; sequence name **`stackbase_ts`**; shard id **`'default'`**; placeholder ts **`0n`**.
- Schema statements keep the one-statement-per-element discipline (single-statement drivers like PGlite must work) — `docstore-postgres/src/schema.ts:4-27` pattern.
- FSL core changes (docstore, docstore-sqlite, docstore-postgres, transactor) are engine-critical: tests in the owning packages; the shared conformance suite covers both stores. ee/ files carry the enterprise header.
- Node/vitest, no Bun APIs in tests; `bun run build` before cross-package tests; typecheck after tests; full gate = `bun run build && bun run typecheck && bun run test`.
- Commit trailer: `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.

**Verified ground truth (do not re-derive):** transactor commit path `packages/transactor/src/single-writer-transactor.ts:192-235` (validate ring `c.ts > snapshotTs` → `oracle.allocateTimestamp()` :206 → entries stamped with commitTs, `prev_ts` from `await this.docStore.get(w.id)` — ts-independent → `indexWrites {ts: commitTs, update}` → `docStore.write(entries, indexWrites, "Error", shardId)` → ring push → `publishCommitted` → OplogDelta). PKs: `documents(table_id, internal_id, ts)`, `indexes(index_id, key, ts)`, `persistence_globals(key)` (`schema.ts:4-27`). SQLite store has NO in-memory ts counter (`maxTimestamp()` queries MAX(ts), `sqlite-docstore.ts:263`) — its commitWrite computes MAX(ts)+1 inside its own transaction (race-free: single writer + synchronous txn). Conformance suite: `packages/docstore/test-support/conformance.ts` (imported by both stores' test files). Current lease upsert `ee/packages/fleet/src/lease.ts:59-62` (`ON CONFLICT (id) DO UPDATE SET epoch = epoch + 1`). LeaseMonitor probe wired at `ee/packages/fleet/src/node.ts:463-466` (`probe: async () => { await client.query("SELECT 1") }`); its timeout-as-miss machinery from the hardening slice stays. `application_name` per node already on `NodePgClient` (`node-pg-client.ts:47-63`, constructor `opts {connectionString, applicationName?}`) — session timeouts join this config. Fan-out payload = `EmbeddedWriteFanoutPayload` (`packages/runtime-embedded/src/write-fanout.ts:11`), published from `OplogDelta` at :48-49. Tailer pull target `ee/packages/fleet/src/replica-tailer.ts:~207` (`primary.maxTimestamp()`). RYOW `forwarder.ts:104,138,163`. `PgQuerier` exported from `docstore-postgres/src/pg-client.ts`. `prepareFleetNode(deps)` at `node.ts:261` (TTL/test-override threads there).

**DAG:** T1 → {T2 ∥ T3} → T4 → T5 → T6 → T7. (T2 transactor vs T3 fleet-lease: disjoint packages, parallel worktrees. T4 and T5 both touch `node.ts`/tailer: serial. T1 first: everything depends on `commitWrite`. T6 = most capable model.)

---

### Task 1: `DocStore.commitWrite` + both store impls + commit-guard seam + conformance

**Files:**
- Modify: `packages/docstore/src/types.ts` (interface), `packages/docstore-sqlite/src/sqlite-docstore.ts`, `packages/docstore-postgres/src/postgres-docstore.ts`, `packages/docstore-postgres/src/schema.ts` (sequence + shard_id columns), `packages/docstore/test-support/conformance.ts` (new cases), `ee/packages/fleet/src/switchable-store.ts` (delegate the new member)
- Test: conformance runs via both stores' existing test files; plus `packages/docstore-postgres/test/commit-guard.test.ts`

**Interfaces (produced — Tasks 2–5 rely on these EXACT signatures):**

```ts
// packages/docstore/src/types.ts — DocStore gains:
/** Commit staged rows, allocating the commit ts inside the store's own atomicity domain.
 * documents[].ts and indexUpdates[].ts arrive as 0n placeholders and are stamped by the store.
 * Postgres: nextval('stackbase_ts') inside the commit transaction (ts visible atomically with
 * its rows). SQLite: MAX(ts)+1 inside its transaction. Returns the allocated commitTs. */
commitWrite(documents: readonly DocumentLogEntry[], indexUpdates: readonly IndexWrite[], shardId?: ShardId): Promise<bigint>;

// packages/docstore-postgres — PostgresDocStore gains:
/** Runs inside every commitWrite transaction, after row inserts, before COMMIT.
 * Throwing aborts the entire commit. Installed by fleet code (epoch fence); never set at Tier-0. */
setCommitGuard(guard: ((q: PgQuerier, commitTs: bigint) => Promise<void>) | null): void;
```

- Postgres commitWrite: one transaction — `SELECT nextval('stackbase_ts')` → stamp all document+index rows with it (and `shard_id = shardId ?? 'default'`) → run the guard if set → COMMIT. Reuse the existing `write()` row-building/dedup internals (extract a shared private helper; do NOT duplicate the INSERT SQL).
- Sequence + seeding (the spec's deferred recipe, decided): in `setupSchema`, after DDL — `CREATE SEQUENCE IF NOT EXISTS stackbase_ts` as its own statement; then seed exactly once using a sentinel global:
  ```sql
  -- only when writeGlobalIfAbsent('core:tsSeqSeeded', '1') actually inserted (store API tells us):
  SELECT setval('stackbase_ts', GREATEST((SELECT COALESCE(MAX(ts),0) FROM documents), 1));
  ```
  (Idempotent: the sentinel makes seeding one-shot; a pre-existing deployment continues its ts line seamlessly; a fresh DB starts at 1.)
- `shard_id TEXT NOT NULL DEFAULT 'default'` on documents+indexes: Postgres `ALTER TABLE ... ADD COLUMN IF NOT EXISTS ...` (one statement each, appended to SCHEMA_STATEMENTS). SQLite: `node:sqlite` has no IF-NOT-EXISTS for columns — guard with a `pragma table_info` check in its setupSchema before `ALTER TABLE ADD COLUMN`. Both `write()` (verbatim path) and `commitWrite` stamp it (`write()` from the entries' shardId param as passed; keep backward compatibility: rows written before the column exist read as 'default' via the DEFAULT).
- SQLite commitWrite: inside its existing synchronous transaction — compute `MAX(ts)+1` (0-row ⇒ 1), stamp, insert, return. Same placeholder contract.
- SwitchableDocStore: add the one-line delegation (`const d = this.delegate` first, as established).

- [ ] **Step 1 (failing tests):** conformance additions in `test-support/conformance.ts` (both stores automatically): (a) commitWrite returns strictly increasing ts across calls and > any prior write()'s ts; (b) all rows of one commit share the returned ts (get + index_scan verify); (c) placeholder 0n never persisted (no row with ts=0); (d) maxTimestamp() === returned ts after commit; (e) shard_id stamped 'default' (query raw via the store's client where the suite allows, else assert via a targeted store-level accessor — keep the suite storage-agnostic: if raw row access isn't in the suite's vocabulary, put the shard_id assertions in each store's own test file instead and say so). Plus `commit-guard.test.ts` on PGlite: guard invoked with (querier, allocated ts) after inserts; a THROWING guard aborts — zero document/index rows landed, sequence advanced is acceptable; `setCommitGuard(null)` clears.
- [ ] **Step 2:** Run both stores' suites — FAIL (member missing).
- [ ] **Step 3:** Implement per the interface block (types.ts, both stores, schema statements, switchable delegate).
- [ ] **Step 4:** `bun run --filter @stackbase/docstore-sqlite test && bun run --filter @stackbase/docstore-postgres test && bun run --filter @stackbase/fleet test` + typechecks; then `bun run build && bun run test` (nothing else consumes commitWrite yet — full green expected).
- [ ] **Step 5:** Commit: `feat(docstore): commitWrite — store-allocated commit timestamps + Postgres commit-guard seam + shard_id columns`

---

### Task 2: Transactor switches to `commitWrite` (highest blast radius — proof is the existing suites)

**Files:**
- Modify: `packages/transactor/src/single-writer-transactor.ts:192-235`
- Test: `packages/transactor/test/` (extend the existing commit-path test file with the placeholder assertions)

**Interfaces:** Consumes T1's `commitWrite`. Produces: no signature changes — `CommitResult`/`OplogDelta` identical.

- [ ] **Step 1 (failing test):** transactor-level (in-memory SQLite store): after a mutation commits, the ring's newest entry ts === the store's maxTimestamp(); entries handed to the store carried ts 0n (spy/wrap commitWrite to capture) while prev_ts chaining matches the pre-commit head revisions; OCC conflict behavior across two sequential transactions unchanged (existing tests already cover — add only the capture-based assertions).
- [ ] **Step 2:** FAIL. **Step 3:** implement: phase 2+3 merge — build entries with `ts: 0n` (prev_ts logic UNTOUCHED, still `await this.docStore.get(w.id)` before), `indexWrites` with `ts: 0n`, `const commitTs = await this.docStore.commitWrite(entries, indexWrites, shardId)`, ring push `{ts: commitTs, writes: ctx.writeRanges}`, `this.oracle.publishCommitted(commitTs)`, OplogDelta from commitTs. Remove the `allocateTimestamp` call (interface member stays; add a doc-comment marking it legacy at `docstore/src/types.ts:143`).
- [ ] **Step 4:** THE GATE IS THE POINT: `bun run --filter @stackbase/transactor test && bun run --filter @stackbase/executor test && bun run --filter @stackbase/runtime-embedded test && bun run --filter @stackbase/test test` all green unchanged (RYOW overlay, OCC retries, activeSnapshots proven untouched), then full monorepo gate.
- [ ] **Step 5:** Commit: `feat(transactor): allocate commit timestamps via DocStore.commitWrite — no allocated-but-unlanded window`

---

### Task 3: `shard_leases` + LeaseManager rewire + heartbeat-as-probe + guard installation

**Files:**
- Modify: `ee/packages/fleet/src/lease.ts` (table + acquisition + read), `ee/packages/fleet/src/lease-monitor.ts` (probe semantics note only if needed), `ee/packages/fleet/src/node.ts:461-466` (probe thunk → heartbeat; guard install at writer boot + promotion), `ee/packages/fleet/src/index.ts` (export FencedError)
- Create: `ee/packages/fleet/src/fenced-error.ts` (or co-locate in lease.ts — implementer's call, one place)
- Test: `ee/packages/fleet/test/lease.test.ts` (extend), `ee/packages/fleet/test/fence.test.ts`

**Interfaces (produced):**

```ts
export class FencedError extends Error {}   // thrown by the commit guard + detected from heartbeat 0-rows
// LeaseManager: table becomes shard_leases per spec D2 (shard_id PK 'default', epoch, writer_url,
// writer_app_name, expires_at, frontier_ts DEFAULT 0, prev_ts DEFAULT 0).
// tryAcquire(): advisory lock then fencing upsert:
//   INSERT ... VALUES ('default', 1, $url, $app, now() + interval '15 seconds', 0, 0)
//   ON CONFLICT (shard_id) DO UPDATE SET epoch = shard_leases.epoch + 1, writer_url = $url,
//     writer_app_name = $app, expires_at = now() + interval '15 seconds'
//   RETURNING epoch, ...
// heartbeat(epoch): UPDATE shard_leases SET expires_at = now() + interval '15 seconds'
//   WHERE shard_id='default' AND epoch=$epoch  → returns rowCount (0 = fenced)
// read(): all columns.
```

- Probe thunk at node.ts:463-466 becomes: writer role → `const n = await lease.heartbeat(myEpoch); if (n === 0) throw new FencedError("lease fenced")`; the LeaseMonitor's existing timeout-as-miss machinery is untouched, but a FencedError from the probe (distinguish by instanceof in the miss handler) → **immediate exit** (bypass the 3-miss tolerance — fenced is definitive like connectionLost; add `LeaseMonitor.fenced()` mirroring `connectionLost()` and call it from the probe wrapper).
- Guard installation (spec D3): at writer boot and inside promotion success, `pgStore.setCommitGuard(async (q, ts) => { const r = await q.query('UPDATE shard_leases SET prev_ts = frontier_ts, frontier_ts = $1 WHERE shard_id = $2 AND epoch = $3', [ts, 'default', currentEpoch()]); if (rowCount(r) === 0) throw new FencedError('commit fenced'); })` — `currentEpoch()` reads a mutable ref updated on acquisition/promotion. A FencedError surfacing from any mutation commit → monitor.fenced() → exit path.
- fleet_lease table abandoned (no DDL for it anymore; no migration — coordination state is ephemeral; upgrade note is T7's doc).

- [ ] **Step 1 (failing tests, PGlite):** acquisition creates/bumps epoch with all columns; heartbeat extends expires_at; heartbeat with stale epoch → 0 rows → FencedError from the probe wrapper; guard install → a commitWrite on the pgStore runs the fenced UPDATE (frontier_ts becomes the commit ts, prev_ts the old frontier); stale-epoch guard → whole commit aborts (no rows landed — reuse T1's commit-guard test harness); monitor.fenced() → onExit once immediately.
- [ ] **Steps 2–5:** fail → implement → fleet suite + typecheck green → commit: `feat(fleet): shard_leases (lease+fence+frontier), heartbeat-as-probe, epoch-fenced commit guard`

---

### Task 4: Fencing-first eviction + wedged takeover + session timeouts

**Files:**
- Modify: `ee/packages/fleet/src/lease.ts` (evict + acquire-loop expiry check), `ee/packages/fleet/src/node.ts` (takeover sequence), `packages/docstore-postgres/src/node-pg-client.ts` (session-timeout options — constructor opts gain `sessionTimeouts?: { idleInTransactionMs: number; statementMs: number }`, applied via the pg `Client` config's `options: '-c idle_in_transaction_session_timeout=... -c statement_timeout=...'` string or post-connect SETs in `ensure()` — pick whichever the pg driver supports cleanly, show it), fleet prep threads the option for WRITER-capable connections
- Test: `ee/packages/fleet/test/eviction.test.ts`

**Interfaces (produced):** `LeaseManager.evictExpired(): Promise<{ fenced: boolean; oldAppName: string | null }>` — runs (with `lock_timeout='2s'` set for the statement): capture `writer_app_name` via the same UPDATE's RETURNING, `UPDATE shard_leases SET epoch = epoch + 1, writer_url = NULL, writer_app_name = NULL, frontier_ts = GREATEST(frontier_ts, (SELECT nextval('stackbase_ts'))) WHERE shard_id='default' AND expires_at < now() RETURNING (SELECT writer_app_name FROM ... )` — VERIFY RETURNING-old-value semantics in PG (RETURNING sees NEW row); if old value needs a CTE, use `WITH old AS (SELECT writer_app_name FROM shard_leases WHERE shard_id='default' AND expires_at < now() FOR UPDATE) UPDATE ... RETURNING (SELECT writer_app_name FROM old)` — show the exact SQL that works, test it on PGlite. `lock_timeout` expiry → `{fenced:false}`, retry next tick.

- Acquire loop: each tick, if advisory-lock try fails AND `read().expires_at < now()` → `evictExpired()`; on `{fenced:true, oldAppName}` → `pg_terminate_backend` by app name (reuse the E2E-established query shape) → next tick's advisory try succeeds → normal acquisition (epoch bumps again — monotonic, fine) → promotion.
- Session timeouts: applied only when the fleet threads the option (non-fleet `NodePgClient` construction unchanged).

- [ ] **Step 1 (failing tests, PGlite):** evictExpired on an expired row → epoch+1, writer_url NULL, frontier bumped ≥ old, returns old app name; on a live row → no-op {fenced:false}; the row-lock serialization vs a concurrent commit is E2E-only (single-connection PGlite — state that in the test header); session-timeout option produces the right connection config (assert the constructed config object / issued SETs, no live PG needed).
- [ ] **Steps 2–5:** fail → implement → fleet + docstore-postgres suites + typecheck → commit: `feat(fleet): fencing-first eviction + wedged-writer takeover + bounded writer sessions`

---

### Task 5: Tailer targets F + density assertions + StablePrefixTs + fan-out shardId

**Files:**
- Modify: `ee/packages/fleet/src/replica-tailer.ts` (target + assertions + brand), `ee/packages/fleet/src/node.ts` (frontier read supplier), `ee/packages/fleet/src/forwarder.ts` (waitFor threshold takes the brand — type-only), `packages/runtime-embedded/src/write-fanout.ts` (`EmbeddedWriteFanoutPayload` gains `shardId: string` — additive, sourced from `OplogDelta.shardId` at :48-49), `ee/packages/fleet/src/index.ts`
- Create: `ee/packages/fleet/src/stable-prefix.ts` (`StablePrefixTs` brand + the sole constructor `stablePrefixFromFrontier(row): StablePrefixTs`)
- Test: `ee/packages/fleet/test/replica-tailer.test.ts` (extend), type-level assertions in a `*.test-d.ts`-style block or `@ts-expect-error` cases inside the test file

**Interfaces (produced):** `ReplicaTailer` pull target = `SELECT frontier_ts FROM shard_leases WHERE shard_id='default'` (via the existing `CommitChannelClient`), branded `StablePrefixTs`; watermark and `waitFor` threshold typed with the brand; `DensityViolationError` (message names docId, expected prev_ts, actual head ts).

- Density assertion in the apply loop: for each document entry — `prev_ts != null` ⇒ replica's current head for that doc must exist and equal it; `prev_ts == null` ⇒ replica must have no live head (insert). Violation → throw `DensityViolationError` (tailer crashes loudly; shipped delete-and-re-bootstrap is the remedy — reference it in the error message). F must be ≥ previous F (assert).
- RYOW: `waitFor(commitTs)` semantics unchanged — at one shard, the commit's own frontier bump makes F ≥ commitTs immediately; assert in a test.

- [ ] **Step 1 (failing tests, PGlite→sqlite replica):** (a) commits then tick → tailer pulls exactly `(wm, F]` where F = the lease row's frontier (write rows above F artificially via raw write() with a manual ts to prove they are NOT pulled — the F-boundary test); (b) constructed density violation (apply a batch, then hand-tamper the replica head, apply next batch) → DensityViolationError naming the doc; (c) insert-case violation (entry prev_ts null but head exists) → error; (d) F regression assertion; (e) RYOW waitFor resolves once the frontier-carrying batch applies; (f) `@ts-expect-error`: passing `primary.maxTimestamp()`'s bigint where the brand is required fails to compile.
- [ ] **Steps 2–5:** fail → implement → fleet + runtime-embedded suites + typecheck → full gate (fan-out payload change touches core) → commit: `feat(fleet): tailer targets the fenced frontier — density assertions, StablePrefixTs, shardId fan-out`

---

### Task 6: Wedged-writer E2E + the behavior-identical gate

**Files:**
- Modify: `ee/packages/fleet/test/fleet-e2e.test.ts` (+ a `FLEET_LEASE_TTL_MS` test override threaded through `prepareFleetNode(deps)` at `node.ts:261` and serve's fleet config — VERIFY how existing fleet options thread from serve flags/env; add env `STACKBASE_FLEET_LEASE_TTL_MS`, default 15000, documented as test/ops tuning)

- [ ] **Step 1:** New Docker-gated scenario (all shipped hygiene: kill array, per-node mkdtemp dirs, bounded waits): boot writer A + sync B with `STACKBASE_FLEET_LEASE_TTL_MS=4000`; open a subscription on B; run a background mutation loop via B; `SIGSTOP` A mid-traffic; within ~TTL+loop-bound, assert via direct pg: `shard_leases.epoch` bumped AND `writer_url` = B (fence + takeover + promotion); mutations via B succeed again and push to the pre-existing subscription; `SIGCONT` A → A's process exits (FencedError path — assert exit via child handle); **density check**: direct SQL over the affected range — for every document with >1 revision in the window, its prev_ts chain is intact (each revision's prev_ts equals the prior revision's ts) — plus kill B's replica file, re-bootstrap, and assert the tailer's own density assertions pass over the full log.
- [ ] **Step 2:** `bun run build`; run the fleet E2E — ALL existing scenarios must pass UNMODIFIED alongside the new one; iterate on real bugs (smallest correct fix, separate commits, documented).
- [ ] **Step 3:** Full monorepo gate. Commit: `test(fleet): wedged-writer E2E — SIGSTOP, fence, takeover, straggler aborts, density holds`

---

### Task 7: Docs + finish

**Files:**
- Modify: `docs/enduser/deploy/fleet.md` (failover: wedged-writer TTL failover ~15s alongside instant crash failover; `STACKBASE_FLEET_LEASE_TTL_MS`; upgrade note: `fleet_lease` → `shard_leases`, fleet nodes upgrade together), `docs/dev/architecture/write-sharding-research.md` (status: B1 SHIPPED)
- [ ] **Step 1:** Write docs (match voice; no over-promising — wedged failover bound = TTL + fence + promotion, state it). **Step 2:** Full gate. Commit: `docs(fleet): B1 — wedged-writer failover, shard_leases upgrade note`

## Execution notes

- T1 first (largest core surface — most capable model). T2 ∥ T3 in worktrees (transactor vs fleet — disjoint; T3 consumes T1's setCommitGuard via built dist). T4 → T5 serial (node.ts overlap). T6 most capable model (E2E debugging + the protocol's first real-world test). Watch the duplicate-package.json-key merge gotcha if any task adds deps (none should).
- The behavior-identical constraint is the slice's soul: if any existing test needs modification, STOP and treat it as a design problem, not a test problem.
