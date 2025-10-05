/* Stackbase Enterprise. Licensed under the Stackbase Commercial License — see ee/LICENSE. */
/**
 * `WriteForwarder`'s Task 3 read-your-own-writes wait: after a successful `/_fleet/run` POST,
 * `forward()` waits for a locally attached replica tailer to catch up to the write's `commitTs`
 * before resolving — so a client that just wrote through a sync node doesn't immediately read its
 * own write's absence off a replica that hasn't applied it yet.
 *
 * Uses `StubTailer`, a lightweight structural stand-in for `ReplicaTailer`'s `waitFor`/`release`
 * seam (`ReplicaWaiter` in `forwarder.ts`) — a real `ReplicaTailer` needs a live Postgres primary +
 * replica store, which is what `replica-tailer.test.ts` is for; this file is pure forwarder-logic
 * unit tests. A stubbed global `fetch` stands in for the writer's `/_fleet/run` endpoint, and a
 * stub `PgClient` (not PGlite) backs the `LeaseManager` so `forward()`'s writer-URL discovery has
 * something real to call without any I/O — `LeaseManager`'s own persistence is covered elsewhere
 * (`lease.test.ts`).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { PgClient, PgQuerier, PgRow, PgValue } from "@stackbase/docstore-postgres";
import { LeaseManager } from "../src/lease";
import { WriteForwarder, type ReplicaWaiter } from "../src/forwarder";

type WaitOutcome = "reached" | "timeout" | "released";

interface StubWaiter {
  ts: bigint;
  settle: (outcome: WaitOutcome) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** Minimal stand-in for `ReplicaTailer`'s public `waitFor`/`release` surface — a directly settable
 *  watermark plus real `setTimeout`-driven timeout semantics (mirroring the real class closely
 *  enough that fake timers drive it the same way). */
class StubTailer implements ReplicaWaiter {
  private wm = 0n;
  private readonly waiters = new Set<StubWaiter>();

  setWatermark(ts: bigint): void {
    this.wm = ts;
    for (const w of [...this.waiters]) if (this.wm >= w.ts) w.settle("reached");
  }

  waitFor(ts: bigint, timeoutMs: number): Promise<WaitOutcome> {
    if (this.wm >= ts) return Promise.resolve("reached");
    return new Promise<WaitOutcome>((resolve) => {
      const waiter: StubWaiter = {
        ts,
        settle: (outcome) => {
          clearTimeout(waiter.timer);
          this.waiters.delete(waiter);
          resolve(outcome);
        },
        timer: setTimeout(() => waiter.settle("timeout"), timeoutMs),
      };
      this.waiters.add(waiter);
    });
  }

  release(): void {
    for (const w of [...this.waiters]) w.settle("released");
  }

  pendingCount(): number {
    return this.waiters.size;
  }
}

/** Stub `PgClient` whose query always returns a single canned `fleet_lease` row — enough for
 *  `LeaseManager.read()` to resolve a writer URL without standing up PGlite. */
