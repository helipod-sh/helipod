import { describe, it, expect } from "vitest";
import { v } from "@stackbase/values";
import { mutation, query, action } from "../src/functions";

describe("functions.ts — returns validator surface", () => {
  it("a def with `returns` carries a live returnsValidator and its JSON", () => {
    const fn = mutation({
      args: { name: v.string() },
      returns: v.string(),
      handler: (_ctx, args) => args.name,
    });
    expect(fn.type).toBe("mutation");
    expect(fn.returnsValidator).toBeDefined();
    expect(fn.returnsJson).toBeDefined();
    expect(fn.returnsJson).toMatchObject({ type: "string" });
  });

  it("a query's `returns` works without `args`", () => {
    const fn = query({
      returns: v.array(v.number()),
      handler: () => [1, 2, 3],
    });
    expect(fn.returnsValidator).toBeDefined();
    expect(fn.returnsJson).toMatchObject({ type: "array", value: { type: "number" } });
  });

  it("a complex object returns validator round-trips through toJSON", () => {
    const fn = action({
      returns: v.object({ ok: v.boolean(), count: v.number() }),
      handler: async () => ({ ok: true, count: 1 }),
    });
    expect(fn.returnsJson).toMatchObject({ type: "object" });
    expect(Object.keys((fn.returnsJson as { value: Record<string, unknown> }).value)).toEqual(["ok", "count"]);
  });

  it("absent `returns` carries no validator (the documented any gap)", () => {
    const fn = query((_ctx, _args) => 1);
    expect(fn.returnsValidator).toBeUndefined();
    expect(fn.returnsJson).toBeUndefined();
  });

  it("the `{ handler }`-only form without `returns` carries no validator", () => {
    const fn = action({ handler: async () => "ok" });
    expect(fn.returnsValidator).toBeUndefined();
    expect(fn.returnsJson).toBeUndefined();
  });

  it("`returns` does not disturb the existing `args`/`shardBy` surface", () => {
    const fn = mutation({
      args: { id: v.string() },
      shardBy: "id",
      returns: v.null(),
      handler: (_ctx, args) => {
        void args.id;
        return null;
      },
    });
    expect(fn.argsJson).toBeDefined();
    expect(fn.shardBy).toBe("id");
    expect(fn.returnsJson).toMatchObject({ type: "null" });
  });
});
