// components/workflow/test/helpers.ts
import { SqliteDocStore, NodeSqliteAdapter } from "@stackbase/docstore-sqlite";
import { composeComponents } from "@stackbase/component";
import { EmbeddedRuntime } from "@stackbase/runtime-embedded";
import { defineSchema } from "@stackbase/values";
import { query, mutation, type RegisteredFunction } from "@stackbase/executor";
import { defineScheduler, type SchedulerDriver } from "@stackbase/scheduler";
import { defineWorkflow, type WorkflowRegistry } from "../src/index";

// Privileged raw-table scan — reads a fully-qualified table name (e.g. "workflow/workflows")
// bypassing the namespace boundary, so tests can assert on the component's own tables.
function systemModules(): Record<string, RegisteredFunction> {
  return {
    "_system:scan": query(async (ctx, args: { table: string }) => await ctx.db.query(args.table, "by_creation").collect()),
    // Test-only escape hatch (mirrors `components/scheduler/test/helpers.ts`'s identically-named
    // one): forces an EXISTING scheduler job's `state`/lease directly, bypassing `_claim`/
    // `_complete` — used to simulate "the driver claimed this job and the process died before
    // completing it" (an `inProgress` job with an expired lease) for the action-step at-most-once
    // crash test, without needing a real crash.
    "_system:forceJobState": mutation(
      async (ctx, args: { jobId: string; state: "pending" | "inProgress" | "success" | "failed" | "canceled"; leaseExpiresAt?: number }) => {
        const job = await ctx.db.get(args.jobId);
        if (job === null) return null;
        await ctx.db.replace(args.jobId, {
          ...job,
          state: args.state,
          ...(args.leaseExpiresAt !== undefined ? { leaseHolder: "driver", leaseExpiresAt: args.leaseExpiresAt } : {}),
        });
        return null;
      },
    ),
  };
}

/**
 * Composes an `EmbeddedRuntime` with BOTH `@stackbase/scheduler` (workflow's `requires:
 * ["scheduler"]`) and `@stackbase/workflow` enabled, plus the given app modules. Mirrors
 * `components/scheduler/test/helpers.ts`'s `makeRuntimeWithScheduler` — same store/tableNumbers/
 * bootSteps/drivers wiring — with the workflow component added on top and its own registry
 * (`workflows: Record<workflowFnPath, WorkflowDefinition>`) passed to `defineWorkflow`.
 *
 * `opts.now` injects a controllable virtual clock (flows through to both `ctx.scheduler`'s facade
 * and the driver's internal modules); the returned `tick()` drives exactly one deterministic
 * scheduler-driver loop iteration via its `__tick()` test seam — no real timers/sleeps needed in
 * assertions.
 */
export async function makeRuntimeWithWorkflow(
  appModules: Record<string, RegisteredFunction>,
  workflows: WorkflowRegistry,
  opts?: { now?: () => number; store?: SqliteDocStore; maxParallelism?: number },
): Promise<{
  runtime: EmbeddedRuntime;
  tick: () => Promise<void>;
  wake: () => void;
  sweep: () => Promise<void>;
  /**
   * The composed scheduler driver itself — exposed (beyond the `tick`/`wake`/`sweep` seams above)
   * so a test that needs to freeze the event-driven cascade mid-flight (e.g. to observe a step's
   * scheduler job while it's still genuinely `"pending"`, not yet auto-claimed by the reactive
   * `onCommit` wake) can call `driver.stop()` right after setup, then drive everything by hand via
   * `tick()` — with `onCommit` unsubscribed, each `tick()` call processes exactly the jobs due at
   * that moment (no nested wake-triggered cascade to a job created mid-pass), instead of the
   * default fully-reactive behavior where a single `tick()`/commit can cascade a whole multi-step
   * workflow to completion in one pass.
   */
  driver: SchedulerDriver;
}> {
  const schema = defineSchema({});
  const c = composeComponents(
    { schemaJson: schema.export(), moduleMap: appModules },
    [defineScheduler(), defineWorkflow({ workflows, maxParallelism: opts?.maxParallelism })],
  );
  const runtime = await EmbeddedRuntime.create({
    store: opts?.store ?? new SqliteDocStore(new NodeSqliteAdapter()),
    catalog: c.catalog,
    modules: c.moduleMap,
    systemModules: systemModules(),
    componentNames: c.componentNames,
    contextProviders: c.contextProviders,
    policyRegistry: c.policyRegistry,
    policyProviders: c.policyProviders,
    relationRegistry: c.relationRegistry,
    bootSteps: c.bootSteps,
    drivers: c.drivers,
    tableNumbers: c.tableNumbers,
    now: opts?.now,
  });
  const driver = c.drivers.find((d) => d.name === "scheduler") as SchedulerDriver | undefined;
  if (!driver) throw new Error("scheduler driver not wired — defineScheduler() must set `driver: schedulerDriver()`");
  return { runtime, tick: () => driver.__tick(), wake: () => driver.__wake(), sweep: () => driver.__sweep(), driver };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function readTable(runtime: EmbeddedRuntime, table: string): Promise<any[]> {
  const r = await runtime.runSystem<unknown[]>("_system:scan", { table });
  return r.value as any[]; // eslint-disable-line @typescript-eslint/no-explicit-any
}
