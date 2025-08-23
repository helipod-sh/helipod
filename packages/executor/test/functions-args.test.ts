import { describe, it, expect } from "vitest";
import { v } from "@stackbase/values";
import { mutation, query, action } from "../src/functions";

describe("functions.ts — args validator surface", () => {
  it("a def with `args` carries a live argsValidator and its JSON", () => {
    const fn = mutation({
      args: { name: v.string(), age: v.number() },
      handler: (_ctx, args) => `${args.name}:${args.age}`,
    });
    expect(fn.type).toBe("mutation");
    expect(fn.argsValidator).toBeDefined();
    expect(fn.argsJson).toBeDefined();
    // The JSON round-trips as an object validator over the declared fields.
    expect(fn.argsJson).toMatchObject({ type: "object" });
    expect(Object.keys((fn.argsJson as { value: Record<string, unknown> }).value)).toEqual(["name", "age"]);
  });

  it("the bare-function form carries no validator", () => {
    const fn = query((_ctx, _args) => 1);
    expect(fn.type).toBe("query");
    expect(fn.argsValidator).toBeUndefined();
    expect(fn.argsJson).toBeUndefined();
  });

  it("the `{ handler }`-only form carries no validator", () => {
    const fn = action({ handler: async () => "ok" });
    expect(fn.type).toBe("action");
    expect(fn.argsValidator).toBeUndefined();
    expect(fn.argsJson).toBeUndefined();
  });

  it("infers the handler args param from the validator (compile-time)", () => {
    mutation({
      args: { flag: v.boolean() },
      handler: (_ctx, args) => {
        const b: boolean = args.flag; // typed as boolean via ObjectType inference
        // @ts-expect-error — `missing` is not a declared arg
        args.missing;
        return b;
      },
    });
    expect(true).toBe(true);
  });
});
