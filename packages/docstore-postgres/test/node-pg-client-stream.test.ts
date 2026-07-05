/**
 * `NodePgClient.queryStream` (Task 4, pooled in Task 9) — CONNECTION LIFECYCLE unit test,
 * `pg`/`pg-cursor` mocked.
 *
 * Real-Postgres behavior (does the cursor actually stream, does it see the right rows) is proven
 * by the shared conformance suite running against `PgliteClient.queryStream` (`stream-client.test.ts`,
 * `index-scan.test.ts`) — an in-process real-Postgres-semantics engine — and CANNOT be re-proven here
 * against a live server (embedded-postgres can't boot in this environment; see `embedded-pg.test.ts`).
 * What CAN be proven without a live server, and is the actual Critical-bug risk these tasks call out,
 * is the CONNECTION LIFECYCLE around `pg-cursor` and the bounded read pool it now borrows from (Task 9):
 * does `queryStream` open its own connection (never the pinned writer connection, never hijacking a
 * `transaction()`); is a healthy connection RETURNED to the pool (not torn down) so a later call reuses
 * it instead of paying a fresh TCP+auth handshake; is a connection that errored DISCARDED rather than
 * handed to the next borrower; and is every pooled connection's teardown/'error'-listener wiring intact
 * on every exit path (full drain, early consumer `break`, thrown error, `close()`).
 *
 * `pg.Client.query(submittable)` returns the SAME object synchronously when the argument exposes a
 * `.submit` function (confirmed against the installed `pg@8.22.0` source, `lib/client.js`) — so the
 * mock's `query()` just mirrors that one contract; it does not attempt to replicate `pg-cursor`'s real
 * wire-protocol `.submit()` (Parse/Bind/Describe/Execute), which is not what this test is proving.
 *
 * NOTE (honest scope): this suite exercises the pool SEQUENTIALLY (one `queryStream` fully finishes
 * before the next starts) — the mock's shared `readQueue` FIFO doesn't distinguish which cursor a
 * `.read()` belongs to, so true concurrent interleaving isn't representable here. Sequential reuse is
 * still the behavior that matters (no handshake-per-call), and is what's asserted via build counts.
 * Real concurrent borrow/wait/release behavior against a live Postgres is unvalidated — see the task
 * report for the explicit real-PG-smoke follow-up.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

interface FakeClientInstance {
  opts: { connectionString: string; application_name?: string };
  connected: boolean;
  ended: boolean;
  /** Every plain-SQL-text `.query()` call this instance received, in order — lets a test assert
   *  which `SET` statements (if any) were issued on a given connection, e.g. the session-timeout
   *  `SET`s a pooled read connection should now install post-connect when configured. */
  queries: string[];
  /** Number of listeners registered for `event` — lets a test assert an `'error'` handler was
   *  actually attached (not just that `.on()` was called-and-discarded by a no-op stub). */
  listenerCount(event: string): number;
  /** Fires registered listeners for `event`, mirroring Node's `EventEmitter` contract closely
   *  enough for this test: emitting `'error'` with zero registered listeners THROWS (the same
   *  "unhandled 'error' event" crash the real `pg.Client`/Node `EventEmitter` produces), so a test
   *  can prove the production code's listener is real by emitting without it blowing up. */
  emit(event: string, ...args: unknown[]): void;
}

const state = vi.hoisted(() => ({
  clientInstances: [] as FakeClientInstance[],
  cursorInstances: [] as FakeCursorInstance[],
  /** FIFO of `.read()` results consumed by cursor instances IN THE ORDER `.read()` is called,
   *  shared across cursors in a test (each test only ever opens one). An `Error` entry makes that
   *  `.read()` call reject instead of resolve. */
  readQueue: [] as Array<unknown[] | Error>,
  /** When true, `FakeCursor.read()` returns a manually-controllable deferred instead of consuming
   *  `readQueue` — used to hold multiple concurrent `queryStream` calls open at will, so a test can
   *  drive the bounded read pool's waiter queue (borrow N, block the (N+1)th, release one, observe
   *  the waiter wake). One deferred per `.read()` call, appended to `manualReads` in call order. */
  useManualReads: false,
  manualReads: [] as Array<{ resolve: (rows: unknown[]) => void; reject: (e: Error) => void }>,
  /** When true, the NEXT `FakeClient.connect()` call rejects once (then resets to false) — models a
   *  network blip/auth hiccup on a freshly-built read-pool connection. */
  failNextConnect: false,
}));

