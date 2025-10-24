import { describe, it, expect } from "vitest";
import { SqliteDocStore, NodeSqliteAdapter } from "@stackbase/docstore-sqlite";
import { composeComponents } from "@stackbase/component";
import type { DriverContext } from "@stackbase/component";
import { EmbeddedRuntime } from "@stackbase/runtime-embedded";
import { defineSchema } from "@stackbase/values";
import type {
  BlobStore,
  UploadTarget,
  StoredBlob,
  ByteRange,
  CreateUploadTargetOpts,
  SignUrlOpts,
} from "@stackbase/blobstore";
import { STORAGE_TABLE, STORAGE_TABLE_NUMBER, storageTableDefinition } from "../src/system-table";
import { storageModules } from "../src/modules";
import { storageReaper } from "../src/reaper";
import type { StorageReaperDriver } from "../src/reaper";

/**
 * A minimal in-file `BlobStore` fake (mirrors `test/context.test.ts`'s `FakeBlobStore` — the real
 * `MemoryBlobStore` in `@stackbase/blobstore`'s test-support isn't a published export). `delete`
 * can be told to throw for specific keys, to exercise the reaper's best-effort robustness.
 */
class FakeBlobStore implements BlobStore {
  readonly blobs = new Map<string, Uint8Array>();
  readonly failDeleteFor = new Set<string>();

  async createUploadTarget(): Promise<UploadTarget> {
    return { kind: "proxied", url: "/api/storage/upload", method: "POST" };
  }
  async store(key: string, bytes: Uint8Array): Promise<StoredBlob> {
    this.blobs.set(key, bytes);
    return { size: bytes.byteLength, sha256: null };
  }
  async finalizeUpload(): Promise<StoredBlob | null> {
    return null;
  }
  async read(key: string, _range?: ByteRange): Promise<ReadableStream<Uint8Array> | null> {
    const buf = this.blobs.get(key);
    if (!buf) return null;
    return new ReadableStream({
      start(c) {
        c.enqueue(buf);
        c.close();
      },
    });
  }
  async delete(key: string): Promise<void> {
    if (this.failDeleteFor.has(key)) throw new Error(`boom: delete failed for ${key}`);
    this.blobs.delete(key);
  }
  async signGetUrl(_key: string, _opts: SignUrlOpts): Promise<string | null> {
    return null;
  }
  publicUrl(): string | null {
    return null;
  }
}

/** A runtime with only the `_storage` table + its privileged built-in modules — no context
 * provider/component needed: the reaper drives everything through `_storage:*` system modules. */
async function makeRuntime(): Promise<EmbeddedRuntime> {
  const schema = defineSchema({ [STORAGE_TABLE]: storageTableDefinition });
  const c = composeComponents({ schemaJson: schema.export(), moduleMap: {} }, [], {
    [STORAGE_TABLE]: STORAGE_TABLE_NUMBER,
  });
  return EmbeddedRuntime.create({
    store: new SqliteDocStore(new NodeSqliteAdapter()),
    catalog: c.catalog,
    modules: storageModules,
    systemModules: storageModules,
    componentNames: c.componentNames,
    contextProviders: c.contextProviders,
    policyRegistry: c.policyRegistry,
    policyProviders: c.policyProviders,
    relationRegistry: c.relationRegistry,
    bootSteps: c.bootSteps,
    drivers: c.drivers,
    tableNumbers: c.tableNumbers,
  });
}

/**
 * A manual/controllable fake `DriverContext`: `now()`/timers are driven explicitly by the test
 * (no real `setTimeout`), while `runFunction` dispatches through the REAL runtime above — mirroring
 * `components/scheduler/test/driver*.test.ts`'s "fake DriverContext + real modules" harness style.
 */
function makeFakeDriverContext(runtime: EmbeddedRuntime): {
  ctx: DriverContext;
  setNow: (t: number) => void;
  hasLiveTimer: () => boolean;
  fireDueTimers: () => Promise<void>;
  fireCommit: (tables: string[]) => void;
} {
  let clock = 0;
  let seq = 0;
  const timers = new Map<number, { atMs: number; cb: () => void }>();
  const commitSubs = new Set<(inv: { tables: string[]; ranges: readonly never[]; commitTs: number }) => void>();

  const ctx: DriverContext = {
    runFunction: async (path, args) => (await runtime.runSystem(path, args)).value,
    onCommit: (cb) => {
      commitSubs.add(cb);
      return () => commitSubs.delete(cb);
    },
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
    hasLiveTimer: () => timers.size > 0,
    // Fires every timer whose `atMs <= clock` (one at a time, since firing one may re-arm a fresh
    // one that's already due too), flushing a real macrotask after each so the fire-and-forget
    // async tick it kicks off fully settles before this returns — the tick body is pure
    // promise/microtask chaining (no nested real timers), so a single macrotask flush per fired
    // callback is enough regardless of how many `await`s the chain has.
    fireDueTimers: async () => {
      for (;;) {
        const due = [...timers.entries()].find(([, t]) => t.atMs <= clock);
        if (!due) break;
        const [h, t] = due;
        timers.delete(h);
        t.cb();
        await new Promise((r) => setTimeout(r, 0));
      }
    },
    fireCommit: (tables) => {
      for (const cb of commitSubs) cb({ tables, ranges: [], commitTs: clock });
    },
  };
}

