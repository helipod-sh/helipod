# Phase-0 Benchmark Harness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a standalone `benchmarks/runner` package that runs the reactive benchmark set, emits structured JSON, and compares two runs with regression bands — so DLR stages gate on measured deltas.

**Architecture:** A new private leaf workspace package `@stackbase/bench` at `benchmarks/runner`. It owns a relocated store-agnostic fan-out measurement core, a scenario registry (reactive axis first), a `run` verb (writes JSON) and a `compare` verb (delta table + ±band verdicts). Being a leaf (nothing depends on it), it may depend on both docstores + client + runtime with no build cycle — which is exactly why the fan-out core moves out of `@stackbase/test`.

**Tech Stack:** TypeScript, Bun (runs the CLI directly, no build step for the runner itself), vitest (smoke + compare unit tests), embedded-postgres (real native PG16, Docker-free) for the I/O-bound store, existing `@stackbase/*` engine packages.

## Global Constraints

- **Package manager / runtime:** Bun `1.3.11`; workspace deps use `workspace:*`; shared dev-dep versions come from the root `catalog:`.
- **License boundary:** `benchmarks/runner` is MIT (like `packages/*`). Do NOT move any `ee/` (commercial-licensed) benchmark that imports `@stackbase/fleet` into it. EE benches relocate within `ee/` (Task 7).
- **Determinism rule (unchanged):** query/mutation handlers never read the clock/random inside the transaction; the fan-out core stamps `postAt` client-side and passes it as an argument. Preserve this.
- **Prerequisite for running the bench:** cross-package imports resolve via built `dist/`, so `bun run build` must have run before `bun run bench:reactive`. Document, don't fight it.
- **Opt-in / substrate:** SQLite runs always; the Postgres store runs only when embedded-postgres is available (`embeddedPgAvailable()`), selected via `--store pg|both`.
- **Metrics honesty:** latency is p50/p99 (never mean); ELU is reported; numbers are same-machine ratios, never published as absolutes.

---

### Task 1: Scaffold the `benchmarks/runner` package + workspace wiring

**Files:**
- Create: `benchmarks/runner/package.json`
- Create: `benchmarks/runner/tsconfig.json`
- Create: `benchmarks/runner/src/cli.ts` (skeleton — usage only)
- Create: `benchmarks/runner/README.md`
- Modify: `package.json` (root — add workspace member + `bench:*` scripts)
- Modify: `.gitignore` (root — ignore `benchmarks/results/`)
- Create: `benchmarks/baselines/.gitkeep`

**Interfaces:**
- Produces: the `@stackbase/bench` package resolving under the workspace; root scripts `bench:reactive` and `bench:compare`; a `src/cli.ts` whose `main(argv)` dispatches on `argv[0]` (`"run"` | `"compare"`).

- [ ] **Step 1: Create the package manifest**

`benchmarks/runner/package.json`:

```json
{
  "name": "@stackbase/bench",
  "version": "0.0.0",
  "type": "module",
  "private": true,
  "description": "Internal benchmark runner: reactive-axis scenarios, structured JSON output, compare-with-bands. Not published.",
  "scripts": {
    "build": "echo '(@stackbase/bench: no build)'",
    "test": "vitest run",
    "typecheck": "tsc --noEmit",
    "clean": "rm -rf .turbo"
  },
  "dependencies": {
    "@stackbase/client": "workspace:*",
    "@stackbase/docstore": "workspace:*",
    "@stackbase/docstore-postgres": "workspace:*",
    "@stackbase/docstore-sqlite": "workspace:*",
    "@stackbase/executor": "workspace:*",
    "@stackbase/id-codec": "workspace:*",
    "@stackbase/runtime-embedded": "workspace:*"
  },
  "devDependencies": {
    "@types/node": "catalog:",
    "typescript": "catalog:",
    "vitest": "catalog:"
  }
}
```

- [ ] **Step 2: Create the tsconfig**

`benchmarks/runner/tsconfig.json` (mirror a leaf package; no emit — Bun runs TS directly):

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "noEmit": true,
    "types": ["node"]
  },
  "include": ["src", "test"]
}
```

- [ ] **Step 3: Create the CLI skeleton**

`benchmarks/runner/src/cli.ts`:

```ts
/** Internal benchmark runner. Verbs: `run` (execute scenarios → JSON), `compare` (delta table). */

const USAGE = `stackbase bench
  run     [--axis reactive] [--store sqlite|pg|both] [--seconds N] [--save <path>] [--baseline <path>] [--label <name>]
  compare <baseline.json> <candidate.json> [--band 0.03]
`;

export async function main(argv: string[]): Promise<number> {
  const verb = argv[0];
  if (verb === "run") {
    const { runVerb } = await import("./run");
    return runVerb(argv.slice(1));
  }
  if (verb === "compare") {
    const { compareVerb } = await import("./compare-cli");
    return compareVerb(argv.slice(1));
  }
  process.stdout.write(USAGE);
  return verb ? 1 : 0;
}

