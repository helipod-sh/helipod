import { describe, it, expect } from "vitest";
import type { DriverContext } from "@stackbase/component";
import { schedulerDriver } from "../src/driver";
import { SWEEP_MS } from "../src/modules";

/**
 * Regression: `schedulerDriver().stop()` must not resurrect the loop. An in-flight pass's
 * end-of-pass `setTimer` re-arm (`runPass`), and an in-flight `sweepOnce()`'s `finally → armSweep`,
 * both run when the work they were awaiting settles — even if `stop()` raced in mid-await. Without
 * the `stopped` guard, they schedule a fresh timer AFTER `stop()` returned and the driver keeps
 * running forever (matters for `stackbase dev` hot-reload teardown racing a dispatch/sweep).
 *
 * Driven with a controllable fake `DriverContext` so `setTimer` calls are directly observable —
 * the real-runtime harness (`./helpers.ts`) can't see the driver's private timers.
 */

interface RecordedTimer { atMs: number; cb: () => void; handle: number; cleared: boolean }

function makeFakeCtx(runFn: (path: string) => Promise<unknown>): { ctx: DriverContext; timers: RecordedTimer[] } {
  const timers: RecordedTimer[] = [];
  let nextHandle = 1;
  const ctx: DriverContext = {
    runFunction: (path: string) => runFn(path),
    onCommit: () => () => {},
    setTimer: (atMs: number, cb: () => void) => {
      const handle = nextHandle++;
      timers.push({ atMs, cb, handle, cleared: false });
      return handle;
    },
    clearTimer: (handle: number) => {
      const t = timers.find((x) => x.handle === handle);
      if (t) t.cleared = true;
    },
    now: () => 1000,
  };
  return { ctx, timers };
}

const settle = () => new Promise((r) => setTimeout(r, 0));

describe("schedulerDriver stop() race", () => {
  it("stop() while a dispatch pass is in flight does not re-arm the due-job timer", async () => {
    let releasePeek: (v: { due: unknown[]; earliestFutureTs: number | null }) => void = () => {};
    const blockedPeek = new Promise<{ due: unknown[]; earliestFutureTs: number | null }>((r) => {
      releasePeek = r;
    });
    let peekCalls = 0;
    const { ctx, timers } = makeFakeCtx(async (path) => {
      if (path === "scheduler:_peekDue") {
        peekCalls++;
        return blockedPeek;
      }
      return {}; // _reclaim etc.
    });

    const driver = schedulerDriver();
    driver.start(ctx); // wake() -> runPass -> awaits _peekDue (blocks); armSweep() arms the sweep timer
    await settle();
    expect(peekCalls).toBe(1);
    const timersBeforeStop = timers.length; // just the sweep timer

    driver.stop?.();

    // Release the blocked peek with a FUTURE earliest ts — WITHOUT the guard, runPass's end-of-pass
    // `setTimer(earliestFutureTs, wake)` would re-arm the loop here.
    releasePeek({ due: [], earliestFutureTs: ctx.now() + 100_000 });
    await settle();

    // No new timer armed after stop(), and no second pass kicked off.
    expect(timers.length - timersBeforeStop).toBe(0);
    expect(peekCalls).toBe(1);
  });

  it("stop() while a lease-reclaim sweep is in flight does not re-arm the sweep timer", async () => {
    let releaseReclaim: () => void = () => {};
    const blockedReclaim = new Promise<unknown>((r) => {
      releaseReclaim = () => r({});
    });
    let reclaimCalls = 0;
    const { ctx, timers } = makeFakeCtx(async (path) => {
      if (path === "scheduler:_peekDue") return { due: [], earliestFutureTs: null };
      if (path === "scheduler:_reclaim") {
        reclaimCalls++;
        return blockedReclaim;
      }
      return {};
    });

    const driver = schedulerDriver();
    driver.start(ctx); // initial pass completes (no due, no future ts); arms the sweep timer
    await settle();

    // Fire the sweep timer's callback to start an in-flight sweepOnce().
    const sweepTimer = timers.find((t) => t.atMs === ctx.now() + SWEEP_MS && !t.cleared);
    expect(sweepTimer).toBeDefined();
    sweepTimer!.cb(); // sweepOnce() -> awaits _reclaim (blocks)
    await settle();
    expect(reclaimCalls).toBe(1);
    const timersBeforeStop = timers.length;

    driver.stop?.();

    // Release the blocked reclaim — WITHOUT the guard, sweepOnce()'s `finally -> armSweep()` re-arms.
    releaseReclaim();
    await settle();

    // No new live timer armed after stop().
    const newLiveTimers = timers.slice(timersBeforeStop).filter((t) => !t.cleared);
    expect(newLiveTimers.length).toBe(0);
  });
});
