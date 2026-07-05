import { query, mutation } from "@helipod/executor";

export const seed = mutation({
  handler: async (ctx) => {
    await ctx.db.insert("users", { name: "ada", admin: true });
    await ctx.db.insert("users", { name: "bob", admin: false });
    await ctx.db.insert("messages", { author: "ada", body: "hi", n: 1 });
    await ctx.db.insert("messages", { author: "ada", body: "again", n: 2 });
    await ctx.db.insert("messages", { author: "bob", body: "yo", n: 3 });
    return null;
  },
});

// Returns full docs (incl. _id + _creationTime) so the round-trip can assert byte-identical rows.
export const allMessages = query({
  handler: async (ctx) => ctx.db.query("messages", "by_author").collect(),
});

export const allUsers = query({
  handler: async (ctx) => ctx.db.query("users", "by_name").collect(),
});