if (import.meta.main) {
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
```

> Note: `./run` and `./compare-cli` are created in later tasks. Until then, invoking those verbs throws a module-not-found — acceptable for this scaffold task; the usage path (no args) works.

- [ ] **Step 4: Wire the workspace + root scripts**

In root `package.json`, add `"benchmarks/runner"` to `workspaces.packages` (after `"benchmarks/convex-comparison"`), and add to `scripts`:

```json
    "bench:reactive": "bun benchmarks/runner/src/cli.ts run --axis reactive",
    "bench:compare": "bun benchmarks/runner/src/cli.ts compare"
```

In root `.gitignore`, add:

```
benchmarks/results/
```

Create `benchmarks/baselines/.gitkeep` (empty file) so the committed baselines dir exists.

- [ ] **Step 5: Create the runner README**

`benchmarks/runner/README.md`:

```markdown
# @stackbase/bench — Phase-0 benchmark harness

Runs the reactive benchmark set, emits structured JSON, compares two runs with regression bands.
Manual/on-demand. Docker/same-machine **ratios only** — never publish these as absolute numbers.

## Prerequisite

    bun run build   # cross-package imports resolve via built dist/

## Run

    bun run bench:reactive --store both --save benchmarks/baselines/reactive-main.json

## Compare (same sitting for a trustworthy delta)

    # on main:
    bun run bench:reactive --save benchmarks/baselines/reactive-main.json
    # on your branch:
    bun run bench:reactive --baseline benchmarks/baselines/reactive-main.json

See `docs/superpowers/specs/2025-11-28-benchmark-harness-design.md`.
```

- [ ] **Step 6: Install + verify the package resolves**

Run: `bun install`
Then: `bun benchmarks/runner/src/cli.ts`
Expected: prints the usage block, exit 0.

- [ ] **Step 7: Commit**

```bash
git add benchmarks/runner/package.json benchmarks/runner/tsconfig.json benchmarks/runner/src/cli.ts benchmarks/runner/README.md benchmarks/baselines/.gitkeep package.json .gitignore
git commit -m "feat(bench): scaffold @stackbase/bench runner package + workspace wiring"
```

---

### Task 2: Relocate the fan-out core into the runner (+ per-update bytes) + smoke test

**Files:**
- Create: `benchmarks/runner/src/cores/fanout.ts` (moved from `packages/test/src/bench-fanout.ts`, + bytes)
- Create: `benchmarks/runner/test/smoke.test.ts`

**Interfaces:**
- Produces: `runFanoutBench(opts: FanoutBenchOpts): Promise<FanoutBenchResult>` — same signature as today, plus `FanoutBenchResult.bytesPerUpdateAvg: number`. `FanoutBenchOpts` unchanged: `{ subscriptions, shape: "broadcast"|"selective", queryCost: "point"|"scan", seconds, warmupMs?, store?, channelPrefix? }`.

- [ ] **Step 1: Copy the core into the runner**

Copy `packages/test/src/bench-fanout.ts` verbatim to `benchmarks/runner/src/cores/fanout.ts` (do not delete the original yet — Task 6 removes it after the runner fully replaces it). Update the file's header comment first line to:

```ts
/**
 * Reactive fan-out benchmark — the store-agnostic measurement core. Lives in @stackbase/bench (a leaf
 * package that may depend on every docstore without a build cycle). Drives the real client -> sync ->
 * SubscriptionManager -> engine invalidation path. See docs/dev/research/reactivity/fanout-benchmark.md.
 */
```

- [ ] **Step 2: Add per-update byte measurement to the result**

In `benchmarks/runner/src/cores/fanout.ts`, extend `FanoutBenchResult`:

```ts
export interface FanoutBenchResult {
  reRunsPerSec: number;
  propP50Ms: number;
  propP99Ms: number;
  eluDuringStorm: number;
  writesPerSec: number;
  subsMatchedAvg: number;
  bytesPerUpdateAvg: number;
  errors: number;
}
```

Add byte accumulation. Near the counters (`let reRuns = 0;`), add:

```ts
  let bytesSum = 0;
```

Inside `onValue`, after `reRuns += 1;` (inside the `if (postAt > 0)` block):

```ts
      bytesSum += JSON.stringify(arr).length;
```

In the returned object, add:

```ts
    bytesPerUpdateAvg: reRuns > 0 ? bytesSum / reRuns : 0,
```

- [ ] **Step 3: Write the smoke test (the relocated always-on sanity)**

`benchmarks/runner/test/smoke.test.ts`:

```ts
/** Harness anti-rot: fast always-on sanity for the fan-out core (SQLite, in-process). Relocated from
 *  the former packages/test/test/bench-fanout.test.ts smoke block. Runs in `bun run test`. */
import { describe, it, expect } from "vitest";
import { runFanoutBench } from "../src/cores/fanout";

describe("bench-fanout — harness smoke (CI-fast, always on)", () => {
  it("broadcast: one bump wakes every subscription", async () => {
    const r = await runFanoutBench({
      subscriptions: 20, shape: "broadcast", queryCost: "point", seconds: 1, warmupMs: 300,
    });
    expect(r.reRunsPerSec).toBeGreaterThan(0);
    expect(r.errors).toBe(0);
    expect(r.subsMatchedAvg).toBeGreaterThan(10);
    expect(r.bytesPerUpdateAvg).toBeGreaterThan(0);
  }, 30_000);

  it("selective: one bump wakes ~one subscription", async () => {
    const r = await runFanoutBench({
      subscriptions: 20, shape: "selective", queryCost: "point", seconds: 1, warmupMs: 300,
    });
    expect(r.reRunsPerSec).toBeGreaterThan(0);
    expect(r.errors).toBe(0);
    expect(r.subsMatchedAvg).toBeLessThan(3);
  }, 30_000);
});
```

- [ ] **Step 4: Run the smoke test**

Run: `bun run build && bun run --filter @stackbase/bench test`
Expected: both smoke cases PASS.

- [ ] **Step 5: Commit**

```bash
git add benchmarks/runner/src/cores/fanout.ts benchmarks/runner/test/smoke.test.ts
git commit -m "feat(bench): relocate fan-out core into the runner + per-update byte metric + smoke"
```

---

### Task 3: Result JSON schema, machine profile, and report writer

**Files:**
- Create: `benchmarks/runner/src/machine.ts`
- Create: `benchmarks/runner/src/report.ts`
- Create: `benchmarks/runner/test/report.test.ts`

**Interfaces:**
- Produces:
  - `machineProfile(store: StoreKind): { substrate: string; runtime: string; machine: string }`
  - `type StoreKind = "sqlite" | "pg"`
  - `interface ScenarioResult { name: string; axis: string; store: StoreKind; params: Record<string, unknown>; metrics: Record<string, number | null>; errors: number }`
  - `interface BenchResult { gitSha: string; dirty: boolean; substrate: string; runtime: string; machine: string; ts: number; band: number; scenarios: ScenarioResult[] }`
  - `writeResult(dir: string, label: string, result: BenchResult): string` (returns the written path)
  - `gitInfo(): { gitSha: string; dirty: boolean }`

- [ ] **Step 1: Write the machine profile**

`benchmarks/runner/src/machine.ts`:

```ts
import { cpus, platform } from "node:os";
import { existsSync } from "node:fs";

export type StoreKind = "sqlite" | "pg";

/** A coarse machine/substrate fingerprint so a compare across different boxes/substrates is flagged. */
export function machineProfile(store: StoreKind): { substrate: string; runtime: string; machine: string } {
  const inDocker = existsSync("/.dockerenv");
  const substrate = `${inDocker ? "docker" : "host"}/${store === "pg" ? "pg16" : "sqlite-memory"}`;
  const bunVer = (globalThis as { Bun?: { version?: string } }).Bun?.version;
  const runtime = bunVer ? `bun-${bunVer}` : `node-${process.versions.node}`;
  const machine = `${platform()}/${cpus().length}cpu`;
  return { substrate, runtime, machine };
}
```

- [ ] **Step 2: Write the report types + writer**

`benchmarks/runner/src/report.ts`:

```ts
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { StoreKind } from "./machine";

export interface ScenarioResult {
  name: string;
  axis: string;
  store: StoreKind;
  params: Record<string, unknown>;
  metrics: Record<string, number | null>;
  errors: number;
}

export interface BenchResult {
  gitSha: string;
  dirty: boolean;
  substrate: string;
  runtime: string;
  machine: string;
  ts: number;
  band: number;
  scenarios: ScenarioResult[];
}

export function gitInfo(): { gitSha: string; dirty: boolean } {
  try {
    const gitSha = execFileSync("git", ["rev-parse", "--short", "HEAD"]).toString().trim();
    const dirty = execFileSync("git", ["status", "--porcelain"]).toString().trim().length > 0;
    return { gitSha, dirty };
  } catch {
    return { gitSha: "unknown", dirty: false };
  }
}

/** Write a result to `<dir>/<label>.json` (dir created if missing). Returns the path. */
export function writeResult(dir: string, label: string, result: BenchResult): string {
  const path = join(dir, `${label}.json`);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(result, null, 2) + "\n");
  return path;
}
```

- [ ] **Step 3: Write the report unit test**

`benchmarks/runner/test/report.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeResult, type BenchResult } from "../src/report";
import { machineProfile } from "../src/machine";

