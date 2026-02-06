# Tier 3 Slice 4 — multi-shard + fence/failover (implementation plan)

> REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Grounded in the design record (§4 commit
> fence, §5 layout, §7 cold-start/claim, §10 failure modes) and Slices 1–3 (shipped). Slice 3 gave us
> snapshots + O(state+tail) bootstrap + the explicit `nextSeqno` cursor — this slice builds the
> ownership layer on top so a second node can safely TAKE OVER a shard.

**Goal:** make an object-storage shard safely ownable and fail-overable across processes: exactly one
writer owns a shard at a time (enforced by the manifest CAS = the fence), a wedged/crashed owner is
displaced by a challenger after its lease expires, and the challenger bootstraps from the bucket
(Slice 3) and resumes committing — with the deployment identity preserved from object storage, not
re-minted. Plus the multi-shard composition: N independent lanes with zero cross-contention.

**Architecture — the manifest IS the lease (object-store-only, no coordinator, no database):**
- The manifest gains lease fields: `epoch` (already present, now load-bearing), `writerId: string`,
  `leaseExpiresAt: string` (ms-epoch decimal). The etag-CAS one-winner property (Slices 1–3, proven on
  MinIO) is the mechanical fence; `epoch`/`writerId`/`leaseExpiresAt` are the ownership semantics.
- **Acquisition** (`acquire({writerId, leaseTtlMs, now})`): bootstrap the local store via the Slice-3
  `open` path, then — iff the shard is unowned OR the current lease is EXPIRED (`now > leaseExpiresAt`)
  — CAS the manifest to `{...manifest, epoch: epoch+1, writerId, leaseExpiresAt: now+leaseTtlMs}`. The
  epoch bump FENCES any prior owner (its cached etag is now stale). If the lease is live and held by
  someone else, acquire refuses (returns `{acquired:false, heldBy, expiresAt}`) — this is what prevents
  two live writers ping-ponging (no coordinator needed; a heartbeating owner's lease never expires).
  Two challengers racing an expired lease → CAS one-winner picks one; the loser gets CasConflict → may
  retry against the fresh manifest.
- **Heartbeat** (`heartbeat({now, leaseTtlMs})`): the owner periodically CAS-renews `leaseExpiresAt`
  (etag advances; `epoch`/`writerId` unchanged). A heartbeat whose CAS fails means the owner was fenced
  (a challenger bumped epoch) → the instance poisons + reports fenced. `now` is caller-supplied (the
  recurring-driver seam or the test drives it) — the substrate holds NO ambient clock.
- **Commit under lease:** the commit path already CAS-chains on `this.cached.etag` and poisons+throws
  `FencedError` on a moved etag (Slices 2–3). With the lease, a fenced owner's next commit finds the
  etag moved by the challenger's epoch bump → `FencedError` → poisoned → must re-`acquire` (which =
  re-open + re-claim). The commit additionally asserts it still holds the epoch it acquired (defense in
  depth) and carries `epoch`/`writerId`/`leaseExpiresAt` UNCHANGED in its `next` manifest (a commit is
  not a lease renewal — heartbeat renews).
- **Globals** (`deployment-level`, carried note I1): a persist-once `globals` object carrying
  `{deploymentId, numShards}`, CAS-created (create-only) the first time and read thereafter, so a fresh
  node materializing from the bucket ADOPTS the existing `deploymentId` instead of minting a new one
  (which would flip every outbox client to `known:false`).

**Boundary with Slice 5 (do NOT build here):** cross-node reactivity — the min-over-manifests frontier
`F`, replica polling/tailing, consumer watermarks — is Slice 5. Slice 4 proves single-shard
OWNERSHIP/FAILOVER + multi-lane independence. A "replica" that tails another writer's shard is Slice 5.
Wiring a real heartbeat driver into `EmbeddedRuntime` is also Slice 5's concern (Slice 4 exposes the
`now`-driven lease methods + proves them; the runtime drives them later).

