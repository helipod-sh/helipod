# Fleet B4 — Per-Shard Group Commit

**Status:** approved design (brainstormed 2025-10-01)
**Protocol basis:** `docs/dev/research/write-sharding/verdict.md` §d (B4 — the throughput headline)
**Builds on:** main `fea9f7f` (B1 fenced frontier · B2a/B2b sharding · B3 hybrid + effectively-once).

## Goal

Amortize per-commit I/O: while one flush is in flight, ready mutations on the same shard
accumulate and the next flush commits them as ONE store transaction (N consecutive
timestamps, one guard UPDATE, one fsync). Natural adaptive batching — idle = batch of 1 =
today's latency; batches form only under concurrent load; no timer.

## The structural fact the design rests on

Execution is ALREADY outside the shard mutex: `ShardWriter.runInTransaction` runs `fn(ctx)`
unserialized (concurrent mutations execute at concurrent snapshots) and takes the mutex only
for `commit()` = validate → prev_ts reads → `commitWrite` (the full store txn I/O) →
publish. OCC validation at commit already handles execution races. Group commit therefore
does NOT touch execution semantics — it splits the mutex-held commit section (fast,
in-memory staging) from the flush I/O (a per-shard committer loop).

## Non-goals

Cross-shard batching (each shard's committer is independent) · timer-based batching (the
natural pipeline is the design; a knob can come later if ops demands it) · changing the
public mutation contract in any way (latency at idle, error shapes, RYOW, per-mutation
fan-out all identical) · within-batch prev_ts chaining (the batch-cut rule below removes
the need).

## Honest abort criterion (benchmark-first)

Task 1 builds the commit-throughput benchmark BEFORE any batching code: single shard + 8
shards, insert-heavy and RMW mixes, PGlite AND real-container Postgres, concurrent-client
load. Baseline numbers recorded. **If the final real-PG concurrent-load win is < 2×, the
slice concludes assessed-not-worth-it** (the B3 fast-path precedent) with numbers on
record. **The dark-off mechanism is defined up front (spec-review edit):**
`STACKBASE_GROUP_COMMIT` — the committer path is built behind it, default **on** once the
gate's ≥2× number is in hand, default **off** (single-commit path byte-identical) if the
criterion misses; either way the flag ships, so the miss case needs no revert and the ops
escape hatch exists from day one.

## Design

### D1. `commitWriteBatch` — the store contract

```
DocStore.commitWriteBatch(
  units: Array<{ documents: DocumentLogEntry[]; indexUpdates: IndexWrite[];
                 meta?: Record<string, string> }>,
  shardId?: ShardId,
): Promise<bigint[]>   // one ts per unit, strictly increasing, allocated in unit order
```
- **Postgres:** one transaction on the shard's commit connection: for each unit — nextval
  (the shipped `GREATEST(nextval, MAX+1)` discipline per unit), stamp + INSERT its rows;
  then ONE guard invocation with a **batch-shaped contract (spec-review edit — resolves a
  confirmed contradiction: the B3 idempotency INSERT lives INSIDE the fleet guard, so a
  single last-ts guard call would silently drop units 1..N-1's `fleet_idempotency` rows and
  record the wrong ts on the last — breaking effectively-once replay):**
  `setCommitGuard((q, units: Array<{ts: bigint; meta?: Record<string,string>}>, shardId))`
  — the fleet guard epoch-fences ONCE, runs the frontier UPDATE ONCE at
  `GREATEST(frontier_ts, ts_N)`, and loops the per-unit `meta_i.idempotencyKey` INSERTs
  each at its own `ts_i`. (The single-commit path passes a one-unit array — one contract.)
  COMMIT. A guard fence or any error aborts the WHOLE transaction (no unit lands).
  Conformance/E2E assertion: after a batched flush with N keyed units, N DISTINCT
  fleet_idempotency rows exist, each at its own unit's commitTs.
- **SQLite:** same contract — one BEGIN..COMMIT stamping consecutive `MAX+1` ts's per unit.
  **(Spec-review honesty edit:** SQLite's flush is synchronous, so nothing accumulates
  during it — natural batching on Tier-0 is opportunistic and typically batch-of-1; the
  shared code path is correct-but-inert there, and the throughput claim is Postgres-only.)
- `commitWrite` (single) remains and delegates to a one-unit batch — one implementation.
- Conformance suite additions run on BOTH stores: unit order = ts order; atomicity (a
  failing unit aborts all); per-unit meta rows; density of per-doc chains across units.

### D2. The ShardWriter committer loop

**The two-buffer reality (spec-review edit — THE corruption fix; the review's prime-suspect
confirmation):** while the committer loop flushes a detached **flushingBatch** OFF the
mutex, new stagers fill a fresh **pendingBatch**. A unit's writes must stay visible to
validation and to the batch-cut from the moment it is staged until its ts lands in
`recentCommits` — i.e. the loop moves write-visibility pending → flushing → ring, never
dropping it. Consulting only the pending buffer would (a) let a blind write to a doc in the
FLUSHING batch stage a prev_ts below the about-to-land revision — a forked chain → replica
density violation → tailer halt; and (b) silently miss read/write conflicts against
flushing units — a lost update.

Under the mutex (fast, in-memory — no store txn I/O):
1. **Validate** against `recentCommits ∪ flushingBatch.writes ∪ pendingBatch.writes` (all
   staged writes are logically after every current snapshot — a validated read intersecting
   any of them aborts with `OccConflictError` exactly as if the write had committed).