const sample: BenchResult = {
  gitSha: "abc1234", dirty: false, substrate: "host/sqlite-memory", runtime: "bun-1.3.11",
  machine: "darwin/8cpu", ts: 1783720000000, band: 0.03,
  scenarios: [{ name: "fanout-selective-100", axis: "reactive", store: "sqlite",
    params: { subscriptions: 100 }, metrics: { propP50Ms: 0.3, reRunsPerSec: 1000 }, errors: 0 }],
};

describe("report", () => {
  it("writes a result file that round-trips", () => {
    const dir = mkdtempSync(join(tmpdir(), "bench-"));
    const path = writeResult(dir, "unit", sample);
    const parsed = JSON.parse(readFileSync(path, "utf8")) as BenchResult;
    expect(parsed.scenarios[0]!.name).toBe("fanout-selective-100");
    expect(parsed.scenarios[0]!.metrics["propP50Ms"]).toBe(0.3);
  });

  it("machineProfile reflects the store", () => {
    expect(machineProfile("pg").substrate.endsWith("pg16")).toBe(true);
    expect(machineProfile("sqlite").substrate.endsWith("sqlite-memory")).toBe(true);
  });
});
```

- [ ] **Step 4: Run the report tests**

Run: `bun run --filter @stackbase/bench test`
Expected: report + smoke tests PASS.

- [ ] **Step 5: Commit**

```bash
git add benchmarks/runner/src/machine.ts benchmarks/runner/src/report.ts benchmarks/runner/test/report.test.ts
git commit -m "feat(bench): result JSON schema, machine profile, and report writer"
```

---

### Task 4: Reactive scenario registry + the `run` verb (SQLite + Postgres)

**Files:**
- Create: `benchmarks/runner/src/scenarios/reactive.ts`
- Create: `benchmarks/runner/src/run.ts`

**Interfaces:**
- Consumes: `runFanoutBench` (Task 2), `ScenarioResult`/`BenchResult`/`writeResult`/`gitInfo` (Task 3), `machineProfile`/`StoreKind` (Task 3).
- Produces:
  - `reactiveScenarios(store: StoreKind): Scenario[]` where `interface Scenario { name: string; axis: "reactive"; params: Record<string, unknown>; run(makeStore: () => Promise<StoreHandle>): Promise<{ metrics: Record<string, number | null>; errors: number }> }`
  - `runVerb(args: string[]): Promise<number>` (the `run` CLI verb)
  - `type StoreHandle = { store?: DocStore; close: () => Promise<void> }` (sqlite handle has `store: undefined` → core makes its own in-memory SQLite; pg handle carries a real `PostgresDocStore` + a `close`)

- [ ] **Step 1: Define the reactive scenarios**

`benchmarks/runner/src/scenarios/reactive.ts`:

```ts
import type { DocStore } from "@stackbase/docstore";
import { NodePgClient, PostgresDocStore } from "@stackbase/docstore-postgres";
import { startEmbeddedPg, embeddedPgAvailable, type EmbeddedPg } from "@stackbase/docstore-postgres/test-support/embedded-pg";
import { shardIdList } from "@stackbase/id-codec";
import { runFanoutBench, type FanoutBenchResult } from "../cores/fanout";
import type { StoreKind } from "../machine";

export type StoreHandle = { store?: DocStore; close: () => Promise<void> };

export interface Scenario {
  name: string;
  axis: "reactive";
  params: Record<string, unknown>;
  run(makeStore: () => Promise<StoreHandle>): Promise<{ metrics: Record<string, number | null>; errors: number }>;
}

