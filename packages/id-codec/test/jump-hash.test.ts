import { describe, it, expect } from "vitest";
import { jumpConsistentHash, shardIdForKeyValue, JumpShardRouter } from "../src/index";

describe("jumpConsistentHash — Lamping-Veach", () => {
  it("matches the canonical reference vectors (regression anchor)", () => {
    // Well-known jump-hash vectors (dgryski/go-jump & the original paper).
    expect(jumpConsistentHash(0n, 1)).toBe(0);
    expect(jumpConsistentHash(1n, 1)).toBe(0);
    expect(jumpConsistentHash(0xdeadbeefn, 1)).toBe(0);
    expect(jumpConsistentHash(1n, 10)).toBe(6);
    expect(jumpConsistentHash(0xdeadbeefn, 100)).toBe(87);
    expect(jumpConsistentHash(0xffffffffffffffffn, 16)).toBe(10);
  });

  it("is deterministic across repeated invocations (stability across runs)", () => {
    for (const key of [0n, 1n, 42n, 999999n, 0xabcdef12345678n]) {
      const a = jumpConsistentHash(key, 8);
      const b = jumpConsistentHash(key, 8);
      expect(a).toBe(b);
      expect(a).toBeGreaterThanOrEqual(0);
      expect(a).toBeLessThan(8);
    }
  });

  it("always returns bucket 0 when there is exactly one bucket", () => {
    for (let i = 0; i < 500; i++) {
      expect(jumpConsistentHash(BigInt(i) * 2654435761n, 1)).toBe(0);
    }
  });

  it("rejects a bucket count below 1", () => {
    expect(() => jumpConsistentHash(1n, 0)).toThrow(/buckets/);
  });

  it("distributes ~evenly over 10k keys into 8 buckets (roughness bound)", () => {
    const counts = new Array(8).fill(0);
    for (let i = 0; i < 10_000; i++) {
      counts[shardSlot("key-" + i)]++;
    }
    // Expected 1250 per bucket; allow a generous ±30% band (jump hash is provably well-mixed).
    for (const c of counts) {
      expect(c).toBeGreaterThan(875);
      expect(c).toBeLessThan(1625);
    }
  });

  it("moves minimally when the bucket count grows 8 → 16 (B5 resharding sanity)", () => {
    let moved = 0;
    const total = 5000;
    for (let i = 0; i < total; i++) {
      const key = fnvKey("reshard-" + i);
      const before = jumpConsistentHash(key, 8);
      const after = jumpConsistentHash(key, 16);
      // The jump-hash invariant: a key either KEEPS its old bucket, or moves into one of the
      // brand-new buckets [8,16). It never reshuffles among the pre-existing buckets [0,8).
      expect(after === before || after >= 8).toBe(true);
      if (after !== before) moved++;
    }
    // Only keys destined for a new bucket move: expected ≈ total * (8/16) = 50%.
    expect(moved / total).toBeGreaterThan(0.35);
    expect(moved / total).toBeLessThan(0.65);
  });
});

describe("shardIdForKeyValue — value → shard", () => {
  it("maps slot 0 to 'default' and slot k to 's'+k", () => {
    // Representatives found by scanning (numShards = 8).
    expect(shardIdForKeyValue("chan-3", 8)).toBe("default");
    expect(shardIdForKeyValue("chan-1", 8)).toBe("s1");
    expect(shardIdForKeyValue("chan-5", 8)).toBe("s2");
    expect(shardIdForKeyValue("chan-13", 8)).toBe("s3");
    expect(shardIdForKeyValue("chan-0", 8)).toBe("s4");
  });

  it("routes everything to 'default' when numShards is 1 (zero-shard-overhead default)", () => {
    for (const v of ["chan-0", "chan-1", "chan-13", 42, 7n, true, null]) {
      expect(shardIdForKeyValue(v, 1)).toBe("default");
    }
  });

  it("canonicalizes via the engine's own value encoding — routing is stable and type-aware", () => {
    // Deterministic per value.
    expect(shardIdForKeyValue("chan-0", 8)).toBe(shardIdForKeyValue("chan-0", 8));
    // Distinct scalar types are distinct index keys, so a number and its string form need not
    // co-route — but each is individually stable.
    expect(shardIdForKeyValue(42, 8)).toBe(shardIdForKeyValue(42, 8));
    expect(shardIdForKeyValue(42n, 8)).toBe(shardIdForKeyValue(42n, 8));
  });
});

describe("JumpShardRouter", () => {
  it("routes a null shard key to 'default' and a value key by jump hash", () => {
    const router = new JumpShardRouter(8);
    expect(router.getShardForKey(null)).toBe("default");
    expect(router.getShardForKey("chan-1")).toBe(shardIdForKeyValue("chan-1", 8));
    expect(router.getShardForDocument("messages", "chan-1")).toBe(shardIdForKeyValue("chan-1", 8));
    expect(router.getSyncNodeId("client-x")).toBe("local");
  });

  it("rejects a shard count below 1", () => {
    expect(() => new JumpShardRouter(0)).toThrow(/numShards/);
  });
});

// Helpers ---------------------------------------------------------------------------------------

function shardSlot(value: string): number {
  const id = shardIdForKeyValue(value, 8);
  return id === "default" ? 0 : Number(id.slice(1));
}

/** A quick FNV-1a-ish 64-bit key from a string, for exercising jumpConsistentHash directly. */
function fnvKey(s: string): bigint {
  let h = 0xcbf29ce484222325n;
  for (let i = 0; i < s.length; i++) {
    h ^= BigInt(s.charCodeAt(i));
    h = (h * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return h;
}
