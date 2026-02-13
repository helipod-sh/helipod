# Tier 3 Slice 5 — replicas + cross-node reactivity (implementation plan)

> REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Grounded in the design record (§7
> cold-start/replica, §8 reactivity/frontier, §6c watermark GC), Slices 1–4 (shipped), and the recon of
> the SHIPPED Postgres fleet's `ReplicaTailer` + `invalidationSink` (the pattern this slice ports to
> object storage).

**Goal:** turn single-writer-per-shard failover (Slice 4) into a live multi-node fleet: a replica node
materializes a shard from object storage, tails the writer's new segments, and drives its OWN reactive
fan-out so its local subscribers see the writer's commits (cross-node reactive propagation) — plus a
consumer-watermark so GC never deletes a segment a lagging replica still needs.

**Architecture (the SHIPPED fleet pattern, ported to object storage):**
- The shipped `ReplicaTailer` (ee/packages/fleet/src/replica-tailer.ts) pulls `(watermark, F]` from a
  Postgres primary, applies via `DocStore.write(...,"Overwrite")`, builds an `AppliedInvalidation`
  `{newMaxTs, writtenTables, writtenKeys, writtenDocs}`, calls an `onInvalidation` sink, then advances
  its watermark. The sink (`node.ts` `invalidationSink`) drives the reactive tier via
  `runtime.observeTimestamp(ts)` → `runtime.handler.notifyWrites({tables, ranges, commitTs})` →
  `runtime.notifyExternalCommit(...)`. **This slice builds the object-storage analog.**
- The object-storage analog: the writer's `manifest.frontierTs` is the primary's `frontier_ts`; the
  `segments`/`nextSeqno` are the log the replica pulls; `ObjectStoreDocStore.open()` (materialize
  without acquiring — Slice 4 already supports this) is the replica's bootstrap; the replica then POLLS
  the manifest and pulls newly-referenced segment objects, applying them via `local.write(...,
  "Overwrite")` (the SAME primitive `materializeTo` uses) while CAPTURING the applied rows into an
  `AppliedInvalidation` (which `materializeTo` currently discards — the gap).
- **Frontier F** = `min(frontierTs)` over the N shard manifests (a LIST/GET per shard), monotone,
  partial-manifest-set → not-ready — the object-storage analog of `ReplicaTailer.readFrontier`.
- **Watermark GC:** replicas publish a `consumers/{id}` object carrying their applied seqno; `gc()`
  computes `W_min = min(consumer appliedSeqno)` and only deletes segments a lagging replica no longer
  needs (`seqno <= min(snapshotSegBase, W_min)`), closing the Slice-3/4 GC-under-replicas deferral. The
  tailer additionally falls back to re-materialize-from-snapshot if it has fallen behind
  `snapshotSegBase` (or a referenced segment was raced away by GC) — the correctness backstop.

