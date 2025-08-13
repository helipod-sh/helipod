import type { Driver, DriverContext } from "@stackbase/component";
import type { JSONValue } from "@stackbase/values";
import type { ClaimResult, JobResult, PeekDueResult } from "./modules";
import { SWEEP_MS } from "./modules";

/**
 * A `schedulerDriver()` also exposes:
 *  - `__tick`: a deterministic test seam for one loop iteration (no real timers).
 *  - `__wake`: the same fire-and-forget signal `DriverContext.onCommit`/timers use internally,
 *    exposed so a test can simulate a commit notification landing at a precise moment (e.g. from
 *    inside a job's own mutation body, to interleave with an in-flight `__tick()`) — the reactive
 *    `onCommit` path itself can't be driven precisely from a test, since it fires off the real
 *    commit fan-out on whatever schedule the runtime gives it.
 *  - `__sweep`: runs the lease-reclaim sweep (`scheduler:_reclaim`) exactly once, without arming
 *    (or waiting on) the real `SWEEP_MS`-interval timer — the deterministic test seam for Task 4's
 *    infra-kill reclaim path.
 */
export interface SchedulerDriver extends Driver {
  __tick: () => Promise<void>;
  __wake: () => void;
  __sweep: () => Promise<void>;
}

/**
 * `@stackbase/scheduler`'s driver — the event-driven loop that actually RUNS due jobs.
 *
 * Two wake sources, NO fixed-interval polling:
 *  - **Reactive**: taps the runtime's commit fan-out (`DriverContext.onCommit`) and re-runs
 *    `iterate()` whenever a commit touches any `scheduler/*` table (an `enqueue`/`cancel`/
 *    `complete` write) — so a freshly-enqueued due job gets picked up with ~0 latency.
 *  - **Timer**: re-arms a single wall-clock timer to `earliestFutureTs` (the soonest still-pending
 *    job) after every iteration, so a job scheduled for later still fires once its time arrives
 *    without anything scanning `jobs` in between.
 *
 * Single-owner: an in-process `running` flag collapses overlapping wake-ups (two commits, or a
 * commit racing a timer) into a single iteration at a time. Because `running` is set
 * synchronously — before the first `await` — two `iterate()` calls issued back-to-back in the
 * same synchronous turn can never both proceed; the second observes `running === true` and
 * returns immediately. That said, the in-process flag is only a throughput optimization, NOT the
 * correctness guarantee: the AUTHORITATIVE double-run guard is `scheduler:_claim`'s snapshot-read
 * + exact `state === "pending"` check (`./modules.ts`), serialized by the single-writer OCC
 * transactor — even if two iterations somehow ran concurrently (e.g. two runtimes sharing a
 * store), at most one `_claim` call per job ever observes `"pending"`.
 *
 * A wake that arrives while `running` is already true is NOT dropped: it sets a coalesced
 * `pendingWake` bit that the in-flight iteration checks at the end of every pass, looping for one
 * more fresh peek/claim/complete pass instead of exiting. Without this, a commit that lands
 * mid-iteration (an app mutation enqueuing a due-now job between the loop's awaits) would be
 * silently swallowed — the timer re-arm at the end of the pass would use the `earliestFutureTs`
 * that pass captured, which doesn't account for the new job, and the job would sit `pending`
 * until some unrelated future wake.
 *
 * A job that throws while running is caught per-job (not allowed to escape the loop), so one bad
 * job can't wedge the whole batch or leave `running` stuck `true` — `_complete` is always called
 * (with a `failed` result) and the outer `try/finally` always clears `running`.
 *
 * `iterate()` always returns a promise that settles when the due set it's responsible for has
 * actually been drained — including a coalesced call. A caller that arrives while a pass is
 * already in flight (setting `pendingWake` per above) gets back the SAME promise as the in-flight
 * pass, not an already-resolved one: with the reactive `onCommit` wake now real (not dead code —
 * see `packages/runtime-embedded/src/runtime.ts`), a test's `__tick()` frequently races an
 * app-mutation's own commit, which fires `wake()` before `__tick()` gets a turn. If `__tick()`
 * merely no-op'd on a coalesced call, tests would observe results before the real work finished.
 * `wake()`'s callers (reactive `onCommit`/timer) never await this return value, so they're
 * unaffected — this only changes behavior for synchronous callers like `__tick()`.
 */
