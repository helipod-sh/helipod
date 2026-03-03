# Multi-shard replicas — design

**Status:** approved 2026-02-20. Closes the last deferred item of the Tier-3 object-storage arc
(see [[tier3-object-storage-arc]] memory; `docs/superpowers/specs/2025-12-25-tier3-object-storage-substrate-design.md`).

## Problem

`stackbase serve --object-store <url> --replica` (Slice 8) boots a read-scaled replica that tails
**shard `"0"` only**. On a multi-shard bucket (`globals.numShards > 1`, produced by a `--shards N`
writer or by `objectstore reshard`), a replica silently serves **1/N of the data**: it materializes and
tails one lane, and reads/reactivity for every other lane are simply absent. This is the mirror gap to
the writer path, which was already generalized to N lanes (`buildObjectStoreWriterNode`,
`ShardedObjectStoreDocStore`). This slice generalizes the replica path the same way.

## Key realization (why this is small)

Every mutation is **single-lane**: `shardBy` routes each write to exactly one shard, and the engine's
write-ownership guard rejects a cross-shard write. So every commit is exactly one segment in one lane's
log. Therefore N lanes can be tailed **completely independently** — no cross-lane ordering, no barrier,
no coordinator — and per-commit atomicity is preserved for free (a commit is atomic within its lane; there
is no such thing as a cross-shard transaction to tear).

Two shipped pieces carry the weight:
- **`ShardedObjectStoreDocStore`** — the multi-shard READ composite (get → first non-null lane;
  index_scan/load_documents → per-lane sorted streams k-way-merged; scan/count → fan-out+union;
  globals → default lane). Already built + tested for the writer path.
- **`startReplicaReactiveTailer` / `ObjectStoreReplicaTailer`** — the single-shard reactive tailer,
  battle-tested through Slices 5 & 8: redelivery-safety (advance `appliedSeqno` only post-sink),
  `stop()` awaits an in-flight pump before returning, post-advance watermark publish. Every subtle
  concurrency bug in it is already caught and fixed.

## Design (Approach A: N independent tailers)

Mirror exactly how `buildObjectStoreWriterNode` was generalized from single- to multi-shard.

### 1. `buildObjectStoreReplicaNode` → N materialized lanes behind the read composite

- Read `globals.numShards` (authoritative — adopt, never mint; same discipline as the writer path).
- `shardIds = numShards > 1 ? [...shardIdList(numShards)] : ["0"]`.
- For each lane: `makeLocalSqliteStore(laneDataPath)` where `laneDataPath = numShards > 1 ?
  \`${dataPath}.${shardId}\` : dataPath` (byte-identical single-shard path), then
  `ObjectStoreDocStore.open({ objectStore, shard: shardId, local })` — **materialize only, NO acquire**
  (a replica never claims a lease). Seed `RUNTIME_DEPLOYMENT_ID_GLOBAL_KEY` on each lane's local, as the
  single-shard path does.
- Compose: `numShards === 1` → the single lane store directly (byte-identical to today);
  `> 1` → `new ShardedObjectStoreDocStore(lanes, { defaultShard: DEFAULT_SHARD })`.
- Wrap the **composite** (or the single store) in `wrapReplicaWriteRejection` — writes reject for free
  (no lease anywhere), with the clear "read replica" DX message, exactly as today.

### 2. `attachTailer(runtime)` → N tailers, one per lane, one shared runtime

- Keep the per-lane `local` handles from step 1.
- For each lane, start `startReplicaReactiveTailer({ runtime, objectStore, shard: shardId,
  local: laneLocal, consumerId: \`${consumerId}:${shardId}\`, pollMs })`. All N drive the SAME
  runtime's reactive fan-out (`observeTimestamp` → `notifyWrites` → `notifyExternalCommit`).
- The consumerId is per-lane-scoped (`{consumerId}:{shardId}`) so each lane's watermark lives under its
  own `s{shard}/consumers/` and floors only that lane's writer gc. The base `consumerId` stays
  per-process (`defaultReplicaConsumerId()`), so two replicas never collide.
- `release()` stops ALL N tailers (`Promise.all(handles.map(h => h.stop()))`) and then
  `removeConsumer(objectStore, shardId, laneConsumerId)` for each — so a departing replica stops pinning
  every lane's writer gc, not just lane 0's.