## Global constraints (+ the whole-arc plan's)
- ee/-gated (`@stackbase/objectstore-substrate`, commercial license). Engine never imports an S3 SDK.
- CAS is the ONLY fence — mandatory + fail-fast (the boot probe already exists via `assertCasSupported`).
- `now` is always caller-supplied to lease methods — NO `Date.now()`/ambient clock in the substrate
  (deterministic tests; the driver/test owns the clock). Document the cross-node clock-skew assumption:
  lease safety assumes bounded clock skew relative to `leaseTtlMs` (a challenger fencing an "expired"
  lease that a skewed owner still thinks is live is prevented by the epoch-CAS being one-winner AND by
  the owner detecting its fence on its next heartbeat/commit — but a very short TTL under large skew can
  cause spurious failovers; document TTL >> max-skew as the operational rule).
- Object-first + poison-on-any-CAS-failure discipline is unchanged (a lease CAS failure poisons exactly
  like a commit CAS failure — the cached etag is then untrustworthy).
- Reuse the Slice-3 `open` (bootstrap), the segment/snapshot codecs, and the existing `casManifest`.
  Do NOT fork the commit path — extend the manifest and gate it on lease state.
- Fence/failover paths MUST have a MinIO-gated E2E (carried note I2 — fs keep-first masked C1 before).

## Task 4.1 — Fleet globals object (deploymentId / numShards) + adopt-on-open
**Files:** `ee/packages/objectstore-substrate/src/globals.ts` (new); `src/index.ts` (export); tests.
- `interface FleetGlobals { deploymentId: string; numShards: number }`. Key: `globals` (bucket-root,
  per design §5 layout `deployment/{id}/…` — for Slice 4 single-deployment-per-bucket, key = `globals`).
- `readGlobals(os): Promise<FleetGlobals | null>` (get+decode, null if absent).
- `createGlobals(os, globals): Promise<FleetGlobals>` — create-only via `casPut(key, bytes, null)`;
  throws `CasConflict` if another node already wrote it (caller then `readGlobals` — adopt theirs).
- `ensureGlobals(os, { deploymentId, numShards }): Promise<FleetGlobals>` — read; if present return it
  (ADOPT existing identity); else create-only, and on the create-race CasConflict re-read + return the
  winner's. This is the carried-note-I1 fix: a fresh node adopts, never re-mints.
