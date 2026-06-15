import { describe, it, expect } from "vitest";
import { SubscriptionManager } from "../src/subscription-manager";

const base = { sessionId: "s1", queryId: 1, udfPath: "q", args: {}, readRanges: [] as never[] };

describe("SubscriptionManager global-table matching", () => {
  it("matches a PURE-global sub (no ranges) by global table name", () => {
    const m = new SubscriptionManager();
    m.add({ ...base, tables: [], globalTables: ["users"] });
    expect(m.findAffectedByRanges([], ["users"]).map((s) => s.queryId)).toEqual([1]);
    expect(m.subscribedGlobalTables()).toEqual(["users"]);
  });
  it("matches a MIXED sub (has local ranges AND a global table) — the tableFallbackKeys gap fix", () => {
    const m = new SubscriptionManager();
    const localRange = { keyspace: "index:1", start: "YQ==", end: "Yg==", startInclusive: true, endInclusive: false } as never;
    m.add({ ...base, tables: ["localT"], readRanges: [localRange], globalTables: ["users"] });
    // a global write must still match it even though it has non-empty readRanges:
    expect(m.findAffectedByRanges([], ["users"]).map((s) => s.queryId)).toEqual([1]);
  });
  it("drops the global-table index entry on remove", () => {
    const m = new SubscriptionManager();
    m.add({ ...base, tables: [], globalTables: ["users"] });
    m.remove("s1", 1);
    expect(m.findAffectedByRanges([], ["users"])).toEqual([]);
    expect(m.subscribedGlobalTables()).toEqual([]);
  });
});