class StubPgClient implements PgClient {
  constructor(private readonly writerUrl: string) {}
  async query(_text: string, _params?: readonly PgValue[]): Promise<PgRow[]> {
    return [{ epoch: 1n, writer_url: this.writerUrl }];
  }
  async transaction<T>(fn: (tx: PgQuerier) => Promise<T>): Promise<T> {
    return fn(this);
  }
  async acquireWriterLock(): Promise<void> {}
  async tryAcquireWriterLock(): Promise<boolean> {
    return true;
  }
  async close(): Promise<void> {}
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/** Flush pending real microtasks/macrotasks (fetch + Response body read) without advancing fake
 *  timers, so assertions can observe forward()'s state right after the POST resolves but before
 *  any timer-driven settlement. */
async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("WriteForwarder — read-your-own-writes (Task 3)", () => {
  let lease: LeaseManager;
  let originalFetch: typeof fetch;

  beforeEach(() => {
    lease = new LeaseManager(new StubPgClient("http://writer:4000"), { advertiseUrl: "http://self:4001" });
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.useRealTimers();
  });

  function makeForwarder(): WriteForwarder {
    return new WriteForwarder(lease, { adminKey: "test-admin-key", selfUrl: "http://self:4001" });
  }

  it("does not resolve until the replica watermark reaches commitTs", async () => {
    globalThis.fetch = vi.fn(async () => jsonResponse({ value: 42, committed: true, commitTs: "7" }));
    const forwarder = makeForwarder();
    const tailer = new StubTailer();
    forwarder.attachTailer(tailer);

    let resolved = false;
    const pending = forwarder.forward("mutation", "notes:add", {}, null).then((v) => {
      resolved = true;
      return v;
    });

    await flush();
    expect(resolved).toBe(false);
    expect(tailer.pendingCount()).toBe(1);

    tailer.setWatermark(7n);
    const value = await pending;
    expect(resolved).toBe(true);
    expect(value.value).toBe(42);
  });

  it("resolves immediately when the watermark has already reached commitTs", async () => {
    globalThis.fetch = vi.fn(async () => jsonResponse({ value: "ok", committed: true, commitTs: "3" }));
    const forwarder = makeForwarder();
    const tailer = new StubTailer();
    tailer.setWatermark(5n);
    forwarder.attachTailer(tailer);

    const value = await forwarder.forward("mutation", "notes:add", {}, null);
    expect(value.value).toBe("ok");
    expect(tailer.pendingCount()).toBe(0);
  });

  it("times out after 5s, warns once with path + commitTs, and resolves anyway", async () => {
    vi.useFakeTimers();
    globalThis.fetch = vi.fn(async () => jsonResponse({ value: "ok", committed: true, commitTs: "99" }));
    const forwarder = makeForwarder();
    const tailer = new StubTailer();
    forwarder.attachTailer(tailer);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const pending = forwarder.forward("mutation", "notes:add", {}, null);
    // Flush the (real, non-timer) fetch/JSON microtasks so waitFor() has actually registered its
    // setTimeout before we advance the fake clock past it.
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(5000);

    const value = await pending;
    expect(value.value).toBe("ok");
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const [message] = warnSpy.mock.calls[0] ?? [];
    expect(String(message)).toContain("notes:add");
    expect(String(message)).toContain("99");

    warnSpy.mockRestore();
  });

  it("promote() releases a pending wait immediately", async () => {
    globalThis.fetch = vi.fn(async () => jsonResponse({ value: "ok", committed: true, commitTs: "12" }));
    const forwarder = makeForwarder();
    const tailer = new StubTailer();
    forwarder.attachTailer(tailer);

    const pending = forwarder.forward("mutation", "notes:add", {}, null);
    await flush();
    expect(tailer.pendingCount()).toBe(1);

    forwarder.promote();
    const value = await pending;
    expect(value.value).toBe("ok");
    expect(tailer.pendingCount()).toBe(0);
  });

  it("skips the wait and warns once (not per call) when the response has no commitTs", async () => {
    globalThis.fetch = vi.fn(async () => jsonResponse({ value: "ok", committed: true }));
    const forwarder = makeForwarder();
    const tailer = new StubTailer();
    forwarder.attachTailer(tailer);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const first = await forwarder.forward("mutation", "notes:add", {}, null);
    const second = await forwarder.forward("mutation", "notes:add", {}, null);

    expect(first.value).toBe("ok");
    expect(second.value).toBe("ok");
    expect(tailer.pendingCount()).toBe(0);
    expect(warnSpy).toHaveBeenCalledTimes(1);

    warnSpy.mockRestore();
  });

  it("warns once for a missing commitTs AND once for an unparseable one — two DISTINCT warns, not a shared guard (C8b)", async () => {
    const responses = [
      jsonResponse({ value: "ok", committed: true }), // commitTs absent
      jsonResponse({ value: "ok", committed: true, commitTs: "not-a-bigint" }), // commitTs unparseable
      // Repeat both kinds — a shared/single guard would suppress these; a per-kind guard still
      // warns exactly once per kind total, never a second time for the SAME kind.
      jsonResponse({ value: "ok", committed: true }),
      jsonResponse({ value: "ok", committed: true, commitTs: "still-not-a-bigint" }),
    ];
    globalThis.fetch = vi.fn(async () => responses.shift()!);
    const forwarder = makeForwarder();
    const tailer = new StubTailer();
    forwarder.attachTailer(tailer);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    for (let i = 0; i < 4; i++) await forwarder.forward("mutation", "notes:add", {}, null);

    expect(warnSpy).toHaveBeenCalledTimes(2);
    const messages = warnSpy.mock.calls.map(([m]) => String(m));
    expect(messages.some((m) => m.includes("had no commitTs"))).toBe(true);
    expect(messages.some((m) => m.includes("unparseable commitTs"))).toBe(true);

    warnSpy.mockRestore();
  });

  it("skips the wait entirely when no tailer is attached (writer role)", async () => {
    globalThis.fetch = vi.fn(async () => jsonResponse({ value: "ok", committed: true, commitTs: "7" }));
    const forwarder = makeForwarder();
    // No attachTailer() call — this is the fleet WRITER's own forwarder (never used to forward,
    // but must not explode if it were), or a sync node before a tailer is wired in.
    const value = await forwarder.forward("mutation", "notes:add", {}, null);
    expect(value.value).toBe("ok");
  });
});
