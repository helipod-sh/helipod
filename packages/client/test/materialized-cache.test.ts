import { describe, it, expect } from "vitest";
import { LayeredQueryStore } from "../src/layered-store";
import { driftChecksum, type Change, type RowVersion } from "@stackbase/sync";

function ck(rows: [string, RowVersion][]): string {
  return driftChecksum(new Map(rows));
}

// Same helper as `ck` — kept as a distinct name in the range describe block below purely to mirror
// the task brief's test sketch; `RowVersion` already carries `orderKey`, so no separate shape is
// needed.
const ck2 = ck;

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

/** Builds a `base64ToBytes`-decodable `orderKey` from raw bytes, so tests reason about actual byte
 *  ordering (via `compareKeyBytes`) rather than hand-guessed base64 letters — exercises the exact
 *  decode path `renderRangeValue` uses (`@stackbase/index-key-codec`'s `base64ToBytes`, the mirror
 *  of `bytesToBase64` the server's `orderKeyFor` encodes through). */
function orderKeyB64(bytes: number[]): string {
  return Buffer.from(bytes).toString("base64");
}

describe("LayeredQueryStore.applyDiff — range mode (DLR 2b)", () => {
  it("a range reset renders a sorted array; edits/moves re-sort; removes drop", () => {
    const s = new LayeredQueryStore();
    const sub = s.create(1, "items:list", { channelId: "c" }, "h1");
    // Reset with two docs, orderKeys deliberately out of insertion order to prove sorting (not
    // insertion order) drives the rendered array.
    const okB1 = orderKeyB64([2]);
    const okA1 = orderKeyB64([1]);
    s.applyDiff(
      sub,
      [
        { t: "add", key: "b", row: { _id: "b", n: 2 }, ts: 5, orderKey: okB1 },
        { t: "add", key: "a", row: { _id: "a", n: 1 }, ts: 5, orderKey: okA1 },
      ],
      ck2([
        ["b", { row: { _id: "b", n: 2 }, ts: 5, orderKey: okB1 }],
        ["a", { row: { _id: "a", n: 1 }, ts: 5, orderKey: okA1 }],
      ]),
      { mode: "range", orderDir: "asc" },
    );
    expect((sub.serverValue as Array<{ _id: string }>).map((d) => d._id)).toEqual(["a", "b"]);

    // A move: b's orderKey now sorts before a's.
    const okB2 = orderKeyB64([0]);
    s.applyDiff(
      sub,
      [{ t: "edit", key: "b", row: { _id: "b", n: 2 }, ts: 6, orderKey: okB2 }],
      ck2([
        ["a", { row: { _id: "a", n: 1 }, ts: 5, orderKey: okA1 }],
        ["b", { row: { _id: "b", n: 2 }, ts: 6, orderKey: okB2 }],
      ]),
    );
    expect((sub.serverValue as Array<{ _id: string }>).map((d) => d._id)).toEqual(["b", "a"]);

    const before = sub.serverValue;
    s.applyDiff(
      sub,
      [{ t: "remove", key: "a" }],
      ck2([["b", { row: { _id: "b", n: 2 }, ts: 6, orderKey: okB2 }]]),
    );
    expect(sub.serverValue).not.toBe(before); // fresh array reference
    expect((sub.serverValue as Array<{ _id: string }>).map((d) => d._id)).toEqual(["b"]);
  });

  it("an empty range reset renders []", () => {
    const s = new LayeredQueryStore();
    const sub = s.create(1, "items:list", { channelId: "c" }, "h1");
    s.applyDiff(sub, [], driftChecksum(new Map()), { mode: "range", orderDir: "asc" });
    expect(sub.serverValue).toEqual([]);
  });

  it("descending orderDir reverses the sort", () => {
    const s = new LayeredQueryStore();
    const sub = s.create(1, "items:list", { channelId: "c" }, "h1");
    const okA = orderKeyB64([1]);
    const okB = orderKeyB64([2]);
    s.applyDiff(
      sub,
      [
        { t: "add", key: "a", row: { _id: "a" }, ts: 5, orderKey: okA },
        { t: "add", key: "b", row: { _id: "b" }, ts: 5, orderKey: okB },
      ],
      ck2([
        ["a", { row: { _id: "a" }, ts: 5, orderKey: okA }],
        ["b", { row: { _id: "b" }, ts: 5, orderKey: okB }],
      ]),
      { mode: "range", orderDir: "desc" },
    );
    expect((sub.serverValue as Array<{ _id: string }>).map((d) => d._id)).toEqual(["b", "a"]);
  });

  it("clear-on-reset: a SECOND range reset starts from an empty map, dropping stale rows rather than merging", () => {
    const s = new LayeredQueryStore();
    const sub = s.create(1, "items:list", { channelId: "c" }, "h1");
    const okA = orderKeyB64([1]);
    const okB = orderKeyB64([2]);
    // First reset: {a, b}.
    s.applyDiff(
      sub,
      [
        { t: "add", key: "a", row: { _id: "a" }, ts: 5, orderKey: okA },
        { t: "add", key: "b", row: { _id: "b" }, ts: 5, orderKey: okB },
      ],
      ck2([
        ["a", { row: { _id: "a" }, ts: 5, orderKey: okA }],
        ["b", { row: { _id: "b" }, ts: 5, orderKey: okB }],
      ]),
      { mode: "range", orderDir: "asc" },
    );
    expect((sub.serverValue as Array<{ _id: string }>).map((d) => d._id)).toEqual(["a", "b"]);

    // Second reset (a resync — e.g. after a drift or table-invalidation resubscribe): only {a} this
    // time. If `applyDiff` merged onto the running `diffRows` instead of clearing, `b` would wrongly
    // survive as a stale row.
    s.applyDiff(
      sub,
      [{ t: "add", key: "a", row: { _id: "a" }, ts: 9, orderKey: okA }],
      ck2([["a", { row: { _id: "a" }, ts: 9, orderKey: okA }]]),
      { mode: "range", orderDir: "asc" },
    );
    expect((sub.serverValue as Array<{ _id: string }>).map((d) => d._id)).toEqual(["a"]);
  });

  it("a by-id reset (reset: true) still clears — unaffected in practice since it's always add-all of the single current doc", () => {
    const s = new LayeredQueryStore();
    const sub = s.create(1, "notes:get", { id: "n1" }, "h1");
    s.applyDiff(sub, [{ t: "add", key: "n1", row: { _id: "n1", n: 1 }, ts: 5 }], ck([["n1", { row: { _id: "n1", n: 1 }, ts: 5 }]]), true);
    expect(sub.serverValue).toEqual({ _id: "n1", n: 1 });
    expect(sub.renderMode).toBe("byid");
    // A second by-id reset for a DIFFERENT doc id (simulating the subscribed id itself changing)
    // must not leave the old doc behind.
    s.applyDiff(sub, [{ t: "add", key: "n2", row: { _id: "n2", n: 2 }, ts: 6 }], ck([["n2", { row: { _id: "n2", n: 2 }, ts: 6 }]]), true);
    expect(sub.serverValue).toEqual({ _id: "n2", n: 2 });
  });
});
