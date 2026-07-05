import { v } from "@helipod/values";
import { UserError } from "@helipod/errors";
import { query, mutation } from "./_generated/server";

/** A typed, coded `UserError` subclass is what makes a queued offline `items.add` settle as a
 * TERMINAL failure on drain (pending tray, `error.code === "LIST_LOCKED"`, retry/dismiss) — a
 * plain `Error` carries no code on the wire, so the drain would treat it as an infrastructure
 * hiccup and retry it forever, by design. */
export class ListLockedError extends UserError {
  override readonly code = "LIST_LOCKED";
}

export const list = query({
  args: { listId: v.id("lists") },
  returns: v.array(
    v.object({
      _id: v.id("items"),
      _creationTime: v.number(),
      listId: v.id("lists"),
      label: v.string(),
      done: v.boolean(),
    }),
  ),
  handler: (ctx, args) => ctx.db.query("items", "by_list").eq("listId", args.listId).collect(),
});

export const add = mutation({
  args: { _id: v.optional(v.string()), listId: v.id("lists"), label: v.string() },
  returns: v.id("items"),
  handler: async (ctx, args) => {
    // The demo's conflict rule: the world can change while you're offline. A list locked after
    // you queued an add makes that add terminally invalid when it finally drains.
    const list = await ctx.db.get(args.listId);
    // A missing list (list === null) falls through and the insert proceeds: the demo's FIFO
    // drain guarantees the list's own `create` ran first, so this is unreachable in practice —
    // kept permissive on purpose so a dismissed/never-drained create can't poison this add too.
    if (list !== null && (list.locked as boolean)) {
      throw new ListLockedError(`list "${String(list.name)}" is packed & locked — no more items`);
    }
    return ctx.db.insert("items", { ...args, done: false });
  },
});

export const toggle = mutation({
  args: { id: v.id("items"), done: v.boolean() },
  returns: v.null(),
  handler: async (ctx, { id, done }) => {
    const doc = await ctx.db.get(id);
    if (doc === null) return null;
    // No ctx.db.patch in this engine — read, then replace the full user-field value.
    await ctx.db.replace(id, { listId: doc.listId as string, label: doc.label as string, done });
    return null;
  },
});
