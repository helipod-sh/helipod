# Receipted Outbox Plan A — Server + Wire

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The server half of durable offline sync — per-seq verdict receipts atomic with commits, the per-client floor, owner-side classification with replay-acks, the guard chain (+ the LIVE batch-collateral bug fix), and the additive wire contract (`Connect`/`ConnectAck`, `MutationBatch`) — independently shippable; Plan B (the client) follows.

**Architecture:** Spec = `docs/superpowers/specs/2025-11-04-receipted-outbox-design.md` (post-review 3850b31); AUTHORITY = `docs/dev/research/offline-outbox/verdict.md` §(b)(c)(e) VERBATIM (the governing invariant, the server contract, the wire table). The spec-review corrections are BINDING: fleet captures/releases the `addCommitGuard` unregister handle across promotions (append-blind = every forwarded commit aborts); the `CommitGuardRejection` cascade covers the fleet guard's typed-throw + http-handler's raw-23505 migration; `ackedThrough` = the contiguous settled prefix; `deploymentId` on ConnectAck.

**Tech Stack:** TypeScript; both docstores; PGlite units + real-server E2Es.

## Global Constraints

- The verdict §(c) contract verbatim: `client_mutations(identity, client_id, seq) PK → {verdict, commit_ts, value_json?(64KB cap), error_code?, created_at}` + `client_floors(identity, client_id) PK → {pruned_through_seq, updated_at}` — CORE tables, free-tier, BOTH docstores (the persistence_globals category; NOT fleet_idempotency/ee); identity-scoped keys (anonymous = `""`); applied-receipts written by the commit guard INSIDE the commit txn; failed-receipts via the standalone `recordClientVerdict` (no atomicity needed — nothing committed); classification reads run WHERE THE COMMIT RUNS (owner-side on fleet; never a follower replica).
- Classification outcomes verbatim: hit `applied` → `MutationResponse{success:true, replayed:true, ts:commit_ts, value|valueMissing}`; hit `failed` → replay the terminal verdict; `seq ≤ floor` no-record → `STALE_CLIENT`; miss above floor → run with the dedup meta; guard PK collision → loser reads winner + replay-acks (B3's pattern).
- Wire (verdict §(e) + the spec fix): all additive; absent clientId/seq = today's path bit-for-bit; `Mutation`+`{clientId?, seq?}`; `MutationBatch{entries[]}` applied SEQUENTIALLY with per-unit `MutationResponse` frames (chunk 50 default); `MutationResponse`+`{replayed?, valueMissing?}` / failure+`{code?}`; `Connect{clientId?, held?, ackedThrough?}` activates the reserved no-op; `ConnectAck{known, results[], deploymentId}` — NO tableNumbers.
- Retention: ack-prune (ackedThrough = the contiguous settled prefix) + 30d TTL via a reaper on the recurring-driver seam; floors ≥ 1yr; `pruned_through_seq` advances in the SAME txn as the prune; floor-covers-holes (`seq ≤ floor` without record = STALE — the §(b) invariant's loud-over-silent).
- Split-retry bound: 3, then the chunk rejects retryably. SQLite guards run synchronously (Promise return = dev-throw). Old-client/old-server byte-compat pinned by tests.
- Node/vitest; full gate = build && typecheck && test; existing tests never modified; commit trailer:
  `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>` + `Claude-Session: https://claude.ai/code/session_015RKShEWjRcmbQVJ8ooUPP6`

**Verified ground truth (verdict judging + spec review — do not re-derive):** the guard slot is single (`postgres-docstore.ts:75-97`), fleet occupies it at boot AND re-arms at every promotion (`node.ts:1475/1609/1643` → installCommitGuard ~:916); the B3 guard loops units and INSERTs per-unit idempotency (`node.ts:955-971`); a group flush error rejects EVERY unit (`shard-writer.ts:585-586,619-625`) with raw non-OCC propagation (`:469`) — the live batch-collateral bug; http-handler detects raw 23505 (`http-handler.ts:83-90`); SQLite's commit is one synchronous transaction with meta accepted-and-ignored (`sqlite-docstore.ts:155-186`); zero-staged-writes short-circuits before the store (`shard-writer.ts:317-321`, grouped `:436-440`) and the PG guard skips empty batches (`postgres-docstore.ts:301-303`) — hence standalone `recordClientVerdict`; `SyncUdfExecutor` has no read path (`handler.ts:45-58`); `Connect` is a reserved no-op (`handler.ts:196-198`); inbound frames are fire-and-forget per MESSAGE (`server.ts:293,431`) — one MutationBatch = one internally-sequential task; responses are backpressure-undroppable (`handler.ts:165-172`); B3's forward pre-SELECT + meta channel (`http-handler.ts:202-204`) is the owner-placement precedent.

**DAG:** T1 (spike) → {T2 ∥ T4} → T3 → T5 → T6. (T2 = guard chain + SQLite guard (docstores+fleet); T4 = tables + recordClientVerdict + floor + reaper (docstores+a component-driver) — disjoint from T2 except types.ts (coordinate via T1's spike output). T3 = split-retry + typed cascade (needs T2). T5 = wire + classification + handler integration (needs all). T6 = E2E + finish.)

---

### Task 1: The classification-plumbing SPIKE

**Files:** Create `docs/superpowers/specs/2025-11-04-outbox-spike-notes.md` (the output: exact signatures); NO product code beyond type sketches.

- [ ] **Step 1:** Read the verdict §(c) + the spec's decisions 1-4; trace: (a) `SyncUdfExecutor.runMutation`'s shape (handler.ts:45-58) → design the dedup option + replay-shaped return `{replayed: true, verdict, commitTs, value?}`; (b) the fleet-forward meta threading for `(identity, clientId, seq)` (B3's channel at http-handler.ts:202-204 — what extends); (c) the `CommitGuardRejection` type + where the fleet guard throws it (node.ts:964-971) + what http-handler.ts:83's migration looks like; (d) the `addCommitGuard` chain shape both stores share + the SQLite sync-guard signature; (e) the classification read's store API (`getClientVerdict(identity, clientId, seq)` + `getClientFloor`) and its placement in the handler flow. Write the signatures + a risk list. Commit `docs(outbox): plan-A spike — classification + guard-chain signatures`.

---

### Task 2 (parallel with T4): The guard chain + the SQLite commit guard

**Files:**
- Modify: `packages/docstore/src/types.ts` (the shared guard type + addCommitGuard on the DocStore-guard capability), `packages/docstore-postgres/src/postgres-docstore.ts` (single slot → ordered chain; setCommitGuard retained as a deprecated alias = clear-then-add), `packages/docstore-sqlite/src/sqlite-docstore.ts` (gains the guard chain, run SYNCHRONOUSLY inside its commit transaction; a guard returning a thenable → dev-throw with an instructive message), `ee/packages/fleet/src/node.ts` (**capture the unregister handle; release before re-adding at every armWriter/promotion** — the spec-review hazard), switchable-store delegate, conformance
- Test: conformance both stores (chain order; any-throw-aborts-all; unregister; SQLite sync enforcement) + fleet (promotion re-arm does NOT stack — a double-promotion then a forwarded commit succeeds exactly once)

- [ ] **Steps 1–5:** TDD → implement → docstore suites + fleet suite green (existing unmodified; the promotion-restack regression is the load-bearing test) → full gate → commit `feat(docstore,fleet): the commit-guard chain — addCommitGuard on both stores, fleet handle-managed`.

---

### Task 4 (parallel with T2): Receipts storage + floors + recordClientVerdict + the reaper

**Files:**
- Modify: both docstores (the two tables' DDL — one statement per element; `getClientVerdict`/`getClientFloor`/`recordClientVerdict(identity, clientId, seq, verdict)` (standalone tiny txn)/`pruneClientMutations(identity, clientId, throughSeq)` (delete + floor-advance SAME txn)/TTL-sweep query), `packages/docstore/src/types.ts` (the API), a reaper on the recurring-driver seam (mirror storageReaper — where it lives; 30d records TTL; floors untouched ≤1yr)
- Test: conformance both stores (the STALE matrix: record-hit/hole-below/exactly-floor/floor+1-miss-runs/fresh-client-runs; prune advances floor atomically; 64KB value cap + valueMissing shape; TTL sweep)

- [ ] **Steps 1–5:** TDD → implement → suites green → full gate → commit `feat(docstore): client mutation receipts + floors + the verdict reaper`.

---

### Task 3: CommitGuardRejection + the split-retry (THE LIVE BUG FIX)

**Files:**
- Modify: `packages/docstore/src/types.ts` (the typed error `{unitIndex, code, detail}`), `packages/transactor/src/shard-writer.ts` (the group committer catches it → rejects ONLY that unit with the code → re-flushes the remainder (fresh ts) → 3-bounded → then chunk-retryable; single-commit path: the rejection maps to that mutation's own rejection as today), `ee/packages/fleet/src/node.ts` (the B3 idempotency guard THROWS the typed rejection carrying its loop index), `packages/cli/src/http-handler.ts` (the raw-23505 detection migrates to the typed error; behavior byte-identical for the single-mutation replay path)
- Test: transactor (the collateral regression: a batch of 3 where unit 2's guard rejects → units 1+3 COMMIT with fresh ts + resolve, unit 2 rejects with the code — pre-fix this rejects all 3; the ×3 bound; ordering invariant held across the split), fleet (the duplicate-forward replay path still green through the typed error)

- [ ] **Steps 1–5:** TDD (the collateral regression RED first against the shipped behavior) → implement → transactor + fleet + cli suites → full gate → commit `fix(transactor,fleet): typed guard rejection + committer split-retry — the batch-collateral bug`.

---

### Task 5: The wire + classification + handler integration

**Files:**
- Modify: `packages/sync/src/protocol.ts` (all §(e) additions incl. ConnectAck.deploymentId), `packages/sync/src/handler.ts` (Connect activation → classification of `held` → ConnectAck{known, results, deploymentId}; Mutation{clientId,seq} → classify (getClientVerdict/floor at the OWNER — single-node local; fleet threads via the forward meta per the spike) → replay-ack / STALE_CLIENT / run-with-meta; the applied-receipt written by a NEW addCommitGuard registration (compose with fleet's — the chain from T2); MutationBatch → sequential per-unit processing emitting per-unit responses), `packages/runtime-embedded` (the dedup-option plumbing per the spike), fleet forward extension (the meta + owner-side classification)
- Test: sync loopback (every classification outcome; Connect/ConnectAck shapes; batch sequential + per-unit frames + mid-batch failure leaves prior units applied; old-client bit-compat — no clientId = today's path (spy: no receipt written, no classification read)), fleet (owner-placement: a resend via a DIFFERENT node classifies at the owner)

- [ ] **Steps 1–5:** TDD → implement → sync + cli + fleet + client suites (client untouched-green — Plan B consumes) → full gate → commit `feat(sync): receipts wire contract — Connect/ConnectAck, MutationBatch, owner-side classification`.

---

### Task 6: E2E + finish (Plan A's gate)

**Files:** `packages/cli/test/outbox-server-e2e.test.ts` (raw-wire client harness — Plan B's real client doesn't exist yet; drive the protocol directly per the ws.test.ts pattern)

- [ ] **Step 1:** Real-server E2Es: (1) **kill-after-commit resend** — mutation with (clientId, seq) commits; kill the server before the response is read; restart; resend the SAME seq → `replayed: true` with the ORIGINAL commitTs, exactly one row; (2) duplicate-in-flight (two concurrent same-seq sends → one commits, the loser replay-acks via the guard collision); (3) the STALE_CLIENT boundary through the wire; (4) MutationBatch: 50 entries applied sequentially, per-unit responses in order, a mid-batch deterministic failure → prior units applied + that unit's coded failure + subsequent units continue; (5) the collateral fix live under STACKBASE_GROUP_COMMIT=1 (co-batched innocents survive a duplicate-key abort); (6) fleet+8-shards: resend via a non-owner node classifies at the owner (the placement rule); (7) old-client compat (no new fields = byte-identical flows). Green ×2; full monorepo gate.
- [ ] **Step 2:** Docs-lite: `docs/dev/architecture/` protocol note update (the wire additions; Plan B owns the enduser docs). Commit `test(cli): receipted-outbox server E2E — resend exactly-once, batches, collateral fix, owner placement`.

## Execution notes

- Waves: T1 (opus spike) → **{T2 ∥ T4}** (worktrees: guard chain vs receipts storage — coordinate the one shared types.ts region via the spike's signatures; sonnet each) → T3 (opus — the live-bug fix in the committer) → T5 (opus — the protocol integration) → T6 (opus). Soul: old-client byte-compat; existing tests never modified; the promotion-restack regression is T2's load-bearing test.
- Plan B (the client) is written AFTER this plan merges, from the same spec.
