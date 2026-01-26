# Tier 3 Object-Storage Substrate — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement
> each slice task-by-task. Steps use checkbox (`- [ ]`) syntax. This plan covers the WHOLE 6-slice arc
> so it can be reviewed end-to-end; **Slice 1 is fully task-detailed** (it is built first), and Slices
> 2–6 are milestone-level (goal, files, interfaces, deliverable, tests, gate) — each gets its own
> detailed plan when reached, because its interfaces depend on the slice before it. Do not build a later
> slice before the earlier one runs end-to-end.

**Goal:** a reactive-BaaS durable substrate that is ONE S3-class bucket (zero databases) — breaking the
shared-Postgres-WAL write ceiling the benchmarks measured — while keeping the reactive-core protocol
(scalar timeline, min-over-frontiers, fenced eviction, verbatim tailer, byte-identical client) unchanged.

**Architecture:** separation of storage and compute. Object storage is a **write-only durable log**
(immutable per-shard segment objects) plus a **fence** (one CAS-updated manifest object per shard =
lease = fence = frontier), and is NEVER queried in steady state. Each writer node materializes its
shards' current state into a **local `docstore-sqlite`** it queries and runs OCC against. Periodic
snapshots make bootstrap O(state+tail) and GC tractable. See the design record:
`docs/superpowers/specs/2025-12-25-tier3-object-storage-substrate-design.md`.

**Tech Stack:** TypeScript; `@aws-sdk/client-s3` (conditional `PutObject` for the CAS — Bun's native
S3Client has no `If-Match`); `docstore-sqlite` (local materialized store); the shipped
`packages/transactor`, `ee/packages/fleet` (replica-tailer, lease/fence protocol), and B4 group-commit
machinery, all reused.

## Global Constraints

- **`ee/` tier, enterprise-gated.** The object-storage *substrate* (segment/manifest engine, commit
  path, snapshots, GC) is Tier-2 scale → lives under `ee/` behind the `license.has("scale")` seam
  (locked business-model decision). The generic **ObjectStore seam + S3/fs adapters** are core
  `packages/` (a bucket wrapper is not itself "scale"; keep the split clean).
- **The engine never imports an S3 SDK** — all object I/O through the `ObjectStore` seam, same
  discipline as `DocStore`. A leak of AWS-SDK specifics out of the adapter is a design bug.
- **CAS is load-bearing.** The manifest fence rests on object-store conditional writes
  (`If-Match`/ETag). Fail fast at boot with a CAS probe on a store that can't conditional-PUT — no
  unsafe fallback. (`bench:objectstore` proved this works on MinIO 2025-09.)
- **Group commit is MANDATORY here** (not the dark-off escape hatch it is on Postgres): one PUT per row
  floors throughput at the object-store round-trip (`bench:objectstore`: batch=1 → ~296 commits/s).
  Every commit flush = one segment PUT + one manifest CAS per BATCH.
- **Reactive-core protocol unchanged:** scalar `commitTs`, `F = min(frontier_ts)`, `count = N` readiness
  gate, epoch-as-fence, `commitMeta` idempotency, verbatim segment apply, byte-identical client wire.
- **Reuse, do not reinvent** (the reuse map below is binding — a slice that reimplements a reused piece
  is a defect).

## The reuse-vs-new map (binding)

| GENUINELY NEW (build) | REUSED INTACT (do not reimplement) |
|---|---|
| `ObjectStore` seam + `objectstore-s3` / `objectstore-fs` adapters | Local `docstore-sqlite` (`SqliteDocStore`) as the queryable materialized store |
| Segment encoding + manifest schema | The replica-tailer's verbatim MVCC apply (`ee/packages/fleet/replica-tailer.ts`) |
| The commit path (local apply → segment PUT → manifest CAS) | The transactor's OCC / read-set / reactive fan-out (it just talks to a local `DocStore`) |
| **Snapshots** (periodic materialized image) | B4 group-commit machinery (`commitWriteBatch`, two-buffer committer — shipped dark-off) |
| Watermark GC + compaction | The fleet lease=fence=frontier protocol + `F = min` / count-gate math (mapped to manifests) |
| Bootstrap orchestration (snapshot + tail) | `commitMeta` effectively-once idempotency channel |