interface FakeCursorInstance {
  text: string;
  values: unknown[];
  closed: boolean;
}

vi.mock("pg", () => {
  class FakeClient implements FakeClientInstance {
    connected = false;
    ended = false;
    queries: string[] = [];
    private readonly handlers = new Map<string, Array<(...args: unknown[]) => void>>();
    constructor(public opts: { connectionString: string; application_name?: string }) {
      state.clientInstances.push(this);
    }
    async connect(): Promise<void> {
      if (state.failNextConnect) {
        state.failNextConnect = false;
        throw new Error("simulated connect failure");
      }
      this.connected = true;
    }
    on(event: string, cb: (...args: unknown[]) => void): void {
      const arr = this.handlers.get(event) ?? [];
      arr.push(cb);
      this.handlers.set(event, arr);
    }
    listenerCount(event: string): number {
      return this.handlers.get(event)?.length ?? 0;
    }
    emit(event: string, ...args: unknown[]): void {
      const arr = this.handlers.get(event) ?? [];
      if (event === "error" && arr.length === 0) {
        // Mirrors real Node `EventEmitter`/`pg.Client`: an 'error' event emitted with zero
        // registered listeners throws — the exact process-crash shape this whole fix guards.
        throw args[0] instanceof Error ? args[0] : new Error(String(args[0]));
      }
      for (const cb of arr) cb(...args);
    }
    query(config: unknown, params?: unknown[]): unknown {
      // Mirrors pg's own `typeof config.submit === "function"` branch (see file doc comment): a
      // Submittable (our FakeCursor) is returned AS-IS, synchronously, not run as SQL text/params.
      if (config !== null && typeof config === "object" && typeof (config as { submit?: unknown }).submit === "function") {
        return config;
      }
      if (typeof config === "string") this.queries.push(config);
      return Promise.resolve({ rows: [] });
    }
    async end(): Promise<void> {
      this.ended = true;
    }
  }
  return { default: { Client: FakeClient, types: { getTypeParser: () => (v: string) => v } } };
});

vi.mock("pg-cursor", () => {
  class FakeCursor implements FakeCursorInstance {
    closed = false;
    constructor(public text: string, public values: unknown[]) {
      state.cursorInstances.push(this);
    }
    submit(): void {
      // Real pg-cursor drives the wire protocol from here; the mock's `.read()`/`.close()` below
      // are self-contained and don't need a live connection to answer.
    }
    async read(_maxRows: number): Promise<unknown[]> {
      if (state.useManualReads) {
        return new Promise<unknown[]>((resolve, reject) => {
          state.manualReads.push({ resolve, reject });
        });
      }
      const next = state.readQueue.shift();
      if (next === undefined) return [];
      if (next instanceof Error) throw next;
      return next;
    }
    async close(): Promise<void> {
      this.closed = true;
    }
  }
  return { default: FakeCursor };
});

// Imported AFTER both vi.mock(...) calls — vitest hoists mocks above imports regardless of source
// order, but keeping the imports below keeps the file readable in the order things actually happen.
import { NodePgClient, pgSessionTimeoutStatements } from "../src/node-pg-client";

async function drain<T>(iter: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const v of iter) out.push(v);
  return out;
}

