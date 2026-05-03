/* Stackbase Enterprise. Licensed under the Stackbase Commercial License — see ee/LICENSE. */
import { describe, it, expect } from "vitest";
import { shardIdForKeyValue } from "@stackbase/id-codec";
import { shardDoName, DEFAULT_SHARD_DO_NAME } from "../src/canonical";

describe("shardDoName — mode 'key' (one DO per value)", () => {
  it("is deterministic: the same value always maps to the same name", () => {
    expect(shardDoName("roomA")).toBe(shardDoName("roomA"));
    expect(shardDoName(42)).toBe(shardDoName(42));
  });

  it("maps distinct values to distinct DO names (physical partition per key)", () => {
    expect(shardDoName("roomA")).not.toBe(shardDoName("roomB"));
  });

  it("distinguishes types the way the engine's index encoding does (1 !== \"1\")", () => {
    // Reuses `encodeIndexKey`, so a number and a string route to different DOs — exactly as they land
    // in different shards on the portable path.
    expect(shardDoName(1)).not.toBe(shardDoName("1"));
  });

  it("never collides with the reserved 'default' DO name", () => {
    // An app key literally equal to "default" must NOT alias the unsharded DO.
    expect(shardDoName("default")).not.toBe(DEFAULT_SHARD_DO_NAME);
    expect(shardDoName("default").startsWith("s.")).toBe(true);
  });
});

describe("shardDoName — mode 'hash' (fixed-N, byte-identical to the portable path)", () => {
  it("returns the SAME ShardId string the portable id-codec produces", () => {
    for (const v of ["roomA", "roomB", 7, "tenant-xyz"]) {
      expect(shardDoName(v, "hash", 8)).toBe(shardIdForKeyValue(v, 8));
    }
  });

  it("routes some keys to non-default shards under N>1", () => {
    const names = new Set<string>();
    for (let i = 0; i < 50; i++) names.add(shardDoName(`k${i}`, "hash", 8));
    // With 8 shards and 50 keys, we expect more than one distinct shard id.
    expect(names.size).toBeGreaterThan(1);
  });
});
