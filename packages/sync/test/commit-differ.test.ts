import { describe, it, expect } from "vitest";
import { byIdChangesFor, byIdResetChanges, rangeChangesFor, rangeResetChanges, orderKeyFor } from "../src/commit-differ";
import { applyChanges, driftChecksum, type RowVersion } from "../src/change";
import type { RangeRead } from "../src/classify";
import type { WrittenDoc } from "@helipod/transactor";
import type { FilterExpr } from "@helipod/query-engine";
import { serializeKeyRange, indexKeyRangeStart, indexKeyRangeEnd, indexKeyspaceId } from "@helipod/index-key-codec";

const byId = { keyspace: "table:3", key: "AAE=", docId: "docs|a" };
const wd = (newRow: unknown, wasPresent: boolean, ts: number): WrittenDoc =>
  ({ key: "AAE=", keyspace: "table:3", docId: "docs|a", newRow: newRow as never, wasPresent, ts });

describe("byIdChangesFor (server CommitDiffer)", () => {
  it("insert: absent -> present emits add", () => {
    const { changes, next } = byIdChangesFor(byId as never, new Map(), wd({ _id: "docs|a", n: 1 }, false, 5));
    expect(changes).toEqual([{ t: "add", key: "docs|a", row: { _id: "docs|a", n: 1 }, ts: 5 }]);
    expect(next.get("docs|a")).toEqual({ row: { _id: "docs|a", n: 1 }, ts: 5 });
  });
  it("update: present -> present emits edit", () => {
    const prev = new Map<string, RowVersion>([["docs|a", { row: { _id: "docs|a", n: 1 }, ts: 5 }]]);
    const { changes } = byIdChangesFor(byId as never, prev, wd({ _id: "docs|a", n: 2 }, true, 7));
    expect(changes).toEqual([{ t: "edit", key: "docs|a", row: { _id: "docs|a", n: 2 }, ts: 7 }]);
  });
  it("delete: present -> tombstone emits remove", () => {
    const prev = new Map<string, RowVersion>([["docs|a", { row: { _id: "docs|a" }, ts: 5 }]]);
    const { changes, next } = byIdChangesFor(byId as never, prev, wd(null, true, 9));
    expect(changes).toEqual([{ t: "remove", key: "docs|a" }]);
    expect(next.size).toBe(0);
  });
  it("undefined written doc: no matching write => no-op", () => {
    const prev = new Map<string, RowVersion>([["docs|a", { row: { _id: "docs|a", n: 1 }, ts: 5 }]]);
    const { changes, next } = byIdChangesFor(byId as never, prev, undefined);
    expect(changes).toEqual([]);
    expect(next).toBe(prev);
  });
  it("diff+apply equals the intended next map, checksum matches", () => {
    const prev = new Map<string, RowVersion>();
    const { changes, next } = byIdChangesFor(byId as never, prev, wd({ _id: "docs|a", n: 1 }, false, 5));
    expect([...applyChanges(prev, changes).entries()]).toEqual([...next.entries()]);
    expect(driftChecksum(next)).toBe(driftChecksum(applyChanges(prev, changes)));
  });
  it("a sequence of insert/update/delete: applied map always equals the true current state", () => {
    let prev = new Map<string, RowVersion>();
    const commits: Array<{ newRow: unknown; wasPresent: boolean; ts: number }> = [
      { newRow: { _id: "docs|a", n: 1 }, wasPresent: false, ts: 1 },
      { newRow: { _id: "docs|a", n: 2 }, wasPresent: true, ts: 2 },
      { newRow: { _id: "docs|a", n: 3 }, wasPresent: true, ts: 3 },
      { newRow: null, wasPresent: true, ts: 4 },
      { newRow: { _id: "docs|a", n: 4 }, wasPresent: false, ts: 5 },
    ];
    for (const c of commits) {
      const { changes, next } = byIdChangesFor(byId as never, prev, wd(c.newRow, c.wasPresent, c.ts));
      const applied = applyChanges(prev, changes);
      expect([...applied.entries()]).toEqual([...next.entries()]);
      // "re-run" oracle: the true current state is exactly {docId: {row: newRow, ts}} or absent.
      const trueState = new Map<string, RowVersion>();
      if (c.newRow !== null) trueState.set("docs|a", { row: c.newRow as never, ts: c.ts });
      expect([...next.entries()]).toEqual([...trueState.entries()]);
      expect(driftChecksum(next)).toBe(driftChecksum(trueState));
      prev = next;
    }
  });
});

describe("byIdResetChanges", () => {
  it("present doc: emits an add over an empty map", () => {
    const { changes, next } = byIdResetChanges("docs|a", { _id: "docs|a", n: 1 }, 5);
    expect(changes).toEqual([{ t: "add", key: "docs|a", row: { _id: "docs|a", n: 1 }, ts: 5 }]);
    expect(next.get("docs|a")).toEqual({ row: { _id: "docs|a", n: 1 }, ts: 5 });
    expect(driftChecksum(next)).toBe(driftChecksum(applyChanges(new Map(), changes)));
  });
  it("absent doc (null): emits no changes, empty map", () => {
    const { changes, next } = byIdResetChanges("docs|a", null, 5);
    expect(changes).toEqual([]);
    expect(next.size).toBe(0);
    expect(driftChecksum(next)).toBe(driftChecksum(new Map()));
  });
});

