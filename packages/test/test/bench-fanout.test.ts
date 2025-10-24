/**
 * Reactive fan-out benchmark — in-process, in-memory SQLite. The store-agnostic harness lives in
 * `../src/bench-fanout.ts` (so the real-Postgres variant in `ee/packages/fleet` can import it without
 * dragging `@stackbase/docstore-postgres` into this package — that would create a build cycle, since
 * docstore-postgres depends on @stackbase/test). This file exercises it against SQLite, whose
 * synchronous reads make re-execution pure main-thread CPU. Complements the WRITE-path benchmark
 * `ee/packages/fleet/test/bench-commit.test.ts`. See docs/dev/research/reactivity/fanout-benchmark.md.
 */
import { describe, it, expect } from "vitest";
import { runFanoutBench, type FanoutBenchResult } from "../src/bench-fanout";

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
