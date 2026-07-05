// components/scheduler/test/dispatch.test.ts
import { describe, it, expect } from "vitest";
import { action, mutation } from "@helipod/executor";
import { jsonToConvex } from "@helipod/values";
import { _claim, type ClaimResult } from "../src/modules";
import { makeRuntimeWithScheduler, readTable } from "./helpers";

describe("schedulerDriver — event-driven dispatch", () => {
  it("a due mutation runs on the next tick; a future one does not until the clock advances", async () => {
    let clock = 1_000_000;
    const ran: string[] = [];
    const { runtime, tick } = await makeRuntimeWithScheduler(
      {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        "app:sched": mutation(async (ctx: any) => {
          await ctx.scheduler.runAfter(0, "app:work", { tag: "now" });
          await ctx.scheduler.runAfter(5000, "app:work", { tag: "later" });
          return null;
        }),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        "app:work": mutation(async (_ctx: any, a: { tag: string }) => {
          ran.push(a.tag);
          return null;
        }),
      },
      { now: () => clock },
    );

    await runtime.run("app:sched", {});
    await tick(); // drive one loop iteration at clock=1_000_000
    expect(ran).toEqual(["now"]); // due-now ran; "later" did not

    clock += 5000;
    await tick();
    expect(ran.sort()).toEqual(["later", "now"]); // "later" ran once the clock reached its nextTs

    const jobs = await readTable(runtime, "scheduler/jobs");
    expect(jobs).toHaveLength(2);
    expect(jobs.every((j) => j.state === "success")).toBe(true);
    expect(jobs.every((j) => j.leaseHolder === undefined)).toBe(true);
    expect(jobs.every((j) => typeof j.completedTs === "number")).toBe(true);
  });

  it("claims are single-run: two concurrent ticks never double-run a job", async () => {
    const clock = 2_000_000;
    let runs = 0;
    const { runtime, tick } = await makeRuntimeWithScheduler(
      {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        "app:sched": mutation(async (ctx: any) => {
          await ctx.scheduler.runAfter(0, "app:work", {});
          return null;
        }),
        "app:work": mutation(async () => {
          runs++;
          return null;
        }),
      },
      { now: () => clock },
    );

    await runtime.run("app:sched", {});

    // Fire two ticks back-to-back without awaiting the first — `iterate()`'s in-process `running`
    // guard is set synchronously (before any `await`), so the second call, issued in the same
    // synchronous turn, observes `running === true` and no-ops. `_claim`'s snapshot-read +
    // exact-match check (components/scheduler/src/modules.ts) is what makes this correct even if
    // that in-process collapsing weren't there.
    const p1 = tick();
    const p2 = tick();
    await Promise.all([p1, p2]);

    expect(runs).toBe(1);
    const jobs = await readTable(runtime, "scheduler/jobs");
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ state: "success" });
  });

  it("a mid-iteration enqueue is not stranded: the coalesced wake picks it up in the SAME tick", async () => {
    // Regression test for the lost-wake race: `app:first`'s own mutation body enqueues
    // `app:second` (due now) WHILE the driver is still inside its single `iterate()` pass (between
    // the awaits of the `peekDue → claim → run → complete` loop), then fires the driver's
    // `__wake()` test seam — the same fire-and-forget signal `DriverContext.onCommit` sends
    // internally on a real commit — to simulate that commit notification landing at exactly that
    // moment. (Driving this via a real `onCommit` round-trip isn't viable as a deterministic unit
    // test: the reactive commit fan-out fires on the runtime's own schedule, not a moment the test
    // controls, so `__wake()` is the seam that pins it precisely mid-iteration.) Before the fix,
    // `wake()` while `running===true` was a pure no-op, and the pass's end-of-iteration timer
    // re-arm reused the `earliestFutureTs` captured before the enqueue — either way `app:second`
    // would sit `pending` until some unrelated wake. With the coalesced `pendingWake` bit, the
    // SAME `tick()` call must pick it up and run it too.
    const clock = 4_000_000;
    const ran: string[] = [];
    let wake: (() => void) | undefined;
    const { runtime, tick, wake: driverWake } = await makeRuntimeWithScheduler(
      {
        "app:sched": mutation(async (ctx: any) => { // eslint-disable-line @typescript-eslint/no-explicit-any
          await ctx.scheduler.runAfter(0, "app:first", {});
          return null;
        }),
        "app:first": mutation(async (ctx: any) => { // eslint-disable-line @typescript-eslint/no-explicit-any
          ran.push("first");
          // Enqueued WHILE the driver's single iterate() pass is still in flight (we're inside
          // the `await ctx.runFunction(claimed.fnPath, ...)` call for `app:first` itself).
          await ctx.scheduler.runAfter(0, "app:second", {});
          // Simulate the commit notification for the enqueue above landing right now, mid-pass.
          wake?.();
          return null;
        }),
        "app:second": mutation(async () => {
          ran.push("second");
          return null;
        }),
      },
      { now: () => clock },
    );
    wake = driverWake;

    await runtime.run("app:sched", {});
    await tick(); // exactly ONE driver iteration — no second manual tick

    expect(ran).toEqual(["first", "second"]);
    const jobs = await readTable(runtime, "scheduler/jobs");
    expect(jobs).toHaveLength(2);
    expect(jobs.every((j) => j.state === "success")).toBe(true);
  });

  it("a kind:'action' job dispatches and runs (the driver's action guard was removed)", async () => {
    // Actions now execute (CLAUDE.md build-order #5's action runtime — see @helipod/executor's
    // action branch, Task 1 of the action-runtime slice), so the driver no longer special-cases
    // `kind:"action"` jobs into an automatic "unsupported" failure — it dispatches them through
    // the SAME `runFunction(claimed.fnPath, claimed.args)` path a mutation job uses. There's no
    // public API yet to schedule a `kind:"action"` job directly (`ctx.scheduler`'s `kindOf()` still
    // stubs every job to `kind:"mutation"` — a separate, later-slice registry-lookup gap), so this
    // crafts one via the `_system:insertJob` escape hatch, exactly as the guard-proving version of
    // this test did.
    const clock = 3_000_000;
    let ran = false;
    const { runtime, tick } = await makeRuntimeWithScheduler(
      {
        "app:work": action(async () => {
          ran = true;
          return null;
        }),
      },
      { now: () => clock },
    );

    const insertResult = await runtime.runSystem<string>("_system:insertJob", {
      fnPath: "app:work",
      kind: "action",
      nextTs: clock,
      args: {},
    });
    const jobId = insertResult.value;

    await tick();

    expect(ran).toBe(true); // dispatched — actions are runnable now
    const jobs = await readTable(runtime, "scheduler/jobs");
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({
      _id: jobId,
      state: "success",
    });
  });

  it("REACTIVE WAKE (no manual tick): an enqueued due-now job runs on its own via the commit fan-out", async () => {
    // This is the proving test for the headline feature: the driver's `onCommit` subscription
    // (wired in `packages/runtime-embedded/src/runtime.ts`) must wake the driver on a REAL commit
    // from `runtime.run()` — no `tick()`/`__tick()` anywhere in this test. Every other test in this
    // file drives the driver manually via the `__tick()` test seam, which masks a bug where the
    // fan-out delivered encoded storage-table ids (e.g. "3") instead of full table names (e.g.
    // "scheduler/jobs") to `onCommit`, so `driver.ts`'s `inv.tables.some(t =>
    // t.startsWith("scheduler/"))` filter never matched in production — the reactive wake was dead
    // code, and only the timer path (or a test's manual `tick()`) ever ran jobs.
    const clock = 7_000_000;
    const ran: string[] = [];
    const { runtime } = await makeRuntimeWithScheduler(
      {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        "app:sched": mutation(async (ctx: any) => {
          await ctx.scheduler.runAfter(0, "app:work", { tag: "reactive" });
          return null;
        }),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        "app:work": mutation(async (_ctx: any, a: { tag: string }) => {
          ran.push(a.tag);
          return null;
        }),
      },
      { now: () => clock },
    );

    await runtime.run("app:sched", {});
    // NO tick()/__tick() call here — the enqueue's commit must itself wake the driver.

    const deadline = Date.now() + 2000;
    while (ran.length === 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 20));
    }

    expect(ran).toEqual(["reactive"]);
    const jobs = await readTable(runtime, "scheduler/jobs");
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ state: "success" });
  });

  it("scheduler:_claim is the authoritative guard: a second claim on the same job sees state!=='pending'", async () => {
    // The "two concurrent ticks" test above only proves the in-process `running` flag collapses
    // overlapping driver iterations — it never exercises `_claim` itself with two claims actually
    // reaching it. This test calls `scheduler:_claim` directly, twice, the same way the driver
    // does (`DriverContext.runFunction` is a privileged, fully-qualified-table-name call — see
    // `driver.ts`'s and `modules.ts`'s doc comments — mirrored here via the runtime's own
    // `executor.run(fn, ..., { privileged: true })`), to prove the OCC-backed snapshot-read +
    // exact `state === "pending"` check is what actually prevents double-dispatch, independent of
    // the loop flag.
    const clock = 6_000_000;
    const { runtime } = await makeRuntimeWithScheduler({}, { now: () => clock });

    const insertResult = await runtime.runSystem<string>("_system:insertJob", {
      fnPath: "app:work",
      kind: "mutation",
      nextTs: clock,
      args: {},
    });
    const jobId = insertResult.value;

    const claim = () =>
      runtime.executor.run<ClaimResult | null>(_claim, jsonToConvex({ jobId }), {
        path: "scheduler:_claim",
        privileged: true,
      });

    const first = await claim();
    const second = await claim();

    expect(first.value).not.toBeNull();
    expect(first.value?.jobId).toBe(jobId);
    expect(second.value).toBeNull(); // lost the race: sees state !== "pending", not the OCC layer

    const jobs = await readTable(runtime, "scheduler/jobs");
    expect(jobs).toHaveLength(1); // claimed exactly once — no duplicate/second row
    expect(jobs[0]).toMatchObject({ _id: jobId, state: "inProgress" });
  });
});
