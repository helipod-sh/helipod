import { describe, it, expect } from "vitest";
import { applyChanges, driftChecksum, type Change, type RowVersion } from "../src/change";

const rv = (row: unknown, ts: number): RowVersion => ({ row: row as never, ts });

describe("applyChanges", () => {
  it("add inserts a new keyed row", () => {
    const out = applyChanges(new Map(), [{ t: "add", key: "a", row: { _id: "a", n: 1 }, ts: 5 }]);
    expect(out.get("a")).toEqual({ row: { _id: "a", n: 1 }, ts: 5 });
    expect(out.size).toBe(1);
  });
  it("edit replaces the row + ts", () => {
    const base = new Map<string, RowVersion>([["a", rv({ _id: "a", n: 1 }, 5)]]);
    const out = applyChanges(base, [{ t: "edit", key: "a", row: { _id: "a", n: 2 }, ts: 7 }]);
    expect(out.get("a")).toEqual({ row: { _id: "a", n: 2 }, ts: 7 });
  });
  it("remove deletes the key", () => {
    const base = new Map<string, RowVersion>([["a", rv({ _id: "a" }, 5)]]);
    const out = applyChanges(base, [{ t: "remove", key: "a" }]);
    expect(out.has("a")).toBe(false);
    expect(out.size).toBe(0);
  });
  it("is copy-on-write (input map untouched)", () => {
    const base = new Map<string, RowVersion>([["a", rv({ _id: "a" }, 5)]]);
    applyChanges(base, [{ t: "remove", key: "a" }]);
    expect(base.has("a")).toBe(true);
  });
  it("empty changes returns an equal map", () => {
    const base = new Map<string, RowVersion>([["a", rv({ _id: "a" }, 5)]]);
    const out = applyChanges(base, []);
    expect([...out.entries()]).toEqual([...base.entries()]);
  });
});

describe("driftChecksum", () => {
  it("is order-independent over the same rows", () => {
    const m1 = new Map<string, RowVersion>([["a", rv({}, 1)], ["b", rv({}, 2)]]);
    const m2 = new Map<string, RowVersion>([["b", rv({}, 2)], ["a", rv({}, 1)]]);
    expect(driftChecksum(m1)).toBe(driftChecksum(m2));
  });
  it("changes when a row's ts changes", () => {
    const m1 = new Map<string, RowVersion>([["a", rv({}, 1)]]);
    const m2 = new Map<string, RowVersion>([["a", rv({}, 2)]]);
    expect(driftChecksum(m1)).not.toBe(driftChecksum(m2));
  });
  it("empty map has a stable checksum", () => {
    expect(driftChecksum(new Map())).toBe(driftChecksum(new Map()));
  });
});

describe("orderKey (DLR 2b)", () => {
  it("applyChanges stores orderKey on the row", () => {
    const out = applyChanges(new Map(), [{ t: "add", key: "a", row: { _id: "a" }, ts: 5, orderKey: "AAAB" }]);
    expect(out.get("a")).toEqual({ row: { _id: "a" }, ts: 5, orderKey: "AAAB" });
  });
  it("a move (same key+ts, new orderKey) changes the checksum", () => {
    const m1 = applyChanges(new Map(), [{ t: "add", key: "a", row: {}, ts: 5, orderKey: "AAAB" }]);
    const m2 = applyChanges(new Map(), [{ t: "add", key: "a", row: {}, ts: 5, orderKey: "AAAC" }]);
    expect(driftChecksum(m1)).not.toBe(driftChecksum(m2));
  });
  it("by-id changes (no orderKey) keep the SAME checksum as before this change", () => {
    // orderKey === undefined must fold identically to orderKey === "" — a by-id map is unchanged.
    const byId = applyChanges(new Map(), [{ t: "add", key: "n1", row: { _id: "n1", n: 1 }, ts: 5 }]);
    const explicitEmpty = applyChanges(new Map(), [{ t: "add", key: "n1", row: { _id: "n1", n: 1 }, ts: 5, orderKey: "" }]);
    expect(driftChecksum(byId)).toBe(driftChecksum(explicitEmpty));
  });
});
