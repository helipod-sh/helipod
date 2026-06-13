/**
 * `NodePgClient.queryStream` (Task 4) — CONNECTION LIFECYCLE unit test, `pg`/`pg-cursor` mocked.
 *
 * Real-Postgres behavior (does the cursor actually stream, does it see the right rows) is proven
 * by the shared conformance suite running against `PgliteClient.queryStream` (`stream-client.test.ts`,
 * `index-scan.test.ts`) — an in-process real-Postgres-semantics engine — and CANNOT be re-proven here
 * against a live server (embedded-postgres can't boot in this environment; see `embedded-pg.test.ts`).
 * What CAN be proven without a live server, and is the actual Critical-bug risk this task calls out,
 * is the CONNECTION LIFECYCLE around `pg-cursor`: does `queryStream` open its own connection (never
 * the pinned writer connection, never hijacking a `transaction()`), and is that connection ALWAYS
 * `end()`ed — on a full drain, on an early consumer `break`, and when the cursor throws mid-read.
 *
 * `pg.Client.query(submittable)` returns the SAME object synchronously when the argument exposes a
 * `.submit` function (confirmed against the installed `pg@8.22.0` source, `lib/client.js`) — so the
 * mock's `query()` just mirrors that one contract; it does not attempt to replicate `pg-cursor`'s real
 * wire-protocol `.submit()` (Parse/Bind/Describe/Execute), which is not what this test is proving.
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

describe("NodePgClient.queryStream — connection lifecycle (pg + pg-cursor mocked)", () => {
  afterEach(() => {
    state.clientInstances.length = 0;
    state.cursorInstances.length = 0;
    state.readQueue.length = 0;
    vi.clearAllMocks();
  });

  it("opens a DEDICATED connection (not the pinned writer connection) and ends it on a full drain", async () => {
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
    expect(streamConn.ended).toBe(true); // closed after drain
    expect(mainConn.ended).toBe(false); // the writer connection was never touched
    expect(state.cursorInstances).toHaveLength(1);
    expect(state.cursorInstances[0]!.closed).toBe(true);
  });

  it("closes the cursor and ends the connection on an early consumer break", async () => {
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
    expect(state.clientInstances[1]!.ended).toBe(true); // the dedicated connection was still torn down
    expect(state.cursorInstances[0]!.closed).toBe(true); // and the cursor was still closed
  });

  it("closes the cursor and ends the connection when a read rejects, and rethrows", async () => {
    const client = new NodePgClient({ connectionString: "postgres://fake" });
    const boom = new Error("simulated cursor read failure");
    state.readQueue.push(boom);

    await expect(drain(client.queryStream("SELECT a FROM t"))).rejects.toThrow("simulated cursor read failure");

    expect(state.clientInstances).toHaveLength(2);
    expect(state.clientInstances[1]!.ended).toBe(true); // no leaked connection on error
    expect(state.cursorInstances[0]!.closed).toBe(true); // and the cursor was still closed
  });

  it("attaches an 'error' listener on the stream connection so a connection-level failure can't crash the process, and still cleans up", async () => {
    const client = new NodePgClient({ connectionString: "postgres://fake" });
    state.readQueue.push([{ a: 1 }], []);

    const rows = await drain(client.queryStream("SELECT a FROM t"));
    expect(rows).toEqual([{ a: 1 }]);

    const streamConn = state.clientInstances[1]!;
    // An 'error' listener WAS registered on the dedicated stream connection — mirrors the pinned
    // connection's `this.client.on("error", ...)` in `ensure()` and the per-shard commit
    // connections' `fireShardConnectionLost` wiring. Without this, a connection-level failure
    // (socket ECONNRESET, backend killed via pg_terminate_backend, mid-stream disconnect) would be
    // an unhandled 'error' event and crash the whole process.
    expect(streamConn.listenerCount("error")).toBeGreaterThan(0);
    // Proves the listener is real, not a no-op stub swallowed by the mock itself: emitting 'error'
    // must NOT throw (the FakeClient's own `emit()` throws precisely when zero listeners are
    // registered — the crash shape being guarded against).
    expect(() => streamConn.emit("error", new Error("simulated connection reset"))).not.toThrow();
    // The connection is still torn down normally.
    expect(streamConn.ended).toBe(true);
  });

  it("passes the SQL text and params straight through to the cursor", async () => {
    const client = new NodePgClient({ connectionString: "postgres://fake" });
    state.readQueue.push([]);
    await drain(client.queryStream("SELECT * FROM t WHERE id = $1", [42]));

    expect(state.cursorInstances[0]!.text).toBe("SELECT * FROM t WHERE id = $1");
    expect(state.cursorInstances[0]!.values).toEqual([42]);
  });
});
