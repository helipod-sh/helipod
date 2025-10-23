# Reactive Fan-Out Benchmark Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a reactive fan-out benchmark that measures invalidation/re-execution throughput, propagation latency, and main-thread saturation (the Bun-Workers decision signal), plus a thin real-WebSocket end-to-end propagation cell.

**Architecture:** An in-process harness (`packages/test/test/bench-fanout.test.ts`) drives N loopback subscriptions through the REAL client → sync protocol → `SubscriptionManager` → engine invalidation path (the mechanism `packages/test/src/reactivity.ts` already uses), over an **in-memory SQLite** store (synchronous reads → clean CPU-saturation signal). A single writer loop bumps per-channel counter rows; each commit invalidates the subscriptions reading that channel. A secondary test (`packages/cli/test/bench-fanout-ws.test.ts`) boots a real `startDevServer` and connects K real WebSocket clients for a true end-to-end propagation number.

**Tech Stack:** TypeScript, vitest (under Node), `@stackbase/{test,client,executor,runtime-embedded,docstore-sqlite,id-codec}`, `node:perf_hooks` `eventLoopUtilization`, `ws` (WebSocket cell).

## Global Constraints

- **Tests run under Node (vitest), not Bun.** `globalThis.Bun` is undefined in the suite — use `NodeSqliteAdapter`, not the Bun adapter. (Memory: "Tests run under Node".)
- **Cross-package tests resolve workspace deps via built `dist/`, not `src/`.** After editing any dependency package's source, rebuild it (`bun run build --filter <pkg>`) before the consuming test sees the change. (Memory: "Tests resolve deps via dist".) The two benchmark files here consume already-built packages, so no dep edits are expected; if a dep must change, rebuild it.
- **Benchmark discipline (mirror `bench-commit`):** warmup window discarded, then a fixed measurement window; latency reported as sorted p50/p99 (never averages); deadlines checked via inline `Date.now()` (NOT `setTimeout`-driven flags — a tight `await` loop starves Node's timer phase); a CI-fast smoke always runs, the heavy matrix is opt-in; the heavy test **prints** a table, numbers are **hand-transcribed** into the report so a routine run cannot overwrite it.
- **License boundary:** both benchmark files live under `packages/` (open FSL), not `ee/`. Reactivity is core.
- **No arg validators on the fixture functions** — use the plain `mutation<Args,Ret>({...})` / `query<Args,Ret>({...})` generic form (opt-in validation is off), exactly as `bench-commit`'s `benchModules()` does.

---

### Task 1: In-process fixture + runtime boot

**Files:**
- Create: `packages/test/test/bench-fanout.test.ts`

**Interfaces:**
- Consumes: `NodeSqliteAdapter`, `SqliteDocStore` from `@stackbase/docstore-sqlite`; `SimpleIndexCatalog`, `mutation`, `query`, `type RegisteredFunction` from `@stackbase/executor`; `createEmbeddedRuntime` from `@stackbase/runtime-embedded`; `encodeStorageIndexId` from `@stackbase/id-codec`.
- Produces: `freshCatalog(): SimpleIndexCatalog`, `benchModules(): Record<string, RegisteredFunction>`, `buildRuntime(): Promise<EmbeddedRuntime>`, and the fixture constants `BENCH_TABLE`, `byChannel`. Table shape: one row per `(channelId, kind)` where `kind` is `"counter"` (one per channel) or `"pool"` (K per channel, scan variant); columns `n: number`, `postAt: number`, and for pool rows `i: number`.

- [ ] **Step 1: Write the failing test**

Create `packages/test/test/bench-fanout.test.ts` with the fixture + a boot/invalidation smoke test:

```ts
/**
 * Reactive fan-out benchmark. Complements bench-commit (which measures the WRITE path only) by
 * measuring the REACTIVE path: N loopback subscriptions, a writer that invalidates them, and how
 * fast/how-many re-runs result — plus event-loop utilization as the Bun-Workers saturation signal.
 * Drives the real client -> sync protocol -> SubscriptionManager -> invalidation path (the
 * mechanism in packages/test/src/reactivity.ts), over in-memory SQLite (synchronous reads => the
 * re-execution CPU is on the main thread, which is exactly what we want to observe saturate).
 * See docs/dev/research/reactivity/fanout-benchmark.md (report) and
 * docs/superpowers/specs/2025-10-16-reactive-fanout-benchmark-design.md (design).
 */
import { describe, it, expect } from "vitest";
import { NodeSqliteAdapter, SqliteDocStore } from "@stackbase/docstore-sqlite";
import { SimpleIndexCatalog, mutation, query, type RegisteredFunction } from "@stackbase/executor";
import { createEmbeddedRuntime, type EmbeddedRuntime } from "@stackbase/runtime-embedded";
import { encodeStorageIndexId } from "@stackbase/id-codec";
import { StackbaseClient, loopbackTransport } from "@stackbase/client";

const BENCH_TABLE = 40601;
const BENCH_INDEX_ID = encodeStorageIndexId(BENCH_TABLE, "by_channel");
const byChannel = {
  table: "bench",
  tableNumber: BENCH_TABLE,
  index: "by_channel",
  fields: ["channelId"],
  indexId: BENCH_INDEX_ID,
};

function freshCatalog(): SimpleIndexCatalog {
  const catalog = new SimpleIndexCatalog();
  catalog.addTable("bench", BENCH_TABLE, undefined, false, "channelId");
  catalog.addIndex(byChannel);
  return catalog;
}

function benchModules(): Record<string, RegisteredFunction> {
  return {
    // A subscription reads its channel's rows. For the "point" variant a channel holds exactly one
    // (counter) row => constant re-run cost regardless of how many writes happened. For "scan" the
    // channel also holds K pool rows => a wider, still-constant collect.
    "bench:byChannel": query<{ channelId: string }, unknown>({
      handler: (ctx, { channelId }) =>
        ctx.db.query("bench", "by_channel").eq("channelId", channelId).collect(),
    }),
    // The invalidating write: bump the channel's counter row and stamp postAt (passed in as an
    // ARGUMENT — computed client-side, so the handler stays deterministic, no clock read inside).
    "bench:bump": mutation<{ channelId: string; postAt: number }, null>({
      shardBy: "channelId",
      handler: async (ctx, { channelId, postAt }) => {
        const docs = await ctx.db.query("bench", "by_channel").eq("channelId", channelId).collect();
        const counter = docs.find((d) => (d as Record<string, unknown>)["kind"] === "counter") as
          | Record<string, unknown>
          | undefined;
        if (counter) {
          const n = (counter["n"] as number | undefined) ?? 0;
          await ctx.db.replace(counter["_id"] as string, { ...counter, n: n + 1, postAt });
        }
        return null;
      },
    }),
    "bench:seedCounter": mutation<{ channelId: string }, string>({
      shardBy: "channelId",
      handler: (ctx, { channelId }) =>
        ctx.db.insert("bench", { channelId, kind: "counter", n: 0, postAt: 0 }),
    }),
    "bench:seedPool": mutation<{ channelId: string; i: number }, string>({
      shardBy: "channelId",
      handler: (ctx, { channelId, i }) =>
        ctx.db.insert("bench", { channelId, kind: "pool", i, n: 0, postAt: 0 }),
    }),
  };
}

async function buildRuntime(): Promise<EmbeddedRuntime> {
  const store = new SqliteDocStore(new NodeSqliteAdapter({ path: ":memory:" }));
  return createEmbeddedRuntime({ store, catalog: freshCatalog(), modules: benchModules() });
}

describe("bench-fanout — fixture wiring", () => {
  it("a bump invalidates a subscription reading the same channel", async () => {
    const runtime = await buildRuntime();
    await runtime.run("bench:seedCounter", { channelId: "c0" });
    const client = new StackbaseClient(loopbackTransport(runtime.connect()));
    let reruns = 0;
    const values: unknown[] = [];
    client.subscribe("bench:byChannel", { channelId: "c0" }, (v) => {
      reruns += 1;
      values.push(v);
    });
    // wait for first compute
    await new Promise((r) => setTimeout(r, 50));
    const firstReruns = reruns;
    await runtime.run("bench:bump", { channelId: "c0", postAt: performance.now() });
    await new Promise((r) => setTimeout(r, 50));
    expect(reruns).toBeGreaterThan(firstReruns); // the write re-ran the subscription
    client.close();
  }, 20_000);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run --filter @stackbase/test test -- bench-fanout`
Expected: FAIL initially only if an import path is wrong; if the fixture compiles it should PASS. The real purpose of this step is to confirm the imports resolve. If it fails with a module-resolution error (e.g. `NodeSqliteAdapter`/`SqliteDocStore` not exported from the package index), fix the import to the correct subpath and re-run.

- [ ] **Step 3: (Fix imports only if Step 2 surfaced a resolution error)**

If `@stackbase/docstore-sqlite`'s index does not re-export `NodeSqliteAdapter`/`SqliteDocStore`, import from the concrete modules instead:

```ts
import { NodeSqliteAdapter } from "@stackbase/docstore-sqlite/dist/node-adapter";
import { SqliteDocStore } from "@stackbase/docstore-sqlite/dist/sqlite-docstore";
```

(Prefer the package-index import; use this only if the index doesn't expose them.)

- [ ] **Step 4: Run test to verify it passes**

Run: `bun run --filter @stackbase/test test -- bench-fanout`
Expected: PASS (1 test) — the bump re-ran the subscription.

- [ ] **Step 5: Commit**

```bash
git add packages/test/test/bench-fanout.test.ts
git commit -m "test(bench-fanout): fixture + runtime boot + invalidation smoke"
```

---

### Task 2: `runFanoutBench` core (subscriptions, writer, metrics, ELU)

**Files:**
- Modify: `packages/test/test/bench-fanout.test.ts` (add the harness + a smoke describe)

**Interfaces:**
- Consumes: `buildRuntime`, `benchModules` from Task 1; `performance` from `node:perf_hooks` (`eventLoopUtilization`).
- Produces:
  ```ts
  interface FanoutBenchOpts {
    subscriptions: number;              // fan-out width
    shape: "broadcast" | "selective";  // all-on-one-channel vs one-sub-per-channel
    queryCost: "point" | "scan";       // 1 row per channel vs 1 counter + POOL_SIZE pool rows
    seconds: number;                    // measurement window
    warmupMs?: number;                  // default 2000
  }
  interface FanoutBenchResult {
    reRunsPerSec: number; propP50Ms: number; propP99Ms: number;
    eluDuringStorm: number; writesPerSec: number; subsMatchedAvg: number; errors: number;
  }
  export async function runFanoutBench(opts: FanoutBenchOpts): Promise<FanoutBenchResult>;
  ```

- [ ] **Step 1: Write the failing test**

Add to `packages/test/test/bench-fanout.test.ts` (above the existing `describe`, add the import and helpers; below, add the smoke `describe`):

```ts
import { performance } from "node:perf_hooks";

const POOL_SIZE = 20; // scan-variant rows per channel

function percentile(sortedMs: readonly number[], q: number): number {
  if (sortedMs.length === 0) return 0;
  const idx = Math.min(sortedMs.length - 1, Math.floor(q * sortedMs.length));
  return sortedMs[idx]!;
}

/** Channels for a shape: broadcast = 1 channel with N subs; selective = N channels, 1 sub each. */
function channelsForShape(shape: "broadcast" | "selective", subscriptions: number): string[] {
  if (shape === "broadcast") return Array.from({ length: subscriptions }, () => "c0");
  return Array.from({ length: subscriptions }, (_, i) => `c${i}`);
}

export interface FanoutBenchOpts {
  subscriptions: number;
  shape: "broadcast" | "selective";
  queryCost: "point" | "scan";
  seconds: number;
  warmupMs?: number;
}
export interface FanoutBenchResult {
  reRunsPerSec: number;
  propP50Ms: number;
  propP99Ms: number;
  eluDuringStorm: number;
  writesPerSec: number;
  subsMatchedAvg: number;
  errors: number;
}

export async function runFanoutBench(opts: FanoutBenchOpts): Promise<FanoutBenchResult> {
  const warmupMs = opts.warmupMs ?? 2000;
  const runtime = await buildRuntime();

  // Distinct channels this run touches (deduped), each seeded with a counter row (+ pool rows for scan).
  const subChannels = channelsForShape(opts.shape, opts.subscriptions);
  const distinctChannels = [...new Set(subChannels)];
  for (const channelId of distinctChannels) {
    await runtime.run("bench:seedCounter", { channelId });
    if (opts.queryCost === "scan") {
      for (let i = 0; i < POOL_SIZE; i++) await runtime.run("bench:seedPool", { channelId, i });
    }
  }

  // One shared client, N subscriptions. Each re-run reads the channel's counter row, and if its
  // postAt is a real (post-warmup) stamp, records now-postAt as one propagation sample.
  const client = new StackbaseClient(loopbackTransport(runtime.connect()));
  const latenciesMs: number[] = [];
  let reRuns = 0;
  let errors = 0;
  let measuring = false;

  function onValue(value: unknown): void {
    if (!measuring) return;
    const arr = value as Array<Record<string, unknown>> | undefined;
    if (!Array.isArray(arr)) return;
    const counter = arr.find((d) => d["kind"] === "counter");
    const postAt = (counter?.["postAt"] as number | undefined) ?? 0;
    if (postAt > 0) {
      latenciesMs.push(performance.now() - postAt);
      reRuns += 1;
    }
  }

  for (const channelId of subChannels) {
    client.subscribe("bench:byChannel", { channelId }, onValue, () => {
      if (measuring) errors += 1;
    });
  }
  // Let all initial computes settle before measuring (they carry postAt=0 and are skipped anyway).
  await new Promise((r) => setTimeout(r, 200));

  // Writer loop: bump channels round-robin, stamping postAt at post time. Deadline via Date.now()
  // (NOT a setTimeout flag — a tight await loop starves Node's timer phase; see bench-commit).
  let bumps = 0;
  let writeIdx = 0;
  const startedAt = Date.now();
  const measureStartAt = startedAt + warmupMs;
  const measureEndAt = measureStartAt + opts.seconds * 1000;
  let eluStart = performance.eventLoopUtilization();

  let iter = 0;
  while (Date.now() < measureEndAt) {
    if (!measuring && Date.now() >= measureStartAt) {
      measuring = true;
      eluStart = performance.eventLoopUtilization(); // reset the ELU baseline at window start
    }
    const channelId = distinctChannels[writeIdx % distinctChannels.length]!;
    writeIdx += 1;
    const before = Date.now();
    try {
      await runtime.run("bench:bump", { channelId, postAt: performance.now() });
      if (before >= measureStartAt) bumps += 1;
    } catch {
      if (before >= measureStartAt) errors += 1;
    }
    iter += 1;
    if (iter % 64 === 0) await new Promise<void>((r) => setImmediate(r));
  }
  // Drain in-flight re-runs, then snapshot ELU over the measurement window.
  await new Promise((r) => setTimeout(r, 100));
  const elu = performance.eventLoopUtilization(eluStart);
  client.close();

  latenciesMs.sort((a, b) => a - b);
  return {
    reRunsPerSec: reRuns / opts.seconds,
    propP50Ms: percentile(latenciesMs, 0.5),
    propP99Ms: percentile(latenciesMs, 0.99),
    eluDuringStorm: elu.utilization,
    writesPerSec: bumps / opts.seconds,
    subsMatchedAvg: bumps > 0 ? reRuns / bumps : 0,
    errors,
  };
}

describe("bench-fanout — harness smoke (CI-fast, always on)", () => {
  it("broadcast: one bump wakes every subscription", async () => {
    const r = await runFanoutBench({
      subscriptions: 20, shape: "broadcast", queryCost: "point", seconds: 1, warmupMs: 300,
    });
    expect(r.reRunsPerSec).toBeGreaterThan(0);
    expect(r.errors).toBe(0);
    expect(r.subsMatchedAvg).toBeGreaterThan(10); // ~20 subs matched per bump (broadcast)
  }, 30_000);

  it("selective: one bump wakes ~one subscription", async () => {
    const r = await runFanoutBench({
      subscriptions: 20, shape: "selective", queryCost: "point", seconds: 1, warmupMs: 300,
    });
    expect(r.reRunsPerSec).toBeGreaterThan(0);
    expect(r.errors).toBe(0);
    expect(r.subsMatchedAvg).toBeLessThan(3); // surgical: ~1 sub matched per bump
  }, 30_000);
});
```

- [ ] **Step 2: Run test to verify it fails/passes**

Run: `bun run --filter @stackbase/test test -- bench-fanout`
Expected: the two smoke tests PASS. The load-bearing assertions are the `subsMatchedAvg` contrasts (broadcast ≫ selective) — they prove the fixture drives broadcast vs surgical invalidation as intended. If `subsMatchedAvg` for broadcast is ~1 (not ~20), the subscriptions aren't sharing the channel — check `channelsForShape`.

- [ ] **Step 3: (only if a smoke assertion fails) Diagnose with a print**

If `reRunsPerSec` is 0, temporarily add `console.log(JSON.stringify(r))` in the failing test and re-run; the most likely cause is the measurement window being too short at `seconds:1` — confirm `measuring` flips true (postAt>0 samples recorded). Do not weaken the assertions to pass; fix the harness.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun run --filter @stackbase/test test -- bench-fanout`
Expected: PASS (3 tests total — Task 1 wiring + 2 smokes).

- [ ] **Step 5: Commit**

```bash
git add packages/test/test/bench-fanout.test.ts
git commit -m "feat(bench-fanout): runFanoutBench core + broadcast/selective smoke"
```

---

### Task 3: The opt-in full matrix (7 cells) + printed table

**Files:**
- Modify: `packages/test/test/bench-fanout.test.ts` (add the gated matrix describe)

**Interfaces:**
- Consumes: `runFanoutBench`, `FanoutBenchResult` from Task 2.
- Produces: an opt-in test that prints a copy-pasteable results table. Gate env var: `STACKBASE_BENCH_FANOUT=1`.

- [ ] **Step 1: Write the test (gated, prints — no new asserted behavior beyond sanity)**

Add to `packages/test/test/bench-fanout.test.ts`:

```ts
const RUN_MATRIX = process.env["STACKBASE_BENCH_FANOUT"] === "1";
const matrixDescribe = RUN_MATRIX ? describe : describe.skip;

interface MatrixCell {
  subscriptions: number;
  shape: "broadcast" | "selective";
  queryCost: "point" | "scan";
  result: FanoutBenchResult;
}

matrixDescribe("bench-fanout — full matrix (opt-in: STACKBASE_BENCH_FANOUT=1)", () => {
  it("7 cells: point across the 3x2 grid + one scan headline — prints the table", async () => {
    // point across the full subscriptions x shape grid, plus one scan cell at the headline.
    const cellSpecs: Array<Omit<MatrixCell, "result">> = [];
    for (const shape of ["broadcast", "selective"] as const) {
      for (const subscriptions of [100, 1_000, 10_000]) {
        cellSpecs.push({ subscriptions, shape, queryCost: "point" });
      }
    }
    cellSpecs.push({ subscriptions: 10_000, shape: "broadcast", queryCost: "scan" });

    const cells: MatrixCell[] = [];
    for (const spec of cellSpecs) {
      const result = await runFanoutBench({ ...spec, seconds: 5, warmupMs: 2000 });
      cells.push({ ...spec, result });
      expect(result.errors).toBe(0);
      expect(result.reRunsPerSec).toBeGreaterThan(0);
    }

    // eslint-disable-next-line no-console
    console.log("\n=== Reactive fan-out benchmark (in-process, in-memory SQLite, this machine) ===");
    // eslint-disable-next-line no-console
    console.log("subs   | shape      | qcost | reRuns/s | propP50 | propP99 | ELU   | writes/s | matchedAvg");
    for (const c of cells) {
      const r = c.result;
      // eslint-disable-next-line no-console
      console.log(
        `${String(c.subscriptions).padStart(6)} | ${c.shape.padEnd(10)} | ${c.queryCost.padEnd(5)} | ` +
          `${r.reRunsPerSec.toFixed(0).padStart(8)} | ${r.propP50Ms.toFixed(2).padStart(7)} | ` +
          `${r.propP99Ms.toFixed(2).padStart(7)} | ${r.eluDuringStorm.toFixed(3).padStart(5)} | ` +
          `${r.writesPerSec.toFixed(0).padStart(8)} | ${r.subsMatchedAvg.toFixed(1).padStart(10)}`,
      );
    }
  }, 600_000);
});
```

- [ ] **Step 2: Run the gated matrix once to verify it executes end-to-end**

Run: `STACKBASE_BENCH_FANOUT=1 bun run --filter @stackbase/test test -- bench-fanout`
Expected: the matrix test runs (may take a few minutes), prints the 9-column table with 7 rows, zero errors. Confirm the headline row (`10000 | broadcast | scan`) has a plausible `ELU` between 0 and 1. If the 10 000-subscription cells run out of memory or the run exceeds the timeout, reduce the top N to the largest value that completes and note the cap in Step 4 (no silent truncation).

- [ ] **Step 3: Verify the default (ungated) run still skips the matrix**

Run: `bun run --filter @stackbase/test test -- bench-fanout`
Expected: the matrix describe is skipped; only the 3 always-on tests run and pass. (Keeps routine CI fast.)

- [ ] **Step 4: Commit**

```bash
git add packages/test/test/bench-fanout.test.ts
git commit -m "feat(bench-fanout): opt-in 7-cell matrix + printed results table"
```

---

### Task 4: WebSocket end-to-end propagation cell

**Files:**
- Create: `packages/cli/test/fixtures/bench-fanout/convex/schema.ts`
- Create: `packages/cli/test/fixtures/bench-fanout/convex/bench.ts`
- Create: `packages/cli/test/bench-fanout-ws.test.ts`

**Interfaces:**
- Consumes: `startDevServer` (import + call mirrored from `packages/cli/test/action-e2e.test.ts` around lines 120–135); `StackbaseClient`, `webSocketTransport` from `@stackbase/client`; the fixture's `bench:byChannel` / `bench:seed` / `bench:bump` functions.
- Produces: an opt-in test measuring write → each WS client receives the push (end-to-end p50/p99). Gate env var: `STACKBASE_BENCH_FANOUT_WS=1`.

- [ ] **Step 1: Create the fixture schema**

`packages/cli/test/fixtures/bench-fanout/convex/schema.ts`:

```ts
import { defineSchema, defineTable, v } from "@stackbase/values";

export default defineSchema({
  bench: defineTable({
    channelId: v.string(),
    kind: v.string(),
    n: v.number(),
    postAt: v.number(),
  })
    .index("by_channel", ["channelId"])
    .shardKey("channelId"),
});
```

- [ ] **Step 2: Create the fixture functions**

`packages/cli/test/fixtures/bench-fanout/convex/bench.ts`:

```ts
import { mutation, query } from "./_generated/server";

export const byChannel = query({
  handler: (ctx, args: { channelId: string }) =>
    ctx.db.query("bench", "by_channel").eq("channelId", args.channelId).collect(),
});

export const seed = mutation({
  handler: (ctx, args: { channelId: string }) =>
    ctx.db.insert("bench", { channelId: args.channelId, kind: "counter", n: 0, postAt: 0 }),
});

export const bump = mutation({
  handler: async (ctx, args: { channelId: string; postAt: number }) => {
    const docs = await ctx.db.query("bench", "by_channel").eq("channelId", args.channelId).collect();
    const c = docs.find((d) => (d as { kind: string }).kind === "counter") as
      | { _id: string; n: number }
      | undefined;
    if (c) await ctx.db.replace(c._id, { ...(c as object), n: c.n + 1, postAt: args.postAt });
    return null;
  },
});
```

(`_generated/server` is produced by `stackbase dev` codegen at boot — the same way the other `packages/cli/test/fixtures/*` apps resolve it. No `_generated` is committed by hand.)

- [ ] **Step 3: Write the WS benchmark test**

`packages/cli/test/bench-fanout-ws.test.ts`:

```ts
/**
 * Reactive fan-out — WebSocket end-to-end cell. Boots a real dev server on the bench-fanout fixture
 * and connects K real WS clients to one channel; measures write -> each client RECEIVES the push
 * (true end-to-end propagation, including protocol serialization + loopback socket). The in-process
 * bench-fanout.test.ts measures the CPU/saturation signal; this measures the user-facing latency.
 * Opt-in (STACKBASE_BENCH_FANOUT_WS=1) — heavier than the in-process run.
 */
import { describe, it, expect } from "vitest";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { StackbaseClient, webSocketTransport } from "@stackbase/client";
// NOTE: copy the exact `startDevServer` import used by action-e2e.test.ts (top of that file).
import { startDevServer } from "../src/server";

const RUN_WS = process.env["STACKBASE_BENCH_FANOUT_WS"] === "1";
const wsDescribe = RUN_WS ? describe : describe.skip;

const FIXTURE_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures/bench-fanout",
);

function percentile(sortedMs: readonly number[], q: number): number {
  if (sortedMs.length === 0) return 0;
  return sortedMs[Math.min(sortedMs.length - 1, Math.floor(q * sortedMs.length))]!;
}

wsDescribe("bench-fanout-ws — end-to-end propagation (opt-in: STACKBASE_BENCH_FANOUT_WS=1)", () => {
  it("K WS clients on one channel: measures write -> each client receives push", async () => {
    // Boot the real dev server. Mirror the exact startDevServer(...) options block from
    // packages/cli/test/action-e2e.test.ts (~line 125): projectDir=FIXTURE_DIR, port 0/ephemeral.
    const server = await startDevServer({ projectDir: FIXTURE_DIR, port: 0 } as never);
    const wsUrl = `ws://127.0.0.1:${server.port}/api/sync`;

    try {
      // Seed one channel via the HTTP run endpoint (no WS needed).
      await fetch(`${server.url}/api/run`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: "bench:seed", args: { channelId: "c0" } }),
      });

      const K = 100;
      const clients = Array.from({ length: K }, () => new StackbaseClient(webSocketTransport(wsUrl)));
      const latencies: number[] = [];
      let received = 0;
      let subscribed = 0;

      await Promise.all(
        clients.map(
          (client) =>
            new Promise<void>((resolve) => {
              let first = true;
              client.subscribe("bench:byChannel", { channelId: "c0" }, (value) => {
                if (first) {
                  first = false;
                  subscribed += 1;
                  resolve(); // first compute = subscription established
                  return;
                }
                const arr = value as Array<Record<string, unknown>>;
                const counter = arr.find((d) => d["kind"] === "counter");
                const postAt = (counter?.["postAt"] as number | undefined) ?? 0;
                if (postAt > 0) {
                  latencies.push(performance.now() - postAt);
                  received += 1;
                }
              });
            }),
        ),
      );
      expect(subscribed).toBe(K);

      // One write; every client should receive the push.
      const postAt = performance.now();
      await fetch(`${server.url}/api/run`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: "bench:bump", args: { channelId: "c0", postAt } }),
      });
      // Wait for fan-out to arrive.
      await new Promise((r) => setTimeout(r, 2000));

      for (const c of clients) c.close();
      expect(received).toBe(K); // all K clients saw the update

      latencies.sort((a, b) => a - b);
      // eslint-disable-next-line no-console
      console.log(
        `\n=== bench-fanout WS end-to-end (K=${K} clients, this machine) ===\n` +
          `received=${received}/${K}  propP50=${percentile(latencies, 0.5).toFixed(2)}ms  ` +
          `propP99=${percentile(latencies, 0.99).toFixed(2)}ms`,
      );
    } finally {
      await server.close();
    }
  }, 120_000);
});
```

- [ ] **Step 4: Verify the fixture boots + the cell runs**

Run: `STACKBASE_BENCH_FANOUT_WS=1 bun run --filter @stackbase/cli test -- bench-fanout-ws`
Expected: server boots, codegen produces `_generated`, 100 clients subscribe (`subscribed === 100`), one bump reaches all 100 (`received === 100`), prints p50/p99. If `startDevServer`'s option keys differ from `{ projectDir, port }`, correct them to match the exact call in `action-e2e.test.ts` (that file is the source of truth for the boot signature); the `as never` cast is a placeholder to be removed once the real option names are filled in.

- [ ] **Step 5: Verify the default (ungated) run skips it**

Run: `bun run --filter @stackbase/cli test -- bench-fanout-ws`
Expected: the describe is skipped (0 tests run in this file). Keeps routine CI fast and Docker/server-free.

- [ ] **Step 6: Commit**

```bash
git add packages/cli/test/fixtures/bench-fanout packages/cli/test/bench-fanout-ws.test.ts
git commit -m "test(bench-fanout): real-WS end-to-end propagation cell + fixture"
```

---

### Task 5: Run the benchmark + write the report

**Files:**
- Create: `docs/dev/research/reactivity/fanout-benchmark.md`

**Interfaces:**
- Consumes: the printed tables from Tasks 3 and 4.

- [ ] **Step 1: Run the full in-process matrix and capture the table**

Run: `STACKBASE_BENCH_FANOUT=1 bun run --filter @stackbase/test test -- bench-fanout 2>&1 | tee /tmp/fanout-matrix.txt`
Copy the printed 7-row table.

- [ ] **Step 2: Run the WS cell and capture its line**

Run: `STACKBASE_BENCH_FANOUT_WS=1 bun run --filter @stackbase/cli test -- bench-fanout-ws 2>&1 | tee /tmp/fanout-ws.txt`
Copy the printed `received / propP50 / propP99` line.

- [ ] **Step 3: Write the report**

Create `docs/dev/research/reactivity/fanout-benchmark.md` with: a machine-context section (hardware, `node -v`, vitest version, store = in-memory SQLite, "absolute numbers are this machine; the ELU signal and the broadcast/selective ratios travel"); the transcribed 7-row in-process table; the WS end-to-end line; and an **Interpretation** section reasoning from the headline `broadcast / 10 000 / point` cell:
  - if `eluDuringStorm` → ~1.0 while `reRunsPerSec` plateaus vs the 1 000-sub cell ⇒ main thread CPU-saturated ⇒ **Bun Workers justified**; quote `reRunsPerSec` as the single-thread ceiling to beat;
  - if `eluDuringStorm` < ~0.7 ⇒ not single-core-bound ⇒ Workers won't help; name the next thing to profile;
  - confirm the `selective` cells kept `subsMatchedAvg ≈ 1` and higher `reRunsPerSec` than broadcast at equal N (range-precise invalidation paying off).
Mirror the structure and honesty tone of `docs/dev/research/write-sharding/b4-benchmark.md`.

- [ ] **Step 4: Commit**

```bash
git add docs/dev/research/reactivity/fanout-benchmark.md
git commit -m "docs(bench-fanout): recorded reactive fan-out results + Workers interpretation"
```

---

## Self-Review

**1. Spec coverage:**
- In-process primary harness (loopback, reRunsPerSec/propagation/ELU) → Tasks 1–2. ✓
- In-memory SQLite for a clean CPU signal → Task 1 `buildRuntime`. ✓
- Chat-shaped fixture, broadcast vs selective mapping onto `findAffectedByRanges` → Task 1 fixture + Task 2 `channelsForShape` (broadcast = shared channel → ranges overlap → all re-run; selective = per-channel → surgical). ✓
- 7-cell matrix (point grid + one scan headline) → Task 3. ✓
- ELU as the Workers verdict signal → Task 2 (`eventLoopUtilization`) + Task 5 interpretation. ✓
- Thin real-WS end-to-end cell → Task 4. ✓
- CI-fast smoke always-on + opt-in heavy run + hand-transcribed report → Tasks 2 (smoke), 3/4 (gated), 5 (report). ✓
- Placement (`packages/test/`, `packages/cli/`, report in `docs/dev/research/reactivity/`) → Tasks 1/4/5. ✓
- `subsMatchedAvg` confirming shape → Task 2 smoke assertions + result field. ✓

**2. Placeholder scan:** The only deferred lookups are (a) the exact `startDevServer` option keys and import path (Task 4 Step 4 — resolved by copying the verbatim, working call from `action-e2e.test.ts`, an explicit concrete source, not a vague "TODO"), and (b) the optional docstore-sqlite subpath import (Task 1 Step 3, with the exact fallback given). Both name an exact resolution. No "add error handling"/"write tests for the above"/bare-TODO placeholders. ✓

**3. Type consistency:** `FanoutBenchOpts`/`FanoutBenchResult` field names are identical across Tasks 2, 3, and the self-review. `runFanoutBench`, `buildRuntime`, `benchModules`, `freshCatalog`, `channelsForShape`, `percentile` names are consistent across tasks. Fixture function paths (`bench:byChannel`, `bench:bump`, `bench:seedCounter`, `bench:seedPool` in-process; `bench:byChannel`/`bench:seed`/`bench:bump` in the WS fixture) match their call sites. The `kind: "counter"` / `postAt` row contract is used identically by the writer, the subscription callback, and the WS client. ✓