// ---------------------------------------------------------------------------------------------
// rangeChangesFor / rangeResetChanges (DIFFABLE_RANGE, DLR 2b)
// ---------------------------------------------------------------------------------------------

const CHANNEL_KEYSPACE = indexKeyspaceId("3", "by_channel");

/** A range covering `channelId = "c"` over the single-field index `["channelId"]` — the fixture
 *  the brief calls for. `filters` defaults to `[]`; override per test. */
function channelRange(filters: FilterExpr[] = []): RangeRead {
  return {
    keyspace: CHANNEL_KEYSPACE,
    bounds: serializeKeyRange({
      keyspace: CHANNEL_KEYSPACE,
      start: indexKeyRangeStart(["c"]),
      end: indexKeyRangeEnd(["c"])!, // non-empty prefix => never null
    }),
    filters,
    order: "asc",
    fields: ["channelId"],
  };
}

const row = (id: string, channelId: string, n: number, ct = 100) => ({ _id: id, channelId, n, _creationTime: ct });

/** A `WrittenDoc` for the range differ — `key`/`keyspace`/`wasPresent` are unused by
 *  `rangeChangesFor` (only `docId`/`newRow`/`ts` and `prev.has(docId)` drive the membership diff),
 *  filled with plausible placeholder values. */
const rwd = (docId: string, newRow: unknown, ts: number): WrittenDoc =>
  ({ key: "x", keyspace: "table:3", docId, newRow: newRow as never, wasPresent: true, ts });

describe("orderKeyFor", () => {
  it("is deterministic and ignores fields not in `range.fields` (+ the system tiebreak)", () => {
    const range = channelRange();
    const a = row("docs|a", "c", 1);
    const b = row("docs|a", "c", 999); // same _id/channelId/_creationTime, different `n`
    expect(orderKeyFor(range, a)).toBe(orderKeyFor(range, b));
  });
  it("differs when the index field, _creationTime, or _id differs", () => {
    const range = channelRange();
    const base = orderKeyFor(range, row("docs|a", "c", 1, 100));
    expect(orderKeyFor(range, row("docs|b", "c", 1, 100))).not.toBe(base); // different _id
    expect(orderKeyFor(range, row("docs|a", "c", 1, 200))).not.toBe(base); // different _creationTime
  });
});

