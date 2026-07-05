import type { BuiltRuntime } from "./compose";

/** Fully-qualified name of `@helipod/scheduler`'s jobs table, as it lands in the composed
 * catalog (namespaced `scheduler/*`) — see `components/scheduler/src/schema.ts`. Privileged scans
 * (below) address it directly, mirroring `components/scheduler/test/helpers.ts`'s `_system:scan`. */
const SCHEDULER_JOBS_TABLE = "scheduler/jobs";

/** `jobs.state` values that still represent outstanding work — see `components/scheduler/src/
 * schema.ts`'s `state` union. `"inProgress"` should never actually be observed here in practice:
 * by the time `driver.__tick()`'s promise resolves, every claimed job has already been completed
 * (terminal `success`/`failed`, or back to `pending` for a retry) — see `../../../components/
 * scheduler/src/driver.ts`'s `runPass`. It's included anyway as a defensive belt-and-suspenders
 * check, not load-bearing for correctness. */
const OUTSTANDING_STATES = new Set(["pending", "inProgress"]);

/** How far the virtual clock jumps each iteration of `finishScheduledFunctions`'s loop — large
 * enough to clear any realistic `runAfter`/`runAt`/cron delay in a handful of iterations. */
const STEP_MS = 3_600_000; // 1 hour

/** Bound on `finishScheduledFunctions`'s loop — a recurring cron (or a runAfter chain that keeps
 * rescheduling itself forever) would otherwise spin this forever; this is the safety valve. */
const MAX_ITERATIONS = 100;

/**
 * Privileged raw scan of `@helipod/scheduler`'s `jobs` table, reusing the SAME `_test:_run`
 * plumbing `t.run()` is built on (see `./compose.ts`) rather than registering a bespoke system
 * module — `_test:_run` already runs with a full, privileged (namespace-bypassing) db-writer
 * `ctx`, so a plain `ctx.db.query(fullyQualifiedName, "by_creation").collect()` resolves the
 * component-internal table directly, exactly like `components/scheduler/test/helpers.ts`'s
 * `_system:scan`.
 */
async function scanSchedulerJobs(built: BuiltRuntime): Promise<Array<{ state?: unknown }>> {
  built.setRunFn(async (ctx: any) => await ctx.db.query(SCHEDULER_JOBS_TABLE, "by_creation").collect());
  try {
    await built.runtime.runSystem("_test:_run", {});
    return (built.takeRunResult() as Array<{ state?: unknown }>) ?? [];
  } finally {
    built.setRunFn(null);
  }
}

async function hasOutstandingJobs(built: BuiltRuntime): Promise<boolean> {
  const rows = await scanSchedulerJobs(built);
  return rows.some((row) => OUTSTANDING_STATES.has(String(row.state)));
}

/**
 * Drives every currently- and eventually-due scheduled job (`ctx.scheduler.runAfter`/`runAt`,
 * including cascades — a job that itself schedules another) to completion, without real timers:
 * repeatedly advances the harness's virtual clock by `STEP_MS` and awaits one `driver.__tick()`
 * (which — see `components/scheduler/src/driver.ts`'s reactive `pendingWake` coalescing — already
 * fully drains everything due AT the clock's current value, including 0-delay cascades, before its
 * promise resolves), stopping as soon as a scan of the scheduler's `jobs` table shows nothing left
 * in `"pending"`/`"inProgress"`.
 *
 * A clean no-op if `@helipod/scheduler` wasn't composed (no `defineScheduler()` in
 * `opts.components`) — there's nothing to drive.
 *
 * Bounded at `MAX_ITERATIONS` — a recurring cron (or a chain that keeps rescheduling itself
 * indefinitely) can never fully settle, so an unbounded loop here would hang forever instead of
 * failing loudly; this throws a clear error instead.
 */
export async function finishScheduledFunctions(built: BuiltRuntime): Promise<void> {
  const driver = built.getSchedulerDriver();
  if (!driver) return; // no scheduler composed — nothing scheduled, nothing to drive.

  for (let i = 0; i < MAX_ITERATIONS; i++) {
    if (!(await hasOutstandingJobs(built))) return;
    built.advanceClock(STEP_MS);
    await driver.__tick();
  }
  if (!(await hasOutstandingJobs(built))) return;
  throw new Error(
    `finishScheduledFunctions: scheduled jobs did not settle after ${MAX_ITERATIONS} iterations ` +
      `(advancing the virtual clock by ${STEP_MS}ms each time) — check for a cron or a runAfter chain ` +
      "that keeps rescheduling itself forever.",
  );
}

/**
 * Advances the harness's virtual clock by `ms`, then drives one `driver.__tick()` pass if
 * `@helipod/scheduler` is composed (a no-op tick otherwise — there's no driver to drive).
 * Unlike `finishScheduledFunctions`, this does exactly one pass: it will NOT itself drain a job
 * scheduled further out than `ms`, mirroring a real fake-timer `advanceTimersByTime`.
 *
 * Always advances the clock (throwing via `advanceClock` if `opts.now` was supplied and the
 * harness doesn't own it), regardless of whether a scheduler is composed — advancing time is a
 * general harness primitive, not scheduler-specific.
 */
export async function advanceTimers(built: BuiltRuntime, ms: number): Promise<void> {
  built.advanceClock(ms);
  const driver = built.getSchedulerDriver();
  if (driver) await driver.__tick();
}