2. **Batch-cut rule:** if any staged doc id is already WRITTEN by a unit in the FLUSHING or
   PENDING batch (only reachable via blind writes — an RMW would have aborted in step 1),
   do not stage: await until that unit's batch is promoted to the ring, then stage. No
   in-flight same-doc entries ⇒ `docStore.get(w.id)` for prev_ts always reads a COMMITTED
   revision (and stays race-free: the get runs under the mutex, and a flush landing between
   the cut-check and the get only makes the get see the newer committed revision — correct).
3. **Stage:** append the unit (entries with prev_ts resolved, indexWrites, commitMeta) +
   its promise resolver to the shard's pending batch. Return the promise.
The **committer loop** (one per ShardWriter, started lazily): while the queue is non-empty
— detach the ENTIRE pendingBatch as the new flushingBatch, `commitWriteBatch`, then in
batch order per unit: `recentCommits.push({ts_i, writes_i})`, `oracle.publishCommitted
(ts_i)`, build the unit's own `OplogDelta`, `fanout.publish` — then resolve its promise
with `{value, commitTs: ts_i, oplog}`; finally clear the flushingBatch. Prune once per
batch.
- **OCC retry loop change (spec-review precision):** on `OccConflictError` against an
  in-flight (flushing OR pending) write, the retry FIRST awaits **the conflicting unit's
  batch promotion to the ring** — not merely "the current flush" (the conflictor may sit in
  the not-yet-flushing pending buffer) — then re-executes at a lastCommitted that includes
  it. Conflicts against ring entries retry immediately as today. (Implementation: tag the
  conflict with the buffer's flush promise.)
- **Snapshot-retention note (spec-review edit):** an in-flight unit stays snapshot-retained
  until its promise resolves, so `minActiveSnapshot` pins ring pruning for the flush window
  — bounded by in-flight concurrency, not a leak; stated for the implementer.
- **Failure contract:** a flush error rejects EVERY unit's promise with the store error
  (retryable per the existing per-path semantics); a `FencedError` rejects all units with it
  (the fleet's relinquish fires once — its dispatcher is already idempotent); the pending
  batch is discarded; `recentCommits`/oracle NEVER see the failed ts's.
- **Ordering invariant:** publish/fan-out strictly in batch order (unit i before i+1), and
  no unit of batch K publishes before batch K-1 fully published (single committer loop ⇒
  free).

### D3. What deliberately does not change

Per-mutation oplog/fan-out/invalidation ranges and `commitTs` (the sync tier never sees
batches — the tailer observes a batch as N ts's appearing atomically in one MVCC commit
with F = ts_N; each unit's RYOW wait resolves together, meaning a fast unit's RYOW now
waits for its batch's slowest sibling — correct, stated) · RYOW (`waitFor`/`beforeNotify`
gate on each unit's own ts) · B3 idempotency (per-unit rows at per-unit ts via the
batch-shaped guard, D1; the 23505 discrimination unchanged — a duplicate key in a batch
aborts the whole flush and every unit retries, the duplicate replaying at the handler as
shipped) · density (per-doc prev_ts chains; ts gaps normal since B1) · fencing semantics
(fence = the whole batch aborts = N retryable failures; frontier = batch's last ts is a
valid frontier for all units) · the pure-read path (untouched — no mutex, no batch) ·
Tier-0/dev behavior (same code path; batch of 1 at low concurrency).

### D4. Observability

The health endpoint's fleet section gains `groupCommit: { lastBatchSize, maxBatchSize,
flushesPerSec }` (cheap counters on the committer loop); the benchmark harness reads them
to prove batching actually engaged under load.

## Error handling summary

| Failure | Behavior |
|---|---|
| Flush store error | Every unit rejects retryably; batch discarded; ring/oracle untouched |
| Fence mid-batch | Every unit rejects FencedError; one relinquish; retries route to the new owner |
| RMW vs pending write | OccConflictError; retry awaits the in-flight flush, then re-executes |
| Blind write vs pending same-doc write | Batch-cut: await flush, stage next batch |
| Duplicate idempotency key within a batch | Whole flush aborts (PK); units retry; duplicate replays at the handler (shipped path) |
| Committer loop crash | Impossible to swallow: any throw rejects the batch and the loop re-enters on next stage (test: a poisoned unit doesn't wedge the shard) |

## Testing

- **Unit (both stores via conformance + transactor):** commitWriteBatch (order/atomicity/
  meta/density); the committer loop (natural batching: stage 10 while flush 1 in flight →
  2 flushes; idle → N flushes of 1); validation-vs-pending (RMW aborts + retry-awaits-flush
  + succeeds with the pending write visible); batch-cut (blind write same doc → cut, chains
  correct); failure contract (flush error rejects all; ring/oracle clean; next batch
  proceeds); ordering invariant (fan-out sequence strictly unit-ordered); fence-mid-batch
  (all reject, relinquish once); pure reads unaffected.
- **Benchmark (T1, before batching; re-run at gate):** ops/s single-shard + 8-shard,
  insert-heavy + RMW 80/20, 1/8/64 concurrent clients, PGlite + real PG; results table in
  the report + docs.
- **E2E ship gate** (extend fleet-e2e): a concurrent-load scenario (64 clients hammering
  sharded inserts + RMWs through the sync node for ~10s on a multi-writer fleet):
  throughput quoted before/after (the ≥2× criterion on real PG); dense-chain SQL over the
  whole run; zero ts=0; effectively-once spot-check under load (duplicate forward mid-storm
  replays); RYOW spot-checks; `groupCommit.maxBatchSize > 1` observed (batching engaged);
  existing scenarios byte-unmodified.

## Docs

`docs/enduser/deploy/fleet.md`: a short throughput note (writes batch automatically under
load; numbers from the gate; no knobs). `write-sharding-research.md`: B4 status + the
benchmark table; B5 (reshard design-doc) remains.