describe("NodePgClient.queryStream — connection lifecycle + read pool (pg + pg-cursor mocked)", () => {
  afterEach(() => {
    state.clientInstances.length = 0;
    state.cursorInstances.length = 0;
    state.readQueue.length = 0;
    state.useManualReads = false;
    state.manualReads.length = 0;
    state.failNextConnect = false;
    vi.clearAllMocks();
  });

  it("opens a DEDICATED connection (not the pinned writer connection) on first use, and keeps it open (returned to the pool) after a full drain", async () => {
    const client = new NodePgClient({ connectionString: "postgres://fake" });
    expect(state.clientInstances).toHaveLength(1); // the pinned connection, built eagerly in the ctor
    const mainConn = state.clientInstances[0]!;

    state.readQueue.push([{ a: 1 }, { a: 2 }], []); // one batch, then the empty-batch end signal
    const rows = await drain(client.queryStream!("SELECT a FROM t"));

    expect(rows).toEqual([{ a: 1 }, { a: 2 }]);
    expect(state.clientInstances).toHaveLength(2); // a SECOND, dedicated connection was opened
    const streamConn = state.clientInstances[1]!;
    expect(streamConn).not.toBe(mainConn);
    expect(streamConn.connected).toBe(true);
    expect(streamConn.ended).toBe(false); // NOT torn down — returned to the read pool for reuse
    expect(mainConn.ended).toBe(false); // the writer connection was never touched
    expect(state.cursorInstances).toHaveLength(1);
    expect(state.cursorInstances[0]!.closed).toBe(true);
  });

  it("(a) reuses an idle pooled connection across sequential queryStream calls instead of opening a new one each time", async () => {
    const client = new NodePgClient({ connectionString: "postgres://fake" });

    state.readQueue.push([{ a: 1 }], []);
    await drain(client.queryStream!("SELECT a FROM t"));
    expect(state.clientInstances).toHaveLength(2); // pinned + one stream connection built
    const streamConn = state.clientInstances[1]!;

    state.readQueue.push([{ a: 2 }], []);
    const rows2 = await drain(client.queryStream!("SELECT a FROM t"));

    expect(rows2).toEqual([{ a: 2 }]);
    expect(state.clientInstances).toHaveLength(2); // SAME connection reused — no fresh handshake
    expect(state.clientInstances[1]).toBe(streamConn);
    expect(streamConn.ended).toBe(false);
    expect(state.cursorInstances).toHaveLength(2); // a new cursor per call, same underlying connection
  });

  it("closes the cursor and returns the connection to the pool (not ended) on an early consumer break", async () => {
    const client = new NodePgClient({ connectionString: "postgres://fake" });
    // Queue far more batches than will actually be read — proves the break stops fetching.
    state.readQueue.push([{ a: 1 }], [{ a: 2 }], [{ a: 3 }]);

    const seen: unknown[] = [];
    for await (const row of client.queryStream!("SELECT a FROM t")) {
      seen.push(row);
      break; // consumer bails after the first row — triggers the generator's implicit .return()
    }

    expect(seen).toEqual([{ a: 1 }]);
    expect(state.clientInstances).toHaveLength(2);
    const streamConn = state.clientInstances[1]!;
    expect(streamConn.ended).toBe(false); // healthy early-break: returned to the pool, not torn down
    expect(state.cursorInstances[0]!.closed).toBe(true); // but the cursor itself was still closed

    // Proves it's actually reusable: a subsequent call doesn't open a third connection.
    state.readQueue.push([]);
    await drain(client.queryStream!("SELECT a FROM t"));
    expect(state.clientInstances).toHaveLength(2);
  });

  it("(b) discards (does not reuse) a connection whose read rejected, and rethrows", async () => {
    const client = new NodePgClient({ connectionString: "postgres://fake" });
    const boom = new Error("simulated cursor read failure");
    state.readQueue.push(boom);

    await expect(drain(client.queryStream!("SELECT a FROM t"))).rejects.toThrow("simulated cursor read failure");

    expect(state.clientInstances).toHaveLength(2);
    const brokenConn = state.clientInstances[1]!;
    expect(brokenConn.ended).toBe(true); // discarded, not returned to idle
    expect(state.cursorInstances[0]!.closed).toBe(true); // cursor still closed

    // The NEXT stream call must build a fresh connection rather than reuse the broken one.
    state.readQueue.push([]);
    await drain(client.queryStream!("SELECT a FROM t"));
    expect(state.clientInstances).toHaveLength(3);
    expect(state.clientInstances[2]).not.toBe(brokenConn);
  });

  it("(d) attaches an 'error' listener on every pooled connection so a connection-level failure can't crash the process, and discards a connection it flags even if the read loop itself didn't throw", async () => {
    const client = new NodePgClient({ connectionString: "postgres://fake" });
    state.readQueue.push([{ a: 1 }]); // one batch; hold off the empty-batch terminator

    const iter = client.queryStream!("SELECT a FROM t")[Symbol.asyncIterator]();
    const first = await iter.next();
    expect(first.value).toEqual({ a: 1 });
    expect(first.done).toBeFalsy();

    const streamConn = state.clientInstances[1]!;
    // An 'error' listener WAS registered on the pooled stream connection — mirrors the pinned
    // connection's `this.client.on("error", ...)` in `ensure()` and the per-shard commit
    // connections' `fireShardConnectionLost` wiring. Without this, a connection-level failure
    // (socket ECONNRESET, backend killed via pg_terminate_backend, mid-stream disconnect) would be
    // an unhandled 'error' event and crash the whole process.
    expect(streamConn.listenerCount("error")).toBeGreaterThan(0);
    // Proves the listener is real, not a no-op stub swallowed by the mock itself: emitting 'error'
    // must NOT throw (the FakeClient's own `emit()` throws precisely when zero listeners are
    // registered — the crash shape being guarded against).
    expect(() => streamConn.emit("error", new Error("simulated connection reset"))).not.toThrow();

    // Let the stream finish normally (the read loop itself never throws) — but the connection was
    // flagged broken by the 'error' listener, so it must still be discarded at release time, not
    // handed back to the pool.
    state.readQueue.push([]);
    const rest = await iter.next();
    expect(rest.done).toBe(true);
    expect(streamConn.ended).toBe(true); // discarded despite a "successful" read loop

    // A subsequent stream must NOT reuse the broken connection — it builds a fresh one.
    state.readQueue.push([]);
    await drain(client.queryStream!("SELECT a FROM t"));
    expect(state.clientInstances).toHaveLength(3);
    expect(state.clientInstances[2]).not.toBe(streamConn);
  });

  it("(c) close() ends every idle pooled connection", async () => {
    const client = new NodePgClient({ connectionString: "postgres://fake" });
    state.readQueue.push([{ a: 1 }], []);
    await drain(client.queryStream!("SELECT a FROM t"));

    const streamConn = state.clientInstances[1]!;
    expect(streamConn.ended).toBe(false); // idle, not yet ended

    await client.close();
    expect(streamConn.ended).toBe(true); // close() drained the read pool too
  });

  it("passes the SQL text and params straight through to the cursor", async () => {
    const client = new NodePgClient({ connectionString: "postgres://fake" });
    state.readQueue.push([]);
    await drain(client.queryStream!("SELECT * FROM t WHERE id = $1", [42]));

    expect(state.cursorInstances[0]!.text).toBe("SELECT * FROM t WHERE id = $1");
    expect(state.cursorInstances[0]!.values).toEqual([42]);
  });

  describe("bounded read pool: waiter queue + connect-failure (Task 9 bug fix)", () => {
    // Mirrors the private `READ_POOL_MAX` in `src/node-pg-client.ts` — kept in sync manually since
    // it's intentionally not exported (an internal sizing detail, not part of the `PgClient` seam).
    const READ_POOL_MAX = 4;

    it("blocks the (MAX+1)th concurrent queryStream on the waiter queue until a release wakes it", async () => {
      const client = new NodePgClient({ connectionString: "postgres://fake" });
      state.useManualReads = true;

      // Saturate the pool: READ_POOL_MAX drains, each parked in its own manually-controlled
      // cursor.read() — their connections stay borrowed until we resolve that read.
      const holderSettled = new Array(READ_POOL_MAX).fill(false);
      const holders = Array.from({ length: READ_POOL_MAX }, (_, i) =>
        drain(client.queryStream!("SELECT a FROM t")).then((rows) => {
          holderSettled[i] = true;
          return rows;
        }),
      );
      await vi.waitFor(() => expect(state.manualReads).toHaveLength(READ_POOL_MAX));
      expect(state.clientInstances).toHaveLength(1 + READ_POOL_MAX); // pinned + exactly MAX stream conns

      // The (MAX+1)th call: pool is full and nothing is idle, so it must block on `readPoolWaiters`
      // rather than build a fifth connection.
      let waiterSettled = false;
      const waiterDrain = drain(client.queryStream!("SELECT a FROM t")).then((rows) => {
        waiterSettled = true;
        return rows;
      });

      // Give the waiter every chance to (wrongly) proceed before we release anything.
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      expect(waiterSettled).toBe(false); // still pending — proves it's genuinely blocked, not just slow
      expect(state.clientInstances).toHaveLength(1 + READ_POOL_MAX); // did NOT build a 5th connection

      // Complete ONE held stream (empty batch = clean end of stream) — releases its connection and
      // wakes exactly one queued waiter.
      state.manualReads.shift()!.resolve([]);
      await vi.waitFor(() => expect(holderSettled[0]).toBe(true));

      // The woken waiter reuses the just-freed connection (no new client built) and parks on its own
      // manual read.
      await vi.waitFor(() => expect(state.manualReads).toHaveLength(READ_POOL_MAX));
      expect(state.clientInstances).toHaveLength(1 + READ_POOL_MAX); // reused, not rebuilt
      expect(waiterSettled).toBe(false); // it's running now, but hasn't finished its own read yet

      // Finish the newly-woken waiter specifically — it pushed its manual read LAST (after all the
      // original holders), so it's the tail of the FIFO, not the head; `.pop()` (not `.shift()`)
      // targets it directly instead of completing an arbitrary still-parked holder by accident.
      state.manualReads.pop()!.resolve([]);
      await vi.waitFor(() => expect(waiterSettled).toBe(true));
      expect(await waiterDrain).toEqual([]);

      // Clean up the rest of the still-parked holders so nothing leaks into the next test.
      while (state.manualReads.length > 0) state.manualReads.shift()!.resolve([]);
      await Promise.all(holders);
    }, 5000); // explicit timeout: a regression here is a HANG (waiter never wakes), not a slow pass

    it("frees the read-pool slot and wakes a waiter when a fresh conn.connect() rejects — no permanent deadlock (fails against the pre-fix code)", async () => {
      const client = new NodePgClient({ connectionString: "postgres://fake" });
      state.useManualReads = true;

      // Saturate the pool exactly as above.
      const holders = Array.from({ length: READ_POOL_MAX }, () =>
        drain(client.queryStream!("SELECT a FROM t")).catch((e) => e as Error),
      );
      await vi.waitFor(() => expect(state.manualReads).toHaveLength(READ_POOL_MAX));

      // Queue the (MAX+1)th call: it must block on the waiter queue (pool is full).
      let waiterSettled = false;
      let waiterError: Error | undefined;
      const waiterDrain = drain(client.queryStream!("SELECT a FROM t")).then(
        (rows) => {
          waiterSettled = true;
          return rows;
        },
        (e: Error) => {
          waiterSettled = true;
          waiterError = e;
          throw e;
        },
      );
      waiterDrain.catch(() => {}); // observed via the assertion below; suppress unhandled-rejection noise
      await Promise.resolve();
      await Promise.resolve();
      expect(waiterSettled).toBe(false);
      expect(state.clientInstances).toHaveLength(1 + READ_POOL_MAX); // hasn't attempted a build yet

      // Kill ONE held connection via a genuine read FAILURE (not a clean end). This is the only way
      // to free a `readPoolTotal` slot WITHOUT handing the freed connection back to `readPoolIdle` —
      // a clean end would let the waiter grab the idle connection directly, never calling connect()
      // again, which would not exercise this bug at all. `releaseReadConn(conn, { broken: true })`
      // ends+discards the killed connection and wakes the queued waiter, which must then build (and
      // connect()) a brand-new connection to satisfy itself — exactly the connect() call armed below.
      state.failNextConnect = true;
      state.manualReads.shift()!.reject(new Error("held stream read failure"));

      // (a) the waiter's queryStream call rejects — it does NOT hang forever (the pre-fix deadlock).
      await vi.waitFor(() => expect(waiterSettled).toBe(true), { timeout: 2000 });
      expect(waiterError?.message).toBe("simulated connect failure");
      await expect(waiterDrain).rejects.toThrow("simulated connect failure");

      // (b) `readPoolTotal` did not leak: the failed connect()'s reserved slot was freed, so a fresh
      // queryStream call still succeeds instead of hanging on `readPoolWaiters` forever.
      state.useManualReads = false;
      state.readQueue.push([]);
      await expect(drain(client.queryStream!("SELECT a FROM t"))).resolves.toEqual([]);

      // Clean up the remaining held streams.
      while (state.manualReads.length > 0) state.manualReads.shift()!.resolve([]);
      await Promise.all(holders);
    }, 5000); // explicit timeout: pre-fix, this HANGS (the leaked slot deadlocks the waiter forever)

    it("(FIFO fairness) hands a released connection DIRECTLY to the oldest queued waiter — later waiters and a fresh non-waiting caller never jump the line", async () => {
      const client = new NodePgClient({ connectionString: "postgres://fake" });
      state.useManualReads = true;

      // Saturate the pool exactly as the other pool tests do.
      const holderSettled = new Array(READ_POOL_MAX).fill(false);
      const holders = Array.from({ length: READ_POOL_MAX }, (_, i) =>
        drain(client.queryStream!("SELECT a FROM t")).then((rows) => {
          holderSettled[i] = true;
          return rows;
        }),
      );
      await vi.waitFor(() => expect(state.manualReads).toHaveLength(READ_POOL_MAX));
      expect(state.clientInstances).toHaveLength(1 + READ_POOL_MAX);

      // Queue W1, then W2 — both block on `readPoolWaiters` in that order (pool full, nothing idle).
      // The synchronous prefix of `acquireReadConn` (the `readPoolWaiters.push(...)` inside the
      // blocking-wait `new Promise` executor) runs the moment each call is made — before any
      // `await` — so W1's push is guaranteed to land before W2's simply by calling them in order.
      let w1Settled = false;
      let w2Settled = false;
      const w1 = drain(client.queryStream!("SELECT a FROM t")).then((rows) => {
        w1Settled = true;
        return rows;
      });
      const w2 = drain(client.queryStream!("SELECT a FROM t")).then((rows) => {
        w2Settled = true;
        return rows;
      });
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      expect(w1Settled).toBe(false);
      expect(w2Settled).toBe(false);
      expect(state.clientInstances).toHaveLength(1 + READ_POOL_MAX); // neither built a connection — both queued

      // Release exactly ONE held connection, and — in the SAME synchronous turn, before the release's
      // own microtask chain (cursor.read() resolve -> loop break -> cursor.close() -> releaseReadConn)
      // has run at all — start a brand-new, never-queued caller. This is the exact "steal in the gap"
      // shape the fix closes: under the old push-to-idle-then-wake implementation, a healthy release
      // pushed the connection to `readPoolIdle` and only THEN woke a waiter, leaving a window where any
      // synchronous idle-pop (including a fresh caller's own) could grab it first and re-park the
      // rightful (oldest) waiter behind it. Direct hand-off means there is no idle push to race against.
      state.manualReads.shift()!.resolve([]);
      let freshSettled = false;
      const fresh = drain(client.queryStream!("SELECT a FROM t")).then((rows) => {
        freshSettled = true;
        return rows;
      });

      await vi.waitFor(() => expect(holderSettled[0]).toBe(true));

      // W1 — the oldest waiter — must be the one who got the freed connection: it re-parks on its OWN
      // manual read using the handed-off connection, so `manualReads` grows back to MAX with NO new
      // connection built (a steal-then-rebuild would show up as clientInstances growing past 1+MAX).
      await vi.waitFor(() => expect(state.manualReads).toHaveLength(READ_POOL_MAX));
      expect(state.clientInstances).toHaveLength(1 + READ_POOL_MAX);
      expect(w1Settled).toBe(false); // running now, hasn't finished its own read yet
      expect(w2Settled).toBe(false); // NOT woken — only one connection was freed, and W1 got it
      expect(freshSettled).toBe(false); // did NOT steal it either — queued behind W2, not ahead of it

      // Release a SECOND connection: FIFO says W2 (queued strictly before the fresh caller) must be
      // the one who gets it next — never the fresh caller.
      state.manualReads.shift()!.resolve([]);
      await vi.waitFor(() => expect(holderSettled[1]).toBe(true));
      await vi.waitFor(() => expect(state.manualReads).toHaveLength(READ_POOL_MAX));
      expect(state.clientInstances).toHaveLength(1 + READ_POOL_MAX); // still reused, not rebuilt
      expect(w2Settled).toBe(false); // running now, hasn't finished its own read yet
      expect(freshSettled).toBe(false); // STILL hasn't gotten a connection — proves it never jumped W2

      // Release a THIRD connection: only the fresh caller is left waiting now, so it finally gets one.
      state.manualReads.shift()!.resolve([]);
      await vi.waitFor(() => expect(holderSettled[2]).toBe(true));
      await vi.waitFor(() => expect(state.manualReads).toHaveLength(READ_POOL_MAX));
      expect(state.clientInstances).toHaveLength(1 + READ_POOL_MAX); // reused for the fresh caller too

      // Clean up: no waiters remain queued at this point, so a plain drain finishes everything.
      while (state.manualReads.length > 0) state.manualReads.shift()!.resolve([]);
      await Promise.all([...holders, w1, w2, fresh]);
      expect(w1Settled).toBe(true);
      expect(w2Settled).toBe(true);
      expect(freshSettled).toBe(true);
    }, 5000); // explicit timeout: a regression here is a HANG or a silent starvation reordering
  });
});

