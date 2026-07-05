import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createTestHelipod, type TestHelipod } from "../../src";
import { defineScheduler } from "@helipod/scheduler";
import { mutation, query } from "@helipod/executor";
import { defineSchema, defineTable, v } from "@helipod/values";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type A = any;

const schema = defineSchema({
  messages: defineTable({ room: v.string(), body: v.string() }).index("by_room", ["room"]),
  events: defineTable({ seq: v.number(), label: v.string() }).index("by_seq", ["seq"]),
});

const mod = {
  byRoom: query(async (ctx: A, a: { room: string }) =>
    ctx.db.query("messages", "by_room").eq("room", a.room).collect()),
  insert: mutation(async (ctx: A, a: { room: string; body: string }) => ctx.db.insert("messages", a)),
  // Two inserts into the SAME (subscribed) room within a single mutation/transaction — used to
  // prove one committed write set producing one re-fire, not one re-fire per row touched.
  insertTwo: mutation(async (ctx: A, a: { room: string; body1: string; body2: string }) => {
    await ctx.db.insert("messages", { room: a.room, body: a.body1 });
    await ctx.db.insert("messages", { room: a.room, body: a.body2 });
    return null;
  }),
  setBody: mutation(async (ctx: A, a: { id: string; body: string }) => {
    const cur = await ctx.db.get(a.id);
    await ctx.db.replace(a.id, { ...cur, body: a.body });
    return null;
  }),
  del: mutation(async (ctx: A, a: { id: string }) => {
    await ctx.db.delete(a.id);
    return null;
  }),
  // Range query over the `by_seq` index — half-open [lo, hi) — used to test range-precise
  // (not table-level) invalidation.
  byRange: query(async (ctx: A, a: { lo: number; hi: number }) =>
    ctx.db.query("events", "by_seq").gte("seq", a.lo).lt("seq", a.hi).collect()),
  insertEvent: mutation(async (ctx: A, a: { seq: number; label: string }) => ctx.db.insert("events", a)),
  // Schedules `mod:insert` to run later via `@helipod/scheduler` — used to prove a scheduled
  // mutation's write fans out to a live subscription the same as a directly-called mutation.
  scheduleInsert: mutation(async (ctx: A, a: { room: string; body: string }) =>
    ctx.scheduler.runAfter(1000, "mod:insert", a)),
};

async function waitFor(pred: () => boolean, ms = 1000) {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > ms) throw new Error("timeout waiting for predicate");
    await new Promise((r) => setTimeout(r, 5));
  }
}

const GRACE_MS = 70;

