// components/scheduler/test/helpers.ts
import { SqliteDocStore, NodeSqliteAdapter } from "@stackbase/docstore-sqlite";
import { composeComponents } from "@stackbase/component";
import { EmbeddedRuntime } from "@stackbase/runtime-embedded";
import { defineSchema } from "@stackbase/values";
import { query, mutation, type RegisteredFunction } from "@stackbase/executor";
import type { JSONValue, Value } from "@stackbase/values";
import { defineScheduler, type SchedulerDriver } from "../src/index";

// Privileged raw-table scan — reads a fully-qualified table name (e.g. "scheduler/jobs")
// bypassing the namespace boundary, so tests can assert on the component's own tables.
function systemModules(): Record<string, RegisteredFunction> {
  return {
    "_system:scan": query(async (ctx, args: { table: string }) => await ctx.db.query(args.table, "by_creation").collect()),
    // Test-only escape hatch: insert a `jobs`/`job_args` row directly (bypassing
    // `ctx.scheduler`'s facade, whose `kindOf()` always creates `kind:"mutation"` jobs — there's
    // no public API yet to schedule a `kind:"action"` job), so dispatch.test.ts can exercise the
    // driver's action-kind guard without needing a real action runtime.
    "_system:insertJob": mutation(
      async (ctx, args: { fnPath: string; kind: "mutation" | "action"; nextTs: number; args: JSONValue }) => {
        const jobId = await ctx.db.insert("scheduler/jobs", {
          fnPath: args.fnPath,
          kind: args.kind,
          state: "pending",
          nextTs: args.nextTs,
          attempts: 0,
          maxFailures: 4,
          hasArgs: true,
        });
        await ctx.db.insert("scheduler/job_args", { jobId, args: args.args as Value });
        return jobId;
      },
    ),
  };
}

/**
 * Composes an `EmbeddedRuntime` with `@stackbase/scheduler` enabled. `opts.now` injects a
 * controllable virtual clock (flows through to both `ctx.scheduler`'s facade and the driver's
 * internal `_peekDue`/`_claim`/`_complete` modules — see `executor.ts`'s `this.deps.now`), and the
 * returned `tick()` drives exactly one deterministic loop iteration via the scheduler driver's
 * `__tick()` test seam — no real timers/sleeps needed in assertions. `wake()` is the driver's
 * `__wake()` test seam — the same fire-and-forget signal the reactive commit/timer paths send
 * internally, for simulating one arriving at a precise moment (e.g. mid-`tick()`).
 */
export async function makeRuntimeWithScheduler(
  appModules: Record<string, RegisteredFunction>,
  opts?: { now?: () => number },
): Promise<{ runtime: EmbeddedRuntime; tick: () => Promise<void>; wake: () => void }> {
  const schema = defineSchema({});
  const c = composeComponents({ schemaJson: schema.export(), moduleMap: appModules }, [defineScheduler()]);
  const runtime = await EmbeddedRuntime.create({
    store: new SqliteDocStore(new NodeSqliteAdapter()),
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
  return { runtime, tick: () => driver.__tick(), wake: () => driver.__wake() };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function readTable(runtime: EmbeddedRuntime, table: string): Promise<any[]> {
  const r = await runtime.runSystem<unknown[]>("_system:scan", { table });
  return r.value as any[]; // eslint-disable-line @typescript-eslint/no-explicit-any
}
