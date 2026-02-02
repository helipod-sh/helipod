# Tier 3 Slice 3 — Snapshots + fast bootstrap + GC (implementation plan)

> REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Grounded in the whole-arc plan, the
> design record (§6b snapshots, §6c GC, §7 bootstrap), and Slices 1–2 (shipped). Slice 2 gave us
> `ObjectStoreDocStore` (object-first commit + manifest + segment log + bootstrap-by-full-replay).

**Goal:** make bootstrap **O(state + tail)** instead of O(full log), and reclaim superseded segments.
A periodic snapshot captures the local store's current state; bootstrap restores the latest snapshot
then replays only the tail segments; GC deletes segments below the snapshot.

**Architecture:**
- A **snapshot** `s{shard}/snap/{ts}` is a materialized image of the current state at `frontierTs = ts`
  — the CURRENT revision of every live document (at its real ts/prev_ts) + the current index rows.
  Produced by dumping the local `SqliteDocStore`'s current state; restored via the SAME
  `write(..., "Overwrite")` primitive segments use (so density/prev_ts chains from the snapshot head
  through the tail hold).
- The **manifest** gains `snapshotTs?: string` + `snapshotSegBase?: number` (the seqno the snapshot
  covers UP TO — i.e. bootstrap replays segments with seqno > `snapshotSegBase`). Written by the
  snapshotter via a manifest CAS.
- **Bootstrap** (Slice-2 `open` upgraded): if `snapshotTs` is set → restore `snap/{snapshotTs}` into
  the fresh local store, then replay only segments with seqno > `snapshotSegBase`; else full replay
  (Slice-2 behavior). O(state + tail).
- **Snapshot cadence:** after every `SNAPSHOT_EVERY` committed segments the writer takes a snapshot
  (off the commit hot path — a best-effort background call the commit triggers, or an explicit
  `maybeSnapshot()` the caller can drive; Slice 3 uses an explicit method + a commit-count trigger).
- **GC:** `gc()` deletes segment objects with seqno ≤ `snapshotSegBase` (their current versions are in
  the snapshot) and stale snapshots (keep the newest). Single-node Slice 3: no consumer watermark yet
  (replicas are Slice 5) — the newest snapshot IS the floor. Deletes after object-store eventual-
  consistency is a non-issue for a superseded segment (nothing references it once the manifest's
  `snapshotSegBase` covers it).

## Global constraints (+ the whole-arc plan's)
- Reuse `write(..., "Overwrite")` for snapshot restore (as for segment replay) — no new apply path.
- Snapshot content is the CURRENT state only (latest revision per id, non-tombstone; current index
  rows) — NOT the full history. Each doc keeps its REAL latest ts + prev_ts so the first tail segment's
  `prev_ts` chains from the snapshot head (density holds).
- The snapshotter is single-writer (holds the manifest); it takes a consistent read of `local` at a ts
  and records that ts. Object storage is written snapshot-FIRST (`putImmutable(snap)`) then the manifest
  CAS references it — never a manifest pointing at an absent snapshot (same torn-forward discipline as
  segments).
- Compaction of old revisions inside a snapshot, and the consumer-watermark GC floor, are DEFERRED
  (§12 / Slice 5).
- Honor the Slice-2 carried notes (globals/receipts are local-only — snapshots do NOT need to carry
  them for Slice 3 single-node; the failover slice owns that).

## Task 3.1 — `dumpCurrentState()` + snapshot codec + snapshot object helpers
**Files:** `packages/docstore-sqlite/src/sqlite-docstore.ts` (add `dumpCurrentState`); the substrate's
`ee/packages/objectstore-substrate/src/snapshot.ts` + tests.

- **`SqliteDocStore.dumpCurrentState(): Promise<{ documents: DocumentLogEntry[]; indexUpdates: IndexWrite[] }>`**
  — the CURRENT state: for each id, its LATEST `documents` revision that is non-tombstone (a tombstoned
  id is absent), as a `DocumentLogEntry` at its real `ts`/`prev_ts`/`value`; plus every current row of
  the `indexes` table as an `IndexWrite` at its real ts. Read `sqlite-docstore.ts`'s own schema/queries
  (how `scan`/`get`/`load_documents` read the `documents`/`indexes` tables) and mirror them — do NOT
  invent a schema. This is a concrete method on `SqliteDocStore` (the substrate holds a `SqliteDocStore`
  as `local`), NOT a new `DocStore`-interface method.
- **Snapshot codec** (`snapshot.ts`): `SnapshotPayload = { frontierTs: string; segBase: number;
  documents: DocumentLogEntry[]; indexUpdates: IndexWrite[] }`; `encodeSnapshot`/`decodeSnapshot` —
  reuse `segment.ts`'s value/bigint/key serialization (share the helper). `snapshotKey(shard, ts)` =
  `s{shard}/snap/{ts}`; `writeSnapshot(os, shard, payload)` (putImmutable) + `readSnapshot(os, shard,
  ts)` (get+decode).
