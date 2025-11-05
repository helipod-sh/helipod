import type { Driver, DriverContext } from "@stackbase/component";
import type { DocStore } from "@stackbase/docstore";

/** Default sweep interval: 24h. Records live for 30 days (`DEFAULT_TTL_MS`), so a much-finer
 *  cadence than `storageReaper`'s 60s (which reclaims short-TTL pending uploads) buys nothing —
 *  a day of slack against a 30-day horizon is invisible. */
const DEFAULT_SWEEP_MS = 24 * 60 * 60 * 1000;

/** Default record retention: 30 days (verdict §(c) Retention). */
const DEFAULT_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * `receiptsReaper()` also exposes a test seam: `__tick` runs one sweep pass and awaits its actual
 * completion (no `sweepMs` wait, no real timer needed) — mirrors `StorageReaperDriver.__tick`
 * (`packages/storage/src/reaper.ts`) and `SchedulerDriver.__tick` (`components/scheduler/src/
 * driver.ts`).
 */
export interface ReceiptsReaperDriver extends Driver {
  __tick: () => Promise<{ deletedCount: number }>;
}

/**
 * The Receipted Outbox's TTL reaper (verdict §(c) Retention) — a periodic bulk sweep of
 * `client_mutations` rows older than `ttlMs`, via `DocStore.sweepExpiredClientMutations`. Mirrors
 * `storageReaper`'s single-timer shape (`packages/storage/src/reaper.ts`) but is DELIBERATELY
 * SIMPLER in two ways:
 *
 *  - No `onCommit` tap. `client_mutations`/`client_floors` are core internal tables (the
 *    `persistence_globals` category), never surfaced to the commit fan-out's `tables` list the way
 *    app-schema writes are — there is no commit signal to react to, so this driver is purely
 *    wall-clock timer driven.
 *  - No transactional `runFunction` dispatch. Receipts are not app-schema rows reachable through
 *    `ctx.db`/a registered mutation; the sweep is a direct bulk `DocStore` operation (deletes rows
 *    AND advances each affected client's floor in one store-level transaction — see
 *    `sweepExpiredClientMutations`'s doc comment), taking `store: DocStore` directly rather than a
 *    `BlobStore`-style byte backend. This is the "switchable delegate" the sweep itself is built
 *    on: `DocStore` is already the seam that picks SQLite vs Postgres, so this driver never knows
 *    or cares which backend it's running against.
 *
 * Sweeping is naturally idempotent (an already-swept row is simply absent from the next pass), so —
 * like `storageReaper` — this driver skips any running/pendingWake coalescing: two overlapping
 * passes cost a little redundant work, never incorrect results.
 */
export function receiptsReaper(store: DocStore, opts?: { sweepMs?: number; ttlMs?: number }): ReceiptsReaperDriver {
  const sweepMs = opts?.sweepMs ?? DEFAULT_SWEEP_MS;
  const ttlMs = opts?.ttlMs ?? DEFAULT_TTL_MS;
  let ctx: DriverContext;
  let timer: number | null = null;
  // Set by `stop()` BEFORE it tears down the timer. Guards against the driver resurrecting itself:
  // `wake()`'s `.finally(() => armTimer())` runs unconditionally when an in-flight tick settles,
  // even if `stop()` raced in while `sweepExpiredClientMutations` was still awaiting — without this
  // flag, that `.finally` would arm a brand-new timer after `stop()` already returned. Checked at
  // every re-entry point (`wake`, `tick`, `armTimer`), mirroring `storageReaper`'s same guard.
  let stopped = false;

  async function tick(): Promise<{ deletedCount: number }> {
    if (stopped) return { deletedCount: 0 };
    return store.sweepExpiredClientMutations(ctx.now() - ttlMs);
  }

  function armTimer(): void {
    if (stopped) return;
    if (timer !== null) {
      ctx.clearTimer(timer);
      timer = null;
    }
    timer = ctx.setTimer(ctx.now() + sweepMs, wake);
  }

  // The timer entry point: fire-and-forget — swallow+log rather than let a bug in
  // `sweepExpiredClientMutations` surface as an unhandled rejection (mirroring `storageReaper`'s
  // `wake()`). Always re-arms the timer afterward, success or failure, so one bad pass doesn't
  // silently kill the whole reaper.
  function wake(): void {
    if (stopped) return;
    tick()
      .catch((e: unknown) => {
        console.error("[receipts] reaper: sweep pass failed:", e);
      })
      .finally(() => {
        armTimer();
      });
  }

  return {
    name: "receipts-reaper",
    start(c) {
      ctx = c;
      wake();
    },
    stop() {
      // Set BEFORE tearing anything down — see the `stopped` doc comment above.
      stopped = true;
      if (timer !== null) {
        ctx.clearTimer(timer);
        timer = null;
      }
    },
    // Test seam: runs one sweep pass and awaits its real completion, letting errors propagate
    // (unlike `wake()`, used by the timer path, which swallows+logs) — see the interface doc above.
    __tick: () => tick(),
  };
}
