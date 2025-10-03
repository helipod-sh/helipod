# Shards B2b — Multi-Node Shard Distribution

**Status:** approved design (brainstormed 2025-10-01)
**Protocol basis:** `docs/dev/research/write-sharding/verdict.md` §b/§d (B2 fleet half)
**Builds on:** B2a (main `0860b80`): sharding live single-node — ShardedTransactor, per-shard
commit pool + slot locks, shardBy routing + one-doc-one-ring guards, N shard_leases with
per-shard fencing/frontiers, min-F tailing, NUM_SHARDS=8 persist-once.

## Goal

Shards distribute across nodes: two+ writer nodes commit concurrently on disjoint shard sets,
a deterministic balancer keeps the assignment converged with no coordinator service, per-shard
failover moves only the dead node's shards, and every write reaches its shard's owner from any
entry point — including the scheduler/driver path, which today would fence-and-kill a node.

## Non-goals

Hybrid nodes (replica reads + partial writes on one node — B3's split-snapshot territory;
v1 roles: ≥1 shard held = writer-ish, reads primary; 0 shards = pure sync, reads replica) ·
forward idempotency/commit-dedup (**explicitly deferred**: the transport-failure-after-commit
double-execution window is unchanged from shipped B1/B2a — not a regression; a proper fix
needs result-recording dedup; interim contract documented as at-least-once for that narrow
window; B3 candidate) · partial replicas · group commit (B4) · resharding (B5).

## Design

### D1. Routing moves into the executor (the keystone — fixes the driver hazard structurally)

Today the runtime checks the binary `WriteRouter.isLocalWriter()` BEFORE `executor.run`
resolves the shard — which is why drivers (calling `executor.run` directly) bypass routing
entirely, and why a scheduled sharded mutation would execute on a non-held shard, fence, and
(under B1 policy) kill the node.

- `WriteRouter` (core, `packages/runtime-embedded`) becomes per-shard:
  `isLocalWriter(shardId: ShardId): boolean` · `forward(kind, path, args, identity,
  shardId: ShardId): Promise<JSONValue>`. (Signature change on an ee-implemented interface —
  update the serve.ts structural mirrors in lockstep.)
- `InlineUdfExecutor` gains an optional `writeRouter` **on ExecutorDeps** (spec-review edit —
  it must be visible to the trusted `invoke` path so an action's inner `ctx.runMutation`
  forwards per-shard too): for MUTATIONS, after arg validation + shard resolution and BEFORE
  the transaction: `if (router && !router.isLocalWriter(shardId)) return
  router.forward("mutation", path, convexToJson(args), identity, shardId)` — args are already
  converted `Value`s at this point, so the forward **re-serializes via `convexToJson`**
  (spec-review edit; the import exists in executor.ts). This one chokepoint covers client WS
  mutations, `/api/run`, `ctx.runMutation` inside actions, AND the driver path.
- **Single-hop guard (spec-review edit — without it, a forward landing on a just-relinquished
  owner re-forwards unboundedly during convergence):** the `/_fleet/run` body gains
  `forwarded: true`; the receiving node threads it into the run as a router bypass-with-check:
  if the receiving node is NOT the owner either, it does NOT re-forward — it returns a
  retryable "not the owner" error; the ORIGINAL forwarder's existing refresh+retry-once then
  re-reads the lease and re-routes. Max one hop, enforced at the receiver.
- **Gating (spec-review edit):** the executor router check applies to non-privileged mutations
  AND driver/privileged runs (desired — that's the driver fix), but NOT to boot-step mutations
  (`runtime.create`'s boot steps run before the node is ready and must stay local — gate via
  the existing privileged+options combination; boot steps pass an explicit `localOnly` run
  option). `runSystem` doc mutations already carry their resolved `shardId` (B2a) — the router
  forwards them like any other when the shard isn't held (the dashboard works against any node).
- The runtime-level router checks for mutations are REMOVED (superseded); actions keep the
  runtime-level wholesale forward, now targeted at the **default-shard holder**
  (`writerUrlFor(DEFAULT_SHARD)`) — an action's inner mutations route individually once it
  runs on any writer-ish node.
- `WriteForwarder`: `writerUrl()` becomes `writerUrlFor(shardId)` — reads THAT shard's
  `shard_leases` row (per-shard cache; refresh-on-miss/on-failure + retry-once as shipped).
  `isLocalWriter(shardId)` = membership in the node's held-set (live view of the per-shard
  epoch map). A writer-ish node forwards mutations for shards it doesn't hold (writer→writer
  forwarding is now normal traffic).

### D2. Per-shard fence policy — relinquish, not exit

- A `FencedError` from shard s's commit guard, or a fenced heartbeat for s, becomes
  **relinquish(s)** — remove s from the held map (guard entry + epoch), release s's per-slot
  advisory lock, refresh lease state, log. The in-flight commit still aborts (FencedError
  propagates to its caller — client-retryable, and the forwarder's refresh will route the
  retry to the new owner). The node keeps serving everything else.
