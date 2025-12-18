# Phase-0 Benchmark Harness — Design Spec

> **Status:** approved design (2025-11-28), ready for an implementation plan.
> **Purpose:** a repeatable, Docker-based benchmark runner with structured JSON output and a
> `compare`-with-regression-bands tool, so every stage of the DLR reactivity rework
> ([`docs/dev/architecture/reactivity-differential-log-tail.md`](../../dev/architecture/reactivity-differential-log-tail.md))
> can be gated on a *measured* delta instead of a hand-transcribed guess.

---

## 1. Motivation

The project is currently stable, and we are about to start a **performance campaign** (the DLR
reactive-path rework). DLR's whole premise is "ship Stage 1, **measure**, then Stage 2" — but today
there is no repeatable way to measure. The five existing benchmarks (`bench-fanout`, `overhead-ladder`,
`multinode`, `convex-comparison`, `reconnect-resume`) are **one-off scripts with hand-transcribed
numbers**. They answered specific questions; none can answer *"did this commit regress reactive
propagation versus the baseline?"*

The measurement *cores* are decent and reusable — `runFanoutBench`
(`packages/test/src/bench-fanout.ts`) already returns a structured result, and `measure.mjs`
(`benchmarks/convex-comparison/driver/`) is a backend-agnostic propagation measurer. **What is missing
is the harness around them:** a single entrypoint, structured JSON emit, a stored baseline, and a
`compare` tool with regression bands. This spec builds exactly that, and no more.

## 2. Goals

- One command runs the reactive benchmark set and writes a structured JSON result.
- A `compare` command turns two result files into a per-scenario **% delta** table with
  **regression bands** (🟢 improved / ⚪ noise / 🔴 regressed).
- Consolidate **all** benchmark-related files into `benchmarks/`, out of the `test/` dirs.
- Reactive axis first (fan-out, propagation, diff-bytes) — the scenarios DLR Stage 1–2 move.
- Runs reproducibly in Docker on the developer's machine; honest about ratios-not-absolutes.

## 3. Non-goals (explicitly deferred)

- **No CI regression gate.** Manual, on-demand only. A clean seam is left, but no CI wiring is built
  (laptop/CI variance is unknown; a gate now risks flaky red builds).
- **No publishable absolute numbers.** Docker-on-macOS distorts absolutes; we report **same-machine
  ratios**. A future run on a dedicated Linux box can produce publishable absolutes — out of scope here.
- **No new axes activated yet.** Read / write / scaled-out / reconnect scenarios are *relocated and
  registered* but not wired into the default reactive run; each activates when its DLR stage arrives.
- **Not a public `stackbase bench` CLI.** Internal tooling only; no coupling to the shipped CLI surface.

## 4. Locked decisions (from the brainstorm)

| Decision | Choice |
|---|---|
| Runner form | **Standalone runner** (`benchmarks/runner`), not vitest-hosted, not a public CLI subcommand |
| Usage model | **Manual, on-demand** (`bun run bench:reactive`) |
| Substrate | **Docker on the dev machine**, ratios only |
| Scope | **Reactive axis first** |
| Consolidation | **All** `bench-*` files move into `benchmarks/`; `test/` dirs cleaned |
| Stores | Run against **both** SQLite (in-process, low-noise) **and** Postgres (embedded PG16 — the I/O-bound truth); harness itself is container-runnable for substrate control (see §8) |
| Noise band | **±3%** default (config knob), tightened once real variance is observed |

## 5. Architecture & layout

A new **leaf** workspace package, `benchmarks/runner` (private, name `@stackbase/bench`). Being a leaf —
nothing in the engine depends on it — it may depend on *everything* (both docstores, `@stackbase/test`,
`@stackbase/client`, `@stackbase/runtime-embedded`, `ee/@stackbase/fleet`, `@stackbase/cli`) with no
build cycle. This is what dissolves the current coupling: `runFanoutBench` lives in `packages/test`
today *only* to be shared with `ee/fleet` without a cycle; once both live in this leaf, that reason
evaporates.

