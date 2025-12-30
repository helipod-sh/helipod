import { describe, it, expect } from "vitest";
import { byIdChangesFor, byIdResetChanges } from "../src/commit-differ";
import { applyChanges, driftChecksum, type RowVersion } from "../src/change";
import type { WrittenDoc } from "@stackbase/transactor";

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
