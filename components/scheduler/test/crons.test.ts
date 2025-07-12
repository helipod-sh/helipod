// components/scheduler/test/crons.test.ts
import { describe, it, expect } from "vitest";
import { mutation } from "@stackbase/executor";
import { anyApi } from "@stackbase/client";
import { SqliteDocStore, NodeSqliteAdapter } from "@stackbase/docstore-sqlite";
import { cronJobs, computeNextRun, CATCHUP_CAP } from "../src/index";
import { makeRuntimeWithScheduler, readTable } from "./helpers";

/**
 * A handful of ticks is cheap and deterministic (no real timers) — used after every clock advance
 * so a test doesn't depend on exactly how many `_peekDue`/`_claim`/`_complete` passes it takes to
 * drain a chain of same-instant-due jobs (a cadence tick that enqueues a work job due immediately,
 * or a downtime catch-up that enqueues several at once). `driver.ts`'s `pendingWake` coalescing
 * means a single `tick()` USUALLY drains all of it in one call, but that's an implementation
 * detail of exactly how/when the reactive `onCommit` signal lands relative to `iterate()`'s
 * do/while loop — not something these tests should depend on. Extra `tick()` calls beyond what's
 * needed are fast no-ops (an empty `_peekDue`).
 */
async function drain(tick: () => Promise<void>, times = 4): Promise<void> {
  for (let i = 0; i < times; i++) await tick();
}

describe("computeNextRun", () => {
  it("a cron expression with tz computes the right next run (cron-parser, IANA tz)", () => {
    const next = computeNextRun({ kind: "cron", expr: "0 3 * * *" }, "America/New_York", Date.parse("2026-07-02T12:00:00Z"));
    expect(new Date(next).toISOString()).toBe("2026-07-03T07:00:00.000Z"); // 3am EDT = 07:00 UTC
  });

  it("an interval spec is plain arithmetic: next = afterTs + ms", () => {
    expect(computeNextRun({ kind: "interval", ms: 10_000 }, "UTC", 1_000_000)).toBe(1_010_000);
  });

  it("repeated calls always advance, even when `afterTs` exactly matches the cron pattern", () => {
    const t0 = Date.parse("2026-07-03T07:00:00.000Z");
    const t1 = computeNextRun({ kind: "cron", expr: "0 3 * * *" }, "America/New_York", t0);
    expect(t1).toBeGreaterThan(t0);
    expect(new Date(t1).toISOString()).toBe("2026-07-04T07:00:00.000Z");
  });
});

describe("cronJobs() registry", () => {
  it("rejects a duplicate cron name", () => {
    const crons = cronJobs();
    crons.interval("beat", { seconds: 10 }, "app:beat", {});
    expect(() => crons.interval("beat", { seconds: 5 }, "app:other", {})).toThrow(/already registered/);
  });

  it("rejects a non-positive interval", () => {
    const crons = cronJobs();
    expect(() => crons.interval("noop", {}, "app:beat", {})).toThrow(/positive/);
  });
});

