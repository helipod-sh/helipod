/* Stackbase Enterprise. Licensed under the Stackbase Commercial License — see ee/LICENSE. */
/**
 * Task 7.2a — the gc-driver, over a REAL `ObjectStoreDocStore` on an fs bucket (per `test/gc.test.ts`'s
 * own harness) + a controllable fake `DriverContext` (per `heartbeat-driver.test.ts`'s harness). Three
 * scenarios: (1) a normal sweep runs `store.gc()` on the cadence and reclaims superseded state; (2) a
 * gc() that THROWS is swallowed — the driver logs and re-arms, does NOT die; (3) `stop()` clears the
 * timer and prevents any further sweep.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { newDocumentId, encodeStorageTableId, type InternalDocumentId } from "@stackbase/id-codec";
import type { DocumentLogEntry } from "@stackbase/docstore";
import type { DriverContext } from "@stackbase/component";
import { BunSqliteAdapter, NodeSqliteAdapter, SqliteDocStore } from "@stackbase/docstore-sqlite";
import { FsObjectStore } from "@stackbase/objectstore-fs";
import { ObjectStoreDocStore } from "../src/object-doc-store";
import { gcDriver, type GcDriver } from "../src/gc-driver";

const TABLE = 30001;

function doc(id: InternalDocumentId, body: string): DocumentLogEntry {
  return { ts: 0n, id, prev_ts: null, value: { id, value: { body } } };
}

function freshLocal(): SqliteDocStore {
  const isBun = typeof (globalThis as { Bun?: unknown }).Bun !== "undefined";
  return new SqliteDocStore(isBun ? new BunSqliteAdapter({ path: ":memory:" }) : new NodeSqliteAdapter({ path: ":memory:" }));
}

const dirs: string[] = [];
async function freshBucket(): Promise<FsObjectStore> {
  const dir = await mkdtemp(join(tmpdir(), "objectstore-substrate-gc-driver-test-"));
  dirs.push(dir);
  return new FsObjectStore({ dir });
}

async function openAndAcquire(objectStore: FsObjectStore, shard: string, local: SqliteDocStore): Promise<ObjectStoreDocStore> {
  const store = await ObjectStoreDocStore.open({ objectStore, shard, local });
  const result = await store.acquire({ writerId: "w", leaseTtlMs: Number.MAX_SAFE_INTEGER, now: 0 });
  if (!result.acquired) throw new Error(`test setup: acquire() unexpectedly refused (heldBy ${result.heldBy})`);
  return store;
}

/** A manual/controllable fake `DriverContext` — mirrors `heartbeat-driver.test.ts`'s harness (no real
 *  timers; the test fires timers explicitly). */
function makeFakeDriverContext(): {
  ctx: DriverContext;
  setNow: (t: number) => void;
  liveTimerCount: () => number;
  fireDueTimers: () => Promise<void>;
} {
  let clock = 0;
  let seq = 0;
  const timers = new Map<number, { atMs: number; cb: () => void }>();

  const ctx: DriverContext = {
    runFunction: async () => {
      throw new Error("gcDriver does not call runFunction");
    },
    onCommit: () => () => {},
    setTimer: (atMs, cb) => {
      const h = ++seq;
      timers.set(h, { atMs, cb });
      return h;
    },
    clearTimer: (h) => {
      timers.delete(h);
    },
    now: () => clock,
    readLog: async () => ({ changes: [], maxScannedTs: 0 }),
  };

  return {
    ctx,
    setNow: (t) => {
      clock = t;
    },
    liveTimerCount: () => timers.size,
    // A fired callback (`wake()`) kicks off a fire-and-forget async chain (real fs I/O against the
    // temp-dir bucket + re-arm) — needs a real macrotask-scale delay for that chain to settle before
    // the next due-timer check, same as `heartbeat-driver.test.ts`.
    fireDueTimers: async () => {
      for (;;) {
        const due = [...timers.entries()].find(([, t]) => t.atMs <= clock);
        if (!due) break;
        const [h, t] = due;
        timers.delete(h);
        t.cb();
        await new Promise((r) => setTimeout(r, 25));
      }
    },
  };
}

// SNAPSHOT_EVERY is 8 (object-doc-store.ts) — mirrored here, same note as gc.test.ts/gc-fencing.test.ts.
const SNAPSHOT_EVERY = 8;

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

