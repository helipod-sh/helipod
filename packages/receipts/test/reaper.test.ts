import { describe, it, expect } from "vitest";
import { SqliteDocStore, NodeSqliteAdapter } from "@helipod/docstore-sqlite";
import type { DriverContext } from "@helipod/component";
import type { DocStore } from "@helipod/docstore";
import { receiptsReaper } from "../src/reaper";
import type { ReceiptsReaperDriver } from "../src/reaper";

/**
 * A manual/controllable fake `DriverContext`: `now()`/timers are driven explicitly by the test (no
 * real `setTimeout`) — mirrors `@helipod/storage`'s `test/reaper.test.ts` harness, minus the
 * `runFunction`/`onCommit` plumbing this driver doesn't use (see `reaper.ts`'s doc comment for why).
 */
function makeFakeDriverContext(): {
  ctx: DriverContext;
  setNow: (t: number) => void;
  hasLiveTimer: () => boolean;
  fireDueTimers: () => Promise<void>;
} {
  let clock = 0;
  let seq = 0;
  const timers = new Map<number, { atMs: number; cb: () => void }>();

  const ctx: DriverContext = {
    runFunction: async () => {
      throw new Error("receiptsReaper does not call runFunction");
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
    // Identity, like the runtime's own default — this fake is a long-lived-host stand-in.
    backstopMs: (d: number) => d,
    readLog: async () => ({ changes: [], maxScannedTs: 0 }),
  };

  return {
    ctx,
    setNow: (t) => {
      clock = t;
    },
    hasLiveTimer: () => timers.size > 0,
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
  };
}

async function makeStore(): Promise<SqliteDocStore> {
  const store = new SqliteDocStore(new NodeSqliteAdapter());
  await store.setupSchema();
  return store;
}

describe("receiptsReaper — TTL sweep driver", () => {
  // NOTE on shape: `start()` itself fires an immediate sweep (mirrors `storageReaper`'s own
  // start-up tick) — fire-and-forget, so its actual DB work can land either before or interleaved
  // with an explicitly-awaited `__tick()` call made right after `start()`. These tests therefore
  // assert on STORE STATE after everything has settled, never on which specific call (the implicit
  // start-up tick vs. an explicit `__tick()`) performed a given deletion — the exact `deletedCount`
  // return-value contract is already exhaustively covered by `sweepExpiredClientMutations`'s own
  // conformance-suite tests in `packages/docstore/test-support/conformance.ts`.
  it("leaves a fresh record alone under a short ttlMs, then sweeps it once ttlMs no longer covers it", async () => {
    const store = await makeStore();
    const { ctx, setNow } = makeFakeDriverContext();
    setNow(1_000_000);

    await store.recordClientVerdict("u1", "tab-1", 1, { verdict: "applied", commitTs: 1n });

    // ttlMs=100 means the cutoff is well before the record's real wall-clock createdAt — it must
    // survive both the driver's start-up tick and an explicit follow-up `__tick()`.
    const driver: ReceiptsReaperDriver = receiptsReaper(store, { ttlMs: 100 });
    driver.start(ctx);
    await driver.__tick();
    expect(await store.getClientVerdict("u1", "tab-1", 1)).not.toBeNull();
    driver.stop?.();

    // A huge NEGATIVE ttlMs pushes the cutoff astronomically far into the future — past any real
    // wall-clock `createdAt` the record could carry — so it is gone once this driver has run.
    const driver2: ReceiptsReaperDriver = receiptsReaper(store, { ttlMs: -1e15 });
    driver2.start(ctx);
    await driver2.__tick();
    expect(await store.getClientVerdict("u1", "tab-1", 1)).toBeNull();
    driver2.stop?.();
  });

  it("advances the client's floor for records it sweeps, but never deletes floor rows", async () => {
    const store = await makeStore();
    const { ctx } = makeFakeDriverContext();

    await store.recordClientVerdict("u1", "tab-1", 5, { verdict: "applied", commitTs: 5n });
    expect(await store.getClientFloor("u1", "tab-1")).toBeNull(); // no floor yet

    // A cutoff far in the future sweeps the record — via the driver's own start-up tick and/or the
    // explicit follow-up `__tick()`, whichever gets to it first.
    const driver: ReceiptsReaperDriver = receiptsReaper(store, { ttlMs: -1e15 });
    driver.start(ctx);
    await driver.__tick();

    expect(await store.getClientVerdict("u1", "tab-1", 5)).toBeNull();
    expect(await store.getClientFloor("u1", "tab-1")).toBe(5); // advanced to cover the swept seq
    driver.stop?.();
  });

  it("stop() halts further ticks: the timer no longer fires a sweep afterward", async () => {
    const store = await makeStore();
    const { ctx, setNow, fireDueTimers, hasLiveTimer } = makeFakeDriverContext();
    const driver = receiptsReaper(store, { sweepMs: 1_000, ttlMs: -1e15 });

    driver.start(ctx);
    await new Promise((r) => setTimeout(r, 0)); // let the start-up tick settle
    expect(hasLiveTimer()).toBe(true);

    driver.stop?.();
    expect(hasLiveTimer()).toBe(false);

    await store.recordClientVerdict("u2", "tab-2", 1, { verdict: "applied", commitTs: 1n });
    setNow(100_000);
    await fireDueTimers(); // no live timer left to fire

    // Nothing swept it after stop().
    expect(await store.getClientVerdict("u2", "tab-2", 1)).not.toBeNull();
  });

  it("a sweep failure is swallowed by the timer path and does not kill the driver", async () => {
    // A minimal fake `DocStore` whose only implemented member is the one this driver calls — the
    // point of the test is the driver's own resilience, not a real store's behavior.
    const failingStore = {
      sweepExpiredClientMutations: async () => {
        throw new Error("boom");
      },
    } as unknown as DocStore;
    const { ctx, setNow, fireDueTimers, hasLiveTimer } = makeFakeDriverContext();
    const driver = receiptsReaper(failingStore, { sweepMs: 1_000, ttlMs: 100 });

    driver.start(ctx);
    await new Promise((r) => setTimeout(r, 0));
    expect(hasLiveTimer()).toBe(true); // re-armed even though the pass threw

    setNow(2_000);
    await fireDueTimers();
    expect(hasLiveTimer()).toBe(true); // still re-arms on the second failure too
  });
});