describe("the cron cadence — clock-anchored, dual-job, catch-up, dedup", () => {
  it("an interval cron fires at each period on the virtual clock, clock-anchored (a slow job doesn't drift)", async () => {
    let clock = 1_000_000;
    const fires: number[] = [];
    const crons = cronJobs();
    crons.interval("beat", { seconds: 10 }, "app:beat", {});

    const { tick, runtime } = await makeRuntimeWithScheduler(
      {
        "app:beat": mutation(async () => {
          fires.push(1);
          return null;
        }),
      },
      { now: () => clock, crons },
    );

    const t1 = 1_010_000;
    const t2 = 1_020_000;
    const t3 = 1_030_000;

    clock = t1; // on time
    await drain(tick);

    clock = t2 + 4_000; // 4s LATE — simulates a slow/delayed driver dispatch
    await drain(tick);

    clock = t3; // back on schedule
    await drain(tick);

    expect(fires).toHaveLength(3);

    const jobs = await readTable(runtime, "scheduler/jobs");
    const beatRunTimes = jobs
      .filter((j) => j.fnPath === "app:beat")
      .map((j) => j.nextTs as number)
      .sort((a, b) => a - b);
    // Anchored to the ORIGINAL schedule (t1, t2, t3) — not drifted to the 4s-late dispatch time
    // (which would have produced t2+4000 and a following t2+4000+10000).
    expect(beatRunTimes).toEqual([t1, t2, t3]);
  });

  it('catchUp:"skip" fires none of a downtime backlog; "fireOnce" fires exactly one; "fireAll" fires every missed occurrence', async () => {
    const boot = 2_000_000;
    const period = 10_000;
    // 5 whole periods elapse before the first tick — a clean downtime backlog (the extra 500ms
    // isn't enough to trigger a 6th occurrence, keeping the expected count exactly 5).
    const lateBy = period * 5 + 500;

    async function runScenario(catchUp: "skip" | "fireOnce" | "fireAll"): Promise<number> {
      let clock = boot;
      const crons = cronJobs();
      crons.interval("beat", { seconds: 10 }, "app:beat", {}, { catchUp });
      const { tick, runtime } = await makeRuntimeWithScheduler({ "app:beat": mutation(async () => null) }, { now: () => clock, crons });

      clock = boot + lateBy;
      await drain(tick, 8); // enough passes to drain a `fireAll` backlog of 5 work jobs

      const jobs = await readTable(runtime, "scheduler/jobs");
      return jobs.filter((j) => j.fnPath === "app:beat").length;
    }

    expect(await runScenario("skip")).toBe(0);
    expect(await runScenario("fireOnce")).toBe(1);
    expect(await runScenario("fireAll")).toBe(5);
  });

  it("idempotent enqueue collapses two same-idempotencyKey enqueues into one job — the exact mechanism _cronTick uses to dedupe an occurrence", async () => {
    // `_cronTick` (modules.ts) enqueues each occurrence's work job with
    // `idempotencyKey: "${cronName}:${fireTs}"` through the SAME `enqueueInternal` insert-or-noop
    // path exercised here via the public facade — so two cadence fires that ever computed the
    // same occurrence (`{cronName}:{scheduledTs}`) would collapse into one work job exactly like
    // this test's two `ctx.scheduler.enqueue` calls do.
    let clock = 3_000_000;
    const { runtime } = await makeRuntimeWithScheduler(
      {
        "app:sched": mutation(async (ctx: any) => { // eslint-disable-line @typescript-eslint/no-explicit-any
          return await ctx.scheduler.enqueue("app:work", {}, { runAt: clock, idempotencyKey: "cron-x:3010000" });
        }),
        "app:work": mutation(async () => null),
      },
      { now: () => clock },
    );

    const first = await runtime.run<string>("app:sched", {});
    const second = await runtime.run<string>("app:sched", {});

    expect(second.value).toBe(first.value); // same job id returned both times — insert-or-noop

    const jobs = await readTable(runtime, "scheduler/jobs");
    expect(jobs.filter((j) => j.fnPath === "app:work")).toHaveLength(1); // one job, not two
  });
});

describe("bounded catch-up — _cronTick never materializes an unbounded backlog", () => {
  it('catchUp:"skip" with a ~10-year-old anchor on a 1-second interval completes fast and enqueues zero work jobs', async () => {
    let clock = 1_000_000;
    const crons = cronJobs();
    crons.interval("fast", { seconds: 1 }, "app:fast", {}); // default catchUp: "skip"
    const { tick, runtime } = await makeRuntimeWithScheduler({ "app:fast": mutation(async () => null) }, { now: () => clock, crons });

    // ~315.4 million missed occurrences — the pre-fix implementation would step through (and, for
    // "skip", still allocate an array for) every single one of these synchronously inside one
    // mutation. The proof this test is bounded is that it finishes at all, quickly — not a step
    // count assertion (this suite has no visibility into `_cronTick`'s internals).
    const TEN_YEARS_MS = 10 * 365 * 24 * 60 * 60 * 1000;
    clock += TEN_YEARS_MS;

    const start = performance.now();
    await drain(tick, 4);
    const elapsedMs = performance.now() - start;
    expect(elapsedMs).toBeLessThan(3000); // a per-occurrence loop over ~315M entries would never finish this fast

    const jobs = await readTable(runtime, "scheduler/jobs");
    expect(jobs.filter((j) => j.fnPath === "app:fast")).toHaveLength(0); // "skip" discarded the whole backlog

    const liveCadence = jobs.find(
      (j) => j.fnPath === "scheduler:_cronTick" && (j.state === "pending" || j.state === "inProgress"),
    );
    expect(liveCadence).toBeDefined();
    expect(liveCadence!.nextTs as number).toBeGreaterThan(clock); // re-anchored into the future, not stuck in the past

    const cronRows = await readTable(runtime, "scheduler/crons");
    const cron = cronRows.find((r) => r.name === "fast")!;
    expect(cron.lastScheduledTs as number).toBeLessThanOrEqual(clock); // re-anchored to the real schedule, not left stale
  });

  it('catchUp:"fireAll" caps a backlog at exactly CATCHUP_CAP work jobs — a hard ceiling, not an unbounded materialization', async () => {
    let clock = 2_000_000;
    const period = 10_000;
    const crons = cronJobs();
    crons.interval("capped", { seconds: 10 }, "app:capped", {}, { catchUp: "fireAll" });
    const { tick, runtime } = await makeRuntimeWithScheduler({ "app:capped": mutation(async () => null) }, { now: () => clock, crons });

    // Comfortably more missed occurrences than CATCHUP_CAP.
    clock += period * (CATCHUP_CAP + 500);
    await drain(tick, 4);

    const jobs = await readTable(runtime, "scheduler/jobs");
    expect(jobs.filter((j) => j.fnPath === "app:capped")).toHaveLength(CATCHUP_CAP);
  });
});

