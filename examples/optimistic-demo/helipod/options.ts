import { v } from "@helipod/values";
import { UserError, DocumentNotFoundError } from "@helipod/errors";
import { query, mutation } from "./_generated/server";

/** The rollback demo's trigger: a typed, coded `UserError` subclass. An ONLINE optimistic
 * mutation that throws this rejects the caller's promise, and the client drops the optimistic
 * layer in the same reconcile pass — the count visibly snaps back, exactly. */
export class PollClosedError extends UserError {
  override readonly code = "POLL_CLOSED";
}

export const list = query({
  args: { pollId: v.id("polls") },
  returns: v.array(
    v.object({
      _id: v.id("options"),
      _creationTime: v.number(),
      pollId: v.id("polls"),
      label: v.string(),
      votes: v.number(),
      order: v.number(),
    }),
  ),
  handler: async (ctx, args) => {
    const rows = await ctx.db.query("options", "by_poll").eq("pollId", args.pollId).collect();
    // Same-transaction inserts tie on `_creationTime`, so the index alone doesn't order them —
    // sort by the explicit `order` field instead (see schema.ts's DEVIATION note).
    return [...rows].sort((a, b) => (a.order as number) - (b.order as number));
  },
});

export const vote = mutation({
  args: { id: v.id("options") },
  returns: v.number(),
  handler: async (ctx, { id }) => {
    const opt = await ctx.db.get(id);
    if (opt === null) throw new DocumentNotFoundError(`option ${id} not found`);
    const poll = await ctx.db.get(opt.pollId as string);
    if (poll !== null && (poll.closed as boolean)) {
      throw new PollClosedError(`poll "${String(poll.question)}" is closed — voting has ended`);
    }
    const next = (opt.votes as number) + 1;
    await ctx.db.replace(id, {
      pollId: opt.pollId as string,
      label: opt.label as string,
      votes: next,
      order: opt.order as number,
    });
    return next;
  },
});
