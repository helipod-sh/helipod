import { v } from "@helipod/values";
import { query, mutation } from "./_generated/server";

const pollShape = v.object({
  _id: v.id("polls"),
  _creationTime: v.number(),
  question: v.string(),
  closed: v.boolean(),
});

export const list = query({
  args: {},
  returns: v.array(pollShape),
  handler: (ctx) => ctx.db.query("polls", "by_creation").collect(),
});

export const create = mutation({
  // Composite intent: the poll and its option rows are one transaction, so a subscriber can
  // never observe a poll without its options.
  args: { question: v.string(), options: v.array(v.string()) },
  returns: v.id("polls"),
  handler: async (ctx, { question, options }) => {
    const pollId = await ctx.db.insert("polls", { question, closed: false });
    // `order` pins each label's position (see schema.ts's DEVIATION note): every insert in this
    // transaction shares one `_creationTime`, so the `by_poll` index alone can't order them.
    for (let i = 0; i < options.length; i++) {
      await ctx.db.insert("options", { pollId, label: options[i]!, votes: 0, order: i });
    }
    return pollId;
  },
});

export const setClosed = mutation({
  // Close AND reopen — the rollback demo (vote into a closed poll) stays repeatable.
  args: { id: v.id("polls"), closed: v.boolean() },
  returns: v.null(),
  handler: async (ctx, { id, closed }) => {
    const doc = await ctx.db.get(id);
    if (doc === null) return null; // toggling a vanished poll is a no-op, not an error
    await ctx.db.replace(id, { question: doc.question as string, closed });
    return null;
  },
});
