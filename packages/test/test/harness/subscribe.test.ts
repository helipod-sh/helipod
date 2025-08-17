import { it, expect } from "vitest";
import { createTestStackbase } from "../../src";
import { mutation, query } from "@stackbase/executor";
import { defineSchema, defineTable, v } from "@stackbase/values";

const mod = {
  add: mutation(async (ctx: any, a: { room: string; body: string }) => ctx.db.insert("messages", a)),
  // Real `ctx.db` query-builder shape (see `packages/executor/src/guest.ts`'s `QueryBuilder`):
  // `query(table, index).eq(field, value).collect()` — there is no `.withIndex(...)` method.
  byRoom: query(async (ctx: any, a: { room: string }) =>
    ctx.db.query("messages", "by_room").eq("room", a.room).collect()),
};
const schema = defineSchema({
  messages: defineTable({ room: v.string(), body: v.string() }).index("by_room", ["room"]),
});

async function waitFor(pred: () => boolean, ms = 1000) {
  const start = Date.now();
  while (!pred()) { if (Date.now() - start > ms) throw new Error("timeout"); await new Promise((r) => setTimeout(r, 5)); }
}

it("subscribe re-fires on an intersecting write and NOT on a non-intersecting one", async () => {
  const t = await createTestStackbase({ modules: { "mod.ts": mod, "schema.ts": { default: schema } } });
  try {
    const sub = t.subscribe("mod:byRoom", { room: "general" });
    let changes = 0;
    sub.onChange(() => { changes++; });
    await waitFor(() => sub.value() !== undefined);
    expect(sub.value()).toHaveLength(0);

    await t.mutation("mod:add", { room: "general", body: "hi" }); // intersects the read set
    await waitFor(() => (sub.value()?.length ?? 0) === 1);
    expect(changes).toBeGreaterThanOrEqual(1);

    const before = changes;
    await t.mutation("mod:add", { room: "other", body: "x" }); // does NOT intersect room=general
    await new Promise((r) => setTimeout(r, 50));
    expect(sub.value()).toHaveLength(1);
    expect(changes).toBe(before); // no spurious re-fire
    sub.unsubscribe();
  } finally {
    await t.close();
  }
});