```
benchmarks/
  runner/                          # NEW workspace member — @stackbase/bench (private)
    package.json
    tsconfig.json
    src/
      cli.ts                       # entrypoint: `run` and `compare` verbs + arg parsing
      cores/                       # pure, store-agnostic MEASUREMENT cores (relocated)
        fanout.ts                  #   ← packages/test/src/bench-fanout.ts (verbatim move)
        propagation.ts             #   ← benchmarks/convex-comparison/driver/measure.mjs (TS-ified)
      scenarios/                   # scenario registry, tagged by axis
        reactive.ts                #   fan-out · propagation · diff-bytes  (ACTIVE)
        write.ts read.ts scaled.ts reconnect.ts   # registered, NOT in default run yet
      report.ts                    # JSON result schema + machine-profile stamp + file write
      compare.ts                   # delta table + regression bands + staleness guard
      machine.ts                   # capture {runtime, substrate, cpuCount, docker?} profile
    test/
      smoke.test.ts                # fast always-on sanity (harness anti-rot)
  results/                         # gitignored — raw runs: <label>.json
  baselines/                       # committed — the reference lines
  convex-comparison/               # unchanged (already its own workspace member)
  docs/                            # unchanged (the-story, methodology-lessons, perf-backlog, ...)
```

**Workspace wiring:** add `benchmarks/runner` to the root `package.json` `workspaces.packages` array
(alongside the existing `benchmarks/convex-comparison`). Add root scripts:
`"bench:reactive"`, `"bench:compare"` delegating into the runner. `benchmarks/results/` is git-ignored;
`benchmarks/baselines/` is committed.

## 6. Relocation map (the segregation)

All `bench-*` files leave `test/` dirs. Two tiers:

**Tier A — reactive cores/scenarios, converted into the new format this slice:**

| From | To | Note |
|---|---|---|
| `packages/test/src/bench-fanout.ts` | `benchmarks/runner/src/cores/fanout.ts` | verbatim move; **remove `runFanoutBench` from `@stackbase/test`'s public exports** |
| `packages/test/test/bench-fanout.test.ts` | split: matrix → `scenarios/reactive.ts`; smoke → `runner/test/smoke.test.ts` | |
| `benchmarks/convex-comparison/driver/measure.mjs` | `benchmarks/runner/src/cores/propagation.ts` | TS-ify; convex-comparison keeps working by importing from here (or a thin re-export) |
| `ee/packages/fleet/test/bench-fanout-pg.test.ts` | folded into `scenarios/reactive.ts` as the `--store pg` path | uses the relocated `fanout.ts` core |

**Tier B — non-reactive benches, moved now (test dirs cleaned) but converted later:**

| From | To | Activated with |
|---|---|---|
| `ee/packages/fleet/test/bench-overhead-pg.test.ts` | `benchmarks/runner/src/scenarios/write.ts` | write axis |
| `ee/packages/fleet/test/bench-commit.test.ts` | `benchmarks/runner/src/scenarios/write.ts` | write axis |
| `ee/packages/fleet/test/bench-multinode-pg.test.ts` | `benchmarks/runner/src/scenarios/scaled.ts` | scaled-write axis |
| `packages/cli/test/bench-fanout-ws.test.ts` | `benchmarks/runner/src/scenarios/reactive.ts` (WS E2E variant) | reactive (WS) — may activate this slice if cheap |
| `packages/cli/test/bench-resume-ws.test.ts` | `benchmarks/runner/src/scenarios/reconnect.ts` | reconnect axis |

Tier B files are **physically relocated in this slice** so the `test/` dirs are clean immediately, but
their conversion into runnable scenarios happens when their axis is activated. They move as-is (kept
compiling) into `scenarios/` sub-files or a `scenarios/pending/` holding area — nothing is lost.

**Known risk (the one non-mechanical part):** the server-E2E benches (`bench-*-ws`, `bench-multinode-pg`)
depend on **package-internal test helpers** (the `stackbase dev` server harness in `packages/cli/test/`,
the fleet + embedded-postgres harness in `ee/packages/fleet/test/`). Relocating them may require
**promoting a few of those helpers to real exports** (e.g. a `@stackbase/cli/test-support` subpath, a
fleet test-harness export). This is cheap but must be enumerated in the plan; the pure cores
(`fanout.ts`, `propagation.ts`) move with no such friction.

## 7. The runner CLI

`benchmarks/runner/src/cli.ts`, invoked via `bun run bench:reactive` / `bun run bench:compare`.

### 7.1 `run`

```
bun run bench:reactive [--store sqlite|pg|both] [--save <path>] [--baseline <path>] [--label <name>] [--seconds N]
```

