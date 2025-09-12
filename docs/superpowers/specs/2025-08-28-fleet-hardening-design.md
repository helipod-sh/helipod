# Fleet Hardening — Backpressure, RYOW-for-Actions, Lease/Replica Safety

**Status:** approved design (brainstormed 2025-08-28)
**Builds on:** Fleet slices 1+2 (shipped, main `ebc4f63`). Precedes the write-sharding research
(slice B — researched separately after this ships).
**Follow-up ledger basis:** the accumulated non-blocking findings from the slice-1/2 task and
whole-branch reviews, promoted here into a deliberate slice.

## Goal

Make the shipped fleet production-grade at its current shape. Every item turns a silent,
unbounded, or aspirational behavior into a **visible and bounded** one: drop → resync,
exit → restart-and-rejoin, mismatch → rebuild, discard → guarantee. Eight items, two zones.

**Scope decision (YAGNI):** the seam-8 query cache is explicitly OUT — replicas already made
subscription re-runs local; no measured need; write-sharding research may reshape it.

## Non-goals

Write sharding (separate research → slice B) · autoscale/topology (seam 9) · query cache
(seam 8) · load balancing · any client SDK change · any wire-protocol change (backpressure
drops rely on the EXISTING client version-gap resync).

## Items

### FSL core

**C1. Server backpressure + heartbeat controllers** (`packages/sync` — seam 6's missing server
half, a Foundation obligation per scalability-spectrum.md §5.6, so it is core, not ee):
- `SessionBackpressureController`: every outbound frame passes through it. It watches the
  socket's `bufferedAmount` against a high-water mark (default 1 MiB), drains into a bounded
  per-session queue (default 200 frames), and **drops** frames beyond the limit or after a
  slow-client timeout (default 30s of sustained backpressure). Dropping is safe by design: a
  `Transition` gap makes the client full-resync (built in Foundation for exactly this). Drops
  are counted and logged (per-session counters, one warn per episode — not per frame).
- `SessionHeartbeatController`: server-side ping/liveness — a session with no socket activity
  for the idle timeout (default 60s; ping at half) is reaped (socket closed, session removed).
- Both wired into `SyncProtocolHandler`'s session lifecycle for **every** transport; on the
  Tier 0 loopback they are effectively no-ops (bufferedAmount is always 0; heartbeat sees
  constant activity or is configured off for loopback — decide in plan against how the
  loopback socket behaves). The existing full suite passing unchanged IS the no-op proof.
- Config surfaces as optional handler options with the defaults above; no env vars this slice.

**C2. Read-your-own-writes for actions** (`packages/executor` + delete a documented limitation):
- The action runner currently returns `{commitTs: 0n, oplog: null}` unconditionally, discarding
  inner `ctx.runMutation` commit timestamps. Fix: the action's `UdfResult` carries
  `commitTs = max(inner mutation commitTs)` observed during the action (0n when it wrote
  nothing). Thread it through the trusted `invoke` path's results.
- Downstream already works unchanged: `/_fleet/run` returns `commitTs`, the forwarder waits
  when non-zero. Mutations' behavior untouched.
- `docs/enduser/deploy/fleet.md`'s "does not extend to actions" paragraph is REPLACED by the
  guarantee (and the E2E asserts it — see Testing).
- Non-fleet impact: additive field on action results; nothing else consumes it today. Audit
  the few consumers of action `UdfResult`s (loopback client, scheduler driver, http-handler)
  for accidental behavior change — expected none (they read `.value`).

**C3. httpAction proxy header fidelity** (`packages/cli/src/http-handler.ts`): the sync-node
proxy currently copies response headers verbatim after undici auto-decompressed the body —
a writer httpAction setting `Content-Encoding: gzip` would corrupt. Fix: strip
`content-encoding` and `content-length` from the relayed response headers (undici hands us
decoded bytes; length is recomputed by the server). One unit test with a gzip-claiming stub.

### ee/fleet