/** SQLite handle: undefined store → the core builds its own in-memory SQLite (synchronous, low-noise). */
export function sqliteHandle(): Promise<StoreHandle> {
  return Promise.resolve({ store: undefined, close: async () => {} });
}

/** One shared embedded-postgres server for the whole PG run (started lazily, stopped by the run verb). */
let pgServer: EmbeddedPg | undefined;
export async function pgServerUrl(): Promise<string> {
  if (!pgServer) pgServer = await startEmbeddedPg();
  return `postgres://postgres:postgres@127.0.0.1:${pgServer.port}/postgres`;
}
export async function stopPgServer(): Promise<void> {
  await pgServer?.stop();
  pgServer = undefined;
}

/** A real-PG store wired like a production writer (NodePgClient + per-shard commit pool, 1 shard). */
export function pgHandle(): () => Promise<StoreHandle> {
  return async () => {
    const url = await pgServerUrl();
    const client = new NodePgClient({
      connectionString: url,
      applicationName: "stackbase-bench",
      commitPool: { shards: shardIdList(1) },
    });
    return { store: new PostgresDocStore(client), close: () => client.close() };
  };
}

export function pgAvailable(): boolean {
  return embeddedPgAvailable();
}

const SUB_COUNTS_SQLITE = [100, 1_000, 10_000];
const SUB_COUNTS_PG = [100, 1_000]; // seeding 10k channels over real PG is prohibitively slow (documented)

function fanoutMetrics(r: FanoutBenchResult): Record<string, number | null> {
  return {
    reRunsPerSec: r.reRunsPerSec,
    propP50Ms: r.propP50Ms,
    propP99Ms: r.propP99Ms,
    elu: r.eluDuringStorm,
    writesPerSec: r.writesPerSec,
    subsMatchedAvg: r.subsMatchedAvg,
    bytesPerUpdate: r.bytesPerUpdateAvg,
  };
}

/** Reactive scenarios for a store: fan-out grid (gates Stage 1), propagation (broadcast at low N,
 *  gates Stage 2 latency), and diff-bytes (gates Stage 2 wire reduction) — all over the one core. */
export function reactiveScenarios(store: StoreKind, seconds: number, prefix: string): Scenario[] {
  const subCounts = store === "pg" ? SUB_COUNTS_PG : SUB_COUNTS_SQLITE;
  const scenarios: Scenario[] = [];
  let cell = 0;

  for (const shape of ["selective", "broadcast"] as const) {
    for (const subscriptions of subCounts) {
      const idx = cell++;
      scenarios.push({
        name: `fanout-${shape}-${subscriptions}`,
        axis: "reactive",
        params: { subscriptions, shape, queryCost: "point", seconds },
        run: async (makeStore) => {
          const handle = await makeStore();
          try {
            const r = await runFanoutBench({
              subscriptions, shape, queryCost: "point", seconds,
              warmupMs: 2000, store: handle.store, channelPrefix: `${prefix}${idx}_`,
            });
            return { metrics: fanoutMetrics(r), errors: r.errors };
          } finally {
            await handle.close();
          }
        },
      });
    }
  }

  // propagation: broadcast fan-out at low N reports propP50/p99 (the Stage-2 latency gate).
  for (const subscriptions of [1, 10, 100]) {
    const idx = cell++;
    scenarios.push({
      name: `propagation-${subscriptions}sub`,
      axis: "reactive",
      params: { subscriptions, shape: "broadcast", queryCost: "point", seconds },
      run: async (makeStore) => {
        const handle = await makeStore();
        try {
          const r = await runFanoutBench({
            subscriptions, shape: "broadcast", queryCost: "point", seconds,
            warmupMs: 2000, store: handle.store, channelPrefix: `${prefix}p${idx}_`,
          });
          return { metrics: { propP50Ms: r.propP50Ms, propP99Ms: r.propP99Ms }, errors: r.errors };
        } finally {
          await handle.close();
        }
      },
    });
  }

  // diff-bytes: bytes on the wire per update today (full-result re-send) — the pre-DLR baseline.
  for (const queryCost of ["point", "scan"] as const) {
    const idx = cell++;
    scenarios.push({
      name: `diffbytes-${queryCost}`,
      axis: "reactive",
      params: { subscriptions: 100, shape: "broadcast", queryCost, seconds },
      run: async (makeStore) => {
        const handle = await makeStore();
        try {
          const r = await runFanoutBench({
            subscriptions: 100, shape: "broadcast", queryCost, seconds,
            warmupMs: 2000, store: handle.store, channelPrefix: `${prefix}d${idx}_`,
          });
          return { metrics: { bytesPerUpdate: r.bytesPerUpdateAvg }, errors: r.errors };
        } finally {
          await handle.close();
        }
      },
    });
  }

  return scenarios;
}
```

- [ ] **Step 2: Write the `run` verb**

`benchmarks/runner/src/run.ts`:

```ts
import { copyFileSync } from "node:fs";
import { gitInfo, writeResult, type BenchResult, type ScenarioResult } from "./report";
import { machineProfile, type StoreKind } from "./machine";
import { reactiveScenarios, sqliteHandle, pgHandle, pgAvailable, stopPgServer } from "./scenarios/reactive";

interface RunFlags { store: "sqlite" | "pg" | "both"; seconds: number; save?: string; baseline?: string; label?: string; band: number; }

function parseFlags(args: string[]): RunFlags {
  const flags: RunFlags = { store: "both", seconds: 5, band: 0.03 };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--store") flags.store = args[++i] as RunFlags["store"];
    else if (a === "--seconds") flags.seconds = Number(args[++i]);
    else if (a === "--save") flags.save = args[++i];
    else if (a === "--baseline") flags.baseline = args[++i];
    else if (a === "--label") flags.label = args[++i];
    else if (a === "--band") flags.band = Number(args[++i]);
    else if (a === "--axis") i++; // reactive-only for now; consume the value
  }
  return flags;
}