describe("gcDriver (Tier 3 Slice 7, Task 7.2)", () => {
  it("7.2a-1: a normal sweep runs store.gc() on the cadence and reclaims superseded segments/snapshots", async () => {
    const objectStore = await freshBucket();
    const store = await openAndAcquire(objectStore, "0", freshLocal());

    // Drive two cadence snapshots so gc() has a stale (first) snapshot + superseded segments to
    // reclaim once it runs (same setup shape as gc.test.ts's 3.3b).
    for (let i = 0; i < SNAPSHOT_EVERY; i++) {
      await store.commitWrite([doc(newDocumentId(TABLE), `first-${i}`)], []);
    }
    for (let i = 0; i < SNAPSHOT_EVERY; i++) {
      await store.commitWrite([doc(newDocumentId(TABLE), `second-${i}`)], []);
    }

    const segPrefix = "s0/seg/";
    const snapPrefix = "s0/snap/";
    const preSweepSegCount = (await objectStore.list(segPrefix)).length;
    const preSweepSnapCount = (await objectStore.list(snapPrefix)).length;
    expect(preSweepSegCount).toBe(2 * SNAPSHOT_EVERY); // nothing reclaimed yet
    expect(preSweepSnapCount).toBe(2); // both snapshots still present

    const { ctx, setNow, liveTimerCount, fireDueTimers } = makeFakeDriverContext();
    setNow(0);
    const driver: GcDriver = gcDriver(store, { sweepMs: 300 });

    driver.start(ctx);
    expect(liveTimerCount()).toBe(1); // start() arms only, no up-front sweep

    setNow(300);
    await fireDueTimers();

    // gc() ran: superseded segments/the stale snapshot were reclaimed.
    const postSweepSegKeys = await objectStore.list(segPrefix);
    const postSweepSnapKeys = await objectStore.list(snapPrefix);
    expect(postSweepSegKeys.length).toBeLessThan(preSweepSegCount);
    expect(postSweepSnapKeys.length).toBe(1); // only the current snapshot survives
    expect(liveTimerCount()).toBe(1); // re-armed for the next cadence

    // A store still queryable/live after reclamation.
    const scanned = await store.scan(encodeStorageTableId(TABLE));
    expect(scanned.length).toBe(2 * SNAPSHOT_EVERY);

    driver.stop?.();
    await store.close();
  });

  it("7.2a-2: a gc() that throws is swallowed — the driver logs, does NOT die, and re-arms for the next sweep", async () => {
    let calls = 0;
    const flaky = {
      gc: async () => {
        calls++;
        if (calls === 1) throw new Error("transient object-store blip");
        return { deletedSegments: 0, deletedSnapshots: 0 };
      },
    };
    const { ctx, setNow, liveTimerCount, fireDueTimers } = makeFakeDriverContext();
    setNow(0);
    const driver = gcDriver(flaky, { sweepMs: 300 });

    driver.start(ctx);
    expect(liveTimerCount()).toBe(1);

    setNow(300);
    await fireDueTimers();
    expect(calls).toBe(1);
    expect(liveTimerCount()).toBe(1); // re-armed despite the throw — never dies

    setNow(600);
    await fireDueTimers();
    expect(calls).toBe(2); // kept sweeping on the normal cadence
    expect(liveTimerCount()).toBe(1);

    driver.stop?.();
  });

  it("7.2a-3: stop() clears the timer and prevents any further sweep", async () => {
    let calls = 0;
    const flaky = {
      gc: async () => {
        calls++;
        return { deletedSegments: 0, deletedSnapshots: 0 };
      },
    };
    const { ctx, setNow, liveTimerCount, fireDueTimers } = makeFakeDriverContext();
    setNow(0);
    const driver = gcDriver(flaky, { sweepMs: 300 });
    driver.start(ctx);
    expect(liveTimerCount()).toBe(1);

    driver.stop?.();
    expect(liveTimerCount()).toBe(0);

    // Advancing time and firing due timers is a no-op: nothing is armed anymore.
    setNow(10_000);
    await fireDueTimers();
    expect(liveTimerCount()).toBe(0);
    expect(calls).toBe(0);
  });

  it("7.2a-4: __tick runs one gc() pass and awaits its real completion, propagating an error (unlike wake())", async () => {
    const boom = new Error("boom");
    const flaky = {
      gc: async () => {
        throw boom;
      },
    };
    const { ctx } = makeFakeDriverContext();
    const driver = gcDriver(flaky, { sweepMs: 300 });
    driver.start(ctx);

    await expect(driver.__tick()).rejects.toBe(boom);

    driver.stop?.();
  });
});