- [ ] 3.1a Failing test: `dumpCurrentState` on a `SqliteDocStore` with inserts + an update (superseded
      revision) + a tombstone → returns exactly the current live docs (updated value, tombstoned id
      absent) at their real ts, + the current index rows. (Build the store via `commitWrite`/`write`.)
- [ ] 3.1b Implement `dumpCurrentState`. Run → pass.
- [ ] 3.1c Failing test: snapshot encode/decode round-trip (bigint/bytes/tombstone-free current state).
- [ ] 3.1d Implement `snapshot.ts`; build/typecheck/test green. Commit.

**Gate:** current-state dump is exact (latest non-tombstone per id + current index rows); snapshot
round-trips.

## Task 3.2 — Snapshots wired into `ObjectStoreDocStore` (cadence + fast bootstrap)
**Files:** `object-doc-store.ts` (manifest fields, `snapshot()`/`maybeSnapshot()`, upgraded `open`);
`manifest.ts` (`snapshotTs?`/`snapshotSegBase?`); tests.

- `Manifest` gains optional `snapshotTs?: string`, `snapshotSegBase?: number`.
- **`snapshot()`** (under the commit mutex, or serialized against commits): `payload =
  dumpCurrentState()` stamped with `frontierTs = cached.frontierTs`, `segBase = last committed seqno`;
  `writeSnapshot(...)`; then a manifest CAS advancing `snapshotTs`/`snapshotSegBase` (no new segment).
  `maybeSnapshot()` calls `snapshot()` when `committedSegmentsSinceSnapshot >= SNAPSHOT_EVERY`; the
  commit path calls `maybeSnapshot()` best-effort after a successful commit.
- **`open` upgraded:** if `manifest.snapshotTs` set → `readSnapshot` → `local.write(snapshot.documents,
  snapshot.indexUpdates, "Overwrite")` → replay only segments with seqno > `snapshotSegBase`; else
  full replay.
- [ ] 3.2a Failing test: after `SNAPSHOT_EVERY` commits, `snapshot()` writes `snap/{ts}` and the
      manifest's `snapshotTs`/`snapshotSegBase` are set; state unchanged.
- [ ] 3.2b Implement snapshot cadence + manifest fields. Run → pass.
- [ ] 3.2c **Fast-bootstrap proof:** commit a series, snapshot, commit more (the tail); DELETE the
      pre-snapshot segment OBJECTS from the bucket; a fresh `open` STILL bootstraps to the correct full
      state (restores snapshot + replays only the tail) — proving bootstrap doesn't need pre-snapshot
      segments. Commit.

**Gate:** a snapshot is taken on cadence + recorded; a fresh node bootstraps from snapshot + tail even
with pre-snapshot segments absent.

## Task 3.3 — Segment + snapshot GC
**Files:** `object-doc-store.ts` (`gc()`); tests.
- `gc()`: `list("s{shard}/seg/")` → delete every segment whose seqno ≤ `snapshotSegBase` (superseded by
  the snapshot); `list("s{shard}/snap/")` → delete every snapshot except the newest (`snapshotTs`).
  Never deletes a segment the manifest still needs (seqno > snapshotSegBase) or the current snapshot.
- [ ] 3.3a Failing test: after a snapshot at segBase=k, `gc()` deletes `seg/0..k`, keeps `seg/{>k}` and
      `snap/{snapshotTs}`, deletes older snapshots; and a fresh `open` AFTER gc still bootstraps to the
      correct state.
- [ ] 3.3b Implement `gc()`. Run → pass. Commit.

**Gate:** GC reclaims superseded segments + stale snapshots without breaking bootstrap.

## Task 3.4 — E2E: long run with snapshots + GC, on fs + MinIO
**Files:** `test/snapshot-gc.e2e.test.ts`.
- A `scenario(makeBucket)`: commit >2·SNAPSHOT_EVERY mutations (mix of insert/update/delete) driving
  ≥2 snapshots + `gc()`; assert only a bounded set of segment objects remain (not the full log); open a
  FRESH `ObjectStoreDocStore` → assert it materializes the byte-identical current state; assert the
  bootstrap replayed only the post-snapshot tail (e.g. instrument or assert the surviving object set).
- [ ] 3.4a fs variant (always-on) + a MinIO-gated variant (mirror Slice-1/2 gate). Build/typecheck/test
      green (default skips MinIO). Commit.

**Gate (headline):** over a long commit history, snapshots + GC keep the durable object set bounded and
a fresh process still materializes the exact current state — bootstrap no longer scales with history.

## Self-review
- Covers design §6b/§6c/§7. Consumer-watermark GC + intra-snapshot compaction + snapshot durability of
  globals/receipts are DEFERRED (Slice 5 / the failover slice), consistent with the whole-arc plan.
- Reuse honored: `write("Overwrite")` (restore), the `segment.ts` value codec (shared by `snapshot.ts`),
  the Slice-2 commit/mutex/poison path (snapshot serializes against commits).
- Type consistency: `SnapshotPayload.documents/indexUpdates` are the same `DocumentLogEntry`/`IndexWrite`
  the segment codec uses; `snapshotTs`/`snapshotSegBase` are the manifest's monotone fields (extend, not
  redefine, the Slice-2 `Manifest`).