async function runStore(store: StoreKind, seconds: number): Promise<ScenarioResult[]> {
  const makeHandle = store === "pg" ? pgHandle() : sqliteHandle;
  const scenarios = reactiveScenarios(store, seconds, store === "pg" ? "pg" : "sq");
  const out: ScenarioResult[] = [];
  for (const s of scenarios) {
    const { metrics, errors } = await s.run(makeHandle);
    out.push({ name: s.name, axis: s.axis, store, params: s.params, metrics, errors });
    // eslint-disable-next-line no-console
    console.log(`  ${store}/${s.name}: ${JSON.stringify(metrics)} errors=${errors}`);
  }
  return out;
}

export async function runVerb(args: string[]): Promise<number> {
  const flags = parseFlags(args);
  const stores: StoreKind[] = flags.store === "both" ? ["sqlite", "pg"] : [flags.store];
  const scenarios: ScenarioResult[] = [];

  for (const store of stores) {
    if (store === "pg" && !pgAvailable()) {
      // eslint-disable-next-line no-console
      console.log("  (skipping pg: embedded-postgres unavailable on this platform)");
      continue;
    }
    // eslint-disable-next-line no-console
    console.log(`Running reactive scenarios over ${store}...`);
    scenarios.push(...(await runStore(store, flags.seconds)));
  }
  await stopPgServer();

  const primary = stores.includes("pg") && pgAvailable() ? "pg" : "sqlite";
  const prof = machineProfile(primary);
  const { gitSha, dirty } = gitInfo();
  const result: BenchResult = { gitSha, dirty, ...prof, ts: Date.now(), band: flags.band, scenarios };

  const label = flags.label ?? `reactive-${gitSha}${dirty ? "-dirty" : ""}`;
  const path = writeResult("benchmarks/results", label, result);
  // eslint-disable-next-line no-console
  console.log(`\nWrote ${path}`);
  if (flags.save) { copyFileSync(path, flags.save); console.log(`Saved baseline copy: ${flags.save}`); }

  if (flags.baseline) {
    const { compareFiles } = await import("./compare-cli");
    return compareFiles(flags.baseline, path, flags.band);
  }
  return 0;
}
```

> Note: `./compare-cli` is created in Task 5; the `--baseline` branch is exercised there.

- [ ] **Step 3: Smoke-run the verb over SQLite (fast)**

Run: `bun run build && bun benchmarks/runner/src/cli.ts run --store sqlite --seconds 1`
Expected: prints per-scenario lines for `fanout-*`, `propagation-*`, `diffbytes-*`; writes `benchmarks/results/reactive-<sha>.json`; exit 0. (10k-sub cells at 1s are quick enough for a smoke.)

- [ ] **Step 4: Commit**

```bash
git add benchmarks/runner/src/scenarios/reactive.ts benchmarks/runner/src/run.ts
git commit -m "feat(bench): reactive scenario registry + run verb (sqlite + embedded-pg)"
```

---

### Task 5: The `compare` verb — delta table, regression bands, staleness guard

**Files:**
- Create: `benchmarks/runner/src/compare.ts` (pure logic)
- Create: `benchmarks/runner/src/compare-cli.ts` (file I/O + CLI wrapper)
- Create: `benchmarks/runner/test/compare.test.ts`

**Interfaces:**
- Consumes: `BenchResult`/`ScenarioResult` (Task 3).
- Produces:
  - `METRIC_DIRECTION: Record<string, "lower-better" | "higher-better">`
  - `compareResults(baseline: BenchResult, candidate: BenchResult, band: number): CompareReport`
  - `interface CompareRow { scenario: string; metric: string; base: number | null; cand: number | null; deltaPct: number | null; verdict: "improved" | "regressed" | "noise" | "added" | "removed" }`
  - `interface CompareReport { rows: CompareRow[]; stale: string[] }`
  - `formatReport(report: CompareReport): string`
  - `compareVerb(args: string[]): Promise<number>` and `compareFiles(baselinePath: string, candidatePath: string, band: number): Promise<number>`

- [ ] **Step 1: Write the pure compare logic**

`benchmarks/runner/src/compare.ts`:

```ts
import type { BenchResult, ScenarioResult } from "./report";

/** Per-metric polarity: is a smaller number better (latency, bytes, ELU) or a larger one (throughput)? */
export const METRIC_DIRECTION: Record<string, "lower-better" | "higher-better"> = {
  propP50Ms: "lower-better", propP99Ms: "lower-better", elu: "lower-better", bytesPerUpdate: "lower-better",
  reRunsPerSec: "higher-better", writesPerSec: "higher-better", subsMatchedAvg: "higher-better",
};

export interface CompareRow {
  scenario: string; metric: string; base: number | null; cand: number | null;
  deltaPct: number | null; verdict: "improved" | "regressed" | "noise" | "added" | "removed";
}
export interface CompareReport { rows: CompareRow[]; stale: string[] }

function metricsOf(r: ScenarioResult): Record<string, number | null> { return r.metrics; }

export function compareResults(baseline: BenchResult, candidate: BenchResult, band: number): CompareReport {
  const rows: CompareRow[] = [];
  const baseByName = new Map(baseline.scenarios.map((s) => [`${s.store}/${s.name}`, s]));
  const candByName = new Map(candidate.scenarios.map((s) => [`${s.store}/${s.name}`, s]));

  for (const [key, cand] of candByName) {
    const base = baseByName.get(key);
    if (!base) { rows.push({ scenario: key, metric: "*", base: null, cand: null, deltaPct: null, verdict: "added" }); continue; }
    for (const [metric, candV] of Object.entries(metricsOf(cand))) {
      const baseV = metricsOf(base)[metric] ?? null;
      if (baseV === null || candV === null || baseV === 0) {
        rows.push({ scenario: key, metric, base: baseV, cand: candV, deltaPct: null, verdict: "noise" });
        continue;
      }
      const deltaPct = (candV - baseV) / baseV;
      const dir = METRIC_DIRECTION[metric] ?? "lower-better";
      let verdict: CompareRow["verdict"] = "noise";
      if (Math.abs(deltaPct) > band) {
        const better = dir === "lower-better" ? deltaPct < 0 : deltaPct > 0;
        verdict = better ? "improved" : "regressed";
      }
      rows.push({ scenario: key, metric, base: baseV, cand: candV, deltaPct, verdict });
    }
  }
  for (const key of baseByName.keys()) {
    if (!candByName.has(key)) rows.push({ scenario: key, metric: "*", base: null, cand: null, deltaPct: null, verdict: "removed" });
  }

  const stale: string[] = [];
  if (baseline.machine !== candidate.machine) stale.push(`machine: ${baseline.machine} → ${candidate.machine}`);
  if (baseline.substrate !== candidate.substrate) stale.push(`substrate: ${baseline.substrate} → ${candidate.substrate}`);
  const day = (ts: number) => Math.floor(ts / 86_400_000);
  if (day(baseline.ts) !== day(candidate.ts)) stale.push("captured on different calendar days — re-baseline back-to-back for a trustworthy delta");

  return { rows, stale };
}

