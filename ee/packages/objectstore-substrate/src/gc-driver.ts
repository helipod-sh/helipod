/* Stackbase Enterprise. Licensed under the Stackbase Commercial License — see ee/LICENSE. */
/**
 * The object-storage writer's periodic reclamation driver (Tier 3 Slice 7, Task 7.2) — a recurring
 * `Driver` (the same seam `@stackbase/scheduler`/`@stackbase/triggers`/`storageReaper`/
 * `receiptsReaper`/`leaseHeartbeatDriver` all run on) that calls `store.gc()` on a fixed cadence, so a
 * long-running writer's superseded segments/snapshots get reclaimed automatically instead of only on a
 * manual call.
 *
 * Mirrors `receiptsReaper`'s (`packages/receipts/src/reaper.ts`) single-timer shape — `start` arms the
 * first timer, `wake()` fires the tick fire-and-forget and unconditionally re-arms once it settles
 * (success or failure), `stop()` sets a `stopped` guard before clearing the timer.
 *
 * UNLIKE `leaseHeartbeatDriver` (`./heartbeat-driver.ts`), this driver has NO terminal/fence carve-out:
 * `gc()` is SELF-FENCING by construction (Task 7.1 — it re-reads the manifest and aborts as a harmless
 * no-op if this instance no longer owns the current epoch, or was never an owner at all), so a fenced
 * gc() call simply returns zero counts rather than throwing. Any error `gc()` DOES throw (a transient
 * object-store blip, or the `poisoned` guard's own throw) is therefore never a "must stop serving
 * writes now" signal the way a heartbeat's `FencedError` is — it's just "this sweep didn't complete,
 * try again next cadence." So this driver swallows EVERY error (log + re-arm) and never signals
 * shutdown, exactly `receiptsReaper`'s "one bad pass doesn't kill the reaper" policy with no exception
 * carved out.
 */
import type { Driver, DriverContext } from "@stackbase/component";

/** The minimal surface this driver needs from `ObjectStoreDocStore` — kept narrow (rather than
 *  importing the whole class as a type) so a test fake doesn't need to construct a real store, same
 *  spirit as `heartbeat-driver.ts`'s `HeartbeatableStore`. */
export interface GcableStore {
  gc(): Promise<{ deletedSegments: number; deletedSnapshots: number }>;
}

export interface GcDriverOpts {
  /** How often to run a gc() sweep. gc() is best-effort/idempotent and self-fencing, so there's no
   *  correctness ratio to enforce here (unlike the heartbeat driver's heartbeatMs < leaseTtlMs) — pick
   *  a cadence that trades reclamation latency against sweep cost (default ~60s, mirroring
   *  `storageReaper`'s cadence — see the caller's default). */
  sweepMs: number;
}

/** Test/introspection seam mirroring `ReceiptsReaperDriver`'s `__tick`: runs one gc() pass and awaits
 *  its real completion (propagating any error) rather than the timer path's swallow+log. */
export interface GcDriver extends Driver {
  __tick: () => Promise<{ deletedSegments: number; deletedSnapshots: number }>;
}

/**
 * Build the periodic gc-driver for `store` (Tier 3 Slice 7, Task 7.2). See the module doc above for
 * the full swallow-everything/no-fence-carve-out policy.
 */
export function gcDriver(store: GcableStore, opts: GcDriverOpts): GcDriver {
  const { sweepMs } = opts;
  let ctx: DriverContext;
  let timer: number | null = null;
  // Set by `stop()` BEFORE it tears down the timer — guards every re-entry point (`wake`, `tick`,
  // `armTimer`) against resurrecting a timer after `stop()`, mirroring `receiptsReaper`'s same guard.
  let stopped = false;

  async function tick(): Promise<{ deletedSegments: number; deletedSnapshots: number }> {
    if (stopped) return { deletedSegments: 0, deletedSnapshots: 0 };
    return store.gc();
  }

  function armTimer(): void {
    if (stopped) return;
    if (timer !== null) {
      ctx.clearTimer(timer);
      timer = null;
    }
    timer = ctx.setTimer(ctx.now() + sweepMs, wake);
  }

  // The timer entry point: fire-and-forget — swallow+log ANY error (gc() self-fences harmlessly; a
  // transient object-store error should just retry next sweep) rather than let it surface as an
  // unhandled rejection. Always re-arms afterward, success or failure, so one bad pass doesn't
  // silently kill the whole driver — never signals shutdown (contrast `leaseHeartbeatDriver`, which
  // owns fence→shutdown).
  function wake(): void {
    if (stopped) return;
    tick()
      .catch((e: unknown) => {
        console.error("[objectstore-substrate] gc-driver: sweep pass failed (will retry):", e);
      })
      .finally(() => {
        armTimer();
      });
  }

  return {
    name: "objectStoreGc",
    start(c) {
      ctx = c;
      // Arm-only (no up-front sweep): gc reclaims superseded state, not fresh work — there is nothing
      // urgent to reclaim the instant a node boots, so the first sweep can wait for the normal cadence
      // (mirrors `leaseHeartbeatDriver`'s arm-only `start`, not `receiptsReaper`'s immediate `wake()`).
      armTimer();
    },
    stop() {
      // Set BEFORE tearing anything down — see the `stopped` doc comment above.
      stopped = true;
      if (timer !== null) {
        ctx.clearTimer(timer);
        timer = null;
      }
    },
    // Test seam: runs one gc() pass and awaits its real completion, letting any error propagate
    // (unlike `wake()`, used by the timer path, which swallows+logs) — see the interface doc above.
    __tick: () => tick(),
  };
}
