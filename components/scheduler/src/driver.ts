import type { Driver, DriverContext } from "@stackbase/component";
import type { JSONValue } from "@stackbase/values";
import type { ClaimResult, JobResult, PeekDueResult } from "./modules";

/** A `schedulerDriver()` also exposes `__tick`, a deterministic test seam for one loop iteration (no real timers). */
export interface SchedulerDriver extends Driver {
  __tick: () => Promise<void>;
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
 * A job that throws while running is caught per-job (not allowed to escape the loop), so one bad
 * job can't wedge the whole batch or leave `running` stuck `true` — `_complete` is always called
 * (with a `failed` result) and the outer `try/finally` always clears `running`.
 */
export function schedulerDriver(): SchedulerDriver {
  let ctx: DriverContext;
  let running = false;
  let timer: number | null = null;

  function wake(): void {
    // Fire-and-forget from a sync callback (onCommit/setTimer); swallow+log rather than let an
    // unexpected internal error (a bug in _peekDue/_claim/_complete, not a job's own throw —
    // those are caught per-job below) surface as an unhandled rejection.
    iterate().catch((e: unknown) => {
      console.error("[scheduler] driver iteration failed:", e);
    });
  }

  async function iterate(): Promise<void> {
    if (running) return; // single-owner in-process guard — see class doc above
    running = true;
    try {
      const { due, earliestFutureTs } = (await ctx.runFunction("scheduler:_peekDue", {})) as PeekDueResult;
      for (const job of due) {
        const claimed = (await ctx.runFunction("scheduler:_claim", { jobId: job._id })) as ClaimResult | null;
        if (claimed === null) continue; // lost the claim race → another caller got there first, skip

        let result: JobResult;
        if (claimed.kind === "action") {
          // Actions run outside a transaction with native capabilities (CLAUDE.md build-order
          // #5, not built yet) — fail cleanly instead of silently running an action as a mutation.
          result = { kind: "failed", error: "unsupported: action runtime not built" };
        } else {
          try {
            const value = await ctx.runFunction(claimed.fnPath, claimed.args);
            result = { kind: "success", value };
          } catch (e) {
            result = { kind: "failed", error: String(e) };
          }
        }
        // `result.value` (an action/mutation's arbitrary return) is `unknown`, not provably a
        // `JSONValue` — it's already been through the same JSON syscall round-trip as any other
        // UDF return, so this cast just bridges the gap TS can't see across.
        await ctx.runFunction("scheduler:_complete", { jobId: job._id, result } as unknown as JSONValue);
      }

      // Re-arm the timer to the earliest future job every pass (clearing any stale one first),
      // so a wake that changed the due set still leaves the timer pointed at the right instant.
      if (timer !== null) {
        ctx.clearTimer(timer);
        timer = null;
      }
      if (earliestFutureTs != null) timer = ctx.setTimer(earliestFutureTs, wake);
    } finally {
      running = false;
    }
  }

  return {
    name: "scheduler",
    start(c) {
      ctx = c;
      c.onCommit((inv) => {
        if (inv.tables.some((t) => t.startsWith("scheduler/"))) wake();
      });
      wake();
    },
    // Test seam: drives exactly one loop iteration synchronously and lets errors propagate to
    // the caller (unlike `wake()`, used by the reactive/timer paths, which swallows+logs), so
    // tests see real failures instead of them being silently logged.
    __tick: () => iterate(),
  };
}