export function schedulerDriver(): SchedulerDriver {
  let ctx: DriverContext;
  let running = false;
  let pendingWake = false;
  let timer: number | null = null;
  let inFlight: Promise<void> | null = null;
  // The ONLY periodic timer in this driver — everything else (dispatch) is reactive. Backstops
  // infra kills: a process that `_claim`ed a job and died before `_complete`ing it leaves the job
  // `inProgress` forever without this sweep. Kept on its own handle (separate from `timer`, the
  // due-job wake timer) so re-arming one never clobbers the other.
  let sweepTimer: number | null = null;
  // Set by `stop()` BEFORE it tears down the timers/subscription. Guards against the driver
  // resurrecting itself: an in-flight pass's end-of-pass `setTimer` (`runPass`), a settling
  // `sweepOnce`'s `finally → armSweep`, and `iterate`'s `finally → wake` all run unconditionally
  // when work that was already in flight settles — even if `stop()` raced in while a
  // `runFunction` was awaiting. Without this flag they re-arm a fresh timer after `stop()`
  // already returned, and the loop keeps running forever. Checked at every re-entry/re-arm point
  // (`wake`, `iterate`, `runPass`'s re-arm, `armSweep`) so a timer/commit callback that fires
  // concurrently with `stop()` can't start or re-schedule work either. (Mirrors the same guard in
  // `@stackbase/storage`'s reaper driver.)
  let stopped = false;

  function wake(): void {
    if (stopped) return;
    // Fire-and-forget from a sync callback (onCommit/setTimer); swallow+log rather than let an
    // unexpected internal error (a bug in _peekDue/_claim/_complete, not a job's own throw —
    // those are caught per-job below) surface as an unhandled rejection. If an iteration is
    // already in flight, `iterate()`'s own guard below coalesces this into `pendingWake` instead
    // of no-oping outright — see its comment.
    iterate().catch((e: unknown) => {
      console.error("[scheduler] driver iteration failed:", e);
    });
  }

  function iterate(): Promise<void> {
    if (stopped) return Promise.resolve();
    if (running) {
      // A commit (or another wake) landed while a pass is already in flight — e.g. an app
      // mutation enqueuing a due-now job between the in-flight pass's awaits. That pass may
      // already have read a due set that doesn't include the new job, and its end-of-pass timer
      // re-arm would otherwise use a stale `earliestFutureTs`, silently stranding the new job
      // until some unrelated future wake. Coalesce into a bit the in-flight call checks before
      // releasing `running`, so it loops for one more fresh pass instead of exiting — this call
      // itself doesn't start a new pass; it hands back the in-flight pass's own promise (see the
      // class doc above) so an awaiting caller still observes real completion.
      pendingWake = true;
      return inFlight ?? Promise.resolve();
    }
    running = true;
    const pass = runPass().finally(() => {
      running = false;
      inFlight = null;
      // Closes a residual micro-window: a wake can land between the do/while loop's final
      // `pendingWake` check (inside `runPass`, which already exited) and this `finally` running —
      // e.g. another microtask's `wake()` call resolving in between. Without this, that wake would
      // set `pendingWake` but nothing would ever consume it (the pass that would have looped on it
      // already returned), stranding whatever it was signaling until some unrelated future wake.
      if (pendingWake) void wake();
    });
    inFlight = pass;
    return pass;
  }

  async function runPass(): Promise<void> {
    // Loop passes until a pass completes with no wake pending — a wake that arrives mid-pass
    // (an app mutation enqueuing a due-now job between our awaits) sets `pendingWake`, and we
    // re-run the peek/claim/complete cycle instead of exiting with a stale due set.
    let earliestFutureTs: number | null = null;
    do {
      pendingWake = false;
      const peeked = (await ctx.runFunction("scheduler:_peekDue", {})) as PeekDueResult;
      earliestFutureTs = peeked.earliestFutureTs;
      for (const job of peeked.due) {
        const claimed = (await ctx.runFunction("scheduler:_claim", { jobId: job._id })) as ClaimResult | null;
        if (claimed === null) continue; // lost the claim race → another caller got there first, skip

        // Mutations and actions dispatch through the identical path: `ctx.runFunction` routes to
        // the runtime, which routes to the executor's action branch for a `kind:"action"` fnPath
        // (CLAUDE.md build-order #5's action runtime — see @stackbase/executor) — the driver
        // itself doesn't need to know which kind it claimed. At-most-once for actions is NOT this
        // try/catch's job: it's already guaranteed by `_claim` committing `state:"inProgress"`
        // BEFORE this call runs, so a crash mid-action leaves the job for `_reclaim`'s lease sweep
        // to dead-letter (`modules.ts`'s `_reclaim`) rather than ever re-dispatching it here.
        let result: JobResult;
        try {
          const value = await ctx.runFunction(claimed.fnPath, claimed.args);
          result = { kind: "success", value };
        } catch (e) {
          result = { kind: "failed", error: String(e) };
        }
        // `result.value` (an action/mutation's arbitrary return) is `unknown`, not provably a
        // `JSONValue` — it's already been through the same JSON syscall round-trip as any other
        // UDF return, so this cast just bridges the gap TS can't see across.
        await ctx.runFunction("scheduler:_complete", { jobId: job._id, result } as unknown as JSONValue);
      }
    } while (pendingWake);

    // Re-arm the timer to the LAST pass's fresh earliest future job (clearing any stale one
    // first), so a wake that changed the due set still leaves the timer pointed at the right
    // instant.
    if (timer !== null) {
      ctx.clearTimer(timer);
      timer = null;
    }
    // Guard against re-arming after `stop()` raced in while this pass was awaiting a `runFunction`.
    if (!stopped && earliestFutureTs != null) timer = ctx.setTimer(earliestFutureTs, wake);
  }

  // Runs `scheduler:_reclaim` once, then re-arms itself `SWEEP_MS` out — the recurring safety
  // sweep. Errors are swallowed+logged (mirroring `wake()`): a bug in `_reclaim` itself must never
  // stop the sweep from re-arming, or the whole infra-kill backstop silently dies.
  async function sweepOnce(): Promise<void> {
    try {
      await ctx.runFunction("scheduler:_reclaim", {});
    } catch (e) {
      console.error("[scheduler] lease-reclaim sweep failed:", e);
    } finally {
      armSweep();
    }
  }

  function armSweep(): void {
    // A settling `sweepOnce()` calls this from its `finally` even if `stop()` raced in mid-sweep.
    if (stopped) return;
    if (sweepTimer !== null) {
      ctx.clearTimer(sweepTimer);
      sweepTimer = null;
    }
    sweepTimer = ctx.setTimer(ctx.now() + SWEEP_MS, () => {
      void sweepOnce();
    });
  }

  let unsubscribeCommit: (() => void) | null = null;

  return {
    name: "scheduler",
    start(c) {
      ctx = c;
      unsubscribeCommit = c.onCommit((inv) => {
        if (inv.tables.some((t) => t.startsWith("scheduler/"))) wake();
      });
      wake();
      armSweep();
    },
    stop() {
      // Set BEFORE teardown so any in-flight pass/sweep that settles after this returns sees
      // `stopped` already true and its re-arm (`runPass`'s `setTimer`, `sweepOnce`'s `armSweep`,
      // `iterate`'s `finally → wake`) no-ops instead of resurrecting the driver.
      stopped = true;
      unsubscribeCommit?.();
      unsubscribeCommit = null;
      if (timer !== null) {
        ctx.clearTimer(timer);
        timer = null;
      }
      if (sweepTimer !== null) {
        ctx.clearTimer(sweepTimer);
        sweepTimer = null;
      }
    },
    // Test seam: drives a loop pass and awaits its actual completion (coalescing into an
    // already-in-flight pass — e.g. one a same-turn reactive `onCommit` wake already started —
    // rather than resolving early), and lets errors propagate to the caller (unlike `wake()`,
    // used by the reactive/timer paths, which swallows+logs), so tests see real failures instead
    // of them being silently logged.
    __tick: () => iterate(),
    // Test seam: the same fire-and-forget signal `onCommit`/timers send internally — see the
    // interface doc above.
    __wake: () => wake(),
    // Test seam: runs the lease-reclaim sweep exactly once, without the real `SWEEP_MS` wait and
    // without re-arming a live timer (unlike `armSweep`/`sweepOnce` above) — errors propagate
    // (unlike the internal `sweepOnce`) so a test sees real `_reclaim` failures.
    __sweep: () => ctx.runFunction("scheduler:_reclaim", {}).then(() => undefined),
  };
}
