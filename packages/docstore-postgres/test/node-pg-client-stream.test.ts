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
    constructor(public opts: { connectionString: string; application_name?: string }) {
      state.clientInstances.push(this);
    }
    async connect(): Promise<void> {
      this.connected = true;
    }
    on(_event: string, _cb: (...args: unknown[]) => void): void {}
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

  it("passes the SQL text and params straight through to the cursor", async () => {
    const client = new NodePgClient({ connectionString: "postgres://fake" });
    state.readQueue.push([]);
    await drain(client.queryStream("SELECT * FROM t WHERE id = $1", [42]));

    expect(state.cursorInstances[0]!.text).toBe("SELECT * FROM t WHERE id = $1");
    expect(state.cursorInstances[0]!.values).toEqual([42]);
  });
});