- Executes the **reactive** scenario set (§8) against the selected store(s) (default `both`).
- Writes a structured JSON result (§7.3) to `benchmarks/results/<label>.json`
  (default label: `reactive-<gitSha><-dirty?>-<store>`).
- `--save <path>` also copies the result to `<path>` (used to write into `baselines/`).
- `--baseline <path>` immediately runs `compare` (§7.2) against that file after the run — the one-line
  "run and show me the delta" path.

A **scenario** is a small object:

```ts
interface Scenario {
  name: string;                       // stable id, e.g. "fanout-selective-10k"
  axis: "reactive" | "write" | "read" | "scaled" | "reconnect";
  params: Record<string, unknown>;    // recorded verbatim into the result for reproducibility
  run(store: BenchStore): Promise<ScenarioMetrics>;
}
```

The registry (`scenarios/*.ts`) exports arrays of `Scenario`; `cli.ts` filters by axis. Adding a future
axis = add a file + register it; the `run`/`compare`/JSON machinery is untouched.

### 7.2 `compare`

```
bun run bench:compare <baseline.json> <candidate.json> [--band 0.03]
```

Joins the two result files by `scenario.name`, prints a table: for each metric, the % delta and a band
verdict. Metrics where **lower is better** (latency p50/p99, ELU, bytes) and **higher is better**
(throughput, re-runs/s) are classified so 🟢/🔴 mean the right thing per metric. Scenarios present in
only one file are listed as `added`/`removed` (never silently dropped). Prints a **staleness warning**
(§9) when the two runs' machine profiles or git day diverge. Exit code is `0` regardless (this is a
report, not a gate — the non-goal).

### 7.3 Result JSON schema

```jsonc
{
  "gitSha": "0a874ea",
  "dirty": false,                       // working tree had uncommitted changes at run time
  "substrate": "docker/pg16",           // or "host/sqlite-memory"
  "runtime": "bun-1.1.x",
  "machine": "docker-desktop-mac/8cpu", // from machine.ts
  "ts": 1783720000000,                  // stamped AFTER the run (scripts have no Date.now())
  "band": 0.03,
  "scenarios": [
    {
      "name": "fanout-selective-10k",
      "axis": "reactive",
      "store": "pg",
      "params": { "subscriptions": 10000, "shape": "selective", "queryCost": "point", "seconds": 5 },
      "metrics": {
        "reRunsPerSec": 3200, "propP50Ms": 0.31, "propP99Ms": 0.9,
        "elu": 0.34, "writesPerSec": 3210, "subsMatchedAvg": 1.0, "bytesPerUpdate": null
      },
      "errors": 0
    }
  ]
}
```

`metrics` is an open bag keyed by metric name (a scenario emits only the metrics it measures;
unmeasured = omitted or `null`). Each metric name is tagged in a central `METRIC_DIRECTION` map
(`lower-better | higher-better`) that `compare` reads — the single source of truth for 🟢/🔴 polarity.

## 8. Reactive scenario set (ships first)

| Scenario name | Core | Metric(s) | Gates DLR |
|---|---|---|---|
| `fanout-{selective,broadcast}-{100,1k,10k}` | `fanout.ts` | `propP50Ms`, `reRunsPerSec`, `elu`, `subsMatchedAvg` | **Stage 1** (O(N)→O(log N)) |
| `propagation-{1,10,100}sub` | `propagation.ts` | `propP50Ms`, `propP99Ms` | Stage 2 |
| `diffbytes-{point,scan}` | new (Stage-2 seam) | `bytesPerUpdate` | **Stage 2** (diff pushes) |

- **Stores:** every scenario runs against **SQLite in-process** (fast, low-noise — cleanest signal for
  Stage 1's CPU-scan win; also the always-on smoke) **and Postgres-in-Docker** (the I/O-bound truth
  where ELU 0.13–0.37 lives — the real gating numbers). `--store` selects; default `both`.
- **`diffbytes`** measures bytes-on-the-wire per update. Today (full-result re-send) it records the
  baseline; DLR Stage 2 is expected to slash it. The scenario ships now (measuring the pre-DLR baseline)
  so the improvement is provable later; its wire-byte instrumentation is a thin measurement hook, not a
  DLR dependency.
