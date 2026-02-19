# Tier 3 Slice 7 — automatic reclamation: gc-driver + gc-fencing (implementation plan)

> REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Grounded in the design record (§6c
> watermark GC), the Slice-4 deferred note ("gc() is un-fenced — a stale writer's gc() could delete the
> live owner's snapshot"), and Slices 3/5/6 (shipped gc() + the recurring-driver seam + the writer boot).

**Goal:** make an object-storage deployment reclaim storage automatically (a recurring gc-driver on the
writer node), and make gc() SAFE under failover (a stale/fenced writer's gc() must never delete the
current owner's live snapshot or a still-needed segment). Without this, a real deployment's segment log
grows unbounded forever, and a mid-failover gc() is a data-availability hazard.

**Architecture:**
- **gc-fencing** (the correctness piece — Slice-4 deferral): `gc()` currently runs under `runExclusive`
  + a `poisoned` check, but trusts its CACHED manifest and never verifies it still owns the lease. A
  writer fenced by a challenger (which bumped the manifest epoch) but not yet aware of it (no heartbeat/
  commit since the fence) holds a STALE cached manifest (old `snapshotTs`). Its gc() would then delete
  every `snap/*` except its stale `snapshotTs` — deleting the NEW owner's live snapshot → the new
  owner's next bootstrap fails. Fix `gc()`:
  1. Abort (return zeros) if `this.held === null` (not an owner — a replica or a demoted writer never GCs).
  2. RE-READ the manifest from the bucket; if `fresh.epoch !== this.held.epoch` → we've been fenced →
     `poisoned = true; held = null` + abort (delete NOTHING). Update `this.cached` to the fresh manifest
     when it matches (so gc operates on current truth, and a subsequent commit sees the right etag).
  3. Compute the delete floor from the FRESH manifest's `snapshotSegBase`/`snapshotTs`, not the cached one.
  4. **Snapshot deletion becomes strictly-older-than-keepSnap** (`ts < keepSnap`), NOT "all except
     keepSnap" — closes the TOCTOU window after the epoch check: a fence + a new-owner snapshot in the
     gap produces a snapshot NEWER than our `keepSnap`, which `ts < keepSnap` will never delete. (Segment
     deletion is already TOCTOU-safe: `seqno <= floor` only touches superseded segments; a new owner's
     commits land at higher seqnos.)
- **gc-driver** (the operational piece): a recurring `Driver` (mirror `receiptsReaper`'s single-timer
  shape, same as the Slice-6 heartbeat driver) that calls `store.gc()` on a cadence (default ~60s).
  Unlike the heartbeat driver, a gc failure is NOT terminal — gc() self-fences (aborts harmlessly if not
  the owner) and any transient object-store error is swallowed + re-armed (reaper policy). The driver
  never signals shutdown; the heartbeat driver owns fence→shutdown.
- **Boot wiring:** register the gc-driver in the object-store writer node's `drivers: [...]` array
  alongside the heartbeat driver (only on the `--object-store` writer path). A cadence knob
  (`STACKBASE_OBJECTSTORE_GC_MS` / a bootLoaded option, defaulting to ~60s; not necessarily a CLI flag —
  mirror how the storage-reaper sweep interval is configured).

**Scope boundary (NOT in Slice 7 — the remaining arc tail):** replica-serve mode (`--replica`),
multi-shard-single-node, the reshard tool (B5 Part 1), and the real-cloud benchmark. Slice 7 is the
writer node's automatic reclamation + its failover-safety. (Watermark-aware GC already ships from Slice
5 — consumers publish `appliedSeqno` and gc() floors at `W_min`; Slice 7 makes gc() run automatically +
fence-safe. Replica consumers that publish watermarks arrive with replica-serve, a later slice; the
gc-driver already respects any consumer watermark present.)

## Global constraints (+ the whole-arc plan's)
- ee-gated (`@stackbase/objectstore-substrate` + the CLI object-store path's existing entitlement gate).
- gc-fencing must be ROBUST, not merely likely-safe: after the epoch re-read check, the delete predicates
  must be safe against a fence occurring in the TOCTOU gap (segments `<= floor`, snapshots `< keepSnap`).
- gc() stays best-effort/idempotent — a partial gc (some deletes done, then an error) is safe to re-run.
- The gc-driver holds NO ambient clock beyond `DriverContext.now()`/`setTimer` (the driver seam).
- Reuse the shipped gc() body, `readManifest`, `readConsumerWatermarks`, and the receiptsReaper/heartbeat
  driver shape. No new fence protocol — reuse the epoch/held the lease already tracks.

## Task 7.1 — gc-fencing: gc() aborts if not the current owner + strictly-older snapshot deletion
**Files:** `ee/packages/objectstore-substrate/src/object-doc-store.ts` (`gc()`); tests.
- Modify `gc()` (under the existing `runExclusive`):
  - After the `poisoned` throw (keep it), add: `if (this.held === null) return { deletedSegments: 0,
    deletedSnapshots: 0 };` (a non-owner — replica or demoted — never GCs).
  - RE-READ: `const fresh = await readManifest(this.objectStore, this.shard);` (must be non-null — the
    shard exists). If `fresh.manifest.epoch !== this.held.epoch` → `this.poisoned = true; this.held =
    null;` and return zeros (fenced — delete NOTHING). Else set `this.cached = fresh` (adopt current truth).
  - If `fresh.manifest.snapshotTs === undefined` → return zeros (no snapshot yet). Else compute `segBase
    = fresh.manifest.snapshotSegBase!`, `keepSnap = fresh.manifest.snapshotTs!`, `floor = min(segBase,
    W_min)` from `readConsumerWatermarks(this.objectStore, this.shard)` — all off the FRESH manifest.
  - Segment deletion: unchanged (`seqno <= floor`).
  - **Snapshot deletion: change to `ts < keepSnap`** (strictly older; parse ts as bigint for the compare
    since ts are decimal-string bigints — do NOT string-compare). NEVER delete `keepSnap` or any snapshot
    `>= keepSnap` (a newer one can only be a new owner's — TOCTOU safety).
- Update the gc() doc comment (replace the Slice-4 "un-fenced, deferred" note): gc() now aborts unless it
  re-verifies it still owns the current epoch, and deletes only strictly-older snapshots — safe under a
  concurrent failover.
- [ ] 7.1a Failing test (the fence): A open+acquire+commit enough for a snapshot at T1 (segBase k). B
      open+acquire past expiry (fences A, epoch bump) + commit + snapshot at T2 (so the bucket now has
      snap/T1 AND snap/T2, and the live one is T2). A (stale, still thinks it owns, cached snapshotTs=T1)
      calls `gc()` → it re-reads, sees `fresh.epoch !== A.held.epoch` → returns zeros, deletes NOTHING
      (assert snap/T2 STILL EXISTS + A is now poisoned). This is the data-availability bug the fence fixes.
- [ ] 7.1b Failing test (strictly-older): a single owner with snapshots at T1 then T2 (T2 current); `gc()`
      deletes snap/T1 (older) and KEEPS snap/T2 (== keepSnap). Construct a case with a would-be newer
      snapshot present and assert gc never deletes `>= keepSnap`.
- [ ] 7.1c Failing test (non-owner): a replica-style instance (`open` without `acquire`, held===null)
      calls `gc()` → returns zeros, deletes nothing.
- [ ] 7.1d Implement. Confirm existing gc/watermark-gc tests still pass (they run gc as the current owner
      — the re-read matches, behavior unchanged for the happy path; the strictly-older change may shift a
      "delete all except keepSnap" assertion if a test had a newer snapshot — update faithfully). Commit.

**Gate:** a fenced/stale writer's gc() deletes nothing (never the live owner's snapshot); gc() only
deletes strictly-older snapshots + superseded segments; a non-owner never GCs; the owner's happy-path gc
is unchanged.

## Task 7.2 — the gc-driver
**Files:** `ee/packages/objectstore-substrate/src/gc-driver.ts` (new); `src/index.ts` (export); tests.
- `gcDriver(store: { gc(): Promise<{deletedSegments:number; deletedSnapshots:number}> }, opts: { sweepMs:
  number }): Driver` — mirror `receiptsReaper`/the heartbeat driver's single-timer shape (`start(ctx){
  ctx=c; arm(); }`, `arm() → ctx.setTimer(ctx.now()+sweepMs, wake)`, `wake()` fire-and-forget
  `.finally`-equivalent re-arm, `stop()` sets a `stopped` guard + clearTimer). `wake()` → `await
  store.gc()`. Swallow ALL errors (log + re-arm) — gc() self-fences (a fenced-owner gc is a harmless
  no-op), and a transient object-store error should just retry next sweep. Never signals fence/shutdown.
  Optional: a `__tick` test seam (mirror the reaper) that awaits one real gc pass.
- `name: "objectStoreGc"`. Uses the narrow structural store type (like the heartbeat driver's
  `HeartbeatableStore`) so a test fake needn't be a full ObjectStoreDocStore.
- [ ] 7.2a Failing test: a fake DriverContext (controllable now()/setTimer) + a real ObjectStoreDocStore
      (open+acquire, commit past a snapshot, so gc has something to reclaim). Start the driver; fire the
      timer; assert `store.gc()` ran (segments reclaimed — assert the bucket's seg count dropped, or a
      spy counted a call). A gc that throws → the driver logs + re-arms (does NOT die). `stop()` clears
      the timer + prevents re-arm.
- [ ] 7.2b Implement. Run → green. Commit.

**Gate:** the driver reclaims storage on a cadence, survives a transient gc error (re-arms), and stops
cleanly.

## Task 7.3 — wire the gc-driver into the writer node's boot (+ prove reclamation on a running node)
**Files:** `packages/cli/src/boot.ts` (register the gc-driver on the object-store writer path + a cadence
config); tests.
- In the object-store writer node build (where `leaseHeartbeatDriver` is registered), also register
  `gcDriver(store, { sweepMs })` in the `drivers: [...]` array. `sweepMs` from
  `STACKBASE_OBJECTSTORE_GC_MS` / a bootLoaded option (default ~60s — mirror the storage-reaper sweep
  config). Only on the `--object-store` writer path (unset → no gc-driver, existing paths untouched).
- [ ] 7.3a A test (hermetic, via bootLoaded with a `file://` object-store URL + a short gc sweepMs +
      driving enough commits to create a snapshot + a superseded tail): assert that after the gc-driver
      sweeps, the bucket's segment objects were reclaimed down to the snapshot floor while the node stays
      live and queryable (a read still returns the current state — reclamation didn't break bootstrap).
      Reuse the `objectstore-boot.test.ts` harness. If driving the driver's real timer through bootLoaded
      is hard, drive gc via the driver's `__tick` seam or assert the driver is registered + a manual gc
      reclaims. Keep it hermetic (no MinIO required; the fence-safety is unit-tested in 7.1).
- [ ] 7.3b Implement the wiring. Build/typecheck green. Commit.

**Gate:** a running object-store writer node reclaims storage automatically without breaking reads/
bootstrap; the existing SQLite/PG/fleet paths are untouched when `--object-store` is unset.

## Self-review
- Delivers design §6c (watermark GC now runs automatically + fence-safe) + the Slice-4 gc-fencing
  deferral. Replica-serve, multi-shard-node, reshard, real-cloud bench remain the explicit tail.
- gc-fencing is robust (epoch re-read + TOCTOU-safe delete predicates: segments `<= floor`, snapshots
  `< keepSnap`), not merely likely-safe.
- Reuse honored: the shipped gc() body + watermark read, `readManifest`, the receiptsReaper/heartbeat
  driver shape, the Slice-6 writer boot + driver-registration seam. No new fence protocol.
- Type consistency: snapshot ts compared as bigint (`BigInt(ts) < BigInt(keepSnap)`); the gc-driver
  returns the `@stackbase/component` `Driver`; the boot wiring is strictly conditional on the object-store
  path (no regression to existing store selection).
