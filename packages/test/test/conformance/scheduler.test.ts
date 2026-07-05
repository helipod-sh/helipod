import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createTestHelipod, type TestHelipod } from "../../src";
import { defineScheduler, cronJobs } from "@helipod/scheduler";
import { mutation, query, action } from "@helipod/executor";
import { defineSchema, defineTable, v } from "@helipod/values";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type A = any;

const schema = defineSchema({
  runs: defineTable({ at: v.string() }),
});

const mod = {
  // The scheduled target. MUST return `null` explicitly (not fall through to `undefined`) — the
  // driver round-trips a completed job's return value through `scheduler:_complete`'s JSON args,
  // and the wire codec (`convexToJson`) throws on a bare `undefined`.
  tick: mutation(async (ctx: A) => {
    await ctx.db.insert("runs", { at: "tick" });
    return null;
  }),
  schedule: mutation(async (ctx: A) => ctx.scheduler.runAfter(1000, "mod:tick", {})),
  cancelIt: mutation(async (ctx: A, args: { id: string }) => {
    await ctx.scheduler.cancel(args.id);
    return null;
  }),
  count: query(async (ctx: A) => (await ctx.db.query("runs", "by_creation").collect()).length),
};

describe("conformance — scheduler", () => {
  let t: TestHelipod;

  beforeEach(async () => {
    t = await createTestHelipod({
      modules: { "mod.ts": mod, "schema.ts": { default: schema } },
      components: [defineScheduler()],
    });
  });

  afterEach(async () => {
    await t.close();
  });

  it("runAfter runs the target exactly once (at-most-once) after finishScheduledFunctions", async () => {
    await t.mutation("mod:schedule", {});
    expect(await t.query("mod:count", {})).toBe(0);

    await t.finishScheduledFunctions();
    expect(await t.query("mod:count", {})).toBe(1);

    // Draining again must NOT re-deliver the already-completed job.
    await t.finishScheduledFunctions();
    expect(await t.query("mod:count", {})).toBe(1);
  });

  it("a canceled job does not run", async () => {
    const id = await t.mutation<string>("mod:schedule", {});
    await t.mutation("mod:cancelIt", { id });

    await t.finishScheduledFunctions();
    expect(await t.query("mod:count", {})).toBe(0);
  });

  it("advanceTimers only dispatches once the delay has actually elapsed", async () => {
    await t.mutation("mod:schedule", {});

    // 500ms < the 1000ms delay — not yet due.
    await t.advanceTimers(500);
    expect(await t.query("mod:count", {})).toBe(0);

    // Cumulative 1100ms >= 1000ms — now due.
    await t.advanceTimers(600);
    expect(await t.query("mod:count", {})).toBe(1);
  });
});

