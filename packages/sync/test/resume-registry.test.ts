import { describe, it, expect } from "vitest";
import { ResumeRegistry, regKey, TTL_MS } from "../src/resume-registry";
import { indexKeyspaceId, keySuccessor, serializeKeyRange, type SerializedKeyRange } from "@helipod/index-key-codec";

/** A point range in the `notes` table's `by_<field>` index for a given value. */
function rangeFor(field: string, value: string): SerializedKeyRange {
  const start = new TextEncoder().encode(value);
  return serializeKeyRange({ keyspace: indexKeyspaceId("notes", `by_${field}`), start, end: keySuccessor(start) });
}

describe("ResumeRegistry", () => {
  it("upsert then a NON-intersecting commit leaves lastInvalidatedTs; an intersecting commit advances it", () => {
    const r = new ResumeRegistry();
    const k = regKey("u1", "notes:list", { box: "a" });
    r.upsert(k, [rangeFor("box", "a")], ["notes"], 3, false);
    r.advanceOnCommit([rangeFor("box", "b")], ["notes"], 5); // different box → no intersect
    expect(r.lookup(k)!.lastInvalidatedTs).toBe(3);
    r.advanceOnCommit([rangeFor("box", "a")], ["notes"], 7); // same box → intersect
    expect(r.lookup(k)!.lastInvalidatedTs).toBe(7);
  });

  it("retain/release + TTL sweep evicts a query with no live subs after TTL, not before", () => {
    const r = new ResumeRegistry();
    const k = regKey("u1", "notes:list", { box: "a" });
    r.upsert(k, [rangeFor("box", "a")], ["notes"], 1, false);
    r.retain(k);
    r.release(k, 1000);
    r.sweep(1000 + TTL_MS - 1_000); // within TTL
    expect(r.lookup(k)).toBeDefined();
    r.sweep(1000 + TTL_MS + 1_000); // past TTL
    expect(r.lookup(k)).toBeUndefined();
  });

  it("a released (0 refcount) entry still advances on an intersecting commit (gap invalidation)", () => {
    const r = new ResumeRegistry();
    const k = regKey("u1", "notes:list", { box: "a" });
    r.upsert(k, [rangeFor("box", "a")], ["notes"], 1, false);
    r.retain(k);
    r.release(k, 1000);
    r.advanceOnCommit([rangeFor("box", "a")], ["notes"], 9); // commit during the "gap"
    expect(r.lookup(k)!.lastInvalidatedTs).toBe(9); // advanced even with 0 live subs
  });

  it("wasDiffable is recorded", () => {
    const r = new ResumeRegistry();
    const k1 = regKey("u1", "notes:list", { box: "a" });
    const k2 = regKey("u1", "notes:count", { box: "a" });
    r.upsert(k1, [rangeFor("box", "a")], ["notes"], 1, true);
    r.upsert(k2, [rangeFor("box", "a")], ["notes"], 1, false);
    expect(r.lookup(k1)!.wasDiffable).toBe(true);
    expect(r.lookup(k2)!.wasDiffable).toBe(false);
  });

  it("retain clears a pending expiresAtMs (re-subscribing before TTL keeps the entry alive)", () => {
    const r = new ResumeRegistry();
    const k = regKey("u1", "notes:list", { box: "a" });
    r.upsert(k, [rangeFor("box", "a")], ["notes"], 1, false);
    r.retain(k);
    r.release(k, 1000);
    r.retain(k); // re-subscribe within the gap
    r.sweep(1000 + TTL_MS + 1_000); // would have evicted if still pending expiry
    expect(r.lookup(k)).toBeDefined();
  });

  it("a re-upsert re-indexes ranges so a commit against the OLD range no longer matches", () => {
    const r = new ResumeRegistry();
    const k = regKey("u1", "notes:list", { box: "a" });
    r.upsert(k, [rangeFor("box", "a")], ["notes"], 1, false);
    r.upsert(k, [rangeFor("box", "b")], ["notes"], 2, false); // now reads box "b" instead
    r.advanceOnCommit([rangeFor("box", "a")], ["notes"], 50); // old range → should NOT match
    expect(r.lookup(k)!.lastInvalidatedTs).toBe(2);
    r.advanceOnCommit([rangeFor("box", "b")], ["notes"], 60); // new range → matches
    expect(r.lookup(k)!.lastInvalidatedTs).toBe(60);
  });

  it("upsert takes the max of existing lastInvalidatedTs and atTs", () => {
    const r = new ResumeRegistry();
    const k = regKey("u1", "notes:list", { box: "a" });
    r.upsert(k, [rangeFor("box", "a")], ["notes"], 5, false);
    r.advanceOnCommit([rangeFor("box", "a")], ["notes"], 20);
    expect(r.lookup(k)!.lastInvalidatedTs).toBe(20);
    r.upsert(k, [rangeFor("box", "a")], ["notes"], 10, false); // atTs (10) < current (20)
    expect(r.lookup(k)!.lastInvalidatedTs).toBe(20);
  });
});
