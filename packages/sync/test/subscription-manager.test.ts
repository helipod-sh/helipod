import { describe, it, expect } from "vitest";
import { SubscriptionManager, type Subscription } from "../src/subscription-manager";
import {
  serializeKeyRange, deserializeKeyRange, rangesOverlap, keySuccessor,
  indexKeyspaceId, tableOfKeyspaceId, type SerializedKeyRange, type KeyRange,
} from "@helipod/index-key-codec";

// --- seeded RNG (mulberry32) so failures reproduce; no Math.random ---
function rng(seed: number) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const TABLES = ["users", "messages", "posts"];
const INDEXES = ["by_a", "by_b"];
function keyspaceFor(r: () => number): string {
  return indexKeyspaceId(TABLES[Math.floor(r() * TABLES.length)]!, INDEXES[Math.floor(r() * INDEXES.length)]!);
}
function keyBytes(r: () => number): Uint8Array {
  return new Uint8Array([Math.floor(r() * 8)]); // small alphabet => collisions/overlaps happen
}
function randomRange(r: () => number): KeyRange {
  const ks = keyspaceFor(r);
  const roll = r();
  if (roll < 0.5) { const k = keyBytes(r); return { keyspace: ks, start: k, end: keySuccessor(k) }; } // point
  if (roll < 0.7) return { keyspace: ks, start: new Uint8Array(0), end: null }; // whole keyspace
  const a = keyBytes(r), c = keyBytes(r);
  const [lo, hi] = a[0]! <= c[0]! ? [a, c] : [c, a];
  return { keyspace: ks, start: lo, end: new Uint8Array([hi[0]! + 1]) }; // span
}

// --- the ORACLE: the retired linear-scan semantics ---
function bruteForce(subs: Subscription[], writeRanges: SerializedKeyRange[], writeTables: string[]): Set<string> {
  const out = new Set<string>();
  const wr = writeRanges.map(deserializeKeyRange);
  for (const sub of subs) {
    const key = `${sub.sessionId} ${sub.queryId}`;
    if (sub.readRanges.length > 0) {
      const rr = sub.readRanges.map(deserializeKeyRange);
      if (wr.some((w) => rr.some((r) => rangesOverlap(w, r)))) out.add(key);
    } else {
      if (writeTables.some((t) => sub.tables.includes(t))) out.add(key);
    }
  }
  return out;
}

function makeSub(r: () => number, id: number): Subscription {
  const isFallback = r() < 0.25;
  const ranges: KeyRange[] = isFallback ? [] : Array.from({ length: 1 + Math.floor(r() * 2) }, () => randomRange(r));
  const tables = isFallback
    ? [TABLES[Math.floor(r() * TABLES.length)]!]
    : [...new Set(ranges.map((rg) => tableOfKeyspaceId(rg.keyspace)))];
  return {
    sessionId: `s${id % 5}`, queryId: id, udfPath: "q", args: null,
    tables, readRanges: ranges.map(serializeKeyRange),
  };
}

describe("SubscriptionManager — indexed matcher equals the linear-scan oracle", () => {
  it("matches brute force across randomized populations, churn, and writes", () => {
    for (let seed = 1; seed <= 40; seed++) {
      const r = rng(seed);
      const mgr = new SubscriptionManager();
      const live = new Map<number, Subscription>();
      let nextId = 0;
      // build + churn
      for (let op = 0; op < 120; op++) {
        if (r() < 0.7 || live.size === 0) {
          const sub = makeSub(r, nextId++);
          mgr.add(sub);
          live.set(sub.queryId, sub);
        } else {
          const ids = [...live.keys()];
          const victim = ids[Math.floor(r() * ids.length)]!;
          const sub = live.get(victim)!;
          mgr.remove(sub.sessionId, sub.queryId);
          live.delete(victim);
        }
      }
      const subs = [...live.values()];
      // random writes
      for (let w = 0; w < 30; w++) {
        const writeRanges = Array.from({ length: 1 + Math.floor(r() * 2) }, () => serializeKeyRange(randomRange(r)));
        const writeTables = [...new Set(writeRanges.map((s) => tableOfKeyspaceId(s.keyspace)))];
        const got = new Set(mgr.findAffectedByRanges(writeRanges, writeTables).map((s) => `${s.sessionId} ${s.queryId}`));
        const want = bruteForce(subs, writeRanges, writeTables);
        expect([...got].sort()).toEqual([...want].sort());
      }
    }
  });

  it("removeSession purges range + fallback subs from the index", () => {
    const mgr = new SubscriptionManager();
    const ks = indexKeyspaceId("users", "by_a");
    const k = new Uint8Array([3]);
    const ranged: Subscription = {
      sessionId: "s1", queryId: 1, udfPath: "q", args: null, tables: ["users"],
      readRanges: [serializeKeyRange({ keyspace: ks, start: k, end: keySuccessor(k) })],
    };
    const fallback: Subscription = {
      sessionId: "s1", queryId: 2, udfPath: "q", args: null, tables: ["users"], readRanges: [],
    };
    mgr.add(ranged); mgr.add(fallback);
    const wr = [serializeKeyRange({ keyspace: ks, start: k, end: keySuccessor(k) })];
    expect(mgr.findAffectedByRanges(wr, ["users"]).length).toBe(2);
    mgr.removeSession("s1");
    expect(mgr.findAffectedByRanges(wr, ["users"])).toEqual([]);
    expect(mgr.size).toBe(0);
  });
});
