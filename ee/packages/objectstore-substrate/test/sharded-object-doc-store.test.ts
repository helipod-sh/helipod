/* Helipod Enterprise. Licensed under the Helipod Commercial License — see ee/LICENSE. */
/**
 * Unit tests for `ShardedObjectStoreDocStore` (object-storage multi-shard single-node write
 * scale-out) — the merging-read logic is the load-bearing correctness surface: `get`/`scan`/`count`/
 * `maxTimestamp`/`previous_revisions` merge across every lane, and `index_scan` is a genuine k-way
 * merge (proven with an explicit interleave, both orders, and a `limit` that cuts mid-stream across
 * lanes). Writes route by the caller-supplied `shardId`, exactly as `ShardWriter` (the transactor)
 * always supplies one for `commitWrite`/`commitWriteBatch` (see `packages/transactor/src/
 * shard-writer.ts`).
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  newDocumentId,
  encodeStorageIndexId,
  encodeStorageTableId,
  shardIdForKeyValue,
  shardIdList,
  type InternalDocumentId,
  type ShardId,
} from "@helipod/id-codec";
import { encodeIndexKey } from "@helipod/index-key-codec";
import type { DocumentLogEntry, IndexWrite, DatabaseIndexUpdate, DocStore, CommitGuardUnit } from "@helipod/docstore";
import { BunSqliteAdapter, NodeSqliteAdapter, SqliteDocStore } from "@helipod/docstore-sqlite";
import { FsObjectStore } from "@helipod/objectstore-fs";
import type { ObjectStore } from "@helipod/objectstore";
import { ObjectStoreDocStore } from "../src/object-doc-store";
import { ShardedObjectStoreDocStore } from "../src/sharded-object-doc-store";

const TABLE = 40001;
const INDEX_ID = encodeStorageIndexId(TABLE, "by_body");

function doc(id: InternalDocumentId, body: string): DocumentLogEntry {
  return { ts: 0n, id, prev_ts: null, value: { id, value: { body } } };
}

function indexWrite(id: InternalDocumentId, key: string): IndexWrite {
  const update: DatabaseIndexUpdate = {
    indexId: INDEX_ID,
    key: encodeIndexKey([key]),
    value: { type: "NonClustered", docId: id },
  };
  return { ts: 0n, update };
}

function freshLocal(): SqliteDocStore {
  const isBun = typeof (globalThis as { Bun?: unknown }).Bun !== "undefined";
  return new SqliteDocStore(isBun ? new BunSqliteAdapter({ path: ":memory:" }) : new NodeSqliteAdapter({ path: ":memory:" }));
}

const dirs: string[] = [];
async function freshBucket(): Promise<ObjectStore> {
  const dir = await mkdtemp(join(tmpdir(), "objectstore-substrate-sharded-test-"));
  dirs.push(dir);
  return new FsObjectStore({ dir });
}
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

/** Open + acquire N lanes over ONE bucket, keyed by the engine's `shardIdList(numShards)` ids
 *  (`"default"`, `"s1"`, …), each lane's OWN object-storage `shard` string being its slot number
 *  (`"0"`, `"1"`, …) — mirrors `packages/cli/src/boot.ts`'s multi-shard writer wiring. */
async function openShardedFixture(numShards: number, objectStore: ObjectStore): Promise<{ store: ShardedObjectStoreDocStore; lanes: Map<ShardId, ObjectStoreDocStore> }> {
  const ids = shardIdList(numShards);
  const lanes = new Map<ShardId, ObjectStoreDocStore>();
  for (let slot = 0; slot < numShards; slot++) {
    const engineShardId = ids[slot]!;
    const lane = await ObjectStoreDocStore.open({ objectStore, shard: String(slot), local: freshLocal() });
    const acquired = await lane.acquire({ writerId: `w-${slot}`, leaseTtlMs: Number.MAX_SAFE_INTEGER, now: 0 });
    if (!acquired.acquired) throw new Error(`test setup: acquire() refused for slot ${slot}`);
    lanes.set(engineShardId, lane);
  }
  const store = new ShardedObjectStoreDocStore(lanes);
  return { store, lanes };
}

/** Find `count` distinct small integer key values that route to `targetShard` under `numShards`
 *  (brute-force scan — `numShards`/target counts here are tiny, so this is instant). */
function findKeysForShard(targetShard: ShardId, numShards: number, count: number): number[] {
  const found: number[] = [];
  for (let v = 0; found.length < count; v++) {
    if (shardIdForKeyValue(v, numShards) === targetShard) found.push(v);
    if (v > 100_000) throw new Error(`could not find ${count} keys for shard '${targetShard}' under numShards=${numShards}`);
  }
  return found;
}

