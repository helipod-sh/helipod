import { defineComponent, type ComponentDefinition } from "@stackbase/component";
import { schedulerSchema } from "./schema";
import { schedulerContext } from "./facade";
import { _peekDue, _claim, _complete } from "./modules";
import { schedulerDriver } from "./driver";

export * from "./schema";
export type { SchedulerContext, FunctionReference, FnRef, EnqueueOpts, JobState, SignalKind } from "./facade";
export type { PeekDueResult, ClaimResult, JobResult, DueJob } from "./modules";
export { BATCH_CAP, LEASE_MS } from "./modules";
export type { SchedulerDriver } from "./driver";
export { schedulerDriver } from "./driver";

/**
 * `defineScheduler()` — the `@stackbase/scheduler` component: the `jobs`/`job_args`/`crons`/
 * `signals` schema, the `ctx.scheduler` facade (`runAfter`/`runAt`/`cancel`/`enqueue`), the
 * internal `_peekDue`/`_claim`/`_complete` modules (Task 3), and the `schedulerDriver` event-loop
 * that actually RUNS due jobs — reactive on commits touching `scheduler/*` plus a wall-clock timer
 * re-armed to the earliest future job (see `./driver.ts`).
 *
 * `contextWrite: true` is load-bearing: it's what lets the facade write (via the calling
 * mutation's own transaction) instead of only reading — see `schedulerContext` in `./facade.ts`
 * and the `ContextProvider.write` opt-in on `@stackbase/executor`.
 */
export function defineScheduler(): ComponentDefinition {
  return defineComponent({
    name: "scheduler",
    schema: schedulerSchema,
    modules: { _peekDue, _claim, _complete },
    context: (cctx) => schedulerContext(cctx),
    contextType: { import: "@stackbase/scheduler", type: "SchedulerContext" },
    contextWrite: true,
    driver: schedulerDriver(),
  });
}
