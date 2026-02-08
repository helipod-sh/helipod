# The `connections` bench axis — design

**Date:** 2026-01-15
**Status:** Approved
**Goal:** Measure a sync node's concurrent-WebSocket capacity as a first-class, repeatable
benchmark axis — ΔRSS per connection, hot-query push latency at scale, per-subscription state
cost, and mass-reconnect-storm behavior — so "X connections per node" becomes a *measured,
publishable* number and the recurring gate for future connection-scale optimizations
(query-result sharing, send batching, off-thread fan-out), exactly the role the reactive axis
played for the DLR stages. First rung of the connection-scale ladder (bench → fix what it
indicts → publish the number → edge-gateway design-doc only if demanded).

## Decisions taken (with the user, 2026-01-15)

1. **Load fidelity: hybrid swarm + probes** — N lightweight raw-WebSocket connections speaking
   minimal sync protocol (cheap enough for 50k+ from the driver side) plus ~10 full
   `StackbaseClient` probes measuring real-client push latency. Full-clients-only (driver
   becomes the bottleneck ~10-20k) and raw-only (no user-felt latency) were rejected.
2. **v1 scope: all four cells** — idle memory/accept, hot-query push, distinct-query scaling,
   reconnect storm.
3. **Integration: first-class axis** — `--axis connections`, JSON results, committed baseline,
   `bench:compare` regression bands. A standalone script was rejected: it couldn't gate future
   work.
4. **Isolation note:** built in a dedicated worktree (`bench-connections` branch off `main`)
   because the main checkout is occupied by the Tier 3 arc; file footprints are disjoint
   (`benchmarks/*` vs `ee/*`).

## Topology — three roles, three process kinds

```
runner (bench:connections)
├── server child process        ← the system under test; RSS/CPU sampled externally via ps
│     startDevServer over in-memory SQLite (store is deliberately NOT the variable)
├── W swarm worker child procs  ← default 4; each holds N/W lightweight raw-ws connections
│     minimal protocol: Connect, one subscribe, answer pings, count-and-discard pushes
└── ~10 probe StackbaseClients  ← in the runner; real clients measuring write→push latency
```

- **Server as a child process** is load-bearing: the headline metric is ΔRSS/connection, and
  in-process drivers would contaminate it. A tiny bench entry (`server-entry.ts`) boots
  `startDevServer` with a fixture app and prints `{port, pid}`; the runner samples
  `ps -o rss=,%cpu= -p <pid>`.
- **Swarm workers** shard the client-side fd/memory load so no single driver process needs 50k
  sockets. Workers speak to the runner over stdio IPC (JSON lines): commands
  (`connect N`, `kill-all`, `reconnect`), reports (counts, per-worker connect timings, frames
  received).
- **Swarm connection = minimal sync protocol**, not a fake TCP socket: it must be a *real
  subscriber* (server allocates real session + subscription state for it) or the measurement
  lies. Frames per `packages/sync/src/protocol.ts`: `Connect {sessionId}`, one
  `ModifyQuerySet {add:[query]}`, pong/heartbeat replies, then passively count inbound frames.
  No outbox, no optimistic machinery — swarm connections never mutate.
- **Probes = full `StackbaseClient`s** over `webSocketTransport` (the `ws` shim, as existing
  benches do), subscribed to the same queries as the relevant cell; they measure propagation
  (write→listener-fires), the same metric shape the reactive axis reports.

## The four cells

Each swept over `N ∈ {1k, 5k, 10k, 25k, 50k}` (default; `--max` pushes best-effort beyond, and
`--n` overrides the sweep for quick runs). Fixture app: one table, a `hot:get`-style query for
the fan-out cells and a parameterized per-connection query for `distinct`.

1. **`idle`** — establish N swarm connections all subscribed to the hot query; no writes for
   the measure window. Report: ΔRSS/connection (server RSS at N minus baseline RSS, over N),
   accept rate (connections/sec during ramp; total time-to-N), idle server CPU % (the
   heartbeat + bookkeeping bill).
