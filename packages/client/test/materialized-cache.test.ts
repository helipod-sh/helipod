import { describe, it, expect } from "vitest";
import { LayeredQueryStore } from "../src/layered-store";
import { Reconciler } from "../src/reconcile";
import { driftChecksum, type Change, type RowVersion, type StateModification } from "@stackbase/sync";

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

describe("LayeredQueryStore.applyDiff — page mode (DLR 2c)", () => {
  it("a page reset renders { page: sorted rows, nextCursor, hasMore }; add grows it, remove shrinks it", () => {
    const s = new LayeredQueryStore();
    const sub = s.create(1, "items:page", { channelId: "c" }, "h1");
    s.applyDiff(
      sub,
      [
        { t: "add", key: "b", row: { _id: "b", n: 2 }, ts: 5, orderKey: orderKeyB64([2]) },
        { t: "add", key: "a", row: { _id: "a", n: 1 }, ts: 5, orderKey: orderKeyB64([1]) },
      ],
      ck2([
        ["b", { row: { _id: "b", n: 2 }, ts: 5, orderKey: orderKeyB64([2]) }],
        ["a", { row: { _id: "a", n: 1 }, ts: 5, orderKey: orderKeyB64([1]) }],
      ]),
      { mode: "page", orderDir: "asc", nextCursor: "CUR", hasMore: true, scanCapped: false },
    );
    const v = sub.serverValue as { page: Array<{ _id: string }>; nextCursor: string; hasMore: boolean };
    expect(v.page.map((d) => d._id)).toEqual(["a", "b"]);
    expect(v.nextCursor).toBe("CUR");
    expect(v.hasMore).toBe(true);

    // an in-bounds insert grows the page (row count exceeds the initial size — correct reactive semantics)
    s.applyDiff(
      sub,
      [{ t: "add", key: "c", row: { _id: "c", n: 3 }, ts: 6, orderKey: orderKeyB64([3]) }],
      ck2([
        ["a", { row: { _id: "a", n: 1 }, ts: 5, orderKey: orderKeyB64([1]) }],
        ["b", { row: { _id: "b", n: 2 }, ts: 5, orderKey: orderKeyB64([2]) }],
        ["c", { row: { _id: "c", n: 3 }, ts: 6, orderKey: orderKeyB64([3]) }],
      ]),
    );
    expect((sub.serverValue as any).page.map((d: any) => d._id)).toEqual(["a", "b", "c"]);
    expect((sub.serverValue as any).nextCursor).toBe("CUR"); // metadata fixed across incremental diffs

    const before = sub.serverValue;
    s.applyDiff(
      sub,
      [{ t: "remove", key: "a" }],
      ck2([
        ["b", { row: { _id: "b", n: 2 }, ts: 5, orderKey: orderKeyB64([2]) }],
        ["c", { row: { _id: "c", n: 3 }, ts: 6, orderKey: orderKeyB64([3]) }],
      ]),
    );
    expect(sub.serverValue).not.toBe(before); // fresh object
    expect((sub.serverValue as any).page.map((d: any) => d._id)).toEqual(["b", "c"]);
  });

  it("an empty page renders { page: [], ...metadata }", () => {
    const s = new LayeredQueryStore();
    const sub = s.create(1, "items:page", { channelId: "c" }, "h1");
    s.applyDiff(sub, [], driftChecksum(new Map()), {
      mode: "page",
      orderDir: "asc",
      nextCursor: null,
      hasMore: false,
      scanCapped: false,
    });
    expect(sub.serverValue).toEqual({ page: [], nextCursor: null, hasMore: false, scanCapped: false });
  });
});

