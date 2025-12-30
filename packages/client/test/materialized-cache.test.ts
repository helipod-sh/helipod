import { describe, it, expect } from "vitest";
import { LayeredQueryStore } from "../src/layered-store";
import { driftChecksum, type Change, type RowVersion } from "@stackbase/sync";

function ck(rows: [string, RowVersion][]): string {
  return driftChecksum(new Map(rows));
}

describe("LayeredQueryStore.applyDiff (by-id materialized cache)", () => {
  it("reset add renders the single doc; no drift", () => {
    const s = new LayeredQueryStore();
    const sub = s.create(1, "notes:get", { id: "n1" }, "h1");
    const changes: Change[] = [{ t: "add", key: "n1", row: { _id: "n1", n: 1 }, ts: 5 }];
    const { drift } = s.applyDiff(sub, changes, ck([["n1", { row: { _id: "n1", n: 1 }, ts: 5 }]]));
    expect(drift).toBe(false);
    expect(sub.serverValue).toEqual({ _id: "n1", n: 1 });
    expect(sub.answered).toBe(true);
  });

  it("edit produces a NEW serverValue reference", () => {
    const s = new LayeredQueryStore();
    const sub = s.create(1, "notes:get", { id: "n1" }, "h1");
    s.applyDiff(sub, [{ t: "add", key: "n1", row: { _id: "n1", n: 1 }, ts: 5 }], ck([["n1", { row: { _id: "n1", n: 1 }, ts: 5 }]]));
    const before = sub.serverValue;
    s.applyDiff(sub, [{ t: "edit", key: "n1", row: { _id: "n1", n: 2 }, ts: 7 }], ck([["n1", { row: { _id: "n1", n: 2 }, ts: 7 }]]));
    expect(sub.serverValue).not.toBe(before);
    expect(sub.serverValue).toEqual({ _id: "n1", n: 2 });
  });

  it("remove renders no value (undefined)", () => {
    const s = new LayeredQueryStore();
    const sub = s.create(1, "notes:get", { id: "n1" }, "h1");
    s.applyDiff(sub, [{ t: "add", key: "n1", row: { _id: "n1", n: 1 }, ts: 5 }], ck([["n1", { row: { _id: "n1", n: 1 }, ts: 5 }]]));
    const { drift } = s.applyDiff(sub, [{ t: "remove", key: "n1" }], ck([]));
    expect(drift).toBe(false);
    expect(sub.serverValue).toBeUndefined();
  });

  it("an empty reset (null doc) renders undefined; no drift", () => {
    const s = new LayeredQueryStore();
    const sub = s.create(1, "notes:get", { id: "n1" }, "h1");
    const { drift } = s.applyDiff(sub, [], ck([]));
    expect(drift).toBe(false);
    expect(sub.serverValue).toBeUndefined();
    expect(sub.answered).toBe(true);
  });

  it("a wrong checksum reports drift", () => {
    const s = new LayeredQueryStore();
    const sub = s.create(1, "notes:get", { id: "n1" }, "h1");
    const { drift } = s.applyDiff(sub, [{ t: "add", key: "n1", row: { _id: "n1", n: 1 }, ts: 5 }], "deadbeef");
    expect(drift).toBe(true);
  });
});