- **Postgres substrate:** reuse the project's **embedded-postgres** test substrate (real native PG 16,
  Docker-free) per the established 3-tier substrate rule — *not* a Docker container, so a reactive run
  needs no `docker compose`. ("Docker-based" in the goal means the whole harness is container-runnable
  for a clean substrate; the PG store itself uses embedded-postgres for speed.) Rationale recorded so
  the plan doesn't reach for a PG container.

## 9. Regression bands, baseline workflow & staleness

**Bands.** `compare` reports **% delta** per metric; within **±band** (default 0.03) ⇒ ⚪ no-change;
beyond it ⇒ 🟢/🔴 per the metric's direction. The band is a CLI flag + a documented default, tightened
once we have variance data from a few real runs.

**Baseline workflow (the honest Docker/ratios discipline).** Absolute numbers drift on a laptop
(thermal, background load), so a baseline captured on a different day is not trustworthy for a % delta.
The tool makes back-to-back re-baselining a one-liner:

1. On `main`: `bun run bench:reactive --save benchmarks/baselines/reactive-main.json`
2. On the DLR branch, **same sitting**: `bun run bench:reactive --baseline benchmarks/baselines/reactive-main.json`

Committed baselines make a stage's before/after reviewable in git.

**Staleness guard.** `compare` emits a visible warning when baseline vs candidate differ in `machine`,
`substrate`, or calendar day of `ts` — "baseline captured on a different machine/day; re-baseline
back-to-back for a trustworthy delta." It never blocks (report, not gate), only nudges.

## 10. Metric definitions & rigor rules

- **Latency** is `p50`/`p99` (never mean), over the measurement window after warmup.
- **ELU** = `performance.eventLoopUtilization()` over the measurement window — the I/O-bound proxy
  (near 1.0 = CPU-bound busy loop; 0.1–0.4 = waiting on I/O). Reported so a change's *nature* is visible.
- **Warmup + steady-state:** every scenario discards a warmup window before measuring (the cores already
  do this — `warmupMs`).
- **Coordinated omission:** latency is measured against the *intended* post time (`postAt` stamped at
  send), not just receipt spacing — the cores already stamp `postAt` client-side; preserve this.
- **Same substrate both sides:** a `compare` is only valid when both runs used the same store + machine;
  the staleness guard surfaces violations.
- **Both stores:** SQLite for low-noise CPU-path signal; PG (embedded) for the I/O-bound reality. Never
  read the I/O-bound truth from in-memory SQLite (the ELU=0.98 confound that once made Workers look
  useful).
- **Timestamps** are stamped by `cli.ts` after the run (workflow/script sandboxes forbid `Date.now()`;
  the runner is a normal Bun process, so `Date.now()` is available here — noted only to avoid confusion
  with the Workflow-tool constraint).

## 11. Testing & anti-rot

- `benchmarks/runner/test/smoke.test.ts`: the tiny always-on sanity relocated from
  `bench-fanout.test.ts` — 1-second broadcast + selective assertions over SQLite
  (`reRunsPerSec > 0`, `errors === 0`, `subsMatchedAvg` in the expected band). It runs in the normal
  `bun run test` sweep (the runner package participates in the turbo `test` pipeline), so the harness
  can never silently rot after we move it out of `packages/test`.
- `compare.ts` gets unit tests: band verdict polarity per `METRIC_DIRECTION`, added/removed scenarios,
  staleness detection — pure functions over two fixture JSONs, no engine needed.
- Because the reactive cores move verbatim, their existing behavior is already trusted; the smoke +
  compare-unit tests are the new coverage.

## 12. Sequencing (informs the plan, not part of this slice's build)

1. **This slice:** `benchmarks/runner` package + relocations + `run`/`compare`/JSON/bands + reactive
   scenarios (SQLite + PG) + smoke. Capture the `main` reactive baseline.
2. **Then DLR Stage 1** (index the matcher) gated on the `fanout-*` deltas.
3. Later stages activate the `propagation`/`diffbytes` gates, then the deferred axes
   (write/read/scaled/reconnect) as each becomes relevant — each is "add a scenario file," no harness
   change.

## 13. Provenance

Brainstormed 2025-11-28. Grounded in `benchmarks/docs/methodology-lessons.md`,
`benchmarks/docs/how-the-industry-benchmarks.md`, the five existing benchmarks, and the DLR design doc.
The measurement discipline (same-substrate ratios, p50/p99, ELU, warmup) is the same one that made the
Convex comparison honest and that fired the B4 group-commit gate.