describe("duplicate-cadence-chain fix — a crashed cadence job never spawns a second immortal chain", () => {
  it("a cadence job left inProgress with an expired lease is treated as LIVE across a restart — no second chain", async () => {
    const clock = { now: 5_000_000 };
    const crons = cronJobs();
    crons.interval("beat2", { seconds: 10 }, "app:beat2", {});
    const appModules = { "app:beat2": mutation(async () => null) };

    // Shared storage across two `EmbeddedRuntime` instances — simulates a process restart
    // (mirrors `packages/runtime-embedded/test/runtime-restart.test.ts`'s pattern).
    const store = new SqliteDocStore(new NodeSqliteAdapter());
    const rt1 = await makeRuntimeWithScheduler(appModules, { now: () => clock.now, crons, store });

    let cronRows = await readTable(rt1.runtime, "scheduler/crons");
    const originalCadenceJobId = cronRows.find((r) => r.name === "beat2")!.cadenceJobId as string;

    // Simulate the crash: the driver `_claim`ed the cadence job (state -> inProgress, leased),
    // then the process died before `_cronTick` ever ran (or before `_complete` ran) — force that
    // state directly, bypassing the normal claim path.
    await rt1.runtime.runSystem("_system:forceJobState", {
      jobId: originalCadenceJobId,
      state: "inProgress",
      leaseExpiresAt: clock.now - 1, // already expired, so a later sweep can reclaim it
    });
    await rt1.runtime.stopDrivers();

    // "Restart": a fresh EmbeddedRuntime over the SAME store re-runs `reconcileCrons` at boot.
    const rt2 = await makeRuntimeWithScheduler(appModules, { now: () => clock.now, crons, store });

    cronRows = await readTable(rt2.runtime, "scheduler/crons");
    const cronAfterBoot = cronRows.find((r) => r.name === "beat2")!;
    // `hasLiveCadence` must see the `inProgress` job as live — the pointer is untouched, no
    // second chain was created.
    expect(cronAfterBoot.cadenceJobId).toBe(originalCadenceJobId);

    let jobs = await readTable(rt2.runtime, "scheduler/jobs");
    let liveCadence = jobs.filter(
      (j) => j.fnPath === "scheduler:_cronTick" && (j.state === "pending" || j.state === "inProgress"),
    );
    expect(liveCadence).toHaveLength(1); // still just the one (orphaned) job — no duplicate

    // The lease-reclaim sweep + a tick lets the ORIGINAL chain continue.
    await rt2.sweep();
    await drain(rt2.tick);

    jobs = await readTable(rt2.runtime, "scheduler/jobs");
    liveCadence = jobs.filter((j) => j.fnPath === "scheduler:_cronTick" && (j.state === "pending" || j.state === "inProgress"));
    expect(liveCadence).toHaveLength(1); // exactly one chain continues — no duplication

    await rt2.runtime.stopDrivers();
  });

  it("self-terminate: two live cadence jobs for one cron — the stale one dies at its next tick without rescheduling", async () => {
    const clock = { now: 6_000_000 };
    const crons = cronJobs();
    crons.interval("beat3", { seconds: 10 }, "app:beat3", {});
    const { tick, runtime } = await makeRuntimeWithScheduler(
      { "app:beat3": mutation(async () => null) },
      { now: () => clock.now, crons },
    );

    const cronRowsBoot = await readTable(runtime, "scheduler/crons");
    const cronBoot = cronRowsBoot.find((r) => r.name === "beat3")!;
    const canonicalId = cronBoot.cadenceJobId as string; // the real chain from boot

    const jobsBoot = await readTable(runtime, "scheduler/jobs");
    const canonicalJob = jobsBoot.find((j) => j._id === canonicalId)!;
    const dueAt = canonicalJob.nextTs as number;

    // Craft a SECOND, stale cadence job for the same cron — due at the same instant, carrying a
    // correct self-referential `jobId` in its args (so it WOULD normally proceed), except the
    // cron row doesn't point at it — simulating a duplicate chain that slipped through some other
    // way despite the `hasLiveCadence` fix.
    const staleIdResult = await runtime.runSystem<string>("_system:insertJob", {
      fnPath: "scheduler:_cronTick",
      kind: "mutation",
      nextTs: dueAt,
      args: { cronName: "beat3" },
    });
    const staleId = staleIdResult.value as string;
    await runtime.runSystem("_system:setJobArgs", { jobId: staleId, args: { cronName: "beat3", jobId: staleId } });

    clock.now = dueAt; // both the canonical and stale cadence jobs are due now
    await drain(tick, 6);

    const jobs = await readTable(runtime, "scheduler/jobs");
    const liveCadence = jobs.filter((j) => j.fnPath === "scheduler:_cronTick" && (j.state === "pending" || j.state === "inProgress"));
    expect(liveCadence).toHaveLength(1); // exactly one chain survives

    const staleAfter = jobs.find((j) => j._id === staleId)!;
    expect(staleAfter.state).toBe("success"); // self-terminated cleanly (returned null), not stuck/failed

    const cronRowsAfter = await readTable(runtime, "scheduler/crons");
    const cronAfter = cronRowsAfter.find((r) => r.name === "beat3")!;
    expect(liveCadence[0]!._id).toBe(cronAfter.cadenceJobId); // the surviving chain is the canonical one
  });
});

