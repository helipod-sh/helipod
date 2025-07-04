// components/scheduler/test/enqueue.test.ts
import { describe, it, expect } from "vitest";
import { SqliteDocStore, NodeSqliteAdapter } from "@stackbase/docstore-sqlite";
import { composeComponents } from "@stackbase/component";
import { EmbeddedRuntime } from "@stackbase/runtime-embedded";
import { defineSchema } from "@stackbase/values";
import { query, mutation, type RegisteredFunction } from "@stackbase/executor";
import { defineScheduler } from "../src/index";

// Privileged raw-table scan — reads a fully-qualified table name (e.g. "scheduler/jobs")
// bypassing the namespace boundary, so the test can assert on the component's own tables.
function systemModules(): Record<string, RegisteredFunction> {
  return {
    "_system:scan": query(async (ctx, args: { table: string }) => await ctx.db.query(args.table, "by_creation").collect()),
  };
}

async function makeRuntimeWithScheduler(appModules: Record<string, RegisteredFunction>) {
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
  });
  return { runtime };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function readTable(runtime: EmbeddedRuntime, table: string): Promise<any[]> {
  const r = await runtime.runSystem<unknown[]>("_system:scan", { table });
  return r.value as any[]; // eslint-disable-line @typescript-eslint/no-explicit-any
}

describe("ctx.scheduler — transactional enqueue", () => {
  it("runAfter writes a pending job row inside the calling mutation's transaction", async () => {
    const { runtime } = await makeRuntimeWithScheduler({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      "app:sched": mutation(async (ctx: any) => {
        await ctx.scheduler.runAfter(60_000, "app:work", { x: 1 });
        return null;
      }),
      "app:work": mutation(async () => null),
    });

    await runtime.run("app:sched", {});

    const jobs = await readTable(runtime, "scheduler/jobs");
    expect(jobs.length).toBe(1);
    expect(jobs[0]).toMatchObject({ fnPath: "app:work", state: "pending", kind: "mutation" });
    expect(jobs[0].nextTs).toBeGreaterThan(0);

    const args = await readTable(runtime, "scheduler/job_args");
    expect(args.length).toBe(1);
    expect(args[0]).toMatchObject({ jobId: jobs[0]._id, args: { x: 1 } });

    const signals = await readTable(runtime, "scheduler/signals");
    expect(signals.length).toBe(1);
    expect(signals[0]).toMatchObject({ kind: "enqueue", jobId: jobs[0]._id });
  });

  it("enqueue is transactional — a mutation that throws after scheduling leaves NO job", async () => {
    const { runtime } = await makeRuntimeWithScheduler({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      "app:boom": mutation(async (ctx: any) => {
        await ctx.scheduler.runAfter(1000, "app:work", {});
        throw new Error("rollback");
      }),
      "app:work": mutation(async () => null),
    });

    await expect(runtime.run("app:boom", {})).rejects.toThrow();

    expect((await readTable(runtime, "scheduler/jobs")).length).toBe(0);
    expect((await readTable(runtime, "scheduler/job_args")).length).toBe(0);
    expect((await readTable(runtime, "scheduler/signals")).length).toBe(0);
  });

  it("cancel marks a pending job canceled", async () => {
    let scheduledId = "";
    const { runtime } = await makeRuntimeWithScheduler({
      "app:sched": mutation(async (ctx: any) => { // eslint-disable-line @typescript-eslint/no-explicit-any
        scheduledId = await ctx.scheduler.runAfter(60_000, "app:work", {});
        return scheduledId;
      }),
      "app:cancel": mutation(async (ctx: any, { id }: { id: string }) => { // eslint-disable-line @typescript-eslint/no-explicit-any
        await ctx.scheduler.cancel(id);
        return null;
      }),
      "app:work": mutation(async () => null),
    });

    const res = await runtime.run<string>("app:sched", {});
    const id = res.value;
    expect(id).toBe(scheduledId);

    await runtime.run("app:cancel", { id });

    const jobs = await readTable(runtime, "scheduler/jobs");
    expect(jobs.length).toBe(1);
    expect(jobs[0]).toMatchObject({ state: "canceled" });
    expect(jobs[0].completedTs).toBeGreaterThan(0);

    const signals = await readTable(runtime, "scheduler/signals");
    expect(signals.map((s) => s.kind)).toEqual(["enqueue", "cancel"]);
  });
});