describe("rangeChangesFor (server CommitDiffer)", () => {
  it("add: a new in-range doc not previously tracked emits add", () => {
    const range = channelRange();
    const prev = new Map<string, RowVersion>();
    const newRow = row("docs|a", "c", 1);
    const { changes, next } = rangeChangesFor(range, prev, [rwd("docs|a", newRow, 5)]);
    const ok = orderKeyFor(range, newRow);
    expect(changes).toEqual([{ t: "add", key: "docs|a", row: newRow, ts: 5, orderKey: ok }]);
    expect(next.get("docs|a")).toEqual({ row: newRow, ts: 5, orderKey: ok });
  });

  it("edit: an in-range value change (non-index field) emits edit with orderKey unchanged", () => {
    const range = channelRange();
    const oldRow = row("docs|a", "c", 1);
    const prev = new Map<string, RowVersion>([["docs|a", { row: oldRow, ts: 1, orderKey: orderKeyFor(range, oldRow) }]]);
    const newRow = row("docs|a", "c", 2); // only `n` changes
    const { changes, next } = rangeChangesFor(range, prev, [rwd("docs|a", newRow, 6)]);
    const ok = orderKeyFor(range, newRow);
    expect(ok).toBe(orderKeyFor(range, oldRow));
    expect(changes).toEqual([{ t: "edit", key: "docs|a", row: newRow, ts: 6, orderKey: ok }]);
    expect(next.get("docs|a")).toEqual({ row: newRow, ts: 6, orderKey: ok });
  });

  it("remove: a delete (newRow: null) emits remove", () => {
    const range = channelRange();
    const oldRow = row("docs|a", "c", 1);
    const prev = new Map<string, RowVersion>([["docs|a", { row: oldRow, ts: 1, orderKey: orderKeyFor(range, oldRow) }]]);
    const { changes, next } = rangeChangesFor(range, prev, [rwd("docs|a", null, 7)]);
    expect(changes).toEqual([{ t: "remove", key: "docs|a" }]);
    expect(next.size).toBe(0);
  });

  it("cross-out: a write that now fails the range's `.where` filter emits remove", () => {
    const range = channelRange([{ op: "gt", field: "n", value: 1 }]);
    const oldRow = row("docs|a", "c", 2); // n=2 passes gt 1
    const prev = new Map<string, RowVersion>([["docs|a", { row: oldRow, ts: 1, orderKey: orderKeyFor(range, oldRow) }]]);
    const newRow = row("docs|a", "c", 1); // n=1 now fails gt 1
    const { changes, next } = rangeChangesFor(range, prev, [rwd("docs|a", newRow, 8)]);
    expect(changes).toEqual([{ t: "remove", key: "docs|a" }]);
    expect(next.size).toBe(0);
  });

  it("cross-in: a write that now passes the range's `.where` filter emits add", () => {
    const range = channelRange([{ op: "gt", field: "n", value: 1 }]);
    const prev = new Map<string, RowVersion>(); // wasn't tracked — it was failing the filter before
    const newRow = row("docs|a", "c", 5); // n=5 now passes gt 1
    const { changes, next } = rangeChangesFor(range, prev, [rwd("docs|a", newRow, 9)]);
    const ok = orderKeyFor(range, newRow);
    expect(changes).toEqual([{ t: "add", key: "docs|a", row: newRow, ts: 9, orderKey: ok }]);
    expect(next.get("docs|a")).toEqual({ row: newRow, ts: 9, orderKey: ok });
  });

  it("move: an index-field change that reorders within the range emits edit with a different orderKey", () => {
    // A 2-field index (channelId, priority) with an eq-only bound on channelId — the standard
    // "filter one field, order by another" shape. Updating `priority` keeps the doc inside the
    // channelId="c" bound (a single-field range can't demonstrate a move: an eq bound covering
    // the whole key leaves nothing else to reorder by).
    const keyspace = indexKeyspaceId("3", "by_channel_priority");
    const range: RangeRead = {
      keyspace,
      bounds: serializeKeyRange({ keyspace, start: indexKeyRangeStart(["c"]), end: indexKeyRangeEnd(["c"])! }),
      filters: [],
      order: "asc",
      fields: ["channelId", "priority"],
    };
    const prow = (id: string, channelId: string, priority: number, ct = 100) => ({ _id: id, channelId, priority, _creationTime: ct });
    const oldRow = prow("docs|a", "c", 1);
    const prev = new Map<string, RowVersion>([["docs|a", { row: oldRow, ts: 1, orderKey: orderKeyFor(range, oldRow) }]]);
    const newRow = prow("docs|a", "c", 9); // priority 1 -> 9, channelId unchanged
    const { changes, next } = rangeChangesFor(range, prev, [rwd("docs|a", newRow, 10)]);
    const oldKey = orderKeyFor(range, oldRow);
    const newKey = orderKeyFor(range, newRow);
    expect(newKey).not.toBe(oldKey);
    expect(changes).toEqual([{ t: "edit", key: "docs|a", row: newRow, ts: 10, orderKey: newKey }]);
    expect(next.get("docs|a")).toEqual({ row: newRow, ts: 10, orderKey: newKey });
  });

  it("no-op: a write to a doc outside the range (different channel), never tracked, emits nothing", () => {
    const range = channelRange();
    const prev = new Map<string, RowVersion>();
    const newRow = row("docs|z", "other-channel", 1);
    const { changes, next } = rangeChangesFor(range, prev, [rwd("docs|z", newRow, 11)]);
    expect(changes).toEqual([]);
    expect([...next.entries()]).toEqual([...prev.entries()]);
  });

  it("diff+apply equals applyChanges' own result, checksum matches", () => {
    const range = channelRange();
    const prev = new Map<string, RowVersion>();
    const newRow = row("docs|a", "c", 1);
    const { changes, next } = rangeChangesFor(range, prev, [rwd("docs|a", newRow, 5)]);
    expect([...applyChanges(prev, changes).entries()]).toEqual([...next.entries()]);
    expect(driftChecksum(next)).toBe(driftChecksum(applyChanges(prev, changes)));
  });
});

describe("rangeResetChanges (server CommitDiffer)", () => {
  it("emits one add per doc, in the given order, each carrying its orderKey", () => {
    const range = channelRange();
    const docs = [row("docs|a", "c", 1), row("docs|b", "c", 2)];
    const { changes, next } = rangeResetChanges(range, docs, 3);
    expect(changes).toEqual([
      { t: "add", key: "docs|a", row: docs[0], ts: 3, orderKey: orderKeyFor(range, docs[0]!) },
      { t: "add", key: "docs|b", row: docs[1], ts: 3, orderKey: orderKeyFor(range, docs[1]!) },
    ]);
    expect(next.size).toBe(2);
    expect(next.get("docs|a")).toEqual({ row: docs[0], ts: 3, orderKey: orderKeyFor(range, docs[0]!) });
  });
  it("empty result: no changes, empty map", () => {
    const range = channelRange();
    const { changes, next } = rangeResetChanges(range, [], 3);
    expect(changes).toEqual([]);
    expect(next.size).toBe(0);
  });
});
