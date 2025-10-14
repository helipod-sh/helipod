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
slice concludes assessed-not-worth-it** (the B3 fast-path precedent) with numbers on record
— the batching code then ships dark-off or is reverted, decided at the gate with the user.

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
  (the shipped `GREATEST(nextval, MAX+1)` discipline per unit), stamp + INSERT its rows,
  write its idempotency row when `meta.idempotencyKey` present; ONE commit-guard invocation
  per batch (epoch fenced once; the guard's frontier UPDATE uses the batch's LAST ts) — the
  guard signature is unchanged, invoked with the last unit's ts; COMMIT. A guard fence or
  any error aborts the WHOLE transaction (no unit lands).
- **SQLite:** same contract — one BEGIN..COMMIT stamping consecutive `MAX+1` ts's per unit
  (Tier-0 gets fsync amortization too; same code path, no special-casing).
- `commitWrite` (single) remains and delegates to a one-unit batch — one implementation.
- Conformance suite additions run on BOTH stores: unit order = ts order; atomicity (a
  failing unit aborts all); per-unit meta rows; density of per-doc chains across units.

### D2. The ShardWriter committer loop

Under the mutex (fast, in-memory — no store txn I/O):
1. **Validate** against `recentCommits` ∪ `pendingBatch.writes` (pending writes are
   logically after every current snapshot — a validated read intersecting a pending write
   aborts with `OccConflictError` exactly as if the write had committed).
2. **Batch-cut rule:** if any staged doc id is already WRITTEN by a pending unit (only
   reachable via blind writes — an RMW would have aborted in step 1), do not stage: mark
   the batch "cut", await the in-flight flush, then stage into the next batch. No
   within-batch same-doc entries ⇒ prev_ts always chains to a COMMITTED revision via the
   existing `docStore.get(w.id)` (which stays correct because same-doc predecessors are
   never pending).
3. **Stage:** append the unit (entries with prev_ts resolved, indexWrites, commitMeta) +
   its promise resolver to the shard's pending batch. Return the promise.
The **committer loop** (one per ShardWriter, started lazily): while the queue is non-empty
— take the ENTIRE pending batch, `commitWriteBatch`, then in batch order per unit:
`recentCommits.push({ts_i, writes_i})`, `oracle.publishCommitted(ts_i)`, build the unit's
own `OplogDelta`, `fanout.publish` — then resolve its promise with `{value, commitTs:
ts_i, oplog}`. Prune once per batch.
- **OCC retry loop change:** on `OccConflictError` where the conflict was against a PENDING
  write, the retry FIRST awaits the in-flight flush (kills the livelock — the re-execution
  then snapshots at a lastCommitted that includes the conflicting write). Conflicts against
  committed writes retry immediately as today.
- **Failure contract:** a flush error rejects EVERY unit's promise with the store error
  (retryable per the existing per-path semantics); a `FencedError` rejects all units with it
  (the fleet's relinquish fires once — its dispatcher is already idempotent); the pending
  batch is discarded; `recentCommits`/oracle NEVER see the failed ts's.
- **Ordering invariant:** publish/fan-out strictly in batch order (unit i before i+1), and
  no unit of batch K publishes before batch K-1 fully published (single committer loop ⇒
  free).

### D3. What deliberately does not change

Per-mutation oplog/fan-out/invalidation ranges and `commitTs` (the sync tier never sees
batches) · RYOW (`waitFor`/`beforeNotify` gate on each unit's own ts) · B3 idempotency (N
meta rows in one txn; the 23505 discrimination unchanged — a duplicate key in a batch
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
