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
- `InlineUdfExecutor` gains an optional `writeRouter` (threaded via ExecutorDeps or RunOptions
  — plan picks the smaller seam): for MUTATIONS, after arg validation + shard resolution and
  BEFORE the transaction: `if (router && !router.isLocalWriter(shardId)) return
  router.forward("mutation", path, argsJson, identity, shardId)` (the result shape matches the
  existing forwarded-run contract). This one chokepoint covers client WS mutations, `/api/run`,
  `ctx.runMutation` inside actions, AND the driver path — no per-caller patches.
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

- A `FencedError` from shard s's commit guard, or a 0-row heartbeat for s
  (`node.ts:725,741` today → `monitor.fenced()` → exit): becomes **relinquish(s)** — remove
  s from the held map (guard entry + epoch), release s's per-slot advisory lock (on s's commit
  connection), refresh lease state, log. The in-flight commit still aborts (FencedError
  propagates to its caller — client-retryable, and the forwarder's refresh will route the
  retry to the new owner). The node keeps serving everything else.
- Node **exit(1)** remains ONLY for definitive whole-node loss: pinned-connection
  `onConnectionLost`, per-shard commit-connection loss escalates to relinquish(s) (hazard-b
  wiring from B2a repurposed), and probe exhaustion as shipped.
- A relinquished shard's row was epoch-bumped by whoever fenced it (or is expired) — the
  balancer (D3) decides whether this node should re-acquire it later.

### D3. ShardLeaseBalancer — rendezvous, deterministic, no negotiation

- **Live node set** = distinct `writer_url`s across `shard_leases` rows with unexpired
  (heartbeating) leases. (A node's own membership: it appears once it holds ≥1 shard —
  bootstrap below.)
- **Target set** per node = rendezvous hashing: for each shard, every node computes
  `hash(shardId, advertise_url)` over the live set + ITSELF; the max-weight node owns it. All
  nodes derive the same assignment from the same rows — nothing to negotiate; membership
  changes move only the affected shards (rendezvous minimality).
- **Balancer beat** (every ~2s, alongside the existing acquire loop): (a) ACQUIRE any target
  shard that is expired or orphaned (`writer_url NULL`) — the shipped per-shard
  tryAcquire/eviction machinery; never steal a live non-target holder's shard (fencing a
  healthy peer is failover's job, not balancing's); (b) **gracefully RELEASE** any held shard
  no longer in the target set: drain via `tryRunExclusiveOnShard` (the B2a mutex seam — hold
  the mutex so no commit is in flight), self-fence (`epoch+1, writer_url = NULL`, frontier
  GREATEST-bump), drop from held map, release the slot lock. The rightful owner acquires on
  its next beat (~2s, not a 15s TTL wait).
- **Damping:** act only when the live set has been identical for ≥2 consecutive beats
  (~4s) — a flapping node doesn't thrash shard placement.
- **Bootstrap/role selection:** every fleet node races `tryAcquire(DEFAULT_SHARD)` at boot
  exactly as shipped. Winner = writer-ish boot (pool, pgStore runtime), then its balancer
  converges its held-set. Losers boot sync (replica) as shipped, and their acquire loop
  watches: if the balancer math (or failover) says they should hold shards (expired/orphaned
  targets exist), the shipped whole-node promotion runs FIRST (sync → writer-ish: store swap,
  drivers per D5, pool arming), then targeted acquisition. **Promotion stays whole-node** —
  a sync node that takes over any shard becomes fully writer-ish (v1; hybrid = B3).
- The **default shard** is a rendezvous participant like any other; whichever node owns it
  runs the drivers (D5).

### D4. Orphan frontier bumping — any node

The idle-closer's orphan branch: rows with `writer_url NULL` get
`frontier_ts = GREATEST(frontier_ts, nextval)` bumps from ANY node's beat (row-lock
serialized; no in-flight commits possible on a writer-less shard by construction — its last
writer was fenced first). F never wedges on an unassigned shard; min-F + count-gate tailing
is unchanged.

### D5. Drivers follow the default shard

Scheduler/workflow/cron/reaper drivers run ONLY on the current default-shard holder (as
shipped). On default-shard relinquish/loss: stop drivers (mirror the promotion `startDrivers`
in reverse — `stopDrivers` exists); on default-shard acquisition (boot or takeover): start
them. Scheduled SHARDED mutations now route correctly from wherever the driver runs (D1's
executor chokepoint) — the driver node forwards to the owner and the at-most-once claim
machinery is unaffected (the claim RMW is on unsharded scheduler tables = default ring, which
the driver's node holds by definition).

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
  movement on join/leave, full coverage of 8 shards over 1..4 nodes); balancer beat
  (acquire-missing-targets, never-steal-live-non-target, graceful release drains via the
  mutex seam, damping); per-shard relinquish (fence on s3 → held map loses s3, commits on s4
  keep working, no exit call); executor-level routing (mutation for non-held shard →
  router.forward called with the resolved shardId; held → local; driver-path runFunction on a
  non-held shard forwards — the regression for the node-killing hazard); writerUrlFor
  per-shard cache/refresh; orphan bumping.
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
