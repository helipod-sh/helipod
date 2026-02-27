# The `fleet-connections` bench axis — design

**Date:** 2026-01-15
**Status:** Approved (scope defaults taken per standing decide-decisively guidance while the user
was away: single-machine shape-proof + all four cells; revisit on request)
**Goal:** Rung 3 of the connection-scale ladder: measure what a multi-node sync fleet does to
connection capacity — per-node parity with the single-node baseline (the no-fleet-tax proof),
cross-node push propagation cost, failover-storm behavior, and whether spreading a hot query's
audience across nodes parallelizes the measured 19µs/subscriber send wall. Extends the shipped
`connections` axis machinery; same measure-first discipline.

## The honesty trap this design exists to respect

On ONE machine, K fleet nodes share the same RAM/CPU/kernel. "Capacity multiplies with nodes"
CANNOT be truthfully measured here and this axis does not claim it. What single-machine
co-location CAN honestly measure: **per-node marginal costs** (parity), **cross-node latency**
(a real network-of-processes hop, loopback caveat stated), **failover redistribution**, and
**fan-out parallelization shape**. The findings state capacity multiplication as
arithmetic-from-parity, pending a real multi-machine campaign (its own future arc, only if the
shape-proof and a real need justify it).

## Decisions (defaults taken 2026-01-15)

1. **Scope: single-machine shape-proof** — lands now, no infra; the multi-machine campaign was
   considered and deferred.
2. **Cells: all four** — parity, xnode, failstorm, hotfan (hotfan included because it directly
   answers the "millions of CCU on one hot audience" question the ladder started from).
3. **Structure: extend rung 1** (Approach A) — new core + scenario reusing the swarm workers,
   probes, frame helpers, and `ps` sampling verbatim; a standalone script (can't gate) and
   skip-to-multi-machine (premature) were rejected.

## Topology

```
runner (bench:fleetconn)
├── embedded-postgres           ← the fleet's shared store (the Tier 2 substrate)
├── writer serve child          ← real `startServe`-path process, fleet mode
├── K sync-node serve children  ← K ∈ {1, 2, 4}; each ps-sampled independently
├── W swarm workers             ← rung 1's connections-worker.ts VERBATIM; each told which
│                                  node URL its shard targets (paced ramps, failed counts)
└── probes                      ← full StackbaseClients, subscribed per-node
```

- Fleet nodes are spawned CHILD processes over the shipped `serve` fleet path (env:
  `STACKBASE_FLEET=1`, `STACKBASE_DATABASE_URL` → embedded-pg, `STACKBASE_ADMIN_KEY`, per-node
  port/`STACKBASE_ADVERTISE_URL`) — the same boot shape `packages/cli/test/outbox-e2e.test.ts`'s
  fleet arm uses. Child processes because per-node RSS/CPU come from `ps`, same as rung 1.
- The store is embedded-postgres (real native PG per the 3-tier substrate rule) — a fleet
  requires the shared durable store; in-memory SQLite is structurally unavailable here. Stated
  in the findings (idle RSS baselines differ from the sqlite rung-1 numbers; parity compares
  fleet-node-vs-fleet-node and marginal-vs-baseline SHAPE, not absolute RSS).
- Writer node exists for writes (probes drive mutations through it); swarm subscribers connect
  ONLY to sync nodes.

## The four cells

Default N_total = 8,000 (driver-safe under rung 1's measured driver boundary), sweeping
K ∈ {1, 2, 4}; `FLEETCONN_NS` / `FLEETCONN_KS` / `CONN_WORKERS` env overrides with the same
fail-fast validation as rung 1.

1. **`parity`** — N/K idle subscribers per sync node, no writes: per-node ΔRSS/conn, idle CPU,
   paced accept rate. PASS shape: within `bench:compare` bands of the single-node baseline's
   marginal costs (no fleet tax on holding connections). K=1 is the control cell (fleet-mode
   single sync node vs rung 1's non-fleet node — isolates fleet-mode overhead itself).
2. **`xnode`** — subscribers spread N/K per node; ~5 writes/sec driven through the WRITER;
   probes on each sync node measure push p50/p99. Reported per-node so the
   writer-commit → fan-out → sync-node-push hop cost is visible; deliveredPct across the whole
   swarm validates no cross-node loss.
3. **`failstorm`** — hold at K nodes; SIGKILL one sync node; its workers reconnect its share
   onto the survivors (jittered spread, echoing fingerprints): time-to-all-recovered, survivor
   per-node RSS/CPU deltas, `QueryUnchanged` fraction, `reconnectFailed`. Exercises shipped
   failover + resume at connection scale — the cell only a fleet can run.
4. **`hotfan`** — ONE hot query, its N_total subscribers split across K sync nodes; writes via
   the writer: per-write full-fan-out latency (all probes on all nodes see it) and per-node CPU
   vs the K=1 control. PASS shape if the fleet parallelizes the send wall: per-node send time
   ≈ single-node/(K) for the same N_total (each node serializes only its share). This is the
   cell that says whether "millions on one hot audience" is already answered by horizontal sync
   nodes at moderate K, or genuinely needs send-path dedup (#9/#11).

## Harness integration

- `benchmarks/runner/src/cores/fleet-connections.ts` — fleet lifecycle (embedded-pg, writer + K
  sync children, per-node ps), cell logic; reuses `connections-worker.ts`, the frame helpers,
  `proc-stats`, and the paced-ramp/aggregate-pacing rules unchanged.
- `benchmarks/runner/src/scenarios/fleet-connections.ts` — cells × K sweep; axis
  `fleet-connections`; root script `bench:fleetconn`.
- Results in the standard schema; committed baseline `benchmarks/baselines/fleet-connections-baseline.json`;
  `bench:compare` gates it (register any new higher-better metrics + zero-base alert counters —
  the rung-1 polarity lesson is now a checklist item).
- Small-K/small-N smoke (K=2, N=200) in the runner's vitest suite; fd guardrails inherited.

## Honesty rules (stated in the findings)

- Single-machine co-location: per-node marginal claims only; NO aggregate-capacity
  multiplication claim — stated as arithmetic-from-parity pending multi-machine measurement.
- Embedded-postgres substrate (fleet-required); loopback; protocol-minimal swarm + full-client
  probes; driver boundary inherited from rung 1 (N_total capped accordingly); paced accept
  rates are floors.
- The failstorm's recovery time includes the swarm's own jittered reconnect spread (stated).

## Deliverables

1. The axis + smoke tests + committed baseline.
2. `benchmarks/docs/fleet-connections-findings.md` — the four verdicts (fleet tax? hop cost?
   storm behavior? does K parallelize the 19µs/subscriber wall?), with every number traceable
   to the baseline JSON and the boundaries above verbatim.
3. `benchmarks/docs/performance-backlog.md` updated if `hotfan` changes the #9/#11 picture
   (e.g. "the fleet already parallelizes hot fan-out at K≤4 — dedup trigger raised/lowered
   accordingly").

## Non-goals

- No multi-machine measurement (its own future arc); no engine/fleet changes (pure consumer);
- No writer-connection benching (subscribers live on sync nodes by design);
- No new optimization work — measure first; `hotfan`'s verdict gates whether send-path dedup
  is even needed.

*(post-plan relaxation: one surgical ee/fleet fix — FrontierMonitor notify-on-advance — was
made in-slice after the bench root-caused the 1s cross-node poll-fallback; taken by default
while the user was away, ratified at the merge gate; see notify-diagnosis.md)*
