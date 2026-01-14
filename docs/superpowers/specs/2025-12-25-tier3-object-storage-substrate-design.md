# Tier 3 — the object-storage substrate: design record

**Status:** DESIGN-DOC ONLY (a substrate design record, in the tradition of the B5 record it
extends — `docs/dev/research/write-sharding/b5-reshard-and-object-storage.md`). Nothing here is
built. This document designs the three hard parts B5 Part 2 named but explicitly left undesigned —
the per-writer working set, the segment index, and watermark GC — and, in doing so, corrects the
substrate's read-path architecture. It is grounded against the shipped tree (`ee/packages/fleet/`,
`packages/transactor/`, `packages/docstore-*/`, `packages/blobstore-*/`, `packages/runtime-embedded/`).

**Goal:** break the shared-Postgres-WAL write ceiling that the write benchmarks measured
(`docs/dev/research/writes-benchmark.md`: single-node sharding plateaus ~2.6–2.85× at the shared-WAL
knee; multi-node over one Postgres scales only ~1.4×), by giving each shard a *physically
independent* durable substrate — while keeping the reactive-core protocol (scalar timeline,
min-over-frontiers, fenced eviction, verbatim log apply, byte-identical client) unchanged, exactly
as the write-sharding verdict designed it to be.

**Why object storage, not store-per-shard-Postgres:** the alternative — one Postgres *instance* per
shard — also breaks the shared WAL (each instance has its own WAL), but multiplies the operational
surface (N postmasters to run, back up, patch) and contradicts the project's lightweight /
deploy-anywhere identity. Object storage collapses the entire durable substrate to *one S3-class
bucket*: zero databases to operate, elastic, any provider (AWS S3 / MinIO / R2). It is also the
substrate the shipped protocol was deliberately built to survive onto (B5's portability thesis).
This document commits to it.

---

## 1. The core architectural decision: separation of storage and compute

The single most important — and, relative to B5, corrected — decision:

> **Object storage is a write-only durable log plus a fence. It is never queried in steady state.
> Each writer node materializes its shards' *current state* into a local store it owns, and serves
> all reads/queries/OCC from that local store.**

B5's Part 2 sketch proposed a *partial* per-writer "working-set memtable" holding recently-touched
documents, with cold documents "faulting in from segments" via a "per-shard segment index." That is
the wrong shape, for one decisive reason: **Stackbase queries are index range-scans, not point
reads.** A `.eq(...).collect()`, a `.gt().lt()` range, a `.paginate()` page — these scan an index
range and return every matching row. A partial cache + object-storage fault-in cannot serve a range
scan without, in the worst case, faulting in the whole range from object storage per query, which is
exactly the random-object-read pattern object storage is worst at. The reactive path (recording read
*ranges* for invalidation — the heart of the system) makes range scans the common case, not an edge.

So we do not point-query or range-scan the object store at all. Instead:

- **The durable truth** is the append-only MVCC log, chunked into immutable per-shard **segment**
  objects, plus one small mutable **manifest** object per shard (the lease = fence = frontier, B5's
  design). This is *write-mostly* + *bootstrap-read* — exactly what object storage is good at.
- **The queryable state** is a **local materialized store** on each writer node — reusing
  `docstore-sqlite` verbatim — holding the *current version* of every document/index entry for the
  shards that node owns. OCC validation, index range-scans, the read-set recording, and the
  reactive fan-out all run against this local store, byte-for-byte as they do today. The transactor
  does not know it is not talking to "the" store; it is talking to a local one.
- **The two are bridged** by the commit path (§4: a commit appends a segment + CAS-advances the
  manifest, and applies to the local store) and by the bootstrap path (§7: acquiring a shard's lease
  replays its log — snapshot + tail segments — into a fresh local store).

This is the "separation of storage and compute" architecture that modern serverless data systems
converge on (Neon's pageserver/safekeepers, Warpstream's brokers-over-S3, FoundationDB's
storage/log roles). Its Stackbase-specific payoff is that it **reuses three shipped, tested pieces**:

| Piece the tier needs | Shipped piece it reuses |
|---|---|
| Local queryable current-state store | `docstore-sqlite` (a local `SqliteDocStore`, `:memory:` or on local disk) |
| "Rebuild local state from the log" (bootstrap + replica) | the replica-tailer's verbatim MVCC apply (`ee/fleet/replica-tailer.ts`) |
| OCC / read-set recording / reactive fan-out over that store | the transactor + query engine, unchanged (it is just a local `DocStore`) |

The genuinely-new machinery is confined to: the **ObjectStore seam** (§3), the **segment/manifest
commit path** (§4), **snapshots** (§6b — the piece that makes bootstrap and GC tractable), and
**GC/compaction** (§6c). The "working-set memtable" and "segment index" B5 named as the two biggest
new pieces largely **dissolve**: the local store *is* the working set (full, not partial) and *is*
the index (a real B-tree, not an object-storage LSM).

The cost we accept for this: a writer node needs enough **local disk** to materialize the current
state (not the history) of the shards it owns. Current state ≪ full log, and it is per-shard, so a
node owning K of N shards holds only K/N of the live dataset. This is the deliberate trade — local
disk for the live working set, object storage for infinite durable history — and it is bounded and
reasonable.

---

## 2. What we keep from the shipped protocol (unchanged)

B5's portability thesis holds and is the reason this is tractable. These ship today and are consumed
here as-is:

- **Scalar, store-allocated `commitTs`** — a manifest-held monotone counter (or lease-granted ts
  range per writer) allocates it; `_creationTime` and the client `StateVersion` wire shape are
  untouched.
- **Shards as logical lanes; `shard_id` decorative** (B5 Part 1's structural fact) — routing always
  recomputes `shardIdForKeyValue(key, N)`; no read path filters the log by shard. Here each lane
  additionally gets its *own* segment stream + manifest, which is the whole point, but the routing
  and one-doc-one-ring invariant are identical.
- **lease = fence = frontier as one atom** — one `shard_leases` row becomes one manifest object; the
  atomic row-UPDATE-under-lock becomes an atomic manifest CAS.
- **`F = min(frontier)` across lanes; `count = N` readiness gate** — `SELECT MIN(frontier_ts)` over
  rows becomes `min(frontier_ts)` over manifests; `count(*) < N` becomes `< N manifests present`.
- **Epoch-as-fence, separate from lease-expiry**; **`commitMeta` idempotency channel** (B3
  effectively-once) — travels with the commit into the segment/manifest, no side table.
- **B4 per-shard group commit** — shipped dark-off on Postgres (the ≥2× gate came back 1.63×). Here
  it is **mandatory** (§4): one object PUT per row would floor throughput at object-store round-trip
  latency; batching a lane's queued commits into one segment + one manifest CAS is the only path to
  usable throughput. The dark code is drawn on here.

The **offline reshard tool** (B5 Part 1) ports directly: it updates the persist-once `fleet:numShards`
global and creates/deletes manifest objects for the new/surplus lanes (seeded at `MAX(ts)` per the F1
invariant), against a stopped fleet — the object-storage analog of its `shard_leases` row surgery.
Jump-hash's minimal-movement property (irrelevant when shards were logical) **becomes load-bearing**
here: a key changing lanes now means its future writes append to a different physical segment stream,
so minimizing the fraction of keys that switch streams is a real working-set/locality cost saved.

---

## 3. The `ObjectStore` seam

The file-storage `BlobStore` seam (`packages/blobstore/src/types.ts`: `createUploadTarget`/`get`) is
**not** reusable — it has no conditional write. The tier needs a new, narrow seam (the engine never
imports an S3 SDK directly, same discipline as `DocStore`):

```ts
interface ObjectStore {
  /** Immutable write. Idempotent by key — a retry with the same key+bytes is a no-op. Used for
   *  segments (content-addressed or seqno-keyed). */
  putImmutable(key: string, body: Uint8Array): Promise<void>;

  /** Conditional write — the LINEARIZATION POINT. Succeeds only if the object's current ETag equals
   *  `ifMatch` (or the object is absent when `ifMatch === null`). Returns the new ETag on success;
   *  throws `CasConflict` (etag moved) on failure. Used for the manifest CAS. */
  casPut(key: string, body: Uint8Array, ifMatch: string | null): Promise<{ etag: string }>;

  /** Read with the current ETag (for a subsequent CAS or a conditional re-GET). */
  get(key: string): Promise<{ body: Uint8Array; etag: string } | null>;

  /** List keys under a prefix (for F-recompute manifest enumeration, segment discovery, GC). */
  list(prefix: string): Promise<string[]>;

  /** Delete (GC of segments/snapshots below the watermark). Eventually consistent on many stores. */
  delete(key: string): Promise<void>;
}
```

**Feasibility — the load-bearing external dependency.** `casPut` requires object-store conditional
writes. This is now broadly available but is the tier's hard compatibility floor:

- **AWS S3**: `If-Match`/`If-None-Match` on `PutObject` (GA since Aug 2024 for `If-None-Match`,
  `If-Match` for compare-and-swap since Nov 2024). ✅
- **Cloudflare R2**: conditional `PUT` with `If-Match`/`If-None-Match`. ✅
- **MinIO**: conditional writes supported. ✅
- **Google Cloud Storage**: `x-goog-if-generation-match` (generation, not ETag — the adapter maps
  generation→the CAS token). ✅
- **Older / minimal S3-compatibles without conditional PUT**: **not supported.** The tier fails fast
  at boot on a store that cannot conditional-PUT (a startup probe: PUT-if-none-match a sentinel key
  twice, expect the second to conflict). This is a documented hard requirement, not a silent
  degradation — an object store without CAS cannot provide the one-winner fence, and there is no
  safe fallback.

An adapter (`@stackbase/objectstore-s3`) implements this over the AWS SDK's conditional PUT; a
local-filesystem adapter (`@stackbase/objectstore-fs`, using `open(O_EXCL)`/atomic-rename for CAS)
serves dev/self-host-without-a-bucket and the conformance suite — the same two-adapter (real + local)
shape as `docstore-postgres`/`docstore-sqlite`.

---

## 4. The commit path

A committing mutation on a lane's owning writer node, group-committed (B4 machinery):

1. **Execute + OCC-validate locally.** The transactor runs the mutation against the **local
   materialized store**, records read/write ranges, and validates the OCC ring exactly as today. No
   object-store I/O. This is single-digit-µs, same as the shipped in-process path.
2. **Stage into the batch.** The lane's group-commit buffer (B4's two-buffer stage-then-flush)
   accumulates ready units while a prior flush is in flight — the opportunistic batching that made
   B4 a no-latency-tax win, now essential because the flush is a network round trip.
3. **Flush = append segment + CAS manifest (the atomic pair):**
   a. `putImmutable("s{shard}/seg/{nextSeqno}", encode(batch))` — the batch's rows as one immutable
      segment object. Idempotent: a retry writes the identical object. Segment seqnos are dense
      (the `prev_ts` density role).
   b. `casPut("s{shard}/manifest", newManifest, ifMatch=lastEtag)` where `newManifest` appends the
      segment seqno, advances `frontier_ts` to the batch's last `ts`, carries the current `epoch`,
      and rolls the idempotency-key window. **This CAS is the commit's linearization point and its
      fence** — the direct analog of the shipped `UPDATE ... WHERE epoch=$myEpoch` (`lease.ts:373`).
4. **Confirm or roll back.** On CAS success, the local apply is confirmed and the reactive fan-out
   fires (the node's own subscribers see it immediately; §8). On `CasConflict`, a fencer bumped the
   epoch underneath this writer — a `FencedError`, identical to the shipped path: the batch's local
   apply is discarded, the writer self-demotes, and the units retry (deterministic replay) once the
   node re-acquires or forwards. The orphaned segment object from step 3a is harmless (unreferenced
   by any manifest; GC'd) — this is why segments are written *before* the CAS and are immutable.

**Ordering guarantee.** The segment is durable before the manifest references it, so the manifest
never points at a missing segment (a torn-forward tail is impossible). A crash between 3a and 3b
leaves an orphan segment, never a dangling reference. Group commit makes the amortized cost one
`putImmutable` + one `casPut` per *batch*, not per row.

**Timestamp allocation.** `commitTs` is drawn from a monotone counter carried in the manifest (read
at acquisition, advanced in each CAS). Alternatively, a writer that owns a lane can be granted a
`ts` *range* at acquisition (fewer CAS contentions) — an optimization, not required for correctness.

---

## 5. On-object-store layout

```
bucket/
  deployment/{id}/
    s{shard}/
      manifest                 # mutable, CAS-updated: {epoch, frontier_ts, tsCounter,
                               #   segments:[seqno...], snapshotAt, idempotencyWindow[], writerUrl}
      seg/{seqno}              # immutable segment objects (batches of MVCC rows), dense seqnos
      snap/{ts}                # periodic materialized snapshot of the shard's current state (§6b)
    globals                    # persist-once fleet globals (numShards, deploymentId) — CAS-updated
```

One manifest per lane is the unit of contention; distinct lanes are distinct object prefixes with
**zero shared contention** (B5's "per-shard writer concurrency is free — no shared connection to
pool"). This is precisely what defeats the shared-WAL ceiling: N lanes = N independent segment
streams + N independent manifest-CAS contention domains, bounded only by the object store's
per-prefix throughput (which S3 scales horizontally by prefix).

---

## 6. The three hard parts, designed

### 6a. The "working set" → the full local materialized store

B5's biggest-named-piece dissolves: it is not a partial in-memory memtable with fault-in, it is the
**complete local materialization** of the owned shards' current state in a local `SqliteDocStore`
(`docstore-sqlite`, unchanged). Every read, index range-scan, and OCC validation hits it; there is no
object-store fault-in on the read path, so there is no per-shard segment index to build. Sizing:
current-state-only (not history), per-shard, so a node owning K/N shards holds K/N of the live
dataset — local disk, spillable to the local SQLite file. This is the "compute node holds its
partition's hot state" half of storage/compute separation.

**Durability of the local store is not required** — it is a *cache of the log*. If the node crashes,
its local store is discarded and rebuilt from object storage on the next owner's bootstrap (§7). The
object-storage segments + manifest are the only durable truth. (A node MAY persist its local SQLite
across a clean restart as a bootstrap optimization — resume from its last-applied seqno — but
correctness never depends on it.)

### 6b. Snapshots → what makes bootstrap and GC tractable (the real new piece)

Replaying a shard's *entire* segment history to materialize current state is O(history) — unbounded
cold-start. The fix (and B5's unaddressed dependency for both bootstrap and GC): **periodic
per-shard snapshots.** The owning writer, on a cadence (every M segments or T seconds), writes
`s{shard}/snap/{ts}` — a materialized image of its local store's *current* state at `frontier_ts=ts`
(the current version of every doc/index entry the shard owns; no history). The snapshot's `ts` and
object key are recorded in the manifest (`snapshotAt`) on the next CAS.

Snapshots are the analog of MVCC log compaction / a checkpoint. They make:

- **Bootstrap O(state + tail)**, not O(history): a new owner restores the latest snapshot, then
  replays only `(snapshot.ts, F]` tail segments (§7).
- **GC possible**: segments entirely below the newest snapshot's `ts` are superseded (their current
  versions are captured in the snapshot) and, once no live consumer needs them for replication,
  deletable (§6c).

Snapshot writing is off the commit hot path (a background flush of a consistent read of the local
store) and is itself crash-safe: a snapshot is `putImmutable` (immutable), and only *referenced* by a
manifest CAS after it is fully written, so a half-written snapshot is never pointed at.

### 6c. Watermark GC + compaction

Two reclamation jobs, both background, both safe under object storage's eventual-consistency:

- **Segment GC.** A segment `seqno` is deletable when (i) it is entirely below the newest snapshot's
  `ts` (superseded), AND (ii) it is below the **global consumer watermark** `W_min` = the minimum
  `wm` any live replica/sync-node still needs. Consumers publish their `wm` (a small per-consumer
  object, `consumers/{id}` — or piggybacked in a heartbeat); GC reads them, computes `W_min`, and
  deletes qualifying segments *after* a safety delay (object-store deletes are eventually consistent;
  a reader mid-`GET` of a just-deleted segment retries against the manifest, which no longer
  references it, and pulls from the snapshot instead). Deleting a segment never removes data — its
  current versions live in a snapshot ≥ its ts.
- **Snapshot GC.** Keep the newest snapshot ≤ `W_min` plus the newest overall; delete older ones.

Compaction (merging many small segments into fewer larger ones, dropping superseded intra-segment
versions) is an *optional* optimization the snapshot mechanism largely subsumes — a fresh snapshot
already collapses history — so it is deferred, not required.

---

## 7. Cold start / bootstrap / replica

A node acquiring lane `s` (fresh owner, failover, or a read-only replica materializing the shard):

1. Read `s{shard}/manifest` → `{epoch, frontier_ts=F, snapshotAt, segments}`.
2. Restore `snap/{snapshotAt}` into a fresh local `SqliteDocStore` (bulk load — one object GET +
   apply).
3. Replay tail segments `(snapshotAt, F]` **verbatim** into the local store — the *exact* replica-
   tailer apply path shipped today (`replica-tailer.ts`), pointed at object segments instead of a
   streamed primary log. `prev_ts`/seqno density assertions hold (the chain is the physical chain).
4. The node is now materialized to `F` and queryable. A **writer** additionally claims the lane by
   CAS-bumping the manifest `epoch` (the fence — B5's "CAS the epoch to claim the manifest; the
   manifest is the lease") before accepting writes. A **replica** just keeps polling the manifest and
   pulling new tail segments (`F` advances), applying verbatim — read scale-out is trivial object-
   store read fan-out.

This is why "storage/compute separation" is the right frame: a replica and a writer differ only in
whether they hold the lease and append; both *are* a local materialization of the same object-storage
log. The shipped fleet's hybrid-node model (writer that is also a replica for other shards) ports
directly.

---

## 8. Reactivity — preserved end to end

- **Local subscribers** of a writer node see a commit the instant its local apply is confirmed (step
  4 of §4) — same in-process reactive fan-out as today, same ~2–5 ms propagation the reactive
  benchmark measured. Object storage is not in the local reactive path.
- **Cross-node** propagation is the frontier: `F = min(frontier_ts)` over the N manifests (a `LIST` +
  N cacheable, etag-conditional GETs). A replica/sync-node advances its watermark as `F` advances and
  pulls the new tail segments — the shipped reconnect/resume and DLR machinery ride on `F` exactly as
  they do on the Postgres frontier today. The client wire shape and `StateVersion` are unchanged
  (scalar ts — the portability decision that bought this).
- **Cost:** cross-node visibility latency is bounded below by one manifest-CAS + one F-recompute
  round trip (tens of ms) — the tier's defining characteristic, not a bug (§9).

---

## 9. Latency budget & positioning — honest

- **Commit latency floor**: one `putImmutable` + one `casPut` per batch ≈ **10–100 ms** (object-store
  round trips), vs Postgres single-digit ms. Group commit amortizes it across a batch, so *throughput*
  scales (more shards + bigger batches), but *per-commit* latency has a hard object-store floor. The
  flat single-shard ceiling B4 measured returns here — by design.
- **Read latency**: unchanged (local store) — µs, same as today. This is the crucial asymmetry:
  **reads and reactive fan-out stay fast; only durable commit acquires the object-store floor.** For a
  read-heavy reactive workload (the common case), the tier is far more usable than "10–100 ms per
  operation" suggests.
- **When to choose it**: elastic/serverless self-host with no database to operate, write workloads
  that tolerate tens-of-ms commit latency and batch well, and cost/ops-sensitivity that prefers "an
  S3 bucket" over "a fleet of Postgres." **When not to**: latency-critical writes → stay on the
  Postgres tier (single-digit ms). The two tiers coexist behind the same `DocStore`-shaped seam and
  the same app code; the choice is a deployment config, not a rewrite.

---

## 10. Failure modes

| Failure | Behavior |
|---|---|
| Concurrent writers race the manifest | Exactly one `casPut` wins; the loser gets `CasConflict` → `FencedError` → self-demote + retry (one-winner, from the CAS primitive) |
| Writer crashes mid-flush (after segment PUT, before manifest CAS) | Orphan segment, never referenced; no torn forward; GC'd. The batch is not durable → retried by the client (outbox/effectively-once) |
| Writer crashes with un-flushed local state | Local store discarded; next owner bootstraps from snapshot + tail; only manifest-referenced commits survive (correct — un-flushed = un-committed) |
| Stale-epoch writer keeps committing | Its first post-fence `casPut` fails on the moved etag → aborts; cannot append past the fence |
| Reader GETs a just-GC'd segment | Manifest no longer references it; reader re-reads manifest, pulls from snapshot instead (GC deletes only superseded+below-`W_min` segments after a safety delay) |
| Object store lacks conditional PUT | Fail fast at boot (CAS probe) — no unsafe fallback |
| Object store eventual-consistency on LIST/DELETE | `F` and readiness derive from manifest CONTENT (strongly consistent per-object read-after-write on modern S3), not LIST; LIST is used only for discovery/GC where staleness is tolerated |

---

## 11. Rollout & positioning

- **Tier 3, opt-in, enterprise-gated.** This is multi-node write scale-out's serverless substrate —
  it sits with distributed Tier 2 behind the `license.has("scale")` entitlement seam (the locked
  business-model decision), as `ee/@stackbase/*`. Single-node SQLite and single-node Postgres stay
  free forever.
- **Selected by config**, same story as `--database-url`: e.g. `--object-store s3://bucket/prefix`
  (unset → the existing Postgres/SQLite tiers, no code change). The engine never imports an S3 SDK;
  it talks to the `ObjectStore` seam.
- **Ships behind the two-adapter pattern**: `@stackbase/objectstore-s3` (real) +
  `@stackbase/objectstore-fs` (local CAS via `O_EXCL`/atomic-rename) for dev + a shared conformance
  suite, mirroring `docstore-postgres`/`docstore-sqlite`.

---

## 12. Explicitly deferred / open questions (not designed here)

- **Segment encoding format** (framing, compression, per-row vs columnar) — a throughput/GC-cost
  knob, not a correctness question; pick empirically against a real bucket.
- **Snapshot cadence tuning** (M segments vs T seconds vs bytes-written) — measure bootstrap-cost vs
  snapshot-write-cost; auto-tune later.
- **Compaction** — subsumed by snapshots for v1; a dedicated compactor is a later optimization.
- **Local-store spill/eviction for a shard larger than a node's local disk** — the working set is
  current-state-only and per-shard, so this is a very large-shard edge; a partial-materialization /
  Tier-3-partial-replica seam (the verdict's §c-question-5 reservation) would address it and is left
  open.
- **Multi-region / cross-bucket** — one bucket per deployment for v1.
- **A real-bucket benchmark** — the tens-of-ms floor and the throughput scaling with shard count are
  claimed from the object-store round-trip model; a `bench:objectstore` axis (the natural extension
  of the write-benchmark family) should measure them against a real bucket before any build commits.

---

## Relationship to prior records

This extends **B5 Part 2** (`b5-reshard-and-object-storage.md`) — it adopts B5's protocol mapping
(manifest = lease=fence=frontier, CAS = commit guard, min-over-manifests = `F`, B4-group-commit-
mandatory) verbatim, and **supersedes** B5's read-path sketch: the "working-set memtable + segment
index + fault-in" is replaced by "full local materialization + storage/compute separation," which is
simpler, correct for range-scan queries, and reuses `docstore-sqlite` + the replica-tailer. B5 Part 1
(the offline reshard tool) ports unchanged. The write-sharding arc's design records now run B1→B5 +
this. **Nothing here is scheduled**; it is the design that keeps the door open and, when drawn on,
tells the builder exactly which three pieces are genuinely new (ObjectStore seam, segment/manifest
commit path, snapshots+GC) and which three are reused intact (local docstore, verbatim-apply tailer,
transactor OCC).