const ICON = { improved: "🟢", regressed: "🔴", noise: "⚪", added: "➕", removed: "➖" } as const;

export function formatReport(report: CompareReport): string {
  const lines: string[] = [];
  if (report.stale.length) {
    lines.push("⚠️  STALE COMPARISON — the delta may reflect the substrate, not the code:");
    for (const s of report.stale) lines.push(`     ${s}`);
    lines.push("");
  }
  lines.push("scenario/metric".padEnd(40) + "base".padStart(12) + "cand".padStart(12) + "delta".padStart(10) + "  verdict");
  for (const r of report.rows) {
    const delta = r.deltaPct === null ? "—" : `${(r.deltaPct * 100).toFixed(1)}%`;
    const base = r.base === null ? "—" : r.base.toFixed(3);
    const cand = r.cand === null ? "—" : r.cand.toFixed(3);
    lines.push(`${r.scenario}·${r.metric}`.padEnd(40) + base.padStart(12) + cand.padStart(12) + delta.padStart(10) + `  ${ICON[r.verdict]} ${r.verdict}`);
  }
  return lines.join("\n") + "\n";
}
```

- [ ] **Step 2: Write the CLI wrapper**

`benchmarks/runner/src/compare-cli.ts`:

```ts
import { readFileSync } from "node:fs";
import type { BenchResult } from "./report";
import { compareResults, formatReport } from "./compare";

function load(path: string): BenchResult { return JSON.parse(readFileSync(path, "utf8")) as BenchResult; }

/** Compare two result files; print the table. Always returns 0 (a report, not a gate). */
export async function compareFiles(baselinePath: string, candidatePath: string, band: number): Promise<number> {
  const report = compareResults(load(baselinePath), load(candidatePath), band);
  process.stdout.write(formatReport(report));
  return 0;
}

export async function compareVerb(args: string[]): Promise<number> {
  const positional = args.filter((a) => !a.startsWith("--"));
  let band = 0.03;
  const bi = args.indexOf("--band");
  if (bi >= 0) band = Number(args[bi + 1]);
  if (positional.length < 2) { process.stderr.write("usage: compare <baseline.json> <candidate.json> [--band 0.03]\n"); return 1; }
  return compareFiles(positional[0]!, positional[1]!, band);
}
```

- [ ] **Step 3: Write the compare unit tests**

`benchmarks/runner/test/compare.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { compareResults, METRIC_DIRECTION, type CompareRow } from "../src/compare";
import type { BenchResult } from "../src/report";

function base(overrides: Partial<BenchResult> = {}): BenchResult {
  return {
    gitSha: "aaa", dirty: false, substrate: "host/sqlite-memory", runtime: "bun", machine: "darwin/8cpu",
    ts: 1783720000000, band: 0.03,
    scenarios: [{ name: "fanout-selective-1000", axis: "reactive", store: "sqlite", params: {},
      metrics: { propP50Ms: 1.0, reRunsPerSec: 1000 }, errors: 0 }],
    ...overrides,
  };
}
const rowFor = (rows: CompareRow[], metric: string) => rows.find((r) => r.metric === metric)!;