- **Three shipped seams don't tolerate this reuse (spec-review edits, each a named change):**
  (a) the PgClient seam has NO advisory-unlock — add `releaseShardLock(slot)`
  (`pg_advisory_unlock(classId, slot)` two-int form, executed ON that shard's commit
  connection, mirroring how the lock was taken); (b) `LeaseMonitor.fenced()` is at-most-once
  WHOLE-NODE exit machinery — it is NOT repurposed: it stays reserved for definitive
  whole-node loss, and per-shard fences route to a NEW relinquish dispatcher
  (`relinquish(shardId, reason)` on the node, idempotent per shard); (c) `heartbeatAll`
  discards which rows matched — it must RETURN the fenced shard ids
  (`RETURNING shard_id` diffed against the held set) so the beat can relinquish precisely.
- Node **exit(1)** remains ONLY for definitive whole-node loss: pinned-connection
  `onConnectionLost` and probe exhaustion as shipped. Per-shard commit-connection loss
  (B2a hazard-b wiring) re-routes to relinquish(s), not exit.
- A relinquished shard's row was epoch-bumped by whoever fenced it (or is expired) — the
  balancer (D3) decides whether this node should re-acquire it later.

### D3. ShardLeaseBalancer — rendezvous, deterministic, no negotiation

- **`fleet_nodes` presence table (spec-review edit — WITHOUT it the design deadlocks: a
  shardless node appears in no `shard_leases` row → invisible to every peer's live set →
  never assigned → never holds anything; and the incumbent releases nothing because the
  newcomer is invisible to IT — mutual invisibility, scale-out never happens):**
  `fleet_nodes(advertise_url PK, epoch, expires_at)` — EVERY fleet node (including shardless
  sync nodes) heartbeats its row on the shipped lease TTL clock. **Live node set** = distinct
  unexpired `advertise_url`s in `fleet_nodes` (∪ `shard_leases.writer_url` holders as
  belt-and-braces). A dead node's presence row expires → survivors' rendezvous re-converges.
- **Target set** per node = rendezvous hashing: for each shard, every node computes
  `hash(shardId, advertise_url)` over the live set; the max-weight node owns it. All nodes
  derive the same assignment from the same rows — nothing to negotiate; membership changes
  move only the affected shards (rendezvous minimality).
- **Balancer beat** (every ~2s, alongside the existing acquire loop): (a) ACQUIRE any target
  shard that is expired or orphaned (`writer_url NULL`) — the shipped per-shard
  tryAcquire/eviction machinery; never steal a live non-target holder's shard (fencing a
  healthy peer is failover's job, not balancing's — the healthy holder releases it
  voluntarily per (b)); (b) **gracefully RELEASE** any held shard no longer in the target
  set — **a point-in-time exclusion, not a drain (spec-review edit):** `tryRunExclusiveOnShard`
  excludes only the commit phase; a mutation mid-read/execute at release time will hit
  `FencedError` at its commit — that's OCC-retryable by contract (client retries; the
  forwarder's refresh routes the retry to the new owner). Under the exclusion: self-fence
  (`epoch+1, writer_url = NULL`, frontier GREATEST-bump), drop from held map, release the
  slot lock. The rightful owner acquires on its next beat (~2s, not a 15s TTL wait).