- [ ] 4.1a Failing test: `ensureGlobals` on an empty bucket writes+returns the given globals; a SECOND
      `ensureGlobals` with a DIFFERENT deploymentId returns the FIRST (adopts, doesn't overwrite).
- [ ] 4.1b Failing test: two concurrent `ensureGlobals` (Promise.all, distinct deploymentIds) → both
      resolve to the SAME winner (create-race → one wins, loser adopts). (fs bucket — single-process CAS
      is enough for this unit; the E2E covers MinIO.)
- [ ] 4.1c Implement `globals.ts`; export; build/typecheck/test green. Commit.

**Gate:** deploymentId is written once and adopted by every later opener; the create-race has one winner.

## Task 4.2 — Manifest lease fields + the acquire/heartbeat lease protocol (the core)
**Files:** `src/manifest.ts` (lease fields + helpers); `src/object-doc-store.ts` (acquire/heartbeat +
lease state + commit gating); tests.
- **`manifest.ts`:** `Manifest` gains `writerId: string` and `leaseExpiresAt: string` (both required;
  `emptyManifest()` → `writerId: ""`, `leaseExpiresAt: "0"` = unowned). `epoch` stays (0 in empty).
  Keep `casManifest` as-is (it serializes the whole `next`). Update the doc comment.
- **`object-doc-store.ts`:** add lease state `private held: { epoch: number; writerId: string } | null`
  (null until acquired). New public methods:
  - `async acquire(opts: { writerId: string; leaseTtlMs: number; now: number }): Promise<{ acquired: true } | { acquired: false; heldBy: string; expiresAt: number }>`
    — under `runExclusive`: re-read the manifest (fresh etag) via `readManifest`; if
    `writerId !== "" && now <= Number(leaseExpiresAt) && writerId !== opts.writerId` → return
    `{acquired:false, heldBy, expiresAt}` (live lease held by someone else). Else CAS to
    `{...manifest, epoch: epoch+1, writerId: opts.writerId, leaseExpiresAt: String(now+leaseTtlMs)}`;
    on success set `this.cached`, `this.held = { epoch: epoch+1, writerId }`, clear `poisoned`, return
    `{acquired:true}`; on CasConflict return a re-read `{acquired:false,...}` (lost the race — caller
    may retry). NOTE: acquiring re-reads + can re-bootstrap; if the local store may be stale from a
    prior epoch, acquire should re-run the Slice-3 bootstrap tail-replay to catch up to the manifest's
    frontier before claiming (a fresh challenger's `open` already did; a re-acquire after being fenced
    must catch up — replay segments with seqno >= this.nextSeqno that the fencing owner appended).
  - `async heartbeat(opts: { now: number; leaseTtlMs: number }): Promise<void>` — under `runExclusive`:
    require `this.held` (throw if not owner) and `!poisoned`; CAS `{...cached.manifest, leaseExpiresAt:
    String(now+leaseTtlMs)}` (epoch/writerId unchanged); on success update `this.cached`; on ANY CAS
    failure → `poisoned=true`, `this.held=null`, throw `FencedError` (a moved etag means a challenger
    fenced us or is mid-fence).
  - `release(): void` — clear `this.held` (voluntary demotion; does not touch the bucket — the lease
    simply expires). (Optional convenience; keep minimal.)
- **Commit gating:** `commitWriteBatch` must require ownership — if `this.held === null` throw a clear
  "not the lease owner — acquire() first" error (BEFORE the poisoned check). The `next` manifest built
  by commit must carry `writerId`/`leaseExpiresAt` UNCHANGED (spread `...this.cached.manifest`, already
  the pattern) and MUST keep `epoch: this.held.epoch` (assert `this.cached.manifest.epoch ===
  this.held.epoch` — if they diverge, we've been fenced: poison+FencedError). The existing
  poison-on-CAS-failure + FencedError-on-conflict stays.
- **`open` vs `acquire`:** `open` still bootstraps a read-materialized store WITHOUT claiming (a future
  replica opens without acquiring — Slice 5). A writer does `open` then `acquire`. Keep `open` as-is
  (no lease claim); ownership is `acquire`-only. Update the class doc to state: `open` = materialize
  (no ownership); `acquire` = claim/fence; commits require a held lease.
- [ ] 4.2a Failing test: `open` then `acquire` on a fresh shard → `{acquired:true}`; a commit now
      succeeds; the manifest shows `writerId`, a future `leaseExpiresAt`, `epoch===1`.
- [ ] 4.2b Failing test (the fence): instance A `open`+`acquire`+commit; instance B `open`+`acquire`
      with `now` PAST A's `leaseExpiresAt` → `{acquired:true}` and the manifest `epoch===2`,
      `writerId===B`. A's next `commit` (or `heartbeat`) → throws `FencedError`, A is poisoned. B's
      commit succeeds.
- [ ] 4.2c Failing test (live lease refused): A acquires (lease live); B `acquire` with `now <=
      leaseExpiresAt` → `{acquired:false, heldBy:A}`; A's commit still works; the manifest still shows
      A/epoch 1.
- [ ] 4.2d Failing test (heartbeat renews): A acquires at now=0 (ttl=1000); at now=500 A.heartbeat →
      manifest `leaseExpiresAt===1500`, epoch unchanged; B.acquire at now=1200 → refused (renewed lease
      still live). Implement acquire/heartbeat/commit-gating; run → green. Commit.

**Gate:** exactly one owner at a time; an expired lease is fenceable (epoch bump); a live lease is not;
heartbeat renews; a fenced owner's commit/heartbeat fails loudly (FencedError + poison).

## Task 4.3 — Multi-shard composition + zero-cross-contention
**Files:** `src/object-doc-store.ts` doc only (per-shard already); a `src/fleet-shards.ts` thin helper
(optional) OR just a test proving independence; tests.
- The substrate is already per-shard (each `ObjectStoreDocStore` owns one `shard` prefix). "Multi-shard"
  = N lanes over the SAME bucket at DISTINCT `s{shard}/…` prefixes with zero shared contention +
  `numShards` recorded in globals. Provide a minimal `openShardSet(os, { shards: string[], localFor:
  (shard) => SqliteDocStore, deploymentId, numShards, ... })` helper that `ensureGlobals` once and
  `open`s one `ObjectStoreDocStore` per shard, returning a `Map<shard, ObjectStoreDocStore>` — OR, if
  that's more surface than the slice needs, skip the helper and just prove independence in a test.
  Decide minimally; do not over-build a router (mutation→shard routing is the engine's ShardedTransactor
  concern, not this substrate).
- [ ] 4.3a Failing test: two lanes (shard "0" and "1") over one fs bucket, each acquired by a distinct
      writerId; interleave commits to both; assert each lane's manifest/segments/frontier advance
      INDEPENDENTLY (a commit to lane 0 never touches lane 1's manifest etag), and a fresh `open` of
      each lane materializes only that lane's state. `ensureGlobals` records `numShards===2`.
- [ ] 4.3b Implement the minimal composition (helper or none). Build/typecheck/test green. Commit.

**Gate:** N lanes are independent (distinct manifest-CAS domains, no cross-contention); numShards
recorded.

## Task 4.4 — Headline E2E: fence/failover takeover, deploymentId-preserved, fs + MinIO
**Files:** `test/failover.e2e.test.ts`.
- A shared `scenario(makeBucket)` (mirror bootstrap.e2e.test.ts's fs-always-on + MinIO-gated harness —
  `dockerAvailable() && STACKBASE_OBJECTSTORE_S3==="1"` → describe.skip):
  1. `ensureGlobals` (deploymentId "dep-1", numShards 1). Writer A: `open`+`acquire` shard "0" at now=0
     (ttl=1000); commit several mutations (enough for ≥1 snapshot so takeover exercises snapshot+tail
     bootstrap); A heartbeats a couple times (now advances < ttl).
  2. A "crashes" (stop calling it — do NOT release). Time advances PAST A's last `leaseExpiresAt`.
  3. Writer B: a FRESH local store, `ensureGlobals` (ADOPTS "dep-1" — assert B sees deploymentId
     "dep-1", NOT a new one), `open` shard "0" (bootstraps from the bucket: snapshot + tail), `acquire`
     at the advanced `now` → `{acquired:true}`, manifest `epoch` bumped, `writerId===B`.
  4. B commits new mutations; assert they land and B's local `scan` reflects A's committed history PLUS
     B's new writes (takeover bootstrapped the full state).
  5. A "revives": A.commit (or A.heartbeat) → `FencedError`, A poisoned (the zombie-writer fence).
  6. A truly-fresh `open`+re-`acquire` by yet another instance materializes the final combined state
     byte-identically.
- [ ] 4.4a fs variant (always-on) + MinIO-gated variant. Build/typecheck/test green (default skips
      MinIO). If docker is available locally, run once with `STACKBASE_OBJECTSTORE_S3=1` and report the
      result (the carried-note-I2 real-S3 fence coverage). Commit.

**Gate (headline):** a crashed owner is failed over after lease expiry; the new owner bootstraps the
full state from object storage, adopts the deployment identity, and resumes committing; the zombie old
owner is fenced — proven on fs AND real MinIO.

## Self-review
- Covers design §4 (commit fence), §5 (layout: manifest lease fields + globals), §7 (claim via
  epoch-CAS + bootstrap-on-takeover), §10 (concurrent-writers / stale-epoch / crash-with-unflushed-
  state failure rows). Cross-node reactivity (§8 frontier F, replicas), watermark GC (§6c), and the
  runtime heartbeat-driver wiring are DEFERRED to Slice 5 — stated explicitly above.
- Carried notes resolved: I1 (deploymentId in globals, adopt-on-open) = Task 4.1 + used in 4.4; I2
  (MinIO fence coverage) = Task 4.4's gated arm.
- Reuse honored: Slice-3 `open`/bootstrap, `casManifest`, segment/snapshot codecs, the existing
  poison/FencedError discipline. No fork of the commit path.
- Type consistency: `Manifest` extends (not redefines) the Slice-3 shape (`epoch`/`frontierTs`/
  `tsCounter`/`segments`/`nextSeqno`/`snapshotTs`/`snapshotSegBase` + new `writerId`/`leaseExpiresAt`);
  `now`/`leaseExpiresAt` are ms-epoch numbers carried as decimal strings (JSON has no bigint, matching
  the frontierTs/tsCounter convention).
