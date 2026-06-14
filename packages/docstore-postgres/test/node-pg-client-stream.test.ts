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
import { describe, it, expect, vi, afterEach } from "vitest";

interface FakeClientInstance {
  opts: { connectionString: string; application_name?: string };
  connected: boolean;
  ended: boolean;
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
    private readonly handlers = new Map<string, Array<(...args: unknown[]) => void>>();
    constructor(public opts: { connectionString: string; application_name?: string }) {
      state.clientInstances.push(this);
    }
    async connect(): Promise<void> {
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
import { NodePgClient } from "../src/node-pg-client";

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
    vi.clearAllMocks();
  });

  it("opens a DEDICATED connection (not the pinned writer connection) on first use, and keeps it open (returned to the pool) after a full drain", async () => {
    const client = new NodePgClient({ connectionString: "postgres://fake" });
    expect(state.clientInstances).toHaveLength(1); // the pinned connection, built eagerly in the ctor
    const mainConn = state.clientInstances[0]!;

    state.readQueue.push([{ a: 1 }, { a: 2 }], []); // one batch, then the empty-batch end signal
    const rows = await drain(client.queryStream("SELECT a FROM t"));

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
    await drain(client.queryStream("SELECT a FROM t"));
    expect(state.clientInstances).toHaveLength(2); // pinned + one stream connection built
    const streamConn = state.clientInstances[1]!;

    state.readQueue.push([{ a: 2 }], []);
    const rows2 = await drain(client.queryStream("SELECT a FROM t"));

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
    for await (const row of client.queryStream("SELECT a FROM t")) {
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
    await drain(client.queryStream("SELECT a FROM t"));
    expect(state.clientInstances).toHaveLength(2);
  });

  it("(b) discards (does not reuse) a connection whose read rejected, and rethrows", async () => {
    const client = new NodePgClient({ connectionString: "postgres://fake" });
    const boom = new Error("simulated cursor read failure");
    state.readQueue.push(boom);

    await expect(drain(client.queryStream("SELECT a FROM t"))).rejects.toThrow("simulated cursor read failure");

    expect(state.clientInstances).toHaveLength(2);
    const brokenConn = state.clientInstances[1]!;
    expect(brokenConn.ended).toBe(true); // discarded, not returned to idle
    expect(state.cursorInstances[0]!.closed).toBe(true); // cursor still closed

    // The NEXT stream call must build a fresh connection rather than reuse the broken one.
    state.readQueue.push([]);
    await drain(client.queryStream("SELECT a FROM t"));
    expect(state.clientInstances).toHaveLength(3);
    expect(state.clientInstances[2]).not.toBe(brokenConn);
  });

  it("(d) attaches an 'error' listener on every pooled connection so a connection-level failure can't crash the process, and discards a connection it flags even if the read loop itself didn't throw", async () => {
    const client = new NodePgClient({ connectionString: "postgres://fake" });
    state.readQueue.push([{ a: 1 }]); // one batch; hold off the empty-batch terminator

    const iter = client.queryStream("SELECT a FROM t")[Symbol.asyncIterator]();
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
    await drain(client.queryStream("SELECT a FROM t"));
    expect(state.clientInstances).toHaveLength(3);
    expect(state.clientInstances[2]).not.toBe(streamConn);
  });

  it("(c) close() ends every idle pooled connection", async () => {
    const client = new NodePgClient({ connectionString: "postgres://fake" });
    state.readQueue.push([{ a: 1 }], []);
    await drain(client.queryStream("SELECT a FROM t"));

    const streamConn = state.clientInstances[1]!;
    expect(streamConn.ended).toBe(false); // idle, not yet ended

    await client.close();
    expect(streamConn.ended).toBe(true); // close() drained the read pool too
  });

  it("passes the SQL text and params straight through to the cursor", async () => {
    const client = new NodePgClient({ connectionString: "postgres://fake" });
    state.readQueue.push([]);
    await drain(client.queryStream("SELECT * FROM t WHERE id = $1", [42]));

    expect(state.cursorInstances[0]!.text).toBe("SELECT * FROM t WHERE id = $1");
    expect(state.cursorInstances[0]!.values).toEqual([42]);
  });
});