describe("Convex parity", () => {
  it("a verbatim Convex-style crons.ts (cronJobs() + internal.* refs) registers and fires unchanged", async () => {
    let clock = 4_000_000;
    // Mimics the generated `internal` proxy: `@stackbase/client`'s `anyApi`, the same untyped
    // path-building proxy codegen's `_generated/server` re-exports as `internal` (cast to the
    // generated `Internal` type at the import site) — `internal.maintenance.purge` resolves to
    // the path "maintenance:purge" exactly the way a real generated project's would.
    const internal = anyApi as {
      maintenance: { purge: { __path: string } };
      reports: { build: { __path: string } };
      email: { digest: { __path: string } };
    };

    // Verbatim shape from the design spec §5.2
    // (docs/superpowers/specs/2026-07-02-scheduler-component-design.md):
    //   import { cronJobs } from "./_generated/server";
    //   const crons = cronJobs();
    //   crons.interval("cleanup", { minutes: 5 }, internal.maintenance.purge, {});
    //   crons.cron("nightly", "0 3 * * *", internal.reports.build, {}, { tz: "America/New_York" });
    //   crons.daily("digest", { hourUTC: 8, minuteUTC: 0 }, internal.email.digest, {});
    //   export default crons;
    const crons = cronJobs();
    crons.interval("cleanup", { minutes: 5 }, internal.maintenance.purge, {});
    crons.cron("nightly", "0 3 * * *", internal.reports.build, {}, { tz: "America/New_York" });
    crons.daily("digest", { hourUTC: 8, minuteUTC: 0 }, internal.email.digest, {});

    let purged = 0;
    const { tick, runtime } = await makeRuntimeWithScheduler(
      {
        "maintenance:purge": mutation(async () => {
          purged++;
          return null;
        }),
        "reports:build": mutation(async () => null),
        "email:digest": mutation(async () => null),
      },
      { now: () => clock, crons },
    );

    // Fire the 5-minute interval cron once.
    clock += 5 * 60_000;
    await drain(tick);
    expect(purged).toBe(1);

    // The other two registered correctly too (spec/tz round-trip through the `crons` table).
    const cronRows = await readTable(runtime, "scheduler/crons");
    const byName = new Map(cronRows.map((r) => [r.name as string, r]));
    const nightly = byName.get("nightly");
    const digest = byName.get("digest");
    expect(nightly).toMatchObject({ tz: "America/New_York", workFnPath: "reports:build" });
    expect(JSON.parse(nightly!.spec as string)).toEqual({ kind: "cron", expr: "0 3 * * *" });
    expect(digest).toMatchObject({ tz: "UTC", workFnPath: "email:digest" });
    expect(JSON.parse(digest!.spec as string)).toEqual({ kind: "cron", expr: "0 8 * * *" });
  });
});
