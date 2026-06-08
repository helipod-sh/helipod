import { describe, it, expect } from "vitest";
import { defineTable, v } from "../src/index";

describe("defineTable().global()", () => {
  it("marks the table global in exported JSON", () => {
    const t = defineTable({ handle: v.string() }).global().index("by_handle", ["handle"], { unique: true });
    expect(t.export().global).toBe(true);
  });
  it("a non-global table omits the `global` key (back-compat: not `false`)", () => {
    const t = defineTable({ x: v.string() });
    expect("global" in t.export()).toBe(false);
  });
  it(".global() and .shardKey() are mutually exclusive (throws)", () => {
    expect(() => defineTable({ room: v.string() }).shardKey("room").global()).toThrow(/global.*shard|shard.*global/i);
    expect(() => defineTable({ room: v.string() }).global().shardKey("room")).toThrow(/global.*shard|shard.*global/i);
  });
});
