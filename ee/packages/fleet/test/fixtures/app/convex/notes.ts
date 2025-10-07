import { query, mutation, action } from "@stackbase/executor";
import type { Id } from "./_generated/dataModel";

export const list = query({
  handler: async (ctx) =>
    (await ctx.db.query("notes", "by_box").collect()).map((d) => ({ box: d.box, text: d.text })),
});

// Bare `db.get(id)` read — exercises the DOCUMENT-keyspace invalidation bridge (a write to this
// exact id must re-run this subscription), distinct from `list`'s index-range read.
export const get = query({
  handler: async (ctx, { id }: { id: Id<"notes"> }) => {
    const d = await ctx.db.get(id);
    return d ? { box: d.box, text: d.text } : null;
  },
});

export const add = mutation({
  handler: (ctx, { box, text }: { box: string; text: string }) => ctx.db.insert("notes", { box, text }),
});

// Stackbase has no ctx.db.patch (a documented Convex divergence) — read-merge-replace instead.
export const update = mutation({
  handler: async (ctx, { id, text }: { id: Id<"notes">; text: string }) => {
    const cur = await ctx.db.get(id);
    if (cur) await ctx.db.replace(id, { ...cur, text });
    return null;
  },
});

// A self-perpetuating scheduled chain (the multi-writer E2E's "exactly ONE node runs the scheduler
// through a default-shard MOVE" proof). Each tick inserts a `notes` row tagged `box:"tick"`,
// `text:"tick-<seq>"`, then — while `seq < max` — reschedules ITSELF for `seq+1` after `delayMs`.
// The whole chain runs on the DEFAULT-shard holder (the scheduler driver's node). Kill that holder
// mid-chain and the driver resumes on the new default holder: the `text` seq values stay STRICTLY
// UNIQUE (at-most-once dispatch — no double-execution) and keep climbing (drivers continue). `ctx`
// is cast to `any` for the injected `ctx.scheduler` surface.
export const tick = mutation({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  handler: async (ctx: any, { seq, max, delayMs }: { seq: number; max: number; delayMs: number }) => {
    await ctx.db.insert("notes", { box: "tick", text: `tick-${seq}` });
    if (seq < max) await ctx.scheduler.runAfter(delayMs, "notes:tick", { seq: seq + 1, max, delayMs });
    return null;
  },
});

// Kicks off the `tick` chain at `seq` 0 (a plain scheduling entrypoint a client/test POSTs).
export const scheduleTick = mutation({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  handler: (ctx: any, { max, delayMs }: { max: number; delayMs: number }) =>
    ctx.scheduler.runAfter(delayMs, "notes:tick", { seq: 0, max, delayMs }),
});

// A `notes` query filtered to the tick chain — returns each tick row's `text`, in insertion order,
// so the E2E can assert seq uniqueness + growth across the default-shard move.
export const ticks = query({
  handler: async (ctx) =>
    (await ctx.db.query("notes", "by_box").collect())
      .filter((d) => d.box === "tick")
      .map((d) => d.text),
});

// An ACTION that writes via ctx.runMutation — exercises the fleet action-forwarding + read-your-own-
// writes path (the writer surfaces the inner mutation's commitTs; the sync node's forwarder waits for
// its replica watermark to reach it, so an IMMEDIATE read on the same sync node sees the row).
export const addViaAction = action({
  handler: async (
    ctx: { runMutation: (path: string, args: Record<string, unknown>) => Promise<unknown> },
    { box, text }: { box: string; text: string },
  ): Promise<unknown> => ctx.runMutation("notes:add", { box, text }),
});