describe("compareResults", () => {
  it("lower-better latency dropping beyond band = improved", () => {
    const cand = base({ scenarios: [{ ...base().scenarios[0]!, metrics: { propP50Ms: 0.5, reRunsPerSec: 1000 } }] });
    const { rows } = compareResults(base(), cand, 0.03);
    expect(rowFor(rows, "propP50Ms").verdict).toBe("improved");
  });
  it("lower-better latency rising beyond band = regressed", () => {
    const cand = base({ scenarios: [{ ...base().scenarios[0]!, metrics: { propP50Ms: 2.0, reRunsPerSec: 1000 } }] });
    expect(rowFor(compareResults(base(), cand, 0.03).rows, "propP50Ms").verdict).toBe("regressed");
  });
  it("higher-better throughput rising beyond band = improved", () => {
    const cand = base({ scenarios: [{ ...base().scenarios[0]!, metrics: { propP50Ms: 1.0, reRunsPerSec: 2000 } }] });
    expect(rowFor(compareResults(base(), cand, 0.03).rows, "reRunsPerSec").verdict).toBe("improved");
  });
  it("within band = noise", () => {
    const cand = base({ scenarios: [{ ...base().scenarios[0]!, metrics: { propP50Ms: 1.01, reRunsPerSec: 1000 } }] });
    expect(rowFor(compareResults(base(), cand, 0.03).rows, "propP50Ms").verdict).toBe("noise");
  });
  it("new scenario = added; missing scenario = removed", () => {
    const cand = base({ scenarios: [{ name: "fanout-broadcast-100", axis: "reactive", store: "sqlite", params: {}, metrics: { propP50Ms: 1 }, errors: 0 }] });
    const verdicts = compareResults(base(), cand, 0.03).rows.map((r) => r.verdict);
    expect(verdicts).toContain("added");
    expect(verdicts).toContain("removed");
  });
  it("different machine flags staleness", () => {
    const cand = base({ machine: "linux/16cpu" });
    expect(compareResults(base(), cand, 0.03).stale.some((s) => s.startsWith("machine"))).toBe(true);
  });
  it("METRIC_DIRECTION covers every metric the core emits", () => {
    for (const m of ["propP50Ms", "propP99Ms", "elu", "bytesPerUpdate", "reRunsPerSec", "writesPerSec", "subsMatchedAvg"])
      expect(METRIC_DIRECTION[m]).toBeDefined();
  });
});
```

- [ ] **Step 4: Run the compare tests + an end-to-end compare**

Run: `bun run --filter @stackbase/bench test`
Expected: all compare + report + smoke tests PASS.

Then verify the wired path: `bun benchmarks/runner/src/cli.ts run --store sqlite --seconds 1 --save /tmp/b.json` then `bun benchmarks/runner/src/cli.ts compare /tmp/b.json /tmp/b.json`
Expected: table prints with every row `⚪ noise` (identical files), no staleness warning.

- [ ] **Step 5: Commit**

```bash
git add benchmarks/runner/src/compare.ts benchmarks/runner/src/compare-cli.ts benchmarks/runner/test/compare.test.ts
git commit -m "feat(bench): compare verb — delta table, regression bands, staleness guard"
```

---

### Task 6: Remove the old fan-out core copies (finish the reactive relocation)

**Files:**
- Delete: `packages/test/src/bench-fanout.ts`
- Delete: `packages/test/test/bench-fanout.test.ts`
- Modify: `packages/test/src/index.ts` (remove the two `bench-fanout` export lines)
- Delete: `ee/packages/fleet/test/bench-fanout-pg.test.ts`

**Interfaces:**
- Consumes: nothing new. This task removes the now-duplicated source; the runner (Tasks 2–5) has fully replaced it.

- [ ] **Step 1: Remove the exports from `@stackbase/test`**

In `packages/test/src/index.ts`, delete these two lines:

```ts
export { runFanoutBench } from "./bench-fanout";
export type { FanoutBenchOpts, FanoutBenchResult } from "./bench-fanout";
```

- [ ] **Step 2: Delete the relocated files**

```bash
git rm packages/test/src/bench-fanout.ts packages/test/test/bench-fanout.test.ts ee/packages/fleet/test/bench-fanout-pg.test.ts
```

- [ ] **Step 3: Verify nothing else imports the removed symbols**

Run: `grep -rn "runFanoutBench\|bench-fanout" packages ee --include="*.ts"`
Expected: no matches outside `benchmarks/` (the `dist/` hits disappear after the next build).

- [ ] **Step 4: Rebuild + typecheck the affected packages**

Run: `bun run build && bun run --filter @stackbase/test typecheck && bun run --filter @stackbase/fleet typecheck`
Expected: both green (no dangling `runFanoutBench` reference).

- [ ] **Step 5: Run the affected packages' tests**

Run: `bun run --filter @stackbase/test test && bun run --filter @stackbase/bench test`
Expected: PASS (the smoke now lives in `@stackbase/bench`).

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "refactor(bench): remove relocated fan-out core from @stackbase/test and ee/fleet"
```

---

### Task 7: Segregate the deferred benches out of the `test/` dirs

**Files:**
- Move: `ee/packages/fleet/test/bench-commit.test.ts` → `ee/packages/fleet/bench/commit.bench.ts`
- Move: `ee/packages/fleet/test/bench-overhead-pg.test.ts` → `ee/packages/fleet/bench/overhead-pg.bench.ts`
- Move: `ee/packages/fleet/test/bench-multinode-pg.test.ts` → `ee/packages/fleet/bench/multinode-pg.bench.ts`
- Move: `packages/cli/test/bench-fanout-ws.test.ts` → `packages/cli/bench/fanout-ws.bench.ts`
- Move: `packages/cli/test/bench-resume-ws.test.ts` → `packages/cli/bench/resume-ws.bench.ts`
- Create: `ee/packages/fleet/bench/README.md`, `packages/cli/bench/README.md`
- Modify: `ee/packages/fleet/tsconfig.json`, `packages/cli/tsconfig.json` (exclude `bench/`)

