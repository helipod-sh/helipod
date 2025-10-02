/**
 * Shards B2a, Task 5 — dev-tier proof: `bootLoaded` is the exact boot core `stackbase dev` runs
 * (see boot-loaded.test.ts for the established pattern of driving it directly, in-process, as a
 * "dev-server-level" test without needing a real HTTP server/watcher). Before this task,
 * `RunOptions.numShards` was never threaded past its `?? 1` default anywhere in
 * `runtime-embedded`'s `runtime.ts` (T3's handoff) — under `numShards=1`, jump-hash trivially
 * collapses every shard-key value onto the single "default" bucket, so a sharded mutation's
 * write-ownership guard could never actually observe a cross-shard mismatch. This test proves the
 * fix: the REAL count (8, the default) reaches the executor via the dev boot path, so (a) two
 * channels with different shard-key values genuinely route to different (non-"default") shards,
 * and (b) a mutation that writes a document whose shard-key value doesn't match its own declared
 * shard is rejected with the kernel's instructive error.
 */
import { describe, it, expect, afterEach } from "vitest";
import { rmSync } from "node:fs";
import { shardIdForKeyValue } from "@stackbase/id-codec";
import { loadConvexDir } from "../src/load-modules";
import { bootLoaded } from "../src/boot";

const DATA_DIR = "./.tmp-shard-dev-boot";
const DATA = `${DATA_DIR}/db.sqlite`;
afterEach(() => rmSync(DATA_DIR, { recursive: true, force: true }));

const NUM_SHARDS = 8;

/**
 * Two channel ids that jump-hash to DIFFERENT non-"default" shards under `NUM_SHARDS` — found via
 * the SAME exported router (`shardIdForKeyValue`, `@stackbase/id-codec`) the executor and kernel
 * guards use, rather than a hardcoded pair that could silently stop proving anything if the hash's
 * internals ever changed.
 */
function distinctShardPair(): [string, string] {
  const seenShardOf = new Map<string, string>();
  for (let i = 0; i < 1000; i++) {
    const id = `channel-${i}`;
    const shard = shardIdForKeyValue(id, NUM_SHARDS);
    if (shard === "default") continue;
    for (const [otherId, otherShard] of seenShardOf) {
      if (otherShard !== shard) return [otherId, id];
    }
    seenShardOf.set(id, shard);
  }
  throw new Error("could not find two channel ids that route to different non-default shards");
}

describe("dev-tier shard routing (Shards B2a, T5)", () => {
  it("threads the real NUM_SHARDS through the dev boot path: distinct channels route to distinct shards, and a write that mismatches its own declared shard is rejected", async () => {
    const [channelA, channelB] = distinctShardPair();
    expect(shardIdForKeyValue(channelA, NUM_SHARDS)).not.toBe(shardIdForKeyValue(channelB, NUM_SHARDS));

    const loaded = await loadConvexDir("test/fixtures/shard-dev/convex");
    const { runtime, store } = await bootLoaded({ loaded, components: [], dataPath: DATA, adminKey: "k" });
    try {
      // Real per-shard routing: both channels' sends succeed (neither errors as an "undeclared
      // shard" mistake), and each channel reads back only its own message.
      await runtime.run("messages:send", { channelId: channelA, body: "hi from A" });
      await runtime.run("messages:send", { channelId: channelB, body: "hi from B" });
      const a = await runtime.run<Array<{ channelId: string }>>("messages:list", { channelId: channelA });
      const b = await runtime.run<Array<{ channelId: string }>>("messages:list", { channelId: channelB });
      expect(a.value).toHaveLength(1);
      expect(b.value).toHaveLength(1);

      // `sendWrongShard` runs on channelA's shard (shardBy: "channelId" = channelA) but writes a
      // document keyed to channelB — a cross-shard write the ownership guard must reject. This is
      // the guard the numShards=1 bug made unreachable: with every value collapsing onto
      // "default", `docShard` and `ctx.shardId` would always trivially agree.
      await expect(
        runtime.run("messages:sendWrongShard", { channelId: channelA, otherChannelId: channelB, body: "oops" }),
      ).rejects.toThrow(/sharded by 'channelId'.*runs on shard.*routes to shard/s);
    } finally {
      store.close();
    }
  });
});