describe("NodePgClient read-pool connections — statement_timeout / idle_in_transaction_session_timeout (pool hardening)", () => {
  afterEach(() => {
    state.clientInstances.length = 0;
    state.cursorInstances.length = 0;
    state.readQueue.length = 0;
    vi.clearAllMocks();
  });

  const timeouts = { idleInTransactionMs: 5000, statementMs: 3000 };

  it("issues the configured SET statements on a freshly-built pooled read connection, before it is ever handed to a caller", async () => {
    const client = new NodePgClient({ connectionString: "postgres://fake", sessionTimeouts: timeouts });
    state.readQueue.push([{ a: 1 }], []);
    const rows = await drain(client.queryStream!("SELECT a FROM t"));

    expect(rows).toEqual([{ a: 1 }]); // the stream still worked
    const streamConn = state.clientInstances[1]!; // pinned + one pooled read connection
    // Same builder the pinned connection's `ensure()` uses — same GUCs, same order.
    expect(streamConn.queries).toEqual(pgSessionTimeoutStatements(timeouts));
  });

  it("does NOT issue any SET when sessionTimeouts is unset — pooled connections stay unbounded by default, exactly as before", async () => {
    const client = new NodePgClient({ connectionString: "postgres://fake" });
    state.readQueue.push([]);
    await drain(client.queryStream!("SELECT a FROM t"));

    const streamConn = state.clientInstances[1]!;
    expect(streamConn.queries).toEqual([]);
  });

  it("does not re-issue the SET statements when a pooled connection is REUSED across calls (installed once, at build time)", async () => {
    const client = new NodePgClient({ connectionString: "postgres://fake", sessionTimeouts: timeouts });
    state.readQueue.push([{ a: 1 }], []);
    await drain(client.queryStream!("SELECT a FROM t"));
    const streamConn = state.clientInstances[1]!;
    expect(streamConn.queries).toEqual(pgSessionTimeoutStatements(timeouts));

    state.readQueue.push([{ a: 2 }], []);
    await drain(client.queryStream!("SELECT a FROM t"));

    expect(state.clientInstances).toHaveLength(2); // same connection reused, not rebuilt
    expect(streamConn.queries).toEqual(pgSessionTimeoutStatements(timeouts)); // not issued a second time
  });
});

