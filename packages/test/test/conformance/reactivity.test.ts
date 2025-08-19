import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createTestStackbase, type TestStackbase } from "../../src";
import { mutation, query } from "@stackbase/executor";
import { defineSchema, defineTable, v } from "@stackbase/values";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type A = any;

const schema = defineSchema({
  messages: defineTable({ room: v.string(), body: v.string() }).index("by_room", ["room"]),
});

const mod = {
  byRoom: query(async (ctx: A, a: { room: string }) =>
    ctx.db.query("messages", "by_room").eq("room", a.room).collect()),
  insert: mutation(async (ctx: A, a: { room: string; body: string }) => ctx.db.insert("messages", a)),
  setBody: mutation(async (ctx: A, a: { id: string; body: string }) => {
    const cur = await ctx.db.get(a.id);
    await ctx.db.replace(a.id, { ...cur, body: a.body });
    return null;
  }),
  del: mutation(async (ctx: A, a: { id: string }) => {
    await ctx.db.delete(a.id);
    return null;
  }),
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
  let t: TestStackbase;

  beforeEach(async () => {
    t = await createTestStackbase({ modules: { "mod.ts": mod, "schema.ts": { default: schema } } });
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
});