**Reuse (binding):** `ObjectStoreDocStore.open()` (materialize-no-claim), `materializeTo`/the
`write(...,"Overwrite")` apply path, the segment/snapshot codecs, `readManifest`, `readGlobals`. Mirror
`ReplicaTailer`'s tick()/start()/waitFor() shape + its `AppliedInvalidation`-building (replica-tailer.ts
~:476-488) and `invalidationSink`'s reactive wiring (node.ts ~:1358). The substrate must NOT depend on
`@stackbase/fleet`; define a local `AppliedInvalidation` shape (the tailer's output contract) — the
runtime wiring is the composer's job (the E2E, mirroring `invalidationSink`).

**Boundary (do NOT build here):** the production runtime-integration that constructs a replica node
inside `stackbase serve` / a real CLI entrypoint, and the heartbeat-driver wiring, are Slice 6
(hardening + real-cloud bench + reshard). Slice 5 proves the tailer + reactive propagation + watermark
GC through `createEmbeddedRuntime` in tests (the same way the Slice-2 runtime E2E did), not through the
CLI. Multi-region/cross-bucket stays out (design §12).

## Global constraints (+ the whole-arc plan's)
- ee/-gated (`@stackbase/objectstore-substrate`). Engine never imports an S3 SDK.
- The tailer holds NO ambient clock — it polls the manifest (no `now` needed for tailing; only the
  writer's lease heartbeat needs `now`, which is the writer's concern, unchanged).
- The tailer applies verbatim via `write(...,"Overwrite")` — never `commitWriteBatch` (which requires a
  held lease; a replica never acquires). No new apply path.
- Frontier F is asserted monotone non-decreasing; a partial manifest set (fewer than `numShards`
  manifests present) → F not ready (mirror `ReplicaTailer.readFrontier`'s `count < numShards → 0` guard,
  the F1×N hole guard).
- GC stays safe under object-store eventual consistency: deletes only below `min(snapshotSegBase,
  W_min)`; the tailer's missing-segment→snapshot fallback is the backstop (design §10 row).
- Carried Slice-4 note: globals/receipts are local-only; a replica materialized from object storage
  alone does NOT reconstruct receipts/deploymentId beyond `readGlobals` — fine for a read replica, but
  document that a replica participating in the sync handshake (client dedup) needs the writer's receipts
  (out of scope here; a replica serves queries/subscriptions, not client mutation dedup).

## Task 5.1 — `ObjectStoreReplicaTailer` (poll → pull → apply → AppliedInvalidation → watermark) + frontier F
**Files:** `ee/packages/objectstore-substrate/src/replica-tailer.ts` (new); `src/frontier.ts` (new, the
min-over-manifests helper); `src/index.ts` (exports); tests.

- **`AppliedInvalidation`** (local type): `{ newMaxTs: bigint; writtenTables: string[]; writtenKeys:
  { indexId: string; key: Uint8Array }[]; writtenDocs: { tableId: string; internalId: Uint8Array }[] }`.
- **`readGlobalFrontier(os, shards: string[]): Promise<bigint>`** (frontier.ts): GET each `s{shard}/
  manifest`, return `min(BigInt(frontierTs))`; if any shard's manifest is absent → return `0n` (not
  ready — partial-set guard). (A single-shard replica passes `[shard]`.) Pure read helper; the caller
  asserts monotonicity.