---

## Slice 1 — The `ObjectStore` seam + adapters (FULL detail)

**Why first:** the foundation everything else calls; fully testable in isolation against MinIO + a
local-fs CAS, with zero engine coupling. Productionizes the minimal ObjectStore the objectstore bench
already validated (`benchmarks/runner/src/cores/objectstore.ts`).

**Files:**
- Create: `packages/objectstore/src/types.ts` — the `ObjectStore` interface + `CasConflict` error.
- Create: `packages/objectstore/src/index.ts`, `package.json`, `tsup.config.ts`, `tsconfig.json`.
- Create: `packages/objectstore-s3/src/{s3-objectstore.ts,config.ts,index.ts}` + package scaffolding.
- Create: `packages/objectstore-fs/src/{fs-objectstore.ts,index.ts}` + package scaffolding.
- Create: `packages/objectstore/test/conformance.ts` — the shared conformance suite (a function run
  against BOTH adapters).
- Create: `packages/objectstore-s3/test/s3.conformance.test.ts` (real MinIO container, gated),
  `packages/objectstore-fs/test/fs.conformance.test.ts` (always-on).

**Interfaces:**
- Produces (the seam every later slice consumes):
  ```ts
  export class CasConflict extends Error {}
  export interface ObjectStore {
    putImmutable(key: string, body: Uint8Array): Promise<void>;      // idempotent by key (segments)
    casPut(key: string, body: Uint8Array, ifMatch: string | null): Promise<{ etag: string }>; // linearization point; ifMatch=null ⇒ create-only; throws CasConflict on etag mismatch
    get(key: string): Promise<{ body: Uint8Array; etag: string } | null>;
    list(prefix: string): Promise<string[]>;
    delete(key: string): Promise<void>;
    /** Probe the store's conditional-write support; throws if CAS is unsupported (boot fail-fast). */
    assertCasSupported(): Promise<void>;
  }
  ```
- `objectstore-s3`: `new S3ObjectStore({ endpoint?, region?, accessKeyId, secretAccessKey, bucket, forcePathStyle? })` over `@aws-sdk/client-s3` (`PutObjectCommand` with `IfMatch`/`IfNoneMatch`, `GetObjectCommand`, `ListObjectsV2Command`, `DeleteObjectCommand`).
- `objectstore-fs`: `new FsObjectStore({ dir })` — CAS via `open(O_EXCL)`/atomic-rename + an etag = content hash; for dev + the conformance suite without a bucket.

- [ ] **Task 1.1 — The seam + `CasConflict`.** Write `types.ts`; unit-test that `CasConflict` is
      structurally detectable (an error `code`/`name`, robust across dist/src duplication).
- [ ] **Task 1.2 — The conformance suite** (`conformance.ts`): a `runObjectStoreConformance(make: () =>
      Promise<ObjectStore>)` covering: putImmutable+get round-trip; `casPut(null)` creates once and a
      second create throws `CasConflict`; `casPut(rightEtag)` succeeds and returns a NEW etag;
      `casPut(wrongEtag)` throws `CasConflict`; **concurrent racers with DISTINCT bodies → exactly one
      winner** (the trap the bench hit: constant-body writes keep a constant etag — racers must write
      distinct content); list by prefix; delete; `assertCasSupported` passes.
- [ ] **Task 1.3 — `objectstore-fs`** implementing the seam (CAS via `O_EXCL` create + read-modify-write
      under a lock/atomic-rename; etag = sha of bytes). Run the conformance suite against it (always-on).
- [ ] **Task 1.4 — `objectstore-s3`** over the AWS SDK. Run the conformance suite against a real
      `minio/minio` container (gated on docker availability + `STACKBASE_OBJECTSTORE_S3=1`, the same
      pattern as `storage-e2e`). `assertCasSupported` does the two-PUT-If-None-Match probe.
- [ ] **Task 1.5 — Wiring:** `tsup`/`tsconfig`/`package.json` for all three; add to the workspace;
      `bun run build && bun run typecheck` green; the fs conformance test in the default suite.

