/* Helipod Enterprise. Licensed under the Helipod Commercial License — see ee/LICENSE. */
/**
 * Task 8.1a — the `startReplicaReactiveTailer` helper drives cross-node reactivity, mirroring the
 * Slice-5 `cross-node-reactivity.e2e.test.ts` scenario but THROUGH THE HELPER rather than an inlined
 * sink: a writer node commits a mutation over an fs bucket; a replica node (fresh local, no lease)
 * wired via `startReplicaReactiveTailer` picks it up; its live subscription fires with the writer's
 * data, its `local` reflects the row, and it published a `s{shard}/consumers/{consumerId}` watermark
 * object. `stop()` then halts the tailer — a further writer commit is NOT picked up.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { v, defineSchema, defineTable } from "@helipod/values";
import { SimpleIndexCatalog, query, mutation, type RegisteredFunction } from "@helipod/executor";
import { encodeStorageIndexId } from "@helipod/id-codec";
import { BunSqliteAdapter, NodeSqliteAdapter, SqliteDocStore } from "@helipod/docstore-sqlite";
import type { ObjectStore } from "@helipod/objectstore";
import { FsObjectStore } from "@helipod/objectstore-fs";
import { createEmbeddedRuntime, type EmbeddedRuntime } from "@helipod/runtime-embedded";
import { ObjectStoreDocStore } from "../src/object-doc-store";
import { readManifest } from "../src/manifest";
import { readConsumerWatermarks } from "../src/consumers";
import { startReplicaReactiveTailer } from "../src/replica-wiring";

const SHARD = "0";
const NOTES_TABLE_NUMBER = 40021;
const CONSUMER_ID = "replica-8-1a";

const schema = defineSchema({ notes: defineTable({ body: v.string() }) });

const modules: Record<string, RegisteredFunction> = {
  "notes:add": mutation<{ body: string }, string>({
    handler: (ctx, { body }) => ctx.db.insert("notes", { body }),
  }),
  "notes:list": query<Record<string, never>, string[]>({
    handler: async (ctx) =>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (await (ctx.db.query("notes", "by_creation") as any).collect()).map((d: { body: string }) => d.body),
  }),
};

function notesCatalog(): SimpleIndexCatalog {
  const documentType = schema.export().tables.notes!.documentType;
  return new SimpleIndexCatalog()
    .addTable("notes", NOTES_TABLE_NUMBER, documentType)
    .addIndex({
      table: "notes",
      tableNumber: NOTES_TABLE_NUMBER,
      index: "by_creation",
      fields: [],
      indexId: encodeStorageIndexId(NOTES_TABLE_NUMBER, "by_creation"),
    });
}

function freshLocal(): SqliteDocStore {
  const isBun = typeof (globalThis as { Bun?: unknown }).Bun !== "undefined";
  return new SqliteDocStore(isBun ? new BunSqliteAdapter({ path: ":memory:" }) : new NodeSqliteAdapter({ path: ":memory:" }));
}

type ServerMsg = { type: string; modifications?: Array<{ type: string; queryId?: number; value?: unknown }> };

function latestQueryValue(msgs: ServerMsg[], queryId: number): unknown {
  let value: unknown;
  for (const m of msgs) {
    if (m.type !== "Transition") continue;
    for (const mod of m.modifications ?? []) {
      if (mod.type === "QueryUpdated" && mod.queryId === queryId) value = mod.value;
    }
  }
  return value;
}

const dirs: string[] = [];
async function freshFsBucket(): Promise<ObjectStore> {
  const dir = await mkdtemp(join(tmpdir(), "objectstore-substrate-replica-wiring-e2e-"));
  dirs.push(dir);
  return new FsObjectStore({ dir });
}
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

interface Handles {
  writerStore: ObjectStoreDocStore;
  writerRuntime: EmbeddedRuntime;
  replicaLocal: SqliteDocStore;
  replicaRuntime: EmbeddedRuntime;
  tailerHandle: { stop(): Promise<void>; __pump(): Promise<void> };
}

async function teardown(h: Partial<Handles>): Promise<void> {
  await h.tailerHandle?.stop();
  await h.writerStore?.close();
  await h.replicaLocal?.close();
}

describe("startReplicaReactiveTailer: the wiring helper drives cross-node reactivity + publishes the consumer watermark", () => {
  it("fs — replica subscription fires with the writer's data, local reflects it, watermark published, stop() halts it", async () => {
    const bucket = await freshFsBucket();
    const h: Partial<Handles> = {};

    try {
      // ── WRITER node ──────────────────────────────────────────────────────────────────────────
      const writerStore = await ObjectStoreDocStore.open({ objectStore: bucket, shard: SHARD, local: freshLocal() });
      h.writerStore = writerStore;
      const acquired = await writerStore.acquire({ writerId: "writer", leaseTtlMs: Number.MAX_SAFE_INTEGER, now: 0 });
      if (!acquired.acquired) throw new Error(`test setup: acquire() unexpectedly refused (heldBy ${acquired.heldBy})`);
      const writerRuntime = await createEmbeddedRuntime({ store: writerStore, catalog: notesCatalog(), modules });
      h.writerRuntime = writerRuntime;

      await writerRuntime.run<string>("notes:add", { body: "first" });

      // ── REPLICA node ─────────────────────────────────────────────────────────────────────────
      const replicaLocal = freshLocal();
      h.replicaLocal = replicaLocal;
      // Bootstrap from the bucket (no acquire — a replica never claims the shard); the wrapper is
      // throwaway, the replica's own runtime runs straight over `replicaLocal`.
      await ObjectStoreDocStore.open({ objectStore: bucket, shard: SHARD, local: replicaLocal });

      const replicaRuntime = await createEmbeddedRuntime({ store: replicaLocal, catalog: notesCatalog(), modules });
      h.replicaRuntime = replicaRuntime;

      const bootstrapped = (await replicaRuntime.run<string[]>("notes:list", {})).value;
      expect(bootstrapped).toEqual(["first"]);

      // ── The helper under test — wires the tailer (pollMs kept large so only our own explicit
      // __pump() calls below drive rounds during the deterministic portion of this test) ─────────
      const tailerHandle = startReplicaReactiveTailer({
        runtime: replicaRuntime,
        objectStore: bucket,
        shard: SHARD,
        local: replicaLocal,
        consumerId: CONSUMER_ID,
        pollMs: 60_000,
      });
      h.tailerHandle = tailerHandle;

      // ── A live subscription on the REPLICA, a commit on the WRITER ─────────────────────────────
      const conn = replicaRuntime.connect("replica-session");
      const serverMsgs: ServerMsg[] = [];
      conn.onMessage((m) => serverMsgs.push(m as ServerMsg));
      try {
        await conn.send({
          type: "ModifyQuerySet",
          add: [{ queryId: 1, udfPath: "notes:list", args: {} }],
          remove: [],
        });
        expect((latestQueryValue(serverMsgs, 1) as string[])?.sort()).toEqual(["first"]);

        await writerRuntime.run<string>("notes:add", { body: "second" });

        // Drive exactly one round deterministically via the test seam — no real-timer wait needed.
        await tailerHandle.__pump();

        expect((latestQueryValue(serverMsgs, 1) as string[]).sort()).toEqual(["first", "second"]);

        // The replica's `local` itself reflects the write (not just the pushed subscription).
        const replicaList = (await replicaRuntime.run<string[]>("notes:list", {})).value;
        expect(replicaList.sort()).toEqual(["first", "second"]);

        // A consumer watermark for this replica was published on the shard, reflecting the
        // POST-advance applied position: after the writer's `k`-th commit, `manifest.nextSeqno === k`
        // and the replica's true applied position is the LAST applied seqno, `k - 1` — NOT
        // `nextSeqno` itself (there is no seqno `k` yet to have applied).
        const manifestState = await readManifest(bucket, SHARD);
        expect(manifestState).not.toBeNull();
        const watermarks = await readConsumerWatermarks(bucket, SHARD);
        const mine = watermarks.find((w) => w.consumerId === CONSUMER_ID);
        expect(mine).toBeDefined();
        expect(mine!.appliedSeqno).toBe(manifestState!.manifest.nextSeqno - 1);

        // ── stop() halts the tailer: a further writer commit is NOT picked up ──────────────────
        // Deterministic proof (not a timer race): after stop(), a manual __pump() shares the SAME
        // `stopped` chokepoint the background loop's wake() checks, so it must be a no-op. The writer
        // commits "third"; we drive __pump() explicitly — had stop() failed to set the guard, this
        // would apply "third" and the assertion below would fail. It does not, proving the halt.
        await tailerHandle.stop();
        await writerRuntime.run<string>("notes:add", { body: "third" });
        await tailerHandle.__pump(); // no-op because stopped — would otherwise apply "third"
        expect((latestQueryValue(serverMsgs, 1) as string[]).sort()).toEqual(["first", "second"]);
        // The replica's own local + watermark are likewise unchanged past the halt.
        const afterStop = (await replicaRuntime.run<string[]>("notes:list", {})).value;
        expect(afterStop.sort()).toEqual(["first", "second"]);
      } finally {
        conn.close();
      }
    } finally {
      await teardown(h);
    }
  });

  it("stop() awaits an in-flight watermark publish — a later removeConsumer can't be resurrected (whole-branch fix)", async () => {
    // The race the whole-branch review found: a background pump() already past its guards, mid-publish,
    // could complete AFTER stop() returns and the boot layer's removeConsumer() deletes the watermark —
    // re-creating it (with a never-reused per-process consumerId) and permanently pinning the writer's
    // gc floor. The fix: stop() awaits the in-flight round. This proves stop() blocks until the
    // gated publish completes, so a subsequent removeConsumer is guaranteed to run last.
    const bucket = await freshFsBucket();
    const h: Partial<Handles> = {};
    let releaseGate!: () => void;
    const gate = new Promise<void>((r) => (releaseGate = r));
    let consumerCasPuts = 0;
    const gatedBucket = new Proxy(bucket, {
      get(target, prop, receiver) {
        if (prop === "casPut") {
          return async (key: string, body: Uint8Array, ifMatch: string | null) => {
            if (key.includes("/consumers/")) {
              consumerCasPuts++;
              await gate; // hold the watermark publish in flight
            }
            return (target as ObjectStore).casPut(key, body, ifMatch);
          };
        }
        const val = Reflect.get(target, prop, receiver);
        return typeof val === "function" ? val.bind(target) : val;
      },
    }) as ObjectStore;

    try {
      const writerStore = await ObjectStoreDocStore.open({ objectStore: bucket, shard: SHARD, local: freshLocal() });
      h.writerStore = writerStore;
      const acq = await writerStore.acquire({ writerId: "writer", leaseTtlMs: Number.MAX_SAFE_INTEGER, now: 0 });
      if (!acq.acquired) throw new Error("test setup: acquire refused");
      const writerRuntime = await createEmbeddedRuntime({ store: writerStore, catalog: notesCatalog(), modules });
      h.writerRuntime = writerRuntime;
      await writerRuntime.run<string>("notes:add", { body: "first" });

      const replicaLocal = freshLocal();
      h.replicaLocal = replicaLocal;
      await ObjectStoreDocStore.open({ objectStore: gatedBucket, shard: SHARD, local: replicaLocal });
      const replicaRuntime = await createEmbeddedRuntime({ store: replicaLocal, catalog: notesCatalog(), modules });
      h.replicaRuntime = replicaRuntime;

      const handle = startReplicaReactiveTailer({
        runtime: replicaRuntime,
        objectStore: gatedBucket,
        shard: SHARD,
        local: replicaLocal,
        consumerId: "replica-race",
        pollMs: 5,
      });
      h.tailerHandle = handle;

      // Wait until the background loop's pump reaches the gated publish (now in flight).
      const deadline = Date.now() + 5000;
      while (consumerCasPuts === 0) {
        if (Date.now() > deadline) throw new Error("pump never reached the gated publish");
        await new Promise((r) => setTimeout(r, 5));
      }

      // stop() must NOT resolve while the in-flight publish is gated.
      let done = false;
      const stopPromise = handle.stop().then(() => (done = true));
      await new Promise((r) => setTimeout(r, 100));
      expect(done).toBe(false); // stop() is awaiting the in-flight publish, not returning early

      releaseGate();
      await stopPromise;
      expect(done).toBe(true); // resolves only once the in-flight publish has completed
    } finally {
      releaseGate?.(); // ensure no dangling gate on a failure path
      await teardown(h);
    }
  });
});