describe("NodePgClient — HELIPOD_PG_STREAM kill switch", () => {
  const ENV_KEY = "HELIPOD_PG_STREAM";
  let savedValue: string | undefined;
  let hadKey: boolean;

  beforeEach(() => {
    hadKey = ENV_KEY in process.env;
    savedValue = process.env[ENV_KEY];
  });

  afterEach(() => {
    if (hadKey) {
      process.env[ENV_KEY] = savedValue;
    } else {
      delete process.env[ENV_KEY];
    }
    state.clientInstances.length = 0;
    state.cursorInstances.length = 0;
    state.readQueue.length = 0;
    vi.clearAllMocks();
  });

  it('does NOT advertise queryStream when HELIPOD_PG_STREAM="0"', () => {
    process.env[ENV_KEY] = "0";
    const client = new NodePgClient({ connectionString: "postgres://fake" });
    expect(client.queryStream).toBeFalsy();
  });

  it('does NOT advertise queryStream when HELIPOD_PG_STREAM="false"', () => {
    process.env[ENV_KEY] = "false";
    const client = new NodePgClient({ connectionString: "postgres://fake" });
    expect(client.queryStream).toBeFalsy();
  });

  it("advertises a working queryStream when HELIPOD_PG_STREAM is unset (default ON)", async () => {
    delete process.env[ENV_KEY];
    const client = new NodePgClient({ connectionString: "postgres://fake" });
    expect(client.queryStream).toBeTruthy();

    state.readQueue.push([{ a: 1 }], []);
    const rows = await drain(client.queryStream!("SELECT a FROM t"));
    expect(rows).toEqual([{ a: 1 }]);
  });

  it('advertises a working queryStream when HELIPOD_PG_STREAM="1"', async () => {
    process.env[ENV_KEY] = "1";
    const client = new NodePgClient({ connectionString: "postgres://fake" });
    expect(client.queryStream).toBeTruthy();

    state.readQueue.push([{ a: 1 }], []);
    const rows = await drain(client.queryStream!("SELECT a FROM t"));
    expect(rows).toEqual([{ a: 1 }]);
  });
});
