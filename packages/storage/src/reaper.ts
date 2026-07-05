import type { Driver, DriverContext } from "@helipod/component";
import type { BlobStore } from "@helipod/blobstore";
import { STORAGE_TABLE } from "./system-table";

/** Default sweep interval: 60s — see `storageReaper`'s doc comment. */
const DEFAULT_SWEEP_MS = 60_000;

/**
 * `storageReaper()` also exposes a test seam: `__tick` runs one sweep pass and awaits its actual
 * completion (no `sweepMs` wait, no real timer needed) — mirrors `SchedulerDriver.__tick` in
 * `components/scheduler/src/driver.ts`.
 */
export interface StorageReaperDriver extends Driver {
  __tick: () => Promise<void>;
}

/**
 * `@helipod/storage`'s orphan-reaper `Driver` — a periodic sweep that closes the two windows
 * `./context.ts`'s facade doc comments call out as the reaper's job:
 *  - An abandoned/never-finalized upload: `generateUploadUrl` inserts a `pending` `_storage` row
 *    with an `expiresAt`, but if the client never calls `_finalize` (dropped upload, direct-path
 *    upload gone stale), the row — and, for a direct-upload target, its underlying blob — would
 *    otherwise sit forever.
 *  - `ctx.storage.delete` is a transactional tombstone only (it can't do blob byte I/O inside the
 *    transactor); the physical blob is left for this driver to reclaim by key.
 *
 * Mirrors `components/scheduler/src/driver.ts`'s single-timer shape: one wall-clock timer, armed
 * for `sweepMs` (default 60s) out at the end of every pass. Deliberately simpler than the
 * scheduler driver — there is no due-job dispatch, no lease/claim race to guard, and the sweep
 * itself is naturally idempotent (a row already reaped, or not yet expired, is simply skipped by
 * `_storage:_reapExpired`), so this driver skips the scheduler driver's `running`/`pendingWake`
 * coalescing: two overlapping passes cost a little redundant work, never incorrect results.
 *
 * `onCommit` is NOT required for correctness — the periodic timer alone eventually reaps anything
 * expired — but taps the runtime's commit fan-out to run a pass immediately whenever a commit
 * touches `_storage`, rather than waiting up to `sweepMs` for the next scheduled pass. This is
 * what lets a short-TTL pending row (or a batch of them created back-to-back) get swept close to
 * its expiry instead of on the next multiple-of-`sweepMs` boundary.
 */
export function storageReaper(blobStore: BlobStore, opts?: { sweepMs?: number }): StorageReaperDriver {
  const sweepMs = opts?.sweepMs ?? DEFAULT_SWEEP_MS;
  let ctx: DriverContext;
  let timer: number | null = null;
  let unsubscribeCommit: (() => void) | null = null;
  // Set by `stop()` BEFORE it tears down the timer/subscription. Guards against the driver
  // resurrecting itself: `wake()`'s `.finally(() => armTimer())` runs unconditionally when an
  // in-flight tick settles, even if `stop()` raced in while `runFunction`/`blobStore.delete` was
  // still awaiting — without this flag, that `.finally` would arm a brand-new timer after
  // `stop()` already returned. Checked at every re-entry point (`wake`, `tick`, `armTimer`) so a
  // timer/commit callback that fires concurrently with `stop()` can't start a fresh sweep either.
  let stopped = false;

  async function tick(): Promise<void> {
    if (stopped) return;
    const { keys } = (await ctx.runFunction("_storage:_reapExpired", { now: ctx.now() })) as { keys: string[] };
    for (const key of keys) {
      try {
        await blobStore.delete(key);
      } catch (e) {
        // Best-effort: a physical blob delete failing (transient store error, already-gone blob,
        // etc.) must not stop the sweep from reclaiming the other keys' blobs, and must not throw
        // out of a fire-and-forget timer/commit callback.
        console.error(`[storage] reaper: failed to delete blob for key "${key}":`, e);
      }
    }
  }

  function armTimer(): void {
    if (stopped) return;
    if (timer !== null) {
      ctx.clearTimer(timer);
      timer = null;
    }
    // `backstopMs` (not `sweepMs` raw): this sweep is a pure backstop poll, never next-work — the
    // call site is how a driver declares that, so a host where every wake costs a cold start can
    // stretch it. Reaping stays correct at any cadence (`onCommit` still runs a pass immediately on
    // an `_storage` write; the sweep only bounds how long an ORPHANED row's bytes linger).
    timer = ctx.setTimer(ctx.now() + ctx.backstopMs(sweepMs), wake);
  }

  // The timer/onCommit entry point: fire-and-forget, since both callback shapes are `() => void`
  // — swallow+log rather than let a bug in `_reapExpired`/blob-delete surface as an unhandled
  // rejection (mirroring scheduler's `wake()`/`sweepOnce()`). Always re-arms the timer afterward,
  // success or failure, so one bad pass doesn't silently kill the whole reaper.
  function wake(): void {
    if (stopped) return;
    tick()
      .catch((e: unknown) => {
        console.error("[storage] reaper: sweep pass failed:", e);
      })
      .finally(() => {
        armTimer();
      });
  }

  return {
    name: "storage-reaper",
    start(c) {
      ctx = c;
      unsubscribeCommit = c.onCommit((inv) => {
        if (inv.tables.includes(STORAGE_TABLE)) wake();
      });
      wake();
    },
    stop() {
      // Set BEFORE tearing anything down: an in-flight tick's `runFunction`/`blobStore.delete`
      // may still be awaiting past this point, and when it settles, `wake()`'s `.finally` must
      // see `stopped` already true so `armTimer()` no-ops instead of resurrecting the driver.
      stopped = true;
      unsubscribeCommit?.();
      unsubscribeCommit = null;
      if (timer !== null) {
        ctx.clearTimer(timer);
        timer = null;
      }
    },
    // Test seam: runs one sweep pass and awaits its real completion, letting errors propagate
    // (unlike `wake()`, used by the timer/commit paths, which swallows+logs) — see the interface
    // doc above.
    __tick: () => tick(),
  };
}
