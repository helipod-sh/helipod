import { defineComponent, type ComponentDefinition, type BootContext } from "@stackbase/component";
import { schedulerSchema } from "./schema";
import { schedulerContext, schedulerActionContext } from "./facade";
import { _peekDue, _claim, _complete, _reclaim, _cronTick, _enqueue, _cancel } from "./modules";
import { schedulerDriver } from "./driver";
import { reconcileCrons, type CronJobs } from "./crons";

export * from "./schema";
export type { SchedulerContext, SchedulerActionContext, FunctionReference, FnRef, EnqueueOpts, JobState, EnqueueTables, OnCompleteResult } from "./facade";
export { getFunctionPath, enqueueInternal, fireOnComplete, schedulerActionContext } from "./facade";
export type { PeekDueResult, ClaimResult, JobResult, DueJob } from "./modules";
export { BATCH_CAP, LEASE_MS, SWEEP_MS, CATCHUP_CAP } from "./modules";
export type { SchedulerDriver } from "./driver";
export { schedulerDriver } from "./driver";
export type { BackoffOptions } from "./backoff";
export { computeBackoff, DEFAULT_BACKOFF_OPTIONS } from "./backoff";
export type {
  CronJobs,
  CronSpec,
  CronRegistryEntry,
  CatchUpPolicy,
  CronOpts,
  CronUtcOpts,
  IntervalPeriod,
  DailyAt,
  HourlyAt,
  WeeklyAt,
  MonthlyAt,
  DayOfWeek,
} from "./crons";
export { cronJobs, computeNextRun, computePrevRun, enqueueCadenceJob } from "./crons";

/**
 * `defineScheduler()` — the `@stackbase/scheduler` component: the `jobs`/`job_args`/`crons`
 * schema, the `ctx.scheduler` facade (`runAfter`/`runAt`/`cancel`/`enqueue`), the
 * internal `_peekDue`/`_claim`/`_complete`/`_cronTick` modules, and the `schedulerDriver`
 * event-loop that actually RUNS due jobs — reactive on commits touching `scheduler/*` plus a
 * wall-clock timer re-armed to the earliest future job (see `./driver.ts`).
 *
 * `contextWrite: true` is load-bearing: it's what lets the facade write (via the calling
 * mutation's own transaction) instead of only reading — see `schedulerContext` in `./facade.ts`
 * and the `ContextProvider.write` opt-in on `@stackbase/executor`.
 *
 * `opts.crons` — an app's `crons.ts` (`export default crons` from `cronJobs()` + `.interval()`/
 * `.cron()`/etc.) — is reconciled into the `crons` table once at boot (`reconcileCrons`, see its
 * doc comment in `./crons.ts` for why this is a config value rather than file-discovery magic).
 */
export function defineScheduler(opts?: { crons?: CronJobs }): ComponentDefinition {
  return defineComponent({
    name: "scheduler",
    schema: schedulerSchema,
    modules: { _peekDue, _claim, _complete, _reclaim, _cronTick, _enqueue, _cancel },
    context: (cctx) => schedulerContext(cctx),
    contextType: { import: "@stackbase/scheduler", type: "SchedulerContext" },
    serverExports: ["cronJobs"],
    contextWrite: true,
    driver: schedulerDriver(),
    boot: (ctx: BootContext) => reconcileCrons(ctx, opts?.crons),
    // Action-mode `ctx.scheduler` (Convex parity: portable between a mutation and an action) —
    // see `schedulerActionContext`'s doc comment in `./facade.ts`.
    buildAction: (api) => schedulerActionContext(api),
  });
}
