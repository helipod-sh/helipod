// components/scheduler/test/helpers.ts
import { SqliteDocStore, NodeSqliteAdapter } from "@stackbase/docstore-sqlite";
import { composeComponents } from "@stackbase/component";
import { EmbeddedRuntime } from "@stackbase/runtime-embedded";
import { defineSchema } from "@stackbase/values";
import { query, mutation, type RegisteredFunction } from "@stackbase/executor";
import type { JSONValue, Value } from "@stackbase/values";
import { defineScheduler, type SchedulerDriver, type CronJobs } from "../src/index";

// Privileged raw-table scan — reads a fully-qualified table name (e.g. "scheduler/jobs")
// bypassing the namespace boundary, so tests can assert on the component's own tables.
function systemModules(): Record<string, RegisteredFunction> {
  return {
    "_system:scan": query(async (ctx, args: { table: string }) => await ctx.db.query(args.table, "by_creation").collect()),
    // Test-only escape hatch: insert a `jobs`/`job_args` row directly (bypassing
    // `ctx.scheduler`'s facade, whose `kindOf()` always creates `kind:"mutation"` jobs — there's
    // no public API yet to schedule a `kind:"action"` job), so dispatch.test.ts can exercise the
    // driver's action-kind guard without needing a real action runtime. Extended for Task 4's
    // reliability tests: `state`/`leaseExpiresAt`/`attempts`/`maxFailures`/`parentId` let a test
    // craft an `inProgress`-with-expired-lease row (lease reclaim) or an explicit parent/child
    // pair (cascading cancel) without threading a real ambient `currentJobId` — see the Task 4
    // design note in `../src/facade.ts` for why that ambient isn't wired.
    "_system:insertJob": mutation(
      async (
        ctx,
        args: {
          fnPath: string;
          kind: "mutation" | "action";
          nextTs: number;
          args: JSONValue;
          state?: "pending" | "inProgress" | "success" | "failed" | "canceled";
          leaseExpiresAt?: number;
          attempts?: number;
          maxFailures?: number;
          parentId?: string;
        },
      ) => {
        const jobId = await ctx.db.insert("scheduler/jobs", {
          fnPath: args.fnPath,
          kind: args.kind,
          state: args.state ?? "pending",
          nextTs: args.nextTs,
          attempts: args.attempts ?? 0,
          maxFailures: args.maxFailures ?? 4,
          hasArgs: true,
          ...(args.leaseExpiresAt !== undefined ? { leaseHolder: "driver", leaseExpiresAt: args.leaseExpiresAt } : {}),
          ...(args.parentId !== undefined ? { parentId: args.parentId } : {}),
        });
        await ctx.db.insert("scheduler/job_args", { jobId, args: args.args as Value });
        return jobId;
      },
    ),
    // Test-only escape hatch, added for the duplicate-cadence-chain crash tests: forces an
    // EXISTING job's `state`/lease directly (bypassing `_claim`/`_complete`) — used to simulate
    // "the driver claimed this job and the process died before completing it" (an `inProgress`
    // job with an expired lease) without needing a real crash.
    "_system:forceJobState": mutation(
      async (
        ctx,
        args: {
          jobId: string;
          state: "pending" | "inProgress" | "success" | "failed" | "canceled";
          leaseExpiresAt?: number;
        },
      ) => {
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
    // Test-only escape hatch: overwrites an existing job's `job_args.args` payload — used to craft
    // a stale duplicate cadence job whose args embed a specific (self-referential) `jobId`, which
    // `_system:insertJob` can't do directly (the job's id isn't known until after it's inserted).
    "_system:setJobArgs": mutation(async (ctx, args: { jobId: string; args: JSONValue }) => {
      const rows = await ctx.db.query("scheduler/job_args", "by_job").eq("jobId", args.jobId).take(1).collect();
      const row = rows[0];
      if (row !== undefined) await ctx.db.replace(row._id as string, { ...row, args: args.args });
      return null;
    }),
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
 *
 * `opts.store` — normally omitted (a fresh in-memory `SqliteDocStore` per call). Pass an existing
 * one to simulate a process RESTART: call this twice with the SAME `store` (and the SAME `crons`
 * registry, so `reconcileCrons`'s spec-diff sees no change), stopping the first runtime's drivers
 * in between (`await runtime.stopDrivers()`) — the second call re-runs `composeComponents` +
 * boot (`reconcileCrons`) against the already-populated store, exactly like a real restart. Used
 * by the duplicate-cadence-chain crash tests (`crons.test.ts`). Mirrors the existing pattern in
 * `packages/runtime-embedded/test/runtime-restart.test.ts`.
 */
export async function makeRuntimeWithScheduler(
  appModules: Record<string, RegisteredFunction>,
  opts?: { now?: () => number; crons?: CronJobs; store?: SqliteDocStore },
): Promise<{ runtime: EmbeddedRuntime; tick: () => Promise<void>; wake: () => void; sweep: () => Promise<void> }> {
  const schema = defineSchema({});
  const c = composeComponents({ schemaJson: schema.export(), moduleMap: appModules }, [defineScheduler({ crons: opts?.crons })]);
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
  return { runtime, tick: () => driver.__tick(), wake: () => driver.__wake(), sweep: () => driver.__sweep() };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function readTable(runtime: EmbeddedRuntime, table: string): Promise<any[]> {
  const r = await runtime.runSystem<unknown[]>("_system:scan", { table });
  return r.value as any[]; // eslint-disable-line @typescript-eslint/no-explicit-any
}
