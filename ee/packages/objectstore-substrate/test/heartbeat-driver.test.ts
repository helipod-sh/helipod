/* Stackbase Enterprise. Licensed under the Stackbase Commercial License — see ee/LICENSE. */
/**
 * Task 6.2a — the lease-heartbeat driver, over a REAL `ObjectStoreDocStore` on an fs bucket (per
 * `test/lease.test.ts`'s own harness) + a controllable fake `DriverContext` (per `@stackbase/
 * receipts`' `test/reaper.test.ts` harness). Two scenarios: (1) a normal renew advances the
 * manifest's `leaseExpiresAt` and re-arms; (2) once a challenger fences this store, the driver's
 * `wake()` catches `FencedError`, does NOT re-arm, and fires `onFenced` exactly once. `stop()`
 * clears the timer and prevents any further re-arm.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { DriverContext } from "@stackbase/component";
import { BunSqliteAdapter, NodeSqliteAdapter, SqliteDocStore } from "@stackbase/docstore-sqlite";
import { FsObjectStore } from "@stackbase/objectstore-fs";
import { ObjectStoreDocStore } from "../src/object-doc-store";
import { FencedError } from "../src/fenced-error";
import type { Manifest } from "../src/manifest";
import { leaseHeartbeatDriver, type LeaseHeartbeatDriver } from "../src/heartbeat-driver";

function freshLocal(): SqliteDocStore {
  const isBun = typeof (globalThis as { Bun?: unknown }).Bun !== "undefined";
  return new SqliteDocStore(isBun ? new BunSqliteAdapter({ path: ":memory:" }) : new NodeSqliteAdapter({ path: ":memory:" }));
}

const dirs: string[] = [];
async function freshBucket(): Promise<FsObjectStore> {
  const dir = await mkdtemp(join(tmpdir(), "objectstore-substrate-heartbeat-test-"));
  dirs.push(dir);
  return new FsObjectStore({ dir });
}

async function readManifestRaw(os: FsObjectStore): Promise<Manifest> {
  const e = await os.get("s0/manifest");
  return JSON.parse(new TextDecoder().decode(e!.body));
}

/** A manual/controllable fake `DriverContext` — mirrors `@stackbase/receipts`'
 *  `test/reaper.test.ts`'s harness (no real timers; the test fires timers explicitly). */
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
      throw new Error("leaseHeartbeatDriver does not call runFunction");
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
    // temp-dir bucket + re-arm) — unlike `@stackbase/receipts`' reaper test (SQLite, effectively
    // synchronous), this needs a real macrotask-scale delay, not just one microtask flush, for that
    // chain to settle before the next due-timer check.
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

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