**C4. Writer self-exit on lease loss** (`ee/packages/fleet`): the writer holds its lease on a
Postgres session; today, if that session dies (network partition, PG restart), the writer
just errors on every operation while the doc claims it "must exit". Make it real: the fleet
node monitors lease-session liveness (the dedicated lease connection's `error`/`end` events,
plus a periodic cheap probe ~5s as belt-and-braces) and on loss **logs + `process.exit(1)`**
— the supervisor/Docker restarts it and it rejoins as a sync node (slice-1 behavior, now
actually reachable). Exit is the policy: a writer that cannot verify its lease must not keep
accepting writes (they'd all fail anyway) and must not silently linger.

**C5. Promotion error policy** (`ee/packages/fleet/src/node.ts`): the promotion sequence runs
in a detached async block with no catch — a mid-promotion throw is an unhandled rejection
with a sticky `promoting` flag. Policy: wrap the sequence; on failure **log + `process.exit(1)`**
(a node stuck half-promoted — store swapped but drivers dead, or writable-but-not-swapped —
is strictly worse than a restart that rejoins cleanly). Same restart-and-rejoin story as C4.

**C6. Tailer stop-during-bootstrap re-arm race** (`ee/packages/fleet/src/replica-tailer.ts`):
`stop()` during `start()`'s bootstrap loop currently lets start() fall through and re-arm the
poll interval + LISTEN. Fix: re-check `stopped` after the bootstrap loop and before arming;
arming and `stop()` must be mutually consistent (no leaked timer/listener under any
interleaving). Unit test with a deliberate mid-bootstrap stop.

**C7. Foreign-replica identity stamp** (`ee/packages/fleet`): a replica file reused against a
DIFFERENT primary is currently served as-is (foreign rows below the watermark). Fix: the
primary carries a persistent **deployment id** — a `persistence_globals` row (`fleet:deploymentId`,
a UUID minted once by the first writer via `writeGlobalIfAbsent`). The replica mirrors it
(same key, its own store). At sync boot: read both; mismatch (or replica has data but no
stamp) → warn + delete the replica file + re-bootstrap; fresh replica → adopt the primary's
id. Uses only existing `getGlobal`/`writeGlobalIfAbsent` — no schema change.

**C8. Small leaks/guards** (`packages/docstore-postgres` + `ee/packages/fleet`):
- `NodePgClient.listen`: if the `LISTEN` query fails after `connect()` succeeded, end the
  dedicated connection before rethrowing (no orphan connection).
- Forwarder warn-once guards: absent-commitTs and unparseable-commitTs get separate flags.

## Error-handling philosophy (binding for every item)

Degradations must be **visible and bounded, never silent or infinite**: drop → counted +
resync; dead socket → reaped; lease lost / promotion failed → exit(1) → supervisor restart →
rejoin; foreign replica → rebuild; proxy encoding → correct bytes. No new retry loops without
a bound; no swallowed errors without a counter or log.

## Testing

- **Unit:** backpressure (fake socket with scripted `bufferedAmount`: queue → drop → episode
  warn counter); heartbeat (fake timers: idle reap, activity keeps alive); RYOW-for-actions
  (executor level: action with 0/1/3 inner mutations → commitTs 0n / that ts / max);
  proxy header stripping (gzip-claiming stub response); tailer stop-mid-bootstrap (no re-arm);
  identity stamp (fresh adopt / match / mismatch→rebuild); listen-failure connection cleanup;
  warn-once guard split. Promotion-failure and lease-loss exit policies are tested by
  extracting the decision into a testable function (`process.exit` injected/spied).
- **E2E** (extend `ee/packages/fleet/test/fleet-e2e.test.ts`, Docker-gated, keep all hygiene):
  1. **RYOW-for-actions:** an action that writes via `ctx.runMutation`, called via sync node
     B → immediate query on B sees the write (the previously-documented limitation, now an
     assertion).
  2. **Writer self-exit:** sever the writer's Postgres sessions (restart the PG container —
     `docker restart`, unlike the offload test's `pause`) → the writer process EXITS within a
     bounded window → when PG is back, a surviving sync node takes the lease (epoch bump) and
     writes resume. (Assert the old writer's process exit code/liveness, the epoch bump, and a
     committed post-recovery mutation + push.)
- Full monorepo gate green throughout. The unchanged non-fleet suite passing is the proof that
  C1's controllers are no-ops on loopback and C2 is additive.

## Docs

`docs/enduser/deploy/fleet.md`: RYOW section rewritten (actions now covered — state the new
guarantee and its same 5s bound); failover section gains the now-real writer self-exit
behavior; a short "slow clients" note (drops degrade to resync, bounded memory). Keep the
honest limits section (single writer; no autoscaler) intact.

## Slice B pointer (next, not this spec)

Write sharding gets a dedicated research doc first (multi-writer over a shared log:
safe-watermark/low-water-mark protocols, Calvin/FoundationDB sequencers, CockroachDB closed
timestamps; the mutation-shard routing DX) — same two-pass treatment as
`tier2-topology-research.md`, then its own brainstorm → spec.