- **`ObjectStoreReplicaTailer`** class:
  - ctor `{ objectStore: ObjectStore; shard: string; local: SqliteDocStore; onInvalidation: (inv:
    AppliedInvalidation) => Promise<void>; pollMs?: number }`. The `local` is the replica's materialize
    target — the caller `open`s an `ObjectStoreDocStore` (or just uses the bare `SqliteDocStore`) first
    to bootstrap; the tailer holds `local` + tracks an in-process `appliedSeqno` (start = the manifest
    cursor it bootstrapped to) and `appliedMaxTs` (= `local.maxTimestamp()` at start).
  - `async tick(): Promise<boolean>` — one poll round:
    1. `readManifest(objectStore, shard)`. If `manifest.frontierTs <= appliedMaxTs` (nothing new) →
       return false.
    2. **Fallen-behind-snapshot check:** if `manifest.snapshotTs !== undefined && manifest.snapshotSegBase
       >= appliedSeqno` (the replica is at/below the snapshot floor — its next segments may be GC'd),
       RE-MATERIALIZE from the snapshot: `readSnapshot` → `local.write(snap.documents, snap.indexUpdates,
       "Overwrite")`, set `appliedSeqno = snapshotSegBase`, and BUILD the AppliedInvalidation from the
       snapshot rows (so subscribers re-evaluate). Then continue to replay tail > snapshotSegBase.
    3. **Pull the tail:** for each `seqno` in `manifest.segments` with `seqno > appliedSeqno`, in order:
       `objectStore.get(segmentKey(shard, seqno))`. If null (raced GC) → fall back to the snapshot
       re-materialize (step 2 path) and restart the round. Else `decodeSegment` → `local.write(payload.
       documents, payload.indexUpdates, "Overwrite")`; accumulate the payload's rows.
    4. **Build `AppliedInvalidation`** from all applied rows this round (mirror replica-tailer.ts
       ~:476-488): `newMaxTs = max applied ts`; `writtenDocs` = DISTINCT `{tableId, internalId}` from the
       applied `documents` (derive `tableId` from each doc's `id` the SAME way the store/notifyWrites
       expects — study how `docKeyToPointRange`/the transactor's `buildWrittenDocs` name `tableId`, and
       match it); `writtenKeys` = the applied `indexUpdates`' `{indexId, key}`; `writtenTables` = DISTINCT
       tables across both.
    5. `await onInvalidation(inv)` — THEN advance `appliedSeqno = max applied seqno`, `appliedMaxTs =
       newMaxTs` (advance ONLY after the sink resolves — mirror replica-tailer.ts:490-494). Return true.
  - `start(): void` (setInterval(tick, pollMs ?? 1000), swallow tick errors like the shipped tailer) /
    `stop(): void`.
  - `get appliedSeqno(): number` / `get appliedMaxTs(): bigint` (for consumer-watermark publish + waitFor).
  - `async waitFor(ts: bigint, timeoutMs: number): Promise<void>` — resolve when `appliedMaxTs >= ts`
    (poll-driven; drive `tick()` in a loop or await a satisfied-waiter latch — mirror
    ReplicaTailer.waitFor's contract).
- Export all from `src/index.ts`.
- [ ] 5.1a Failing test: a WRITER `ObjectStoreDocStore` (open+acquire) commits 2 batches to shard "0" on
      an fs bucket; a separate REPLICA `SqliteDocStore` bootstrapped via `ObjectStoreDocStore.open` (no
      acquire); an `ObjectStoreReplicaTailer` over the replica's local store with a capturing
      `onInvalidation`. Call `tick()` → it applies the writer's segments (replica `scan`/`get` now sees
      them), emits an `AppliedInvalidation` whose `writtenDocs`/`writtenTables`/`newMaxTs` match the
      commit, and advances `appliedSeqno`/`appliedMaxTs`. A second `tick()` with no new commits → false.
- [ ] 5.1b Failing test (frontier): `readGlobalFrontier(os, ["0","1"])` over a bucket with both shard
      manifests → min(frontierTs); with only shard 0's manifest present → `0n` (partial-set not-ready).
- [ ] 5.1c Failing test (snapshot fallback): writer commits > SNAPSHOT_EVERY (forces a snapshot) and
      `gc()`s (deletes pre-snapshot segments); a replica whose `appliedSeqno` is BELOW `snapshotSegBase`
      `tick()`s → it re-materializes from the snapshot (does NOT fail on the GC'd segments) and converges
      to the writer's current state. Implement; run → green. Commit.

**Gate:** a replica tails a writer's segments over object storage, materializes verbatim, emits the
correct invalidation, advances its watermark, computes the cross-shard frontier, and survives GC'd
pre-snapshot segments via the snapshot fallback.

## Task 5.2 — Watermark-aware GC (consumer watermark publish + `gc()` respects `W_min`)
**Files:** `src/consumers.ts` (new — consumer watermark objects); `src/object-doc-store.ts` (`gc()`
gains a W_min floor); tests.
- **`consumers.ts`:** key `consumers/{consumerId}`; `publishConsumerWatermark(os, consumerId, {
  appliedSeqno }): Promise<void>` (a plain `putImmutable`-overwrite? NO — putImmutable is keep-first now;
  use a small `casPut`-based upsert OR a dedicated overwrite. A watermark MUST be overwritable as it
  advances — add a narrow `os.casPut(key, bytes, currentEtag)` upsert helper reading its own prior etag,
  OR since watermarks are single-writer-per-consumer, a simple read-etag-then-casPut loop). Provide
  `readConsumerWatermarks(os): Promise<{ consumerId: string; appliedSeqno: number }[]>` (LIST
  `consumers/` + GET each). `removeConsumer(os, consumerId)` for a departing replica.
- **`gc()` W_min floor:** read all consumer watermarks; `W_min = consumers.length ? min(appliedSeqno) :
  +Infinity`; delete segments with `seqno <= min(snapshotSegBase, W_min)` (was just `snapshotSegBase`).
  With no consumers, behavior is IDENTICAL to Slice 3 (W_min = +Inf → floor is snapshotSegBase). Snapshot
  GC unchanged (a replica always restores the NEWEST snapshot; keep-newest stays correct). Update the
  gc() doc (the Slice-4 note said gc-fencing is deferred — clarify: this adds the consumer-watermark
  floor for read-replica safety; epoch-fencing gc() against a stale WRITER is still Slice-6/deferred).
- [ ] 5.2a Failing test: writer commits enough for a snapshot at segBase=k + a tail; a consumer publishes
      `appliedSeqno = j` with `j < k`; `gc()` deletes only `seg <= j` (NOT up to k — the lagging consumer
      still needs `(j, k]`), keeps `(j, …]`. With the consumer advanced to `>= k` (or removed), a second
      `gc()` reclaims up to `k` as before.
- [ ] 5.2b Failing test: no consumers → `gc()` behaves exactly as Slice 3 (floor = snapshotSegBase).
      Implement; run → green. Commit.

**Gate:** GC respects the slowest consumer's watermark (never strands a lagging replica), and is
unchanged when no consumers are registered.

## Task 5.3 — Headline E2E: cross-node reactive propagation (writer runtime + replica runtime), fs + MinIO
**Files:** `test/cross-node-reactivity.e2e.test.ts`.
- Mirror the Slice-2 `runtime.e2e.test.ts` + the fs-always-on/MinIO-gated harness (bootstrap.e2e.test.ts).
  A shared `scenario(makeBucket)`:
  1. **Writer node:** `ObjectStoreDocStore.open`+`acquire` shard "0"; a `createEmbeddedRuntime({ store:
     writerDocStore, ... })`; register a simple query + a mutation (reuse the Slice-2 runtime E2E's
     fixture module shape). Commit a mutation through the runtime → it lands in the bucket.
  2. **Replica node:** a FRESH local `SqliteDocStore`; `ObjectStoreDocStore.open` (NO acquire) to
     bootstrap it to the writer's current state; a SECOND `createEmbeddedRuntime({ store: replicaLocal,
     ... })`; an `ObjectStoreReplicaTailer` over `replicaLocal` whose `onInvalidation` sink mirrors the
     fleet's `invalidationSink`: `replicaRuntime.observeTimestamp(inv.newMaxTs)` → convert
     `writtenKeys`/`writtenDocs` to point ranges (the SAME conversion `node.ts`'s `invalidationSink`
     does — reuse `keyToPointRange`/`docKeyToPointRange` if exported, else inline) →
     `replicaRuntime.handler.notifyWrites({ tables, ranges, commitTs })` →
     `replicaRuntime.notifyExternalCommit(...)`.
  3. **The headline assertion:** open a live subscription on the REPLICA runtime to the query; the
     writer commits a NEW mutation through its runtime; drive the tailer's `tick()` (or `start()` +
     `waitFor`); assert the REPLICA's subscription fires with the writer's new data (cross-node reactive
     propagation — a commit on node A becomes visible + reactive on node B, through object storage
     alone, no shared database).
  4. Also assert `readGlobalFrontier` advanced to the writer's frontier after the tailer applied.
- [ ] 5.3a fs variant (always-on) + MinIO-gated variant (`dockerAvailable() &&
      STACKBASE_OBJECTSTORE_S3==="1"` → describe.skip). Build/typecheck/test green (default skips MinIO).
      If docker available, run the gated arm once and report. Commit.

**Gate (headline):** a mutation committed on the writer node fans out reactively to a subscription on a
SEPARATE replica node whose only link to the writer is the object-storage bucket — proven on fs AND real
MinIO. Multi-node reactive fleet over object storage, no shared database.

## Self-review
- Covers design §7 (replica bootstrap+tail), §8 (cross-node frontier + reactive propagation via the
  documented injection surface), §6c (watermark GC). The production runtime/CLI integration + heartbeat
  driver + reshard + real-cloud bench are Slice 6 (stated). Multi-region is out (§12).
- Reuse honored: `open`(no-claim)/`materializeTo`/`write("Overwrite")`, segment/snapshot codecs,
  `readManifest`; mirrors the shipped `ReplicaTailer`/`invalidationSink` (no `@stackbase/fleet` dep — a
  local `AppliedInvalidation`; wiring lives in the E2E/composer).
- Type consistency: `AppliedInvalidation` fields feed `handler.notifyWrites`'s `WriteInvalidation`
  ({tables, ranges, commitTs}) after the same point-range conversion the fleet sink uses;
  `appliedSeqno`/`snapshotSegBase`/`W_min` are all seqno-space integers; `frontierTs`/`newMaxTs` are
  ts-space bigints (decimal strings on the wire, matching the manifest convention).
- Correctness backstops: frontier monotonicity + partial-set guard (F1×N hole), watermark-floored GC +
  snapshot fallback (eventual-consistency safety), advance-watermark-after-sink (no missed invalidation).