describe("storageReaper — orphan sweep driver", () => {
  it("reaps an expired pending row and its blob on one tick", async () => {
    const runtime = await makeRuntime();
    const blobStore = new FakeBlobStore();
    const { ctx } = makeFakeDriverContext(runtime);
    const driver: StorageReaperDriver = storageReaper(blobStore, { sweepMs: 60_000 });

    const key = "orphan-key";
    await blobStore.store(key, new TextEncoder().encode("bytes"));
    const created = await runtime.runSystem<string>("_storage:_createPending", {
      key,
      contentType: "text/plain",
      visibility: "private",
      expiresAt: 0, // fake clock starts at 0 — already expired ("<=" now)
    });
    const id = created.value;

    driver.start(ctx);
    await driver.__tick();

    const doc = (await runtime.runSystem("_storage:_get", { id })).value;
    expect(doc).toBeNull();
    expect(await blobStore.read(key)).toBeNull();
  });

  it("does not reap a ready row or a pending row with a future expiresAt", async () => {
    const runtime = await makeRuntime();
    const blobStore = new FakeBlobStore();
    const { ctx } = makeFakeDriverContext(runtime);
    const driver: StorageReaperDriver = storageReaper(blobStore);

    const readyKey = "ready-key";
    await blobStore.store(readyKey, new TextEncoder().encode("ready"));
    const readyId = (
      await runtime.runSystem<string>("_storage:_insertReady", {
        key: readyKey,
        size: 5,
        sha256: null,
        contentType: null,
        visibility: "private",
      })
    ).value;

    const futureKey = "future-key";
    await blobStore.store(futureKey, new TextEncoder().encode("future"));
    const futureId = (
      await runtime.runSystem<string>("_storage:_createPending", {
        key: futureKey,
        contentType: null,
        visibility: "private",
        expiresAt: 999_999_999_999, // far future
      })
    ).value;

    driver.start(ctx);
    await driver.__tick();

    expect((await runtime.runSystem("_storage:_get", { id: readyId })).value).not.toBeNull();
    expect((await runtime.runSystem("_storage:_get", { id: futureId })).value).not.toBeNull();
    expect(await blobStore.read(readyKey)).not.toBeNull();
    expect(await blobStore.read(futureKey)).not.toBeNull();
  });

  it("a blobStore.delete that throws for one key does not stop the sweep from reaping the others", async () => {
    const runtime = await makeRuntime();
    const blobStore = new FakeBlobStore();
    const { ctx } = makeFakeDriverContext(runtime);
    const driver: StorageReaperDriver = storageReaper(blobStore);

    const badKey = "bad-key";
    const goodKey = "good-key";
    await blobStore.store(badKey, new TextEncoder().encode("bad"));
    await blobStore.store(goodKey, new TextEncoder().encode("good"));
    blobStore.failDeleteFor.add(badKey);

    const badId = (
      await runtime.runSystem<string>("_storage:_createPending", {
        key: badKey,
        contentType: null,
        visibility: "private",
        expiresAt: 0,
      })
    ).value;
    const goodId = (
      await runtime.runSystem<string>("_storage:_createPending", {
        key: goodKey,
        contentType: null,
        visibility: "private",
        expiresAt: 0,
      })
    ).value;

    driver.start(ctx);
    await expect(driver.__tick()).resolves.toBeUndefined();

    // Both `_storage` rows are gone regardless of the blob-delete outcome — row deletion happens
    // inside `_reapExpired` itself, independent of the driver's best-effort blob reclaim after.
    expect((await runtime.runSystem("_storage:_get", { id: badId })).value).toBeNull();
    expect((await runtime.runSystem("_storage:_get", { id: goodId })).value).toBeNull();
    // The good key's blob was reclaimed; the bad key's blob is left behind (delete failed), but
    // that failure did not prevent the good key's delete from running.
    expect(blobStore.blobs.has(badKey)).toBe(true);
    expect(blobStore.blobs.has(goodKey)).toBe(false);
  });

  it("stop() halts further ticks: neither the timer nor onCommit fires a sweep afterward", async () => {
    const runtime = await makeRuntime();
    const blobStore = new FakeBlobStore();
    const { ctx, setNow, fireDueTimers, fireCommit, hasLiveTimer } = makeFakeDriverContext(runtime);
    const driver = storageReaper(blobStore, { sweepMs: 1_000 });

    driver.start(ctx);
    // Let the initial start-up tick (against an empty table) settle before proceeding.
    await new Promise((r) => setTimeout(r, 0));
    expect(hasLiveTimer()).toBe(true); // armed for now()+sweepMs after the initial tick

    // Advance the clock so the currently-armed timer fires, proving the timer path itself works.
    const key1 = "k1";
    await blobStore.store(key1, new TextEncoder().encode("x"));
    await runtime.runSystem("_storage:_createPending", {
      key: key1,
      contentType: null,
      visibility: "private",
      expiresAt: 500,
    });
    setNow(2_000);
    await fireDueTimers();
    expect(await blobStore.read(key1)).toBeNull(); // reaped by the fired timer

    // Insert another expired row, then stop() before the clock/commit could trigger another sweep.
    const key2 = "k2";
    await blobStore.store(key2, new TextEncoder().encode("y"));
    await runtime.runSystem("_storage:_createPending", {
      key: key2,
      contentType: null,
      visibility: "private",
      expiresAt: 2_500,
    });
    driver.stop?.();

    setNow(10_000);
    await fireDueTimers(); // no live timer left to fire
    fireCommit([STORAGE_TABLE]); // subscription was torn down — no-op

    // k2's blob is still there: nothing swept it after stop().
    expect(await blobStore.read(key2)).not.toBeNull();
  });

  it("stop() while a tick is in flight does not resurrect the driver once that tick settles", async () => {
    // Regression test for the driver-resurrection race: `wake()`'s `.finally(() => armTimer())`
    // used to run unconditionally when an in-flight tick settled, with no "stopped" guard — so if
    // `stop()` raced in while a sweep's `runFunction` was still awaiting (e.g. a `stackbase dev`
    // hot-reload teardown racing a sweep), the settling tick would arm a brand-new timer and the
    // driver would keep running forever after `stop()` returned.
    const runtime = await makeRuntime();
    const blobStore = new FakeBlobStore();
    const { ctx: baseCtx, hasLiveTimer, setNow, fireDueTimers, fireCommit } = makeFakeDriverContext(runtime);

    let runFunctionCalls = 0;
    let blockNextCall = false;
    // Boxed in an object (rather than a bare `let`) so TS doesn't narrow the closed-over binding
    // to `null` across the nested-closure assignment below — a plain `let releaseBlock: (() =>
    // void) | null = null` mutated only inside a nested arrow gets mis-narrowed to `never` at the
    // `releaseBlock?.()` call site.
    const block: { release: (() => void) | null } = { release: null };

    // Wraps the base fake context's `runFunction` so a specific call can be told to block on a
    // manually-resolved promise — simulating a sweep pass (`_storage:_reapExpired`, or the
    // subsequent `blobStore.delete`) that's still mid-flight when `stop()` races in.
    const ctx: DriverContext = {
      ...baseCtx,
      runFunction: async (path, args) => {
        runFunctionCalls++;
        if (blockNextCall) {
          blockNextCall = false;
          await new Promise<void>((resolve) => {
            block.release = resolve;
          });
        }
        return baseCtx.runFunction(path, args);
      },
    };

    const driver = storageReaper(blobStore, { sweepMs: 1_000 });

    // Let the initial start-up tick (against an empty table) settle before proceeding, so the
    // blocking below applies only to the sweep we trigger next.
    driver.start(ctx);
    await new Promise((r) => setTimeout(r, 0));
    expect(hasLiveTimer()).toBe(true);
    const callsAfterStartup = runFunctionCalls;

    // Trigger a fresh sweep via the onCommit path (mirrors a real write racing a hot-reload
    // teardown) and let it reach + block inside `runFunction`, so the tick is genuinely
    // "in flight" when `stop()` is called below.
    blockNextCall = true;
    fireCommit([STORAGE_TABLE]);
    await new Promise((r) => setTimeout(r, 0));
    expect(runFunctionCalls).toBe(callsAfterStartup + 1);

    // Race: stop() while that tick is still awaiting `runFunction`.
    driver.stop?.();
    expect(hasLiveTimer()).toBe(false); // stop() clears the timer that was live at that moment

    // Now let the blocked tick actually settle.
    block.release?.();
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));

    // The settling tick's `wake()` `.finally` must NOT have armed a new timer.
    expect(hasLiveTimer()).toBe(false);

    // Prove it strictly: advance the clock well past `sweepMs` and try to fire due timers. If the
    // driver had resurrected itself (the bug), a re-armed timer would be due now and firing it
    // would trigger another `runFunction` call.
    setNow(100_000);
    await fireDueTimers();
    expect(runFunctionCalls).toBe(callsAfterStartup + 1);

    // And the onCommit subscription stays torn down too — no new sweep from a write either.
    fireCommit([STORAGE_TABLE]);
    await new Promise((r) => setTimeout(r, 0));
    expect(runFunctionCalls).toBe(callsAfterStartup + 1);
  });
});