- **Damping:** act only when the live set has been identical for ≥2 consecutive beats
  (~4s) — a flapping node doesn't thrash placement; transient rendezvous disagreement during
  a membership change resolves within the damping window (acquisition only targets
  expired/orphaned rows, so two nodes can't both hold a shard regardless).
- **Bootstrap/role selection:** every fleet node writes its `fleet_nodes` row FIRST, then
  races `tryAcquire(DEFAULT_SHARD)` as shipped. Winner = writer-ish boot. **`armWriter` is
  split (spec-review edit — the shipped acquire-all loop would fence live peers in a
  multi-writer world):** role-arm (pool, guards, store swap, monitor, drivers-if-default)
  acquires NO shards beyond default; the balancer does ALL targeted acquisition. Losers boot
  sync as shipped; **the promotion trigger generalizes (spec-review edit):** not just the
  default-shard acquire loop — a sync node whose rendezvous targets include ANY
  expired/orphaned shard runs the shipped whole-node promotion first (sync → writer-ish),
  then targeted acquisition. **Promotion stays whole-node** (v1; hybrid = B3).
- The **default shard** is a rendezvous participant like any other; whichever node owns it
  runs the drivers (D5).

### D4. Orphan frontier bumping — any WRITER node (net-new query)

**Spec-review edits:** the shipped `closeIdleFrontiers` iterates only the node's OWN
`heldPairs()` — the orphan bump is a NEW query on the writer beat: rows with
`writer_url NULL` get `frontier_ts = GREATEST(frontier_ts, $nextval)` (row-lock serialized;
no in-flight commits possible on a writer-less shard by construction — its last writer was
fenced first). And "any node" precisely means **any WRITER node** — sync nodes run
`closeIdle: false` and never allocate `nextval`; correct while ≥1 writer exists (a
zero-writer fleet has no commits to wedge behind). F never wedges on an unassigned shard;
min-F + count-gate tailing is unchanged.

### D5. Drivers follow the default shard

Scheduler/workflow/cron/reaper drivers run ONLY on the current default-shard holder (as
shipped). **Spec-review edits — the shipped stop path has two footguns that must be fixed,
not reused:** `stopDrivers()` also `dispose()`s the sync handler (fatal on a
default-relinquish where the node keeps serving), and the `driversStarted` flag is one-way
(a stop→start cycle would no-op the restart). B2b adds a **driver-only, symmetric,
idempotent-both-ways `startDrivers()`/`stopDriversOnly()`** pair that never touches the
handler and resets the flag. On default-shard relinquish/loss: `stopDriversOnly()`; on
default-shard acquisition (boot or takeover): `startDrivers()`. A mid-flight claimed job at
stop time is covered by the shipped at-most-once machinery (the claim row's lease expires
and the NEW default-holder's driver re-claims — same crash-tolerance path as a node death).
Scheduled SHARDED mutations now route correctly from wherever the driver runs (D1's executor
chokepoint) — the claim RMW is on unsharded scheduler tables = default ring, which the
driver's node holds by definition.

### D6. RYOW cross-node (accepted budget)

A commit on node B's s5 bumps s5's frontier inside the commit; the sync node's `waitFor`
target is min-F, which may lag by one idle-close beat of OTHER nodes' shards (~100ms
worst-case). Within the verdict's stated envelope; the progress-aware wait (hardening slice)
already surfaces stalls. No changes beyond D4 keeping orphans moving.

## Error handling summary

| Failure | Behavior |
|---|---|
| Scheduled/driver sharded mutation, shard held elsewhere | Forwarded to the owner (D1) — the node-killing fence is structurally impossible |
| FencedError / 0-row heartbeat on shard s | Relinquish s; node keeps serving; in-flight commit aborts visibly |
| Node dies | Its shards expire → survivors' balancers fence+acquire their rendezvous shares; only those shards' writes stall (≤ TTL + beat) |
| Node joins | Live set changes → after damping, peers gracefully release its rendezvous share (~4-6s convergence, no failover event) |
| Live-set flapping | Damping (2 stable beats) prevents thrash |
| Orphaned shard pins F | Any node's beat bumps it (D4) |
| Forward hits a stale owner | Per-shard cache refresh + retry-once (shipped pattern, now per shard) |

## Testing

- **Unit (PGlite + fakes):** rendezvous assignment (deterministic across nodes, minimal
  movement on join/leave, full coverage of 8 shards over 1..4 nodes); **the bootstrap
  regression (the spec-review deadlock): a shardless node's presence row makes it a
  rendezvous participant — with fleet_nodes it receives targets; without (simulated) it never
  would**; balancer beat (acquire-missing-targets, never-steal-live-non-target, point-in-time
  release under the mutex seam, damping); per-shard relinquish (fence on s3 → held map loses
  s3, commits on s4 keep working, no exit call; heartbeatAll returns the fenced ids; slot
  lock released via releaseShardLock without connection death); executor-level routing
  (mutation for non-held shard → router.forward called with the resolved shardId; held →
  local; driver-path runFunction on a non-held shard forwards — the regression for the
  node-killing hazard; **single-hop: a forwarded=true run on a non-owner returns the
  retryable not-the-owner error, never re-forwards**; boot-step mutations stay local);
  writerUrlFor per-shard cache/refresh; orphan bumping (net-new query, writer-beat only);
  driver-only stop/start cycle restarts drivers and never disposes the handler.
- **E2E ship gate** (extend fleet-e2e, Docker-gated, all hygiene): nodes A+B (writers) + C
  (sync): (1) balancer converges — A and B hold disjoint non-empty shard sets (direct pg
  assert), damped (no thrash across 10s); (2) concurrent commits on shards held by DIFFERENT
  NODES both succeed; C's cross-shard subscription (opened before) sees both, monotonic
  containment; (3) RYOW cross-node via C; (4) a scheduled sharded mutation enqueued on the
  default-holder for a shard held by the OTHER node executes correctly (the driver-forward
  proof) and NO node exits; (5) kill node A → B's balancer fences+acquires A's shards while
  B's own shards keep committing THROUGHOUT (assert an uninterrupted commit loop on B's
  shards); zero skipped ts over the whole run; (6) boot node D → after damping, shards
  redistribute via graceful release (epoch bumps WITHOUT expiry waits; no failover-style
  stall on the moved shards' F).
- Full monorepo gate green; single-node fleet behavior byte-identical (a 1-node fleet's
  rendezvous target = everything — the existing E2E scenarios are that proof, unmodified).

## Docs

`docs/enduser/deploy/fleet.md`: multi-writer distribution section (add nodes → shards spread
automatically; per-shard failover; the read/write scaling knobs: writer nodes vs sync nodes);
`sharding.md` pointer update; `write-sharding-research.md` status (B2b SHIPPED when done).
