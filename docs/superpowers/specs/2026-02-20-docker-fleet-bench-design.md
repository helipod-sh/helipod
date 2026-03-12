# The `docker-fleet` bench axis — design (rung 3.5: resource-bounded fleet)

**Date:** 2026-02-20
**Status:** Approved (defaults taken per standing decide-decisively guidance while the user was
away — host driver / all three cells with netem best-effort / new axis on the shipped image;
revisit on request)
**Goal:** Upgrade the connection ladder's claims from *shape* (rung 3's unlimited co-located
processes) to *capacity planning*: every fleet node runs in a Docker container with
cgroup-enforced `cpus`/`memory` budgets, producing (1) a **budget capacity table** — "a
2-vCPU/1GB sync node holds X connections, sustains Y pushes/s, recovers a storm in Z s" — the
number real deployments size against; (2) an **enforced no-noisy-neighbor proof**; (3)
best-effort **netem WAN tiers** on the cross-node hop. The nodes boot from the repo's own
`Dockerfile` (the shipped self-host artifact) running `serve --fleet`, so the bench continuously
exercises the production Docker deploy path as a side effect.

## The honesty block (first-class, verbatim in the findings)

- **Containers do not create hardware.** All containers share one host; aggregate capacity
  beyond the host is NOT claimed. "Autoscaling" adds containers to the same silicon and is out
  of scope as a capacity claim.
- **Docker-on-macOS is a VM.** Docker Desktop interposes a VM with its own fixed allocation
  (stamped into every result from `docker info`: e.g. 15 vCPU / ~8.3GB on the dev machine);
  absolute numbers are VM-relative — shapes, ratios, and per-budget comparisons are the signal.
  A Linux host is the stated target for publishable absolutes.
- **The host driver crosses Docker Desktop's port-forward path** on every connection — overhead
  documented as constant across cells (ratios clean, absolutes caveated).
- **netem latency is simulation**, not geography.
- Inherited rung-1/3 boundaries: protocol-minimal swarm + full-client probes; paced accept
  floors; driver memory bounds N; fresh state per cell.

## Decisions (defaults taken 2026-02-20)

1. **Driver on the host → published ports** — the driver's gigabytes stay out of the VM
   envelope; everything-in-containers was rejected (driver OOM'd at 25k with the whole host;
   inside 8.3GB it caps measurable N far lower and steals node budget).
2. **All three cells** — budget capacity table, no-noisy-neighbor, netem WAN tiers
   (best-effort: skip cleanly with a stated reason if the VM kernel lacks `sch_netem`).
3. **New axis booting the real image** — `--axis docker-fleet`, `bench:dockerfleet`;
   a substrate flag on fleet-connections was rejected (container lifecycle vs child-process
   lifecycle would give the shared core two personalities).

## Topology

```
host                                          Docker Desktop VM (allocation stamped)
├── runner (bench:dockerfleet)                ├── postgres:16 container (shared store)
├── W swarm workers (rung-1 verbatim)  ──────►├── writer container    (stackbase image, serve --fleet)
└── probes (full StackbaseClients)     ──────►├── sync-node containers (cpus/memory limits per cell)
        via published ports                   └── (wanhop: tc/netem on the bridge)
```

- **Image**: built once per run from the repo's `Dockerfile` (the self-host `runner` stage),
  fixture `convex/` (rung 3's fleetconn fixture, `_generated` committed) bind-mounted read-only
  — the documented self-host pattern, now under fleet mode. `STACKBASE_ADMIN_KEY`,
  `--database-url postgres://…(container)`, `--fleet`, `--advertise-url` per node.
- **Store**: `postgres:16` container on the same Docker network (compose precedent), NOT
  embedded-pg — everything inside the VM boundary for consistent networking.
- **Per-container sampling**: `docker stats --no-stream` (CPU %, mem) replaces `ps`; readiness
  from container logs (the same `{"ready":…,"role":…}` line `serve` prints).
- **Envelope check before every cell**: sum of requested budgets + postgres + headroom must fit
  the VM allocation — fail fast with the exact math, never a silently-throttled cell.
- **Fresh state per cell**: containers + a fresh Postgres database per fleet (the rung-3
  lease-TTL lesson, applied via new DB per boot; containers removed with `docker rm -f`).

## The three cells

Budget tiers: `1cpu/512m`, `2cpu/1g`, `4cpu/2g` (env-overridable `DFLEET_TIERS`, fail-fast
validated).

1. **`budget`** — writer (fixed generous budget) + ONE sync node at the tier under test.
   Sweep N upward per tier (paced ramps) to the max clean N (all-connected, deliveredPct=100,
   no OOM-kill — `docker inspect` OOMKilled checked); report at that N: rssPerConn (from
   docker stats mem), hotpush p50/p99 + serverCpuPct, storm recovery + unchangedPct. Output =
   the capacity table rows.
2. **`neighbor`** — writer + THREE sync nodes at the middle tier, each holding N idle
   subscribers; drive hot fan-out against node A only. B/C must hold: idle CPU and probe push
   latency within compare bands of their own unloaded (A-quiet) control window, measured in the
   same cell run (control window first, then the A-load window). The cgroup-enforced isolation
   proof.
3. **`wanhop`** (best-effort) — writer + one sync node at the middle tier; `tc qdisc add …
   netem delay {1,10,50}ms` applied inside the sync container's namespace (or via a privileged
   sidecar if the image lacks tc); re-measure the cross-node push p50/p99 per tier. Detect
   netem support first; on absence, emit a skipped cell with `reason` in params — never a
   silent gap.

## Harness integration

- `benchmarks/runner/src/cores/docker-fleet.ts` — image build-once, container lifecycle
  (run/readiness/stats/rm), fresh-db-per-fleet, envelope check, the three cells (reusing the
  rung-1 worker protocol + probe patterns verbatim; workers target published ports).
- `benchmarks/runner/src/scenarios/docker-fleet.ts` — tiers × cells sweep; axis `docker-fleet`;
  root script `bench:dockerfleet`; gated on Docker availability (`docker info` probe) the way
  pg cells gate on `pgAvailable()` — skip with a stated reason, never fail, when absent.
- Compare-gate checklist (standing rule): register any new higher-better metrics; reuse
  deliveredPct/unchangedPct/framesPerSec/acceptPerSec; `reconnectFailed` stays zero-base-alerted.
- Small-N smoke (one tier, N=200, Docker-gated) in the runner suite; committed baseline;
  `benchmarks/docs/docker-fleet-findings.md` with the capacity table as centerpiece + the
  honesty block verbatim.

## Deliverables

1. The axis + smoke + committed baseline (VM allocation stamped).
2. The findings doc — capacity table ("what one small node handles, reproducibly, in the
   artifact you'd actually deploy"), the neighbor verdict, the wanhop curve (or its honest
   skip), the honesty block.
3. A `performance-backlog.md` note only if the budget table changes any standing verdict.

## Non-goals

- No capacity-multiplication claims; no autoscaling; no k8s/swarm orchestration.
- No engine changes (and none anticipated — rung 3 already fixed what the fleet needed).
- No multi-machine measurement (that remains the true rung 4, design-doc-only until demanded).
- No netem-based failure injection beyond latency (loss/jitter/partition = future work).
