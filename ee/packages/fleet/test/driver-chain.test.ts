/* Stackbase Enterprise. Licensed under the Stackbase Commercial License — see ee/LICENSE. */
/**
 * Fleet B3, Task 4 (D4) — `createAsyncChain()`: the generic async-op serializer `startFleetNode` uses
 * to route every `startDrivers()`/`stopDriversOnly()` call (the balancer's per-shard acquire,
 * `relinquish`'s default-shard drop, and either promotion path) through ONE ordered chain instead of
 * firing each fire-and-forget. Without it, "last call wins" is NOT guaranteed even though the runtime
 * itself is idempotent (`driversStarted` reset/re-checked): a later-issued but internally FASTER call
 * can resolve before an earlier-issued but SLOWER one, so the wrong op ends up "last applied". These
 * tests exercise the serializer directly with controllable-delay fakes — a lightweight stand-in for
 * `EmbeddedRuntime.startDrivers`/`stopDriversOnly`'s own idempotent-but-unordered shape — rather than
 * standing up a full `startFleetNode` lifecycle (that integration is the fleet-e2e ship gate's job).
 */
import { describe, it, expect } from "vitest";
import { createAsyncChain } from "../src/node";

/** A tiny fake mirroring `EmbeddedRuntime`'s driver shape: `start`/`stop` are each individually
 *  idempotent (a flag), but resolve after a CALLER-CONTROLLED delay — so a test can make a
 *  later-issued call resolve BEFORE an earlier one, reproducing the exact race `createAsyncChain`
 *  closes. `log` records completion order (not issue order) for assertions. */
function makeFakeDrivers() {
  let started = false;
  const log: string[] = [];
  return {
    log,
    isStarted: () => started,
    start: (delayMs: number): (() => Promise<void>) =>
      async () => {
        await new Promise((r) => setTimeout(r, delayMs));
        started = true;
        log.push("start");
      },
    stop: (delayMs: number): (() => Promise<void>) =>
      async () => {
        await new Promise((r) => setTimeout(r, delayMs));
        started = false;
        log.push("stop");
      },
  };
}

describe("createAsyncChain — D4 driver-chain serialization", () => {
  it("queued ops execute in ISSUE order, not completion order (a fast op issued second still runs second)", async () => {
    const run = createAsyncChain();
    const order: string[] = [];
    // Issue "slow" first, "fast" second — WITHOUT the chain, "fast" would resolve first (unawaited).
    const p1 = run(async () => {
      await new Promise((r) => setTimeout(r, 30));
      order.push("slow");
    });
    const p2 = run(async () => {
      await new Promise((r) => setTimeout(r, 1));
      order.push("fast");
    });
    await Promise.all([p1, p2]);
    expect(order).toEqual(["slow", "fast"]); // issue order preserved, despite "fast" being faster
  });

  it("an interleaved start/stop/start storm resolves to STARTED — the last-issued call's state wins", async () => {
    const d = makeFakeDrivers();
    const run = createAsyncChain();
    // Delays are deliberately chosen so this DISCRIMINATES chained-vs-naive behavior: issued
    // start(fast)/stop(SLOW)/start(fast). Fired naively (unawaited, no chain), the slow middle `stop`
    // is the one that resolves LAST chronologically, so naive code would end up started=FALSE — wrong,
    // since the LAST-ISSUED call was `start`. Only serialized (sequential, issue-order) execution gets
    // this right regardless of each op's own duration.
    const p1 = run(d.start(1));
    const p2 = run(d.stop(30));
    const p3 = run(d.start(2));
    await Promise.all([p1, p2, p3]);
    expect(d.log).toEqual(["start", "stop", "start"]); // completed in ISSUE order, not duration order
    expect(d.isStarted()).toBe(true); // last-issued call (start) is what's live
  });

  it("an interleaved stop/start/stop storm resolves to STOPPED — the last-issued call's state wins", async () => {
    const d = makeFakeDrivers();
    const run = createAsyncChain();
    // Mirror of the above: stop(fast)/start(SLOW)/stop(fast) — naive execution would let the slow
    // middle `start` resolve last and leave started=TRUE, wrong since `stop` was issued last.
    const p1 = run(d.stop(1));
    const p2 = run(d.start(30));
    const p3 = run(d.stop(2));
    await Promise.all([p1, p2, p3]);
    expect(d.log).toEqual(["stop", "start", "stop"]);
    expect(d.isStarted()).toBe(false);
  });

  it("a stop issued strictly AFTER a start always lands after it, even if the start is slow", async () => {
    const d = makeFakeDrivers();
    const run = createAsyncChain();
    const startP = run(d.start(50)); // slow start, issued first
    await new Promise((r) => setTimeout(r, 5)); // the start is still in flight
    const stopP = run(d.stop(1)); // fast stop, issued second — must still land AFTER the start
    await Promise.all([startP, stopP]);
    expect(d.log).toEqual(["start", "stop"]);
    expect(d.isStarted()).toBe(false);
  });

  it("a rejecting op does not wedge the chain — the next queued op still runs", async () => {
    const run = createAsyncChain();
    const order: string[] = [];
    const p1 = run(async () => {
      order.push("failing");
      throw new Error("boom");
    });
    const p2 = run(async () => {
      order.push("next");
    });
    await expect(p1).rejects.toThrow("boom");
    await p2; // must resolve — the failure above must not have wedged the tail
    expect(order).toEqual(["failing", "next"]);
  });

  it("each createAsyncChain() call returns an independent chain — two chains never interleave with each other", async () => {
    const runA = createAsyncChain();
    const runB = createAsyncChain();
    const order: string[] = [];
    const a1 = runA(async () => {
      await new Promise((r) => setTimeout(r, 20));
      order.push("A1");
    });
    const b1 = runB(async () => {
      order.push("B1"); // independent chain — resolves immediately, unordered relative to A's chain
    });
    await Promise.all([a1, b1]);
    expect(order).toContain("A1");
    expect(order).toContain("B1");
    // B1, on its own chain, is free to finish before A1 — proving the two chains don't share a tail.
    expect(order.indexOf("B1")).toBeLessThan(order.indexOf("A1"));
  });
});