describe("leaseHeartbeatDriver (Tier 3 Slice 6, Task 6.2)", () => {
  it("6.2a-1: a normal renew advances the manifest's leaseExpiresAt and re-arms for the next cadence", async () => {
    const objectStore = await freshBucket();
    const store = await ObjectStoreDocStore.open({ objectStore, shard: "0", local: freshLocal() });
    expect(await store.acquire({ writerId: "A", leaseTtlMs: 1000, now: 0 })).toEqual({ acquired: true });

    const { ctx, setNow, liveTimerCount, fireDueTimers } = makeFakeDriverContext();
    setNow(0);
    const driver: LeaseHeartbeatDriver = leaseHeartbeatDriver(store, { leaseTtlMs: 1000, heartbeatMs: 300 });

    driver.start(ctx);
    expect(liveTimerCount()).toBe(1); // start() arms immediately, no up-front tick

    setNow(300);
    await fireDueTimers();

    const manifestAfterFirst = await readManifestRaw(objectStore);
    expect(manifestAfterFirst.leaseExpiresAt).toBe("1300"); // now(300) + leaseTtlMs(1000)
    expect(manifestAfterFirst.epoch).toBe(1); // heartbeat never bumps epoch
    expect(manifestAfterFirst.writerId).toBe("A");
    expect(liveTimerCount()).toBe(1); // re-armed for the next cadence

    setNow(600);
    await fireDueTimers();
    const manifestAfterSecond = await readManifestRaw(objectStore);
    expect(manifestAfterSecond.leaseExpiresAt).toBe("1600");
    expect(liveTimerCount()).toBe(1);

    driver.stop?.();
    await store.close();
  });

  it("6.2a-2: once fenced, wake() catches FencedError, does NOT re-arm, and fires onFenced exactly once", async () => {
    const objectStore = await freshBucket();
    const store = await ObjectStoreDocStore.open({ objectStore, shard: "0", local: freshLocal() });
    expect(await store.acquire({ writerId: "A", leaseTtlMs: 1000, now: 0 })).toEqual({ acquired: true });

    const { ctx, setNow, liveTimerCount, fireDueTimers } = makeFakeDriverContext();
    setNow(0);

    const fencedErrors: FencedError[] = [];
    const driver: LeaseHeartbeatDriver = leaseHeartbeatDriver(store, {
      leaseTtlMs: 1000,
      heartbeatMs: 300,
      onFenced: (e) => fencedErrors.push(e),
    });
    driver.start(ctx);
    expect(liveTimerCount()).toBe(1);

    // A challenger acquires past A's lease expiry — bumps epoch, fencing A.
    const challenger = await ObjectStoreDocStore.open({ objectStore, shard: "0", local: freshLocal() });
    expect(await challenger.acquire({ writerId: "B", leaseTtlMs: 1000, now: 2000 })).toEqual({ acquired: true });

    // Fire A's driver's due timer — its heartbeat attempt now loses the CAS race (stale etag).
    setNow(2100);
    await fireDueTimers();

    expect(fencedErrors).toHaveLength(1);
    expect(liveTimerCount()).toBe(0); // did NOT re-arm — the driver stopped itself

    // `__tick()` itself checks the driver's own `stopped` guard first (mirroring `receiptsReaper`'s
    // `tick()`), so it's a no-op post-fence — not a way to re-probe the store. Confirm the STORE
    // itself is genuinely poisoned by going straight at it: any further commit is refused (`held`
    // was cleared by the fence), which is exactly the "never keeps a poisoned node serving" outcome
    // this driver's no-re-arm policy exists to surface promptly instead of retrying forever.
    await expect(driver.__tick()).resolves.toBeUndefined();
    await expect(store.commitWrite([], [])).rejects.toThrow(/not the lease owner/i);
    expect(fencedErrors).toHaveLength(1); // the store-level rejection above didn't re-trigger onFenced

    await store.close();
    await challenger.close();
  });

  it("6.2a-3: a transient (non-fence) heartbeat failure logs and re-arms, keeping renewal attempts alive", async () => {
    let calls = 0;
    const flaky = {
      heartbeat: async () => {
        calls++;
        if (calls === 1) throw new Error("transient object-store blip");
        // second call succeeds — nothing further to assert on a bare fake.
      },
    };
    const { ctx, setNow, liveTimerCount, fireDueTimers } = makeFakeDriverContext();
    setNow(0);
    const fencedErrors: unknown[] = [];
    const driver = leaseHeartbeatDriver(flaky, { leaseTtlMs: 1000, heartbeatMs: 300, onFenced: (e) => fencedErrors.push(e) });

    driver.start(ctx);
    expect(liveTimerCount()).toBe(1);

    setNow(300);
    await fireDueTimers();
    expect(calls).toBe(1);
    expect(liveTimerCount()).toBe(1); // re-armed despite the transient failure
    expect(fencedErrors).toHaveLength(0); // never treated as a fence

    setNow(600);
    await fireDueTimers();
    expect(calls).toBe(2); // kept trying on the normal cadence
    expect(liveTimerCount()).toBe(1);

    driver.stop?.();
  });

  it("6.2a-4: stop() clears the timer and prevents any further re-arm", async () => {
    const objectStore = await freshBucket();
    const store = await ObjectStoreDocStore.open({ objectStore, shard: "0", local: freshLocal() });
    expect(await store.acquire({ writerId: "A", leaseTtlMs: 1000, now: 0 })).toEqual({ acquired: true });

    const { ctx, setNow, liveTimerCount, fireDueTimers } = makeFakeDriverContext();
    setNow(0);
    const driver = leaseHeartbeatDriver(store, { leaseTtlMs: 1000, heartbeatMs: 300 });
    driver.start(ctx);
    expect(liveTimerCount()).toBe(1);

    driver.stop?.();
    expect(liveTimerCount()).toBe(0);

    // Advancing time and firing due timers is a no-op: nothing is armed anymore.
    setNow(10_000);
    await fireDueTimers();
    expect(liveTimerCount()).toBe(0);
    const manifest = await readManifestRaw(objectStore);
    expect(manifest.leaseExpiresAt).toBe("1000"); // never renewed past the original acquire

    await store.close();
  });
});