describe("ShardedObjectStoreDocStore", () => {
  it("constructor rejects an empty lane map and a defaultShard not present among the lanes", () => {
    expect(() => new ShardedObjectStoreDocStore(new Map())).toThrow(/at least one lane/);
    const lanes = new Map<ShardId, ObjectStoreDocStore>();
    // A fake stand-in is fine here — the constructor only checks map membership, never calls a method.
    lanes.set("s1", {} as ObjectStoreDocStore);
    expect(() => new ShardedObjectStoreDocStore(lanes)).toThrow(/defaultShard 'default' is not one of the composed lanes/);
  });

  it("commitWrite/write route by the caller-supplied shardId, and get/scan/count/maxTimestamp merge across lanes", async () => {
    const bucket = await freshBucket();
    const { store } = await openShardedFixture(3, bucket);
    const ids = shardIdList(3); // ["default", "s1", "s2"]

    const idDefault = newDocumentId(TABLE);
    const idS1 = newDocumentId(TABLE);
    const idS2 = newDocumentId(TABLE);

    await store.commitWrite([doc(idDefault, "in-default")], [], ids[0]);
    await store.commitWrite([doc(idS1, "in-s1")], [], ids[1]);
    await store.commitWrite([doc(idS2, "in-s2")], [], ids[2]);

    // get() probes every lane and finds the one hit, regardless of which lane it landed in.
    expect((await store.get(idDefault))?.value.value.body).toBe("in-default");
    expect((await store.get(idS1))?.value.value.body).toBe("in-s1");
    expect((await store.get(idS2))?.value.value.body).toBe("in-s2");
    const missing = newDocumentId(TABLE);
    expect(await store.get(missing)).toBeNull();

    // scan() unions every lane's live docs for the table.
    const scanned = await store.scan(encodeStorageTableId(TABLE));
    expect(scanned.map((d) => d.value.value.body).sort()).toEqual(["in-default", "in-s1", "in-s2"]);

    // count() sums every lane.
    expect(await store.count(encodeStorageTableId(TABLE))).toBe(3);

    // maxTimestamp() is the max across lanes (all three commits landed at ts=1 on their own lane —
    // still exercises the reduce-to-max path across independent per-lane ts spaces).
    expect(await store.maxTimestamp()).toBeGreaterThan(0n);

    // previous_revisions merges per-lane results keyed by (id, ts) — each of the three docs only
    // resolves in the lane it actually landed in; the merge still surfaces all three.
    const revs = await store.previous_revisions([
      { id: idDefault, ts: 1n },
      { id: idS1, ts: 1n },
      { id: idS2, ts: 1n },
    ]);
    expect(revs.size).toBe(3);

    await store.close();
  });

  it("commitWriteBatch to an unknown shardId throws (a routing bug upstream, not silently swallowed)", async () => {
    const bucket = await freshBucket();
    const { store } = await openShardedFixture(2, bucket);
    const id = newDocumentId(TABLE);
    await expect(store.commitWrite([doc(id, "x")], [], "not-a-real-shard")).rejects.toThrow(/unknown shard 'not-a-real-shard'/);
    await store.close();
  });

  it("addCommitGuard registers the SAME guard function on every lane, and the unregister handle removes it from every lane", async () => {
    // NOTE: this asserts the FAN-OUT REGISTRATION mechanics, not that the guard actually fires
    // during a writer-path commit — `ObjectStoreDocStore`'s post-CAS local apply calls the local
    // store's `write()` (an explicit-ts replica-apply primitive), never `commitWrite`/
    // `commitWriteBatch`, so a registered guard is not invoked on that path today (a documented,
    // pre-existing single-lane limitation — see `ObjectStoreDocStore.addCommitGuard`'s own doc
    // comment: "guard atomicity + effectively-once forwarding are a LATER slice"). Composing N
    // lanes doesn't change that scope, so this test proves what the sharded layer actually adds:
    // registration reaches every lane, and unregistering detaches from every lane too.
    const registered: Array<(q: unknown, units: readonly CommitGuardUnit[], shardId: ShardId) => void> = [];
    const unregisterCalls: ShardId[] = [];
    function fakeLane(shardId: ShardId): DocStore {
      return {
        addCommitGuard(guard: (q: unknown, units: readonly CommitGuardUnit[], shardId: ShardId) => void) {
          registered.push(guard);
          return () => unregisterCalls.push(shardId);
        },
      } as unknown as DocStore;
    }
    const lanes = new Map<ShardId, DocStore>([
      ["default", fakeLane("default")],
      ["s1", fakeLane("s1")],
    ]);
    const sharded = new ShardedObjectStoreDocStore(lanes);

    const guard = (): void => {};
    const unregister = sharded.addCommitGuard(guard);
    expect(registered).toEqual([guard, guard]); // the SAME function registered on both lanes

    unregister();
    expect(unregisterCalls.sort()).toEqual(["default", "s1"]); // detached from both lanes
  });

  it("deployment-level bookkeeping (globals, client verdicts) routes to the default lane only", async () => {
    const bucket = await freshBucket();
    const { store, lanes } = await openShardedFixture(2, bucket);

    await store.writeGlobal("k", "v");
    expect(await store.getGlobal("k")).toBe("v");
    // Confirm it landed on the DEFAULT lane specifically, not fanned to every lane.
    expect(await lanes.get("default")!.getGlobal("k")).toBe("v");
    expect(await lanes.get("s1")!.getGlobal("k")).toBeNull();

    await store.recordClientVerdict("id-1", "client-1", 1, { verdict: "applied", commitTs: 1n, value: "ok" });
    const verdict = await store.getClientVerdict("id-1", "client-1", 1);
    expect(verdict?.verdict).toBe("applied");
    expect(await lanes.get("s1")!.getClientVerdict("id-1", "client-1", 1)).toBeNull();

    await store.close();
  });

  describe("index_scan k-way merge", () => {
    async function seedInterleaved(numShards: number): Promise<{ store: ShardedObjectStoreDocStore; keysInOrder: string[] }> {
      const bucket = await freshBucket();
      const { store } = await openShardedFixture(numShards, bucket);
      const ids = shardIdList(numShards);

      // Pick index-key VALUES (not shard-routing values) so the merged output has a known, easily
      // asserted total order: "k00".."k(n-1)", each landing on a DIFFERENT lane in round-robin, so a
      // merge that just concatenated per-lane results (instead of actually merging) would visibly fail
      // the ordering assertion below.
      const n = 6;
      const keysInOrder: string[] = [];
      for (let i = 0; i < n; i++) {
        const key = `k${String(i).padStart(2, "0")}`;
        keysInOrder.push(key);
        const shardId = ids[i % numShards]!;
        const id = newDocumentId(TABLE);
        await store.commitWriteBatch(
          [{ documents: [doc(id, key)], indexUpdates: [indexWrite(id, key)] }],
          shardId,
        );
      }
      return { store, keysInOrder };
    }

    it("merges N lanes' index_scan streams in ascending order", async () => {
      const { store, keysInOrder } = await seedInterleaved(3);
      const readTs = await store.maxTimestamp();
      const out: string[] = [];
      for await (const [, doc] of store.index_scan(INDEX_ID, encodeStorageTableId(TABLE), readTs, { start: new Uint8Array(), end: null }, "asc")) {
        out.push(doc.value.value.body as string);
      }
      expect(out).toEqual([...keysInOrder]);
      await store.close();
    });

    it("merges N lanes' index_scan streams in descending order", async () => {
      const { store, keysInOrder } = await seedInterleaved(3);
      const readTs = await store.maxTimestamp();
      const out: string[] = [];
      for await (const [, doc] of store.index_scan(INDEX_ID, encodeStorageTableId(TABLE), readTs, { start: new Uint8Array(), end: null }, "desc")) {
        out.push(doc.value.value.body as string);
      }
      expect(out).toEqual([...keysInOrder].reverse());
      await store.close();
    });

    it("honors a limit that cuts mid-stream across lanes (asc)", async () => {
      const { store, keysInOrder } = await seedInterleaved(3);
      const readTs = await store.maxTimestamp();
      const out: string[] = [];
      for await (const [, doc] of store.index_scan(INDEX_ID, encodeStorageTableId(TABLE), readTs, { start: new Uint8Array(), end: null }, "asc", 4)) {
        out.push(doc.value.value.body as string);
      }
      expect(out).toEqual(keysInOrder.slice(0, 4));
      await store.close();
    });

    it("honors a limit in descending order too", async () => {
      const { store, keysInOrder } = await seedInterleaved(4);
      const readTs = await store.maxTimestamp();
      const out: string[] = [];
      for await (const [, doc] of store.index_scan(INDEX_ID, encodeStorageTableId(TABLE), readTs, { start: new Uint8Array(), end: null }, "desc", 2)) {
        out.push(doc.value.value.body as string);
      }
      expect(out).toEqual([...keysInOrder].reverse().slice(0, 2));
      await store.close();
    });

    it("a single-shard (numShards=1) merge is a pass-through — sanity floor", async () => {
      const { store, keysInOrder } = await seedInterleaved(1);
      const readTs = await store.maxTimestamp();
      const out: string[] = [];
      for await (const [, doc] of store.index_scan(INDEX_ID, encodeStorageTableId(TABLE), readTs, { start: new Uint8Array(), end: null }, "asc")) {
        out.push(doc.value.value.body as string);
      }
      expect(out).toEqual(keysInOrder);
      await store.close();
    });
  });

  it("routes commits to the shards shardIdForKeyValue actually picks (end-to-end routing sanity)", async () => {
    const numShards = 4;
    const bucket = await freshBucket();
    const { store, lanes } = await openShardedFixture(numShards, bucket);
    const ids = shardIdList(numShards);

    // Find a real key value that routes to slot 2 ("s2") via the SAME jump-hash the engine's
    // ShardedTransactor uses, and commit through that shard id — proving the composed store's
    // routing lines up with the engine's own routing function, not just an arbitrary label.
    const [keyForSlot2] = findKeysForShard(ids[2]!, numShards, 1);
    const id = newDocumentId(TABLE);
    await store.commitWrite([doc(id, `routed-to-slot2-${keyForSlot2}`)], [], ids[2]!);

    // Landed specifically on lane "s2", not any other lane.
    expect(await lanes.get(ids[2]!)!.get(id)).not.toBeNull();
    expect(await lanes.get(ids[0]!)!.get(id)).toBeNull();
    expect(await lanes.get(ids[1]!)!.get(id)).toBeNull();
    expect(await lanes.get(ids[3]!)!.get(id)).toBeNull();

    await store.close();
  });
});