// Finding 2 (DLR 2b final review): a range sub that receives a `QueryUpdated` (the RERUN answer the
// server sends on a SetAuth identity switch — it drops its server-side row-map) must NOT keep its
// prior-identity `diffRows`/`renderMode`, or the NEXT incremental `QueryDiff` merges the new
// identity's write onto the OLD identity's rows and briefly renders the prior user's data (a
// transient cross-identity leak on an auth-scoped range query) until drift-resync heals.
describe("range sub SetAuth staleness (Finding 2)", () => {
  it("a QueryUpdated reverts a range sub to RERUN rendering; a following incremental diff resyncs and never renders the prior identity's rows", () => {
    const store = new LayeredQueryStore();
    const drifted: number[] = [];
    const rec = new Reconciler(store, { onDrift: (qid) => drifted.push(qid) });

    // Subscribe under identity A: a range reset with two rows owned by A.
    const sub = store.create(1, "items:list", { channelId: "c" }, "h1");
    const rendered: unknown[] = [];
    sub.listeners.add({ onUpdate: (v) => rendered.push(v) });

    const okA1 = orderKeyB64([1]);
    const okA2 = orderKeyB64([2]);
    const resetChanges: Change[] = [
      { t: "add", key: "a1", row: { _id: "a1", owner: "A" }, ts: 5, orderKey: okA1 },
      { t: "add", key: "a2", row: { _id: "a2", owner: "A" }, ts: 5, orderKey: okA2 },
    ];
    rec.ingestTransition(
      [
        {
          type: "QueryDiff",
          queryId: 1,
          changes: resetChanges,
          checksum: ck2([
            ["a1", { row: { _id: "a1", owner: "A" }, ts: 5, orderKey: okA1 }],
            ["a2", { row: { _id: "a2", owner: "A" }, ts: 5, orderKey: okA2 }],
          ]),
          reset: { mode: "range", orderDir: "asc" },
        } satisfies StateModification,
      ],
      5,
    );
    expect(sub.renderMode).toBe("range");
    expect((sub.serverValue as Array<{ _id: string }>).map((d) => d._id)).toEqual(["a1", "a2"]);

    // SetAuth to identity B: the server RERUNs and sends a `QueryUpdated` with B's (here empty) value.
    rec.ingestTransition(
      [{ type: "QueryUpdated", queryId: 1, value: [], hash: "hB" } satisfies StateModification],
      5,
    );
    // The fix: the sub reverted to plain RERUN rendering — prior-identity diff state is gone.
    expect(sub.renderMode).toBeUndefined();
    expect(sub.diffRows).toBeUndefined();
    expect(sub.serverValue).toEqual([]);

    // Next commit under identity B: the server (its row-map dropped) emits an INCREMENTAL diff off an
    // empty map — only the newly-written B doc. A correct checksum is supplied so the ONLY thing that
    // could surface A's rows pre-fix is the stale-map merge, not a checksum drift.
    const okB1 = orderKeyB64([3]);
    rec.ingestTransition(
      [
        {
          type: "QueryDiff",
          queryId: 1,
          changes: [{ t: "add", key: "b1", row: { _id: "b1", owner: "B" }, ts: 6, orderKey: okB1 }],
          // Checksum for the map the server actually holds (empty base + b1) — pre-fix the client
          // instead merges onto {a1,a2,b1}, so this is deliberately NOT that map's checksum; but the
          // fix means applyDiff is never reached, so the checksum is moot on the post-fix path.
          checksum: ck2([["b1", { row: { _id: "b1", owner: "B" }, ts: 6, orderKey: okB1 }]]),
        } satisfies StateModification,
      ],
      6,
    );

    // Post-fix: the incremental diff hit the uninitialized-render-mode guard → a resync was requested,
    // and serverValue was left as B's empty RERUN value — A's rows never reappear.
    expect(drifted).toContain(1);
    const finalIds = Array.isArray(sub.serverValue)
      ? (sub.serverValue as Array<{ _id: string }>).map((d) => d._id)
      : [];
    expect(finalIds).not.toContain("a1");
    expect(finalIds).not.toContain("a2");
    // Sanity on the rendered stream: the only frame that legitimately carried A's rows was the very
    // first (identity-A reset) push — every later frame must be free of them.
    const framesAfterFirst = rendered.slice(1);
    for (const frame of framesAfterFirst) {
      const ids = Array.isArray(frame) ? (frame as Array<{ _id: string }>).map((d) => d._id) : [];
      expect(ids).not.toContain("a1");
      expect(ids).not.toContain("a2");
    }
  });
});