async function waitFor(pred: () => boolean, ms = 1000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > ms) throw new Error("timeout waiting for predicate");
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe("conformance — scheduler: runAt, actions, retries, onComplete/context, cascade, idempotency, reactivity, crons, isolation", () => {
  describe("runAt — absolute-time scheduling", () => {
    const runAtMod = {
      tick: mutation(async (ctx: A) => {
        await ctx.db.insert("runs", { at: "tick" });
        return null;
      }),
      scheduleAt: mutation(async (ctx: A, args: { ts: number }) => ctx.scheduler.runAt(args.ts, "mod:tick", {})),
      count: query(async (ctx: A) => (await ctx.db.query("runs", "by_creation").collect()).length),
      // Exposes the engine's own current virtual time — the harness's clock is a FIXED internal
      // epoch (not real `Date.now()`; see `packages/test/src/compose.ts`'s `clockMs` seed), so a
      // test must read it back rather than assume it lines up with wall-clock time.
      currentTs: query(async (ctx: A) => ctx.now()),
    };

    let t: TestHelipod;
    beforeEach(async () => {
      t = await createTestHelipod({
        modules: { "mod.ts": runAtMod, "schema.ts": { default: schema } },
        components: [defineScheduler()],
      });
    });
    afterEach(async () => {
      await t.close();
    });

    it("runAt(timestamp) does not run before the absolute time, and runs after the clock passes it", async () => {
      // The harness's virtual clock is a fixed internal epoch, not real wall-clock time — read it
      // back via `ctx.now()` rather than assuming it's anywhere near `Date.now()`. Schedule far
      // enough out (2 hours) that a single small `advanceTimers` step doesn't accidentally clear it.
      const baseline = await t.query<number>("mod:currentTs", {});
      const targetTs = baseline + 2 * 60 * 60 * 1000;
      await t.mutation("mod:scheduleAt", { ts: targetTs });

      // Not yet due — advancing by 1 hour is still short of the 2-hour target.
      await t.advanceTimers(60 * 60 * 1000);
      expect(await t.query("mod:count", {})).toBe(0);

      // Now past the target.
      await t.advanceTimers(90 * 60 * 1000);
      expect(await t.query("mod:count", {})).toBe(1);
    });
  });

  describe("scheduling an action", () => {
    const actionMod = {
      // action target: no ctx.db, but can still write via ctx.runMutation.
      recordViaAction: action(async (ctx: A, args: { tag: string }) => {
        await ctx.runMutation("mod:insertRun", { at: args.tag });
        return null;
      }),
      insertRun: mutation(async (ctx: A, args: { at: string }) => {
        await ctx.db.insert("runs", { at: args.at });
        return null;
      }),
      scheduleAction: mutation(async (ctx: A) => ctx.scheduler.runAfter(0, "mod:recordViaAction", { tag: "from-scheduled-action" })),
      // Scheduling FROM inside an action — exercises `schedulerActionContext` (the action-mode
      // ctx.scheduler facade, which delegates to the internal scheduler:_enqueue mutation).
      scheduleFromAction: action(async (ctx: A) => ctx.scheduler.runAfter(0, "mod:recordViaAction", { tag: "scheduled-from-action" })),
      count: query(async (ctx: A) => (await ctx.db.query("runs", "by_creation").collect()).length),
      all: query(async (ctx: A) => ctx.db.query("runs", "by_creation").collect()),
    };

    let t: TestHelipod;
    beforeEach(async () => {
      t = await createTestHelipod({
        modules: { "mod.ts": actionMod, "schema.ts": { default: schema } },
        components: [defineScheduler()],
      });
    });
    afterEach(async () => {
      await t.close();
    });

    it("scheduling an action (runAfter) runs the action, which can write via ctx.runMutation", async () => {
      await t.mutation("mod:scheduleAction", {});
      expect(await t.query("mod:count", {})).toBe(0);

      await t.finishScheduledFunctions();
      const rows = await t.query<Array<{ at: string }>>("mod:all", {});
      expect(rows).toHaveLength(1);
      expect(rows[0]!.at).toBe("from-scheduled-action");
    });

    it("scheduling from INSIDE an action (schedulerActionContext) works end-to-end", async () => {
      // NOTE: `schedulerActionContext.runAfter` (`components/scheduler/src/facade.ts`) computes
      // the job's absolute `nextTs` from REAL `Date.now()`, not the injectable `now` an action's
      // ctx otherwise uses — deliberate, since an action is non-deterministic by design (see that
      // function's doc comment). That means it's incompatible with the DEFAULT harness's virtual
      // clock (a fixed internal epoch, `packages/test/src/compose.ts`'s `clockMs`, unrelated to
      // real wall-clock time): `_peekDue` compares `nextTs` against the virtual clock's `now()`,
      // so a job scheduled from an action would only become "due" once the virtual clock is
      // advanced by however many years separate the fixed epoch from the real current time — far
      // beyond `finishScheduledFunctions`'s bounded iteration count. So this test uses its own
      // `t2` with `now: () => Date.now()` (a REAL wall-clock harness), which makes the driver's
      // own reactive/timer wake (no manual ticking needed — see `driver.ts`'s `start()`) drain the
      // job on real (near-zero-delay) time, observed via polling like `reactivity.test.ts`'s
      // `waitFor` rather than `advanceTimers` (unavailable — real clock isn't harness-owned).
      const t2 = await createTestHelipod({
        modules: { "mod.ts": actionMod, "schema.ts": { default: schema } },
        components: [defineScheduler()],
        now: () => Date.now(),
      });
      try {
        await t2.action("mod:scheduleFromAction", {});

        // Async predicate (needs an `await t2.query(...)` per poll), so this uses its own loop
        // rather than the sync-predicate `waitFor` helper above.
        const start = Date.now();
        // eslint-disable-next-line no-constant-condition
        while (true) {
          const rows = await t2.query<Array<{ at: string }>>("mod:all", {});
          if (rows.length === 1) {
            expect(rows[0]!.at).toBe("scheduled-from-action");
            break;
          }
          if (Date.now() - start > 5000) throw new Error("timeout waiting for action-scheduled job to run");
          await new Promise((r) => setTimeout(r, 20));
        }
      } finally {
        await t2.close();
      }
    });
  });

  describe("failure/retry/dead-letter", () => {
    // A DB write from inside the throwing mutation would roll back along with the rest of that
    // mutation's own transaction (a mutation that throws never commits ANY of its writes) — so
    // the side-effect counter here is a plain in-memory closure variable, exactly like
    // `components/scheduler/test/reliability.test.ts`'s `flakyRuns` counter, not a DB row.
    let flakyRuns = 0;
    const retryMod = {
      // Never succeeds — throws every time — so it burns through maxFailures and dead-letters.
      flaky: mutation(async () => {
        flakyRuns++;
        throw new Error("boom: always fails");
      }),
      schedule: mutation(async (ctx: A) => ctx.scheduler.enqueue("mod:flaky", {}, { retry: { maxFailures: 2 } })),
    };

    let t: TestHelipod;
    beforeEach(async () => {
      flakyRuns = 0;
      t = await createTestHelipod({
        modules: { "mod.ts": retryMod, "schema.ts": { default: schema } },
        components: [defineScheduler()],
      });
    });
    afterEach(async () => {
      await t.close();
    });

    it("a throwing scheduled mutation retries per maxFailures, then reaches a terminal failed state", async () => {
      const jobId = await t.mutation<string>("mod:schedule", {});

      await t.finishScheduledFunctions();

      // Ran exactly maxFailures=2 times (side-effect counter), never again once dead-lettered.
      expect(flakyRuns).toBe(2);

      // Draining further must not add more attempts — the job is terminal.
      await t.finishScheduledFunctions();
      expect(flakyRuns).toBe(2);

      // Observe the terminal `failed` state via a privileged raw db read (`t.run`'s escape hatch,
      // mirroring `components/scheduler/test/helpers.ts`'s `_system:scan` pattern) — there is no
      // public status/inspection query for a job yet.
      const job = await t.run(async (ctx: A) => ctx.db.get(jobId));
      expect(job).toMatchObject({ state: "failed", attempts: 2 });
    });
  });

  describe("onComplete + context round-trip", () => {
    const callbackSchema = defineSchema({
      callbacks: defineTable({ payload: v.any() }),
    });

    const callbackMod = {
      work: mutation(async (_ctx: A, args: { n: number }) => args.n * 2),
      onDone: mutation(async (ctx: A, args: A) => {
        await ctx.db.insert("callbacks", { payload: args });
        return null;
      }),
      schedule: mutation(async (ctx: A) =>
        ctx.scheduler.enqueue("mod:work", { n: 21 }, { onComplete: "mod:onDone", context: { workflowId: "w1", step: 3 } }),
      ),
      callbacks: query(async (ctx: A) => ctx.db.query("callbacks", "by_creation").collect()),
    };

    let t: TestHelipod;
    beforeEach(async () => {
      t = await createTestHelipod({
        modules: { "mod.ts": callbackMod, "schema.ts": { default: callbackSchema } },
        components: [defineScheduler()],
      });
    });
    afterEach(async () => {
      await t.close();
    });

    it("onComplete fires on success with {jobId, context, result}, and context round-trips verbatim", async () => {
      const jobId = await t.mutation<string>("mod:schedule", {});

      await t.finishScheduledFunctions();

      const rows = await t.query<Array<{ payload: A }>>("mod:callbacks", {});
      expect(rows).toHaveLength(1);
      expect(rows[0]!.payload).toEqual({
        jobId,
        context: { workflowId: "w1", step: 3 },
        result: { kind: "success", value: 42 },
      });
    });
  });

  describe("cascading cancel", () => {
    // See `components/scheduler/src/facade.ts`'s Task 4 design note: a child scheduled via
    // `ctx.scheduler.runAfter` from INSIDE a running job gets `parentId: undefined` and does not
    // chain today (no ambient "current job id" is threaded through the driver/executor yet). The
    // only way to construct a real parent/child chain is to set `parentId` directly, which the
    // public `ctx.scheduler` facade never exposes as an argument. `t.run(fn)` gives a privileged
    // db-writer ctx (the harness's own escape hatch, analogous to `components/scheduler/test/
    // helpers.ts`'s `_system:insertJob`), so we use that to craft the chain directly, then cancel
    // the parent through the REAL public `ctx.scheduler.cancel` (via a normal app mutation) to
    // exercise the actual cascading walk, which is generic over however `parentId` got set —
    // mirrors `components/scheduler/test/reliability.test.ts`'s equivalent coverage.
    const cancelMod = {
      cancelIt: mutation(async (ctx: A, args: { id: string }) => {
        await ctx.scheduler.cancel(args.id);
        return null;
      }),
    };

    let t: TestHelipod;
    beforeEach(async () => {
      t = await createTestHelipod({
        modules: { "mod.ts": cancelMod, "schema.ts": { default: schema } },
        components: [defineScheduler()],
      });
    });
    afterEach(async () => {
      await t.close();
    });

    it("canceling a parent job cascades to cancel its pending descendants, leaving unrelated jobs untouched", async () => {
      const far = Date.now() + 60 * 60 * 1000; // far in the future — never dispatched mid-test
      const insertPending = (extra: Record<string, unknown> = {}) =>
        t.run(async (ctx: A) =>
          ctx.db.insert("scheduler/jobs", {
            fnPath: "mod:doesNotExist",
            kind: "mutation",
            state: "pending",
            nextTs: far,
            attempts: 0,
            maxFailures: 4,
            hasArgs: true,
            ...extra,
          }),
        );

      const parentId = await insertPending();
      const childId = await insertPending({ parentId });
      const grandchildId = await insertPending({ parentId: childId });
      const unrelatedId = await insertPending();

      await t.mutation("mod:cancelIt", { id: parentId });

      const parentJob = await t.run(async (ctx: A) => ctx.db.get(parentId));
      const childJob = await t.run(async (ctx: A) => ctx.db.get(childId));
      const grandchildJob = await t.run(async (ctx: A) => ctx.db.get(grandchildId));
      const unrelatedJob = await t.run(async (ctx: A) => ctx.db.get(unrelatedId));

      expect(parentJob).toMatchObject({ state: "canceled" });
      expect(childJob).toMatchObject({ state: "canceled" });
      expect(grandchildJob).toMatchObject({ state: "canceled" });
      expect(unrelatedJob).toMatchObject({ state: "pending" });
    });
  });

  describe("idempotency-key dedup", () => {
    const idemMod = {
      work: mutation(async (ctx: A) => {
        await ctx.db.insert("runs", { at: "work" });
        return null;
      }),
      scheduleOnce: mutation(async (ctx: A, args: { key: string }) => ctx.scheduler.enqueue("mod:work", {}, { idempotencyKey: args.key })),
      count: query(async (ctx: A) => (await ctx.db.query("runs", "by_creation").collect()).length),
    };

    let t: TestHelipod;
    beforeEach(async () => {
      t = await createTestHelipod({
        modules: { "mod.ts": idemMod, "schema.ts": { default: schema } },
        components: [defineScheduler()],
      });
    });
    afterEach(async () => {
      await t.close();
    });

    it("two enqueues with the same idempotencyKey produce one job (insert-or-noop, same id returned)", async () => {
      // Two SEPARATE committed mutation calls (not two enqueues inside one transaction) — the
      // dedup lookup (`by_idempotency`) reads committed state, so this mirrors the real use case
      // (e.g. two separate webhook deliveries of the same event) and `components/scheduler/test/
      // crons.test.ts`'s equivalent coverage, which also issues two separate top-level calls.
      const first = await t.mutation<string>("mod:scheduleOnce", { key: "job-x" });
      const second = await t.mutation<string>("mod:scheduleOnce", { key: "job-x" });
      expect(second).toBe(first);

      const jobs = await t.run(async (ctx: A) => ctx.db.query("scheduler/jobs", "by_creation").collect());
      expect((jobs as A[]).filter((j) => j.fnPath === "mod:work")).toHaveLength(1);

      await t.finishScheduledFunctions();
      expect(await t.query("mod:count", {})).toBe(1); // ran exactly once, not twice
    });
  });

  describe("scheduled write fans out reactively", () => {
    const reactiveMod = {
      byCreation: query(async (ctx: A) => ctx.db.query("runs", "by_creation").collect()),
      insertRun: mutation(async (ctx: A, args: { at: string }) => {
        await ctx.db.insert("runs", { at: args.at });
        return null;
      }),
      schedule: mutation(async (ctx: A) => ctx.scheduler.runAfter(0, "mod:insertRun", { at: "reactive-tick" })),
    };

    let t: TestHelipod;
    beforeEach(async () => {
      t = await createTestHelipod({
        modules: { "mod.ts": reactiveMod, "schema.ts": { default: schema } },
        components: [defineScheduler()],
      });
    });
    afterEach(async () => {
      await t.close();
    });

    it("a scheduled mutation's write re-fires a live subscription opened beforehand", async () => {
      const sub = t.subscribe("mod:byCreation", {});
      let changes = 0;
      sub.onChange(() => {
        changes++;
      });
      await waitFor(() => sub.value() !== undefined);
      expect(sub.value()).toHaveLength(0);

      const before = changes;
      await t.mutation("mod:schedule", {});
      await t.finishScheduledFunctions();

      await waitFor(() => (sub.value()?.length ?? 0) === 1);
      expect(changes).toBeGreaterThan(before);
      expect(sub.value()).toMatchObject([{ at: "reactive-tick" }]);

      sub.unsubscribe();
    });
  });

  describe("cron cadence", () => {
    const cronSchema = defineSchema({
      beats: defineTable({ n: v.number() }),
    });

    it("an interval cron fires on cadence under advanceTimers", async () => {
      const crons = cronJobs();
      let n = 0;
      const cronMod = {
        beat: mutation(async (ctx: A) => {
          n++;
          await ctx.db.insert("beats", { n });
          return null;
        }),
        count: query(async (ctx: A) => (await ctx.db.query("beats", "by_creation").collect()).length),
      };
      crons.interval("beat-cron", { seconds: 10 }, "mod:beat", {});

      const t = await createTestHelipod({
        modules: { "mod.ts": cronMod, "schema.ts": { default: cronSchema } },
        components: [defineScheduler({ crons })],
      });
      try {
        // finishScheduledFunctions can't be used here — a recurring cron reschedules itself
        // forever and would hit finishScheduledFunctions' MAX_ITERATIONS bound. Use advanceTimers
        // (a fixed one-shot advance + one driver pass) instead, mirroring
        // `components/scheduler/test/crons.test.ts`'s `drain` helper of repeated `tick()` calls.
        for (let i = 0; i < 4; i++) await t.advanceTimers(10_000);

        // At least 3 fires across ~40s of virtual time on a 10s cadence (clock-anchored, no
        // drift) — the exact count can be 3 or 4 depending on rounding at the boundary.
        const count = await t.query<number>("mod:count", {});
        expect(count).toBeGreaterThanOrEqual(3);
      } finally {
        await t.close();
      }
    });

    it('catchUp:"skip" (the default) discards a downtime backlog instead of firing every missed occurrence', async () => {
      const crons = cronJobs();
      let n = 0;
      const cronMod = {
        beat: mutation(async (ctx: A) => {
          n++;
          await ctx.db.insert("beats", { n });
          return null;
        }),
        count: query(async (ctx: A) => (await ctx.db.query("beats", "by_creation").collect()).length),
      };
      crons.interval("beat-cron-skip", { seconds: 10 }, "mod:beat", {}); // default catchUp: "skip"

      const t = await createTestHelipod({
        modules: { "mod.ts": cronMod, "schema.ts": { default: cronSchema } },
        components: [defineScheduler({ crons })],
      });
      try {
        // Jump WAY past several missed 10s periods in one advance — simulates downtime.
        await t.advanceTimers(10_000 * 5 + 500);

        // "skip" discards the entire backlog — fires nothing for the ~5 missed periods, just re-anchors.
        expect(await t.query<number>("mod:count", {})).toBe(0);

        // ...but the cron is still ALIVE — one more real period fires it exactly once. Without this,
        // a count of 0 above is indistinguishable from a cron that died entirely after the gap.
        await t.advanceTimers(10_000);
        expect(await t.query<number>("mod:count", {})).toBeGreaterThanOrEqual(1);
      } finally {
        await t.close();
      }
    });
  });

  describe("failure isolation", () => {
    const isolationSchema = defineSchema({
      good: defineTable({ n: v.number() }),
    });

    const isolationMod = {
      throws: mutation(async () => {
        throw new Error("boom — this job always fails");
      }),
      succeeds: mutation(async (ctx: A) => {
        await ctx.db.insert("good", { n: 1 });
        return null;
      }),
      scheduleBoth: mutation(async (ctx: A) => {
        await ctx.scheduler.runAfter(0, "mod:throws", {});
        await ctx.scheduler.runAfter(0, "mod:succeeds", {});
        return null;
      }),
      goodCount: query(async (ctx: A) => (await ctx.db.query("good", "by_creation").collect()).length),
    };

    let t: TestHelipod;
    beforeEach(async () => {
      t = await createTestHelipod({
        modules: { "mod.ts": isolationMod, "schema.ts": { default: isolationSchema } },
        components: [defineScheduler()],
      });
    });
    afterEach(async () => {
      await t.close();
    });

    it("two jobs due in the same drain sweep: one throwing does not prevent the other from running", async () => {
      await t.mutation("mod:scheduleBoth", {});

      await t.finishScheduledFunctions();

      // The throwing job retries to its own dead-letter, but never blocks/starves the sibling.
      expect(await t.query("mod:goodCount", {})).toBe(1);
    });
  });
});
