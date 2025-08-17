import { it, expect } from "vitest";
import { createTestStackbase } from "../../src";
import { defineScheduler } from "@stackbase/scheduler";
import { mutation, query } from "@stackbase/executor";
import { defineSchema, defineTable, v } from "@stackbase/values";

const mod = {
  kick: mutation(async (ctx: any) => {
    await ctx.scheduler.runAfter(1000, "mod:mark", {});
  }),
  mark: mutation(async (ctx: any) => ctx.db.insert("marks", { at: "done" })),
  count: query(async (ctx: any) => (await ctx.db.query("marks", "by_creation").collect()).length),
};
const schema = defineSchema({ marks: defineTable({ at: v.string() }) });

it("finishScheduledFunctions runs a scheduled mutation to completion", async () => {
  const t = await createTestStackbase({
    modules: { "mod.ts": mod, "schema.ts": { default: schema } },
    components: [defineScheduler()],
  });
  try {
    await t.mutation("mod:kick", {});
    expect(await t.query("mod:count", {})).toBe(0);
    await t.finishScheduledFunctions();
    expect(await t.query("mod:count", {})).toBe(1);
  } finally {
    await t.close();
  }
});

it("finishScheduledFunctions is a clean no-op when no scheduler is composed", async () => {
  const t = await createTestStackbase({
    modules: { "mod.ts": mod, "schema.ts": { default: schema } },
  });
  try {
    await t.finishScheduledFunctions();
    expect(await t.query("mod:count", {})).toBe(0);
  } finally {
    await t.close();
  }
});

it("finishScheduledFunctions drains a cascade (a scheduled job scheduling another)", async () => {
  // Handlers use expression bodies that resolve to a value (mirroring `mod.mark` above) rather
  // than a block body with an implicit `undefined` return — a scheduled job's return value flows
  // into the driver's `scheduler:_complete` call as JSON, which (a pre-existing, unrelated
  // quirk of the JSON codec) can't encode a bare `undefined`.
  const chain = {
    kickA: mutation(async (ctx: any) => ctx.scheduler.runAfter(1000, "chain:stepB", {})),
    stepB: mutation(async (ctx: any) => {
      await ctx.db.insert("marks", { at: "b" });
      return ctx.scheduler.runAfter(1000, "chain:stepC", {});
    }),
    stepC: mutation(async (ctx: any) => ctx.db.insert("marks", { at: "c" })),
    count: query(async (ctx: any) => (await ctx.db.query("marks", "by_creation").collect()).length),
  };
  const t = await createTestStackbase({
    modules: { "chain.ts": chain, "schema.ts": { default: schema } },
    components: [defineScheduler()],
  });
  try {
    await t.mutation("chain:kickA", {});
    await t.finishScheduledFunctions();
    expect(await t.query("chain:count", {})).toBe(2);
  } finally {
    await t.close();
  }
});

it("advanceTimers advances the clock and drives one scheduler pass", async () => {
  const t = await createTestStackbase({
    modules: { "mod.ts": mod, "schema.ts": { default: schema } },
    components: [defineScheduler()],
  });
  try {
    await t.mutation("mod:kick", {});
    // Not yet due — advancing by less than the 1000ms delay should not dispatch it.
    await t.advanceTimers(500);
    expect(await t.query("mod:count", {})).toBe(0);
    await t.advanceTimers(600);
    expect(await t.query("mod:count", {})).toBe(1);
  } finally {
    await t.close();
  }
});

it("advanceClock/advanceTimers/finishScheduledFunctions throw when opts.now is supplied", async () => {
  const t = await createTestStackbase({
    modules: { "mod.ts": mod, "schema.ts": { default: schema } },
    components: [defineScheduler()],
    now: () => 1_000_000,
  });
  try {
    await t.mutation("mod:kick", {});
    await expect(t.advanceTimers(1000)).rejects.toThrow(/does not own|no clock|custom `now`/i);
    await expect(t.finishScheduledFunctions()).rejects.toThrow(/does not own|no clock|custom `now`/i);
  } finally {
    await t.close();
  }
});
