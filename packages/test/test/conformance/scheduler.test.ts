import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createTestStackbase, type TestStackbase } from "../../src";
import { defineScheduler } from "@stackbase/scheduler";
import { mutation, query } from "@stackbase/executor";
import { defineSchema, defineTable, v } from "@stackbase/values";

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
  let t: TestStackbase;

  beforeEach(async () => {
    t = await createTestStackbase({
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