2. **`hotpush`** — same subscription shape; the runner drives a steady write rate (default
   5 writes/sec) against the hot document. Report: probe push p50/p99 at each N, server CPU %,
   outbound frames/sec (from swarm counts — also validates every subscriber actually received
   every push). This is the cell that prices the measured no-dedup gap (perf-backlog #9) and
   the parked off-thread-send idea (#11) at connection scale.
3. **`distinct`** — each swarm connection subscribes to its OWN query (unique arg → disjoint
   read ranges). Report: ΔRSS/connection (now including per-subscription read-set state), and
   single-write matcher behavior: write one connection's range, measure probe latency on that
   range (validates the interval matcher's O(log N) at N live subs — flat-ish latency as N
   grows is the pass shape).
4. **`storm`** — at N, workers hard-destroy every socket simultaneously, then reconnect on the
   client's own jittered-backoff schedule (the swarm mimics `reconnectDelayMs`'s spread).
   Report: time-to-all-resubscribed, server CPU peak during the storm, and the
   `QueryUnchanged` fraction (unchanged data → the resume path answers cheaply; this
   exercises the shipped fingerprint-resume + DLR-3 machinery at scale).

## Harness integration

- `benchmarks/runner/src/cores/connections.ts` — the measurement engine (server child
  lifecycle, worker orchestration, ps sampling, cell logic).
- `benchmarks/runner/src/scenarios/connections.ts` — cell/sweep definitions in the axis
  registry shape.
- `benchmarks/runner/src/connections-worker.ts` + `connections-server-entry.ts` — the child
  entries.
- CLI: `--axis connections` in `run`; root script `bun run bench:connections`. Results in the
  standard JSON schema (+ machine profile), committed baseline under `benchmarks/baselines/`,
  `bench:compare` works unchanged.

## Kernel/FD guardrails (fail fast, never garbage numbers)

- N connections consume N fds server-side and N/W per worker. The runner checks `ulimit -n`
  before ramping and **aborts with exact raise instructions** (`ulimit -n 65536`, plus the
  macOS `launchctl limit maxfiles` note) if the sweep can't fit. It also spawns children with
  the inherited (raised) limit and re-checks inside each child.
- Ephemeral-port pressure on loopback (all connections share one destination tuple, and the OS
  ephemeral-port range — ~16k by default on macOS — caps distinct source ports per
  destination). *(post-plan correction: the originally sketched `--ports N` multi-listener
  escape hatch is not implementable against the shipped single-listener `startDevServer`
  without engine changes, which this slice forbids. Instead the sweep records the highest N
  that completes cleanly and the findings doc documents the cap and the exact OS settings —
  an honest partial baseline over a garbage full one. A multi-listener flag can be its own
  follow-up if a real machine needs it.)*

## Honesty rules (house style — stated in the report and the findings doc)

- Localhost loopback: no real network jitter, no TLS handshake cost — a stated boundary. The
  number is "what the node can hold," not "what a WAN feels like."
- Swarm connections are protocol-minimal (no client-side reconcile work) — stated; the probes
  exist precisely to keep one honest real-client signal at every N.
- Absolute numbers are machine-specific; the *shape* (RSS/conn flatness, p99-vs-N curve,
  storm recovery time) is the signal — same disclaimer as the writes axis.
- In-memory SQLite store — the commit path is deliberately cheap so connection machinery, not
  the store, is the variable under test; stated.

## Deliverables

1. The axis (cores + scenario + entries + CLI wiring) with unit-testable pieces (frame
   builders, ps parsing, sweep math) under vitest, and a small-N smoke test (N=200) in the
   suite so CI keeps the axis alive without heavy runs.
2. A committed baseline JSON from this machine.
3. `benchmarks/docs/connections-findings.md` — the numbers, the method, and the verdicts:
   what N the node holds, where p99 knees, whether #9 (result sharing) and #11 (off-thread
   send) are indicted or stay parked. Updates `performance-backlog.md` accordingly.

## Non-goals (v1)

- No optimization work in this slice — measure first; fixes are their own follow-ups gated by
  these numbers (the group-commit discipline).
- No multi-machine driving, no TLS, no WAN simulation, no geo distribution.
- No edge-gateway tier — if the numbers ever demand it, that starts as its own design record.