### 3. `bootLoaded` replica path sizes the runtime to `numShards`

The replica runtime's `numShards` must match the bucket (from globals), so the composite/router and the
reactive tier agree on the shard count — the same value the writer path threads. Single-shard replicas
keep `numShards = 1`, byte-identical to today.

## Correctness

- **`observeTimestamp` is monotonic-max** (`packages/docstore/src/timestamp-oracle.ts:34` — `if (ts >
  this.current) this.current = ts`). N lanes advancing it independently is safe: the runtime tracks the
  max, and each lane's own `notifyWrites` re-runs subscriptions whose read set intersects THAT lane's
  ranges, reading the composite (latest MVCC per key per lane). A lane that lags simply re-runs affected
  subscriptions again when it catches up. Guarantee: every committed write eventually drives a re-run
  that observes it. Cross-shard read consistency is eventually-consistent per lane — the same guarantee
  the multi-node fleet already provides, and acceptable because no cross-shard transaction exists.
- **Per-lane watermarks** are independent and correct: each writer lane's `gcDriver` reads only its own
  `s{shard}/consumers/`, so a replica's lane-K watermark floors exactly lane K's gc.
- **No new fencing / no new tailer logic** — the shipped single-shard tailer's disciplines
  (redelivery-safety, stop-awaits-inflight, post-advance publish) apply per lane unchanged.

## Scope

**In:** multi-shard replica reads (composite) + reactivity (N tailers) + per-lane consumer watermarks;
the boot/serve wiring; a real-MinIO multi-shard writer+replica E2E.

**Out:** Replica-side gc, snapshot creation, and lease acquisition remain writer-only by design (a
replica materializes + tails, never writes the bucket except its own watermark).

**Write-forwarding on a multi-shard bucket is FAILED FAST, not supported (whole-branch review correction).**
The original design claimed forwarding was "already shard-agnostic — no change needed." That is wrong: the
review found forwarding relies on the G4 origin-frontier fallback (`SyncProtocolHandler.pendingFrontiers`/
`sweepPendingFrontiers`), where a forwarded mutation commits on the writer and the replica advances the
origin session's observed frontier once its tailer drains past that commit ts. A multi-shard replica runs
one tailer PER LANE, each sweeping with its OWN lane's ts — and per-lane object-store timestamps are
independent counters, not a shared clock — so a fast lane's sweep could prematurely satisfy a forwarded
frontier owned by a lane that hasn't applied the write yet (a transient RYOW/no-flicker violation). The
tested + shipped multi-shard config is REJECT-mode; `--writer-url` on a multi-shard bucket now throws a
clear "not yet supported" error at boot (`bootLoaded`), the same fail-fast discipline as the other
object-store/fleet mutual-exclusion guards. Proper multi-shard forwarding needs a per-lane pending-frontier
design — a future slice, out of scope here. Reject-mode multi-shard and single-shard forwarding are both
unaffected.

## Test plan

- Substrate/unit: none strictly required (Approach A adds no new substrate primitive — it composes
  shipped ones). Confidence comes from the boot-level + E2E tests.
- Boot-level (hermetic, fs bucket): a `--shards 3` writer commits channelId-sharded rows across all 3
  lanes; a multi-shard replica (fresh local dirs) materializes + reads every channel back through the
  composite, and a writer commit fans out reactively to a replica subscription. Assert each lane's
  consumer watermark object exists under its own prefix.
- E2E through the real `stackbase serve` (fs + real MinIO ship gate): a 3-shard WRITER process + a
  3-shard REPLICA process over ONE bucket (two real serve processes, no shared database) — a writer
  mutation to a lane fans out reactively to a replica subscription; the replica rejects writes; each
  lane publishes its watermark; departure `removeConsumer`s every lane.

## Review

Built under the standing SDD process. If subagents are available (weekly limit was to reset 2026-03-12),
run the per-task + whole-branch opus review; otherwise build solo with heavy tests + a post-hoc
whole-branch review, as the object-storage reshard slice did. The recurring arc lesson holds: the
always-on fs test substrate can mask an S3-semantics hazard, so the multi-shard E2E's ship gate must run
against real MinIO.