**Interfaces:**
- Consumes: nothing. Pure relocation — these are *parked* (renamed `.bench.ts` so vitest's `*.test.ts` glob ignores them), converted to runner scenarios only when their axis activates. They stay in their license-correct package (`ee/` benches import `@stackbase/fleet` and must remain commercial-licensed; the runner is MIT).

- [ ] **Step 1: Move + rename each file (drop `.test.ts` so vitest skips it)**

```bash
mkdir -p ee/packages/fleet/bench packages/cli/bench
git mv ee/packages/fleet/test/bench-commit.test.ts        ee/packages/fleet/bench/commit.bench.ts
git mv ee/packages/fleet/test/bench-overhead-pg.test.ts   ee/packages/fleet/bench/overhead-pg.bench.ts
git mv ee/packages/fleet/test/bench-multinode-pg.test.ts  ee/packages/fleet/bench/multinode-pg.bench.ts
git mv packages/cli/test/bench-fanout-ws.test.ts          packages/cli/bench/fanout-ws.bench.ts
git mv packages/cli/test/bench-resume-ws.test.ts          packages/cli/bench/resume-ws.bench.ts
```

- [ ] **Step 2: Fix the now-off-by-one relative imports**

Each moved file previously imported test helpers via `./...` (same `test/` dir) or `../src/...`. From the new `bench/` sibling dir, `./x` helpers become `../test/x` and `../src/x` stays `../src/x`. For each moved file, update only the relative-path imports that pointed at `./` (same-dir helpers) to `../test/`. Leave `@stackbase/*` and `../src/*` imports unchanged. (Grep each file for `from "./` to find them.)

- [ ] **Step 3: Add a parked-bench README to each home**

`ee/packages/fleet/bench/README.md`:

```markdown
# Parked fleet benchmarks

These are benchmark scripts (not tests — renamed `*.bench.ts` so vitest's `*.test.ts` glob skips them),
relocated out of `test/` during the Phase-0 harness slice. They exercise the commercial `@stackbase/fleet`
package and so stay under the EE license here rather than moving into the MIT `benchmarks/` tree.

They will be converted into `@stackbase/bench` scenarios (write / scaled-write axes) when those axes are
activated. Until then, run one directly with vitest if needed:

    bun run --filter @stackbase/fleet exec vitest run bench/overhead-pg.bench.ts
```

`packages/cli/bench/README.md`:

```markdown
# Parked CLI benchmarks

WebSocket end-to-end benchmarks (fan-out, reconnect-resume), relocated out of `test/` during the Phase-0
harness slice and renamed `*.bench.ts` so vitest skips them. They will become `@stackbase/bench`
scenarios (reconnect axis / WS reactive variant) when activated.
```

- [ ] **Step 4: Exclude `bench/` from each package's typecheck**

In `ee/packages/fleet/tsconfig.json` and `packages/cli/tsconfig.json`, add `"bench"` to the `exclude` array (create the array if absent, e.g. `"exclude": ["dist", "bench"]`). This keeps parked code from gating `tsc --noEmit`.

- [ ] **Step 5: Verify the test suites no longer see the parked benches, and typecheck is green**

Run: `bun run --filter @stackbase/fleet test && bun run --filter @stackbase/cli test && bun run --filter @stackbase/fleet typecheck && bun run --filter @stackbase/cli typecheck`
Expected: green; the parked `*.bench.ts` files do not run and do not gate typecheck.

- [ ] **Step 6: Confirm the `test/` dirs are clean of bench files**

Run: `ls packages/cli/test/bench-* ee/packages/fleet/test/bench-* packages/test/**/bench-* 2>/dev/null; echo done`
Expected: only `done` (no matches).

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "refactor(bench): segregate deferred benches out of test/ dirs into parked bench/ homes"
```

---

### Task 8: Capture the reactive baseline + docs pointer

**Files:**
- Create: `benchmarks/baselines/reactive-main.json` (the committed reference line)
- Modify: `benchmarks/docs/performance-backlog.md` (add a "how to measure" pointer near the top)

**Interfaces:**
- Consumes: the whole runner (Tasks 1–5).

- [ ] **Step 1: Build, then capture the baseline over both stores**

Run: `bun run build && bun benchmarks/runner/src/cli.ts run --store both --seconds 5 --save benchmarks/baselines/reactive-main.json --label reactive-main`
Expected: writes `benchmarks/results/reactive-main.json` and copies it to `benchmarks/baselines/reactive-main.json`; SQLite scenarios always present, PG scenarios present if embedded-postgres is available (else the skip line printed).

- [ ] **Step 2: Add a measurement pointer to the perf backlog**

In `benchmarks/docs/performance-backlog.md`, immediately after the existing intro paragraph (before `## High impact`), add:

```markdown
> **Measuring a change:** the reactive numbers below are tracked by the `@stackbase/bench` harness
> (`benchmarks/runner`). Capture a baseline on `main`, then compare from your branch **in the same
> sitting** (Docker/same-machine ratios only — never publish these as absolutes):
>
>     bun run build
>     bun run bench:reactive --save benchmarks/baselines/reactive-main.json   # on main
>     bun run bench:reactive --baseline benchmarks/baselines/reactive-main.json   # on your branch
>
> See `docs/superpowers/specs/2025-11-28-benchmark-harness-design.md`. Bands: within ±3% = ⚪ noise.
```

- [ ] **Step 3: Full monorepo green check**

Run: `bun run build && bun run typecheck && bun run test`
Expected: all packages green, including `@stackbase/bench`'s smoke + report + compare tests.

- [ ] **Step 4: Commit**

```bash
git add benchmarks/baselines/reactive-main.json benchmarks/docs/performance-backlog.md
git commit -m "feat(bench): capture the reactive main baseline + perf-backlog measurement pointer"
```

---

## Self-Review

**Spec coverage:**
- §5 layout / leaf package → Task 1. ✅
- §6 relocation (reactive cores) → Tasks 2, 6. Tier-B parking → Task 7. ✅
- §7 `run`/`compare` verbs + JSON schema + `METRIC_DIRECTION` → Tasks 3, 4, 5. ✅
- §8 reactive scenarios (fan-out, propagation, diffbytes) over SQLite + embedded-PG → Tasks 2 (bytes), 4. ✅
- §9 bands + baseline workflow + staleness → Tasks 5, 8. ✅
- §10 metric rigor (p50/p99, ELU, warmup, coordinated-omission via `postAt`) → preserved by moving the core verbatim (Task 2). ✅
- §11 anti-rot smoke in `bun run test` → Task 2 (smoke) + Task 8 Step 3 (full green). ✅

*Deviation from spec §6 (noted deliberately):* `convex-comparison/driver/measure.mjs` is **not** moved — it already lives under `benchmarks/` (not a `test/` dir), and the runner derives propagation from the fan-out core instead of a second measurement core, so there is no reason to disturb a working cross-system benchmark. Propagation and diff-bytes are scenarios over the one relocated core, not separate cores — simpler and DRY.

**Placeholder scan:** No TBD/TODO; every code step shows complete code; every run step shows the exact command + expected result. Task 7 Step 2 describes a mechanical import fix-up rather than pre-writing five files' diffs (the exact edits depend on each file's current relative imports, which the implementer greps) — this is the one judgement step and is bounded to "same-dir `./` helper imports become `../test/`."

**Type consistency:** `FanoutBenchResult.bytesPerUpdateAvg` (Task 2) is surfaced as metric key `bytesPerUpdate` (Task 4 `fanoutMetrics`) and covered in `METRIC_DIRECTION` + its test (Task 5). `ScenarioResult`/`BenchResult`/`StoreKind` are defined in Task 3 and consumed unchanged in Tasks 4–5. `Scenario.run(makeStore)` signature matches `runStore`'s call site. `compareFiles`/`compareVerb` names match between `run.ts` (Task 4 import) and `compare-cli.ts` (Task 5).