**Gate:** both adapters pass the identical conformance suite (fs always; s3 against real MinIO);
`assertCasSupported` fails fast on a fake non-CAS store; build+typecheck green. **Deliverable:** a
production `ObjectStore` seam the substrate can build on, with the CAS fence proven on a real bucket.

---

## Slice 2 — Single-shard commit over object storage (milestone)

**Goal:** one writer commits durably to a bucket (no Postgres), and a second process materializes the
identical state by replaying the log. Single node, single shard, no snapshots yet (bootstrap = full log).

**Files (ee):** `ee/packages/objectstore-substrate/src/{segment.ts,manifest.ts,commit.ts,bootstrap.ts,
object-doc-store.ts}` + tests.

**Interfaces / mechanics:**
- **Segment** — encode a group-commit batch's MVCC rows into an immutable object `s{shard}/seg/{seqno}`
  (framing + the `WrittenDoc[]` shape B4 already produces). Dense monotone seqnos (the `prev_ts`
  density role).
- **Manifest** — `s{shard}/manifest` holding `{ epoch, frontierTs, tsCounter, segments: seqno[],
  snapshotAt?, idempotencyWindow[], writerUrl }`. Read → `{manifest, etag}`.
- **`ObjectStoreDocStore`** — a composite `DocStore` (implements the engine's `DocStore` seam) whose
  reads/scans/OCC hit a LOCAL `SqliteDocStore`, and whose `commitWrite`/`commitWriteBatch` do:
  local apply → `putImmutable(segment)` → `casPut(manifest)` (the linearization + fence). A `CasConflict`
  → `FencedError` (reuse the transactor's existing fenced path; do not OCC-retry a fence).
- **Bootstrap** — replay all segments `(0, F]` verbatim into a fresh local store using the replica-tailer
  apply. `commitTs` allocated from the manifest `tsCounter` (advanced in the CAS).

**Tests:** a writer commits a mutation → segment + manifest land in the bucket; a second
`ObjectStoreDocStore` over the SAME bucket bootstraps and reads the identical value; a forced
concurrent CAS conflict yields `FencedError` and the batch retries; the MVCC `prev_ts`/seqno chains are
dense. Run against `objectstore-fs` (fast) + real MinIO (gate). **Gate:** durable commit + faithful
bootstrap over object storage, single-shard.

---

## Slice 3 — Snapshots + fast bootstrap + segment GC (milestone)

**Goal:** bootstrap becomes O(state+tail), not O(history); segments below the watermark are reclaimed.

**Mechanics:** a background snapshotter writes `s{shard}/snap/{ts}` (a materialized image of the local
store's current state) every M segments / T seconds, referenced by the next manifest CAS. Bootstrap
restores the latest snapshot then replays only `(snapshotAt, F]`. GC deletes segments below both the
newest snapshot's ts AND the min consumer watermark `W_min` (published per-consumer), after a
safety delay (object-store deletes are eventually consistent). Snapshot GC keeps newest ≤ `W_min` + newest.

**Tests:** bootstrap time is bounded by snapshot+tail, not history size (seed a long log, snapshot,
assert replay reads only tail segments); a GC'd segment is unreferenced and a reader falls back to the
snapshot; `F` never regresses across a snapshot. **Gate:** O(state+tail) bootstrap + safe GC proven.

---

## Slice 4 — Multi-shard + fence / failover (milestone)

**Goal:** N shards, each its own segment stream + manifest; a writer claims a shard by CAS-bumping the
manifest epoch (the lease); `F = min(frontierTs)` over the N manifests; per-shard failover on lease
expiry via fencing-first eviction (epoch bump).

**Mechanics:** map the shipped fleet lease/fence/frontier protocol onto manifests — "CAS the epoch to
claim" = acquire; "commit guard `WHERE epoch=$mine`" = the commit CAS; "fencing-first eviction" = a
fencer conditional-PUT that bumps epoch + `GREATEST`-raises frontier. Reuse the fleet's balancer +
per-shard routing; only the lease *substrate* changes (manifest instead of `shard_leases` row). The
`count = N manifests present` readiness gate; the one-doc-one-ring invariant unchanged (routing still
`shardIdForKeyValue`).

**Tests:** N-shard commits distribute; a killed writer's shard is fenced+taken over with no skipped ts
(the fenced-frontier E2E, ported to manifests); `F = min` monotone across failover. **Gate:** multi-shard
write scale-out + per-shard failover over object storage.

---

## Slice 5 — Replicas + cross-node reactivity (milestone)

**Goal:** read scale-out + cross-node reactive propagation, all over the bucket.

**Mechanics:** a replica materializes a shard by bootstrap (Slice 3) then keeps polling the manifest and
pulling new tail segments, applying verbatim (the shipped replica-tailer, pointed at object segments
instead of a streamed primary). Local subscribers on a writer see commits immediately (unchanged
in-process fan-out, ~2–5 ms); cross-node visibility rides `F = min` over manifests. Hybrid nodes (writer
for some shards, replica for others) port from the shipped fleet. Best-effort wake via manifest polling
or S3 event notifications.

**Tests:** a replica converges to `F` from segments and serves queries; a write on node A becomes
visible on replica B within the frontier interval; the client wire shape / `StateVersion` unchanged.
**Gate:** cross-node reactivity + read replicas over object storage; the reactive story intact.

---

## Slice 6 — Reshard tool + real-cloud benchmark + hardening (milestone)

**Goal:** operational completeness + honest end-to-end numbers.

**Mechanics:** port the B5 Part 1 offline reshard tool to manifests (update the persist-once
`fleet:numShards`; create/delete manifest objects for new/surplus lanes, each seeded at `MAX(ts)` per
the F1 invariant; against a stopped fleet). Extend `bench:objectstore` into an end-to-end `bench` that
measures commit latency + throughput (with group commit) + shard-count scaling against a REAL cloud
bucket (the design's named prerequisite that local MinIO under-represents). Config wiring:
`--object-store s3://bucket/prefix` selects the tier; `assertCasSupported` at boot; the
`license.has("scale")` gate. Docs (`docs/enduser/self-hosting.md` object-storage section).

**Tests:** reshard N→M over manifests moves no rows and leaves M dense lanes; the CAS boot probe gates a
non-CAS store; a full `docker compose`-style E2E: commit → segment/manifest → bootstrap a second node →
reactive fan-out, over a real bucket. **Gate:** operable, benchmarked, documented Tier-3 tier.

---

## Self-Review (writing-plans)

- **Spec coverage:** every section of the design record maps to a slice — ObjectStore seam (§3) → S1;
  commit path (§4) + layout (§5) + local materialization (§6a) → S2; snapshots (§6b) + GC (§6c) → S3;
  fence/frontier (§2, §10) → S4; reactivity (§8) + bootstrap (§7) → S5; reshard (§ prior B5) + latency
  positioning (§9) + rollout (§11) → S6. The §12 deferred items (segment format tuning, compaction,
  multi-region, local-store spill) stay deferred, flagged in their slices.
- **Type consistency:** the `ObjectStore` seam names (S1) are consumed verbatim by S2's commit path;
  `manifest`/`segment` shapes defined in S2 are extended (not redefined) by S3 (snapshotAt) and S4
  (epoch). `commitTs` scalar + `F = min` are the shipped protocol's, unchanged.
- **Granularity note:** Slice 1 is task-level (built next); Slices 2–6 are milestone-level by design —
  each is re-planned in full (task-level TDD steps) at the start of its own build, since its interfaces
  depend on the slice before it. This is deliberate, not a placeholder gap.
- **Right-sizing:** each slice ends with an independently-testable deliverable and its own gate; a
  reviewer could accept/reject any slice without the next.

## Execution Handoff

Build **Slice 1** first via superpowers:subagent-driven-development (fresh subagent per task + task
review). When Slice 1 merges, write Slice 2's full task-level plan (its interfaces are now real), build,
merge; repeat through Slice 6. Do not start a later slice before the earlier one runs end-to-end.