describe("conformance — reactive invalidation precision", () => {
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

  it("an intersecting insert re-fires the subscription with the new row", async () => {
    const sub = t.subscribe("mod:byRoom", { room: "general" });
    let changes = 0;
    sub.onChange(() => { changes++; });
    await waitFor(() => sub.value() !== undefined);
    expect(sub.value()).toHaveLength(0);

    const before = changes;
    await t.mutation("mod:insert", { room: "general", body: "hello" });
    await waitFor(() => (sub.value()?.length ?? 0) === 1);
    expect(changes).toBeGreaterThan(before);
    expect(sub.value()).toMatchObject([{ room: "general", body: "hello" }]);

    sub.unsubscribe();
  });

  it("a write to a different index key does NOT re-fire the subscription", async () => {
    const sub = t.subscribe("mod:byRoom", { room: "general" });
    let changes = 0;
    sub.onChange(() => { changes++; });
    await waitFor(() => sub.value() !== undefined);
    expect(sub.value()).toHaveLength(0);

    const before = changes;
    await t.mutation("mod:insert", { room: "other", body: "unrelated" });
    await new Promise((r) => setTimeout(r, GRACE_MS));
    expect(changes).toBe(before); // no spurious re-fire
    expect(sub.value()).toHaveLength(0); // still empty — the write never touched this read set

    sub.unsubscribe();
  });

  it("a read-merge-replace update to a subscribed row re-fires with the new value", async () => {
    const id = await t.run(async (ctx: A) => ctx.db.insert("messages", { room: "general", body: "orig" }));

    const sub = t.subscribe("mod:byRoom", { room: "general" });
    let changes = 0;
    sub.onChange(() => { changes++; });
    await waitFor(() => (sub.value()?.length ?? 0) === 1);

    const before = changes;
    await t.mutation("mod:setBody", { id, body: "updated" });
    await waitFor(() => sub.value()?.[0]?.body === "updated");
    expect(changes).toBeGreaterThan(before);
    expect(sub.value()).toMatchObject([{ room: "general", body: "updated" }]);

    sub.unsubscribe();
  });

  it("deleting a subscribed row re-fires with the row gone", async () => {
    const id = await t.run(async (ctx: A) => ctx.db.insert("messages", { room: "general", body: "bye" }));

    const sub = t.subscribe("mod:byRoom", { room: "general" });
    let changes = 0;
    sub.onChange(() => { changes++; });
    await waitFor(() => (sub.value()?.length ?? 0) === 1);

    const before = changes;
    await t.mutation("mod:del", { id });
    await waitFor(() => (sub.value()?.length ?? 0) === 0);
    expect(changes).toBeGreaterThan(before);
    expect(sub.value()).toHaveLength(0);

    sub.unsubscribe();
  });

  it("two subscriptions to different keys: a write to one re-fires only that one", async () => {
    const subGeneral = t.subscribe("mod:byRoom", { room: "general" });
    const subOther = t.subscribe("mod:byRoom", { room: "other" });
    let generalChanges = 0;
    let otherChanges = 0;
    subGeneral.onChange(() => { generalChanges++; });
    subOther.onChange(() => { otherChanges++; });
    await waitFor(() => subGeneral.value() !== undefined && subOther.value() !== undefined);

    const beforeGeneral = generalChanges;
    const beforeOther = otherChanges;
    await t.mutation("mod:insert", { room: "general", body: "hi" });
    await waitFor(() => (subGeneral.value()?.length ?? 0) === 1);
    await new Promise((r) => setTimeout(r, GRACE_MS));

    expect(generalChanges).toBeGreaterThan(beforeGeneral);
    expect(otherChanges).toBe(beforeOther); // untouched key's subscription must not fire
    expect(subOther.value()).toHaveLength(0);

    subGeneral.unsubscribe();
    subOther.unsubscribe();
  });

  it("a subscription over an empty range stays empty and does not fire on an unrelated write", async () => {
    const sub = t.subscribe("mod:byRoom", { room: "empty" });
    let changes = 0;
    sub.onChange(() => { changes++; });
    await waitFor(() => sub.value() !== undefined);
    expect(sub.value()).toHaveLength(0);

    const before = changes;
    await t.mutation("mod:insert", { room: "general", body: "unrelated" });
    await new Promise((r) => setTimeout(r, GRACE_MS));
    expect(changes).toBe(before);
    expect(sub.value()).toHaveLength(0);

    sub.unsubscribe();
  });

  it("a subscription over an index RANGE re-fires for a write inside the range and NOT for a disjoint write in the same table", async () => {
    // Pre-seed one row outside the [10,20) range so the table is non-empty before we subscribe —
    // a table-level (coarse) engine would re-fire on ANY write to `events`; a range-precise engine
    // must only re-fire for writes whose key falls inside [lo, hi).
    await t.run(async (ctx: A) => ctx.db.insert("events", { seq: 1, label: "outside-preexisting" }));

    const sub = t.subscribe("mod:byRange", { lo: 10, hi: 20 });
    let changes = 0;
    sub.onChange(() => { changes++; });
    await waitFor(() => sub.value() !== undefined);
    expect(sub.value()).toHaveLength(0);

    // A write OUTSIDE the subscribed range, in the SAME table — must NOT re-fire.
    const beforeOutside = changes;
    await t.mutation("mod:insertEvent", { seq: 25, label: "outside" });
    await new Promise((r) => setTimeout(r, GRACE_MS));
    expect(changes).toBe(beforeOutside); // FINDING if this fires: table-level, not range-precise, invalidation
    expect(sub.value()).toHaveLength(0);

    // A write INSIDE the subscribed range — must re-fire.
    const beforeInside = changes;
    await t.mutation("mod:insertEvent", { seq: 15, label: "inside" });
    await waitFor(() => (sub.value()?.length ?? 0) === 1);
    expect(changes).toBeGreaterThan(beforeInside);
    expect(sub.value()).toMatchObject([{ seq: 15, label: "inside" }]);

    sub.unsubscribe();
  });

  it("unsubscribe stops delivering further changes", async () => {
    const sub = t.subscribe("mod:byRoom", { room: "general" });
    let changes = 0;
    sub.onChange(() => { changes++; });
    await waitFor(() => sub.value() !== undefined);

    sub.unsubscribe();
    const before = changes;
    await t.mutation("mod:insert", { room: "general", body: "after-unsub" });
    await new Promise((r) => setTimeout(r, GRACE_MS));
    expect(changes).toBe(before); // no callback after unsubscribe, even though the write matches
  });

  it("two sequential matching mutations produce exactly two additional re-fires", async () => {
    const sub = t.subscribe("mod:byRoom", { room: "general" });
    let changes = 0;
    sub.onChange(() => { changes++; });
    await waitFor(() => sub.value() !== undefined);

    const before = changes;
    await t.mutation("mod:insert", { room: "general", body: "one" });
    await waitFor(() => (sub.value()?.length ?? 0) === 1);
    await t.mutation("mod:insert", { room: "general", body: "two" });
    await waitFor(() => (sub.value()?.length ?? 0) === 2);
    await new Promise((r) => setTimeout(r, GRACE_MS)); // let any stray extra fire show up before asserting the exact count

    expect(changes - before).toBe(2);

    sub.unsubscribe();
  });

  it("a single mutation performing two intersecting writes produces exactly one re-fire", async () => {
    const sub = t.subscribe("mod:byRoom", { room: "general" });
    let changes = 0;
    sub.onChange(() => { changes++; });
    await waitFor(() => sub.value() !== undefined);

    const before = changes;
    await t.mutation("mod:insertTwo", { room: "general", body1: "a", body2: "b" });
    await waitFor(() => (sub.value()?.length ?? 0) === 2);
    await new Promise((r) => setTimeout(r, GRACE_MS)); // let any stray extra fire show up before asserting the exact count

    expect(changes - before).toBe(1); // one committed transaction => one re-fire, regardless of row count touched

    sub.unsubscribe();
  });

  it("a scheduled mutation's write fans out to a live subscription after finishScheduledFunctions", async () => {
    const sub = t.subscribe("mod:byRoom", { room: "scheduled-room" });
    let changes = 0;
    sub.onChange(() => { changes++; });
    await waitFor(() => sub.value() !== undefined);
    expect(sub.value()).toHaveLength(0);

    const before = changes;
    await t.mutation("mod:scheduleInsert", { room: "scheduled-room", body: "later" });
    // Not yet run — the scheduled job hasn't been driven.
    await new Promise((r) => setTimeout(r, GRACE_MS));
    expect(sub.value()).toHaveLength(0);

    await t.finishScheduledFunctions();
    await waitFor(() => (sub.value()?.length ?? 0) === 1);
    expect(changes).toBeGreaterThan(before);
    expect(sub.value()).toMatchObject([{ room: "scheduled-room", body: "later" }]);

    sub.unsubscribe();
  });

  it("subscribing to a query over pre-existing rows immediately yields current state", async () => {
    await t.run(async (ctx: A) => {
      await ctx.db.insert("messages", { room: "preexisting", body: "first" });
      await ctx.db.insert("messages", { room: "preexisting", body: "second" });
      return null;
    });

    const sub = t.subscribe("mod:byRoom", { room: "preexisting" });
    await waitFor(() => sub.value() !== undefined);

    // The very first emitted value must already reflect the rows that existed before the
    // subscription was created — not an empty initial value waiting for a future write. (Order
    // is not asserted — only that both pre-existing rows are already present.)
    expect(sub.value()).toHaveLength(2);
    expect(sub.value()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ room: "preexisting", body: "first" }),
        expect.objectContaining({ room: "preexisting", body: "second" }),
      ]),
    );

    sub.unsubscribe();
  });
});
