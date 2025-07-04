import { defineComponent, type ComponentDefinition } from "@stackbase/component";
import { schedulerSchema } from "./schema";
import { schedulerContext } from "./facade";

export * from "./schema";
export type { SchedulerContext, FunctionReference, FnRef, EnqueueOpts, JobState, SignalKind } from "./facade";

/**
 * `defineScheduler()` — the `@stackbase/scheduler` component: the `jobs`/`job_args`/`crons`/
 * `signals` schema plus the `ctx.scheduler` facade (`runAfter`/`runAt`/`cancel`/`enqueue`).
 *
 * `contextWrite: true` is load-bearing: it's what lets the facade write (via the calling
 * mutation's own transaction) instead of only reading — see `schedulerContext` in `./facade.ts`
 * and the `ContextProvider.write` opt-in on `@stackbase/executor`.
 *
 * No `modules` this slice (the component has no registered functions of its own yet) and no
 * `driver` (the recurring loop that actually RUNS due jobs is Task 3) — jobs enqueued here just
 * sit `pending` until a driver picks them up.
 */
export function defineScheduler(): ComponentDefinition {
  return defineComponent({
    name: "scheduler",
    schema: schedulerSchema,
    modules: {},
    context: (cctx) => schedulerContext(cctx),
    contextType: { import: "@stackbase/scheduler", type: "SchedulerContext" },
    contextWrite: true,
  });
}
