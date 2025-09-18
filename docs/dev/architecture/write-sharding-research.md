---
title: Write Sharding — Multi-Agent Research & the Fenced Frontier Verdict
status: proposed (research complete, pre-spec — slice B1 to be brainstormed/spec'd from this)
date: 2025-08-28
audience: engineering (internal)
---

# Write Sharding — Research & Verdict: the **Fenced Frontier** protocol

> How Stackbase removes the single-writer ceiling (Tier 2's writes axis) without breaking the
> one-global-timestamp reactive core. Produced by a 10-agent adversarial research workflow
> (2025-08-28): 3 evidence gatherers → 3 independent designers with opposing biases → 3
> adversarial critics → 1 judge. **Full corpus: [`../research/write-sharding/`](../research/write-sharding/)**
> — the verdict there ([verdict.md](../research/write-sharding/verdict.md)) is the canonical
> protocol statement; this page is the orientation layer.
>
> Companions: [tier2-topology-research.md](./tier2-topology-research.md) (the shipped symmetric
> fleet this extends), [scalability-spectrum.md](./scalability-spectrum.md) (seams 1–2).

## The two problems this had to solve

1. **Global-ts vs parallel writers.** Everything in the engine — MVCC snapshots, OCC, client
   `StateVersion` brackets, replica watermarks, pagination cursors — assumes one monotonic ts
   line where "all ts ≤ X are present". Parallel writers commit out of order; a naive reader
   skips in-flight timestamps forever.
2. **Mutation routing DX.** OCC is in-process per writer, so a mutation's shard must be known
   *before* execution — a public API decision that must leave Tier-0 code byte-identical.

## The process (and why its outputs are trustworthy)

- **Evidence:** a web sweep of modern ordering systems (TiDB TSO, CockroachDB closed
  timestamps, Spanner TrueTime, FoundationDB sequencer/resolvers, Calvin/VoltDB, Kafka LSO,
  Vitess/Citus routing) · a clean-room study of the ancestors' actual code in `.reference/`
  (concave's per-tenant transactors, Lunora's `.shardBy()`/Query-Coordinator/watermarks,
  convex-backend) · a file:line audit of our own binding invariants.
- **Three designs, opposing biases:** A (central-order/parallel-execute, one ts line survives),
  B (per-shard logs, frontier vectors), C (deterministic sequenced batches).
- **Three adversarial critiques** (correctness/failure-modes, performance/scalability,
  DX/deploy/buildability) that argued about *real code* — load-bearing claims were verified
  against the tree. The correctness critique **falsified Design A as written** (the
  live-lease-exclusion rule readmits the skipped-ts bug via an idle-in-transaction straggler on
  an expired-but-unfenced lease) and supplied the repair the verdict adopts.
- **Judge:** picked A's skeleton *as amended*, grafting B's safety core and C's economics.

## The verdict in one page — Fenced Frontier

**One global ts line. Per-shard parallel OCC writers. Visibility = min over per-shard
frontiers. The novel mechanism: lease, fence, and frontier are ONE Postgres row, updated
atomically inside every commit's own transaction — and eviction from the min is a fencing
UPDATE on that same row, serialized by its row lock.**

- **Allocation:** the store allocates `commitTs` (`nextval` inside the commit transaction —
  ts becomes visible atomically with its rows; no allocated-but-unlanded window). Same
  contract on SQLite (its counter) — one behavior at every tier, conformance-covered.
- **Commit (fleet):** rows stamped + `UPDATE shard_leases SET frontier_ts = $ts WHERE
  shard_id = $s AND epoch = $myEpoch` — 0 rows → the whole commit aborts (`FencedError`,
  self-demote). Fencing-first eviction: an expired shard leaves the min only via
  `epoch = epoch+1` + frontier bump on that row, which *blocks behind any in-flight commit's
  row lock* — the straggler either lands-and-is-counted or aborts. No skipped ts, by
  construction, including failover.
- **Readers:** fleet-safe snapshot `F = min(frontier_ts)` over all shard rows; frontier
  closing is node-batched and event-driven (~10–30 ms, O(nodes) not O(shards)); tailers pull
  `(wm, F]` with per-shard `prev_ts` density assertions; queries/subscriptions/`StateVersion`/
  cursors evaluate at F — **scalar versions, byte-identical client protocol, true consistent
  cross-shard snapshots** (a subscription spanning shards can never see effect-before-cause).
- **Routing DX:** `.shardKey("channelId")` on the table + `shardBy: "channelId"` on the
  mutation; resolution server-side at the existing `WriteRouter` chokepoint; clients stay
  shard-blind. `stackbase dev` runs **8 virtual shards in one process** so shard mistakes
  error on the laptop, day one; unsharded apps are byte-identical on the default shard.
- **OCC scope:** full serializability per shard (today's machinery verbatim); cross-shard
  transactions rejected (locked); global-table reads inside sharded mutations are
  stable-snapshot-at-F (documented write-skew class, auth-revocation lag ~10–100 ms named
  explicitly; escape hatch = run on the default shard).
- **Honest failure envelope:** a crashed writer stalls only its shard (≤ lease TTL); a
  wedged-but-alive writer stalls fleet-wide *visibility* (never correctness) for bounded
  single-digit seconds (`idle_in_transaction_session_timeout` + fence) — observable, named in
  the dashboard, and the deliberate price of one timeline.

**Uniqueness, honestly stated:** every ingredient is borrowed (CRDB's closed timestamps,
Convex's repeatable-ts, FoundationDB's order/execute split, Lunora/VoltDB's per-shard
writers) — **the conjunction is what nobody ships:** live range-precise cross-shard reactive
subscriptions at true consistent snapshots over parallel serializable-per-shard writers, on
vanilla Postgres, zero added services, byte-identical client. The novel micro-mechanism is
lease=fence=frontier as one commit-atomic row with lock-serialized min-eviction — and it
ports to the object-storage substrate (CAS frontier manifests).

## Why the rivals died (short form — full autopsy in the verdict)

- **B (per-shard logs):** permanent cross-session effect-before-cause on the headline
  cross-shard-subscription feature (invisible in every dev environment), unbounded frozen-read
  staleness incl. auth, a four-tier consistency model to teach, the largest wire/migration
  surface. Its commit-atomic frontier-on-the-lease-row mechanism became the winner's safety core.
- **C (sequenced batches):** unflaggable bet-the-engine slice 0, a ~31-day 2^53 truncation
  bomb, unspecified batch-abort semantics, one wedged node = silent fleet-wide read freeze.
  Its tier-uniform guards, group commit (B4), and O(nodes) economics were grafted.

## Slice plan (each independently shippable)

- **B1 — Fenced frontier at one shard**: pure hardening of the SHIPPED fleet (closes its
  skipped-ts/promotion-fencing class), behavior-identical, valuable even if sharding stopped here.
- **B2 — N shards live**: `shardBy` API + codegen cross-check + kernel guards at every tier,
  per-shard leases/transactors/drivers, split snapshot, frontier closing, 8-virtual-shard dev,
  the 2-writer cross-shard-subscription E2E.
- **B3 — latency/ops polish** (single-shard fast path, stall alerting).
- **B4 — per-shard group commit** (the Postgres-fsync ceiling raise — where the throughput
  headline gets earned).
- **B5 — design-doc only**: object-storage substrate mapping, offline reshard tool.

## Open questions for the spec phase

NUM_SHARDS default · single-shard fast-path wire semantics · stall UX contract defaults ·
the serializable-globals escape hatch surface · replica apply amplification measurement
(see verdict §c for full statements).
