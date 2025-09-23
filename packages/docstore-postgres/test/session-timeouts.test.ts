/**
 * Bounded-writer-session timeouts (Fenced Frontier B1, D4). A fleet writer-capable `NodePgClient`
 * gets `idle_in_transaction_session_timeout` + `statement_timeout` SET on its pinned connection at
 * connect; a non-fleet client (no `sessionTimeouts`) stays unbounded. No live Postgres: the pure SQL
 * builder is asserted directly, and `pg` is mocked (as in `node-pg-client-listen.test.ts`) to observe
 * the SETs actually issued post-connect on the MAIN connection.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { pgSessionTimeoutStatements } from "../src/node-pg-client";

describe("pgSessionTimeoutStatements — the pure SET builder", () => {
  it("emits idle_in_transaction + statement timeouts as integer-millisecond SETs", () => {
    expect(pgSessionTimeoutStatements({ idleInTransactionMs: 5000, statementMs: 10000 })).toEqual([
      "SET idle_in_transaction_session_timeout = 5000",
      "SET statement_timeout = 10000",
    ]);
  });

  it("truncates fractional millisecond inputs (GUCs want a bare integer)", () => {
    expect(pgSessionTimeoutStatements({ idleInTransactionMs: 5000.9, statementMs: 10000.1 })).toEqual([
      "SET idle_in_transaction_session_timeout = 5000",
      "SET statement_timeout = 10000",
    ]);
  });
});

// ---- issued-SETs test (pg mocked; no live Postgres) --------------------------------------------

const state = vi.hoisted(() => ({ instances: [] as FakeClientInstance[] }));

interface FakeClientInstance {
  opts: { connectionString: string; application_name?: string };
  queries: string[];
}

vi.mock("pg", () => {
  class FakeClient implements FakeClientInstance {
    queries: string[] = [];
    constructor(public opts: { connectionString: string; application_name?: string }) {
      state.instances.push(this);
    }
    async connect(): Promise<void> {}
    on(_event: string, _cb: (...args: unknown[]) => void): void {}
    async query(text: string): Promise<{ rows: unknown[] }> {
      this.queries.push(text);
      return { rows: [] };
    }
    async end(): Promise<void> {}
  }
  return { default: { Client: FakeClient, types: { getTypeParser: () => (v: string) => v } } };
});

// Imported AFTER vi.mock — vitest hoists the mock above imports regardless.
import { NodePgClient } from "../src/node-pg-client";

describe("NodePgClient — session-timeout SETs issued at connect", () => {
  afterEach(() => {
    state.instances.length = 0;
    vi.clearAllMocks();
  });

  it("issues both timeout SETs on the pinned connection before the first user query", async () => {
    const client = new NodePgClient({
      connectionString: "postgres://fake",
      applicationName: "stackbase-fleet-4000",
      sessionTimeouts: { idleInTransactionMs: 5000, statementMs: 10000 },
    });
    // First real query triggers ensure() → connect() → the SETs are chained into the connect promise.
    await client.query("SELECT 1");

    const main = state.instances[0]!;
    expect(main.opts.application_name).toBe("stackbase-fleet-4000");
    // The two SETs precede the user query, in order.
    expect(main.queries.slice(0, 3)).toEqual([
      "SET idle_in_transaction_session_timeout = 5000",
      "SET statement_timeout = 10000",
      "SELECT 1",
    ]);
  });

  it("a non-fleet client (no sessionTimeouts) issues NO SET — unbounded session, unchanged", async () => {
    const client = new NodePgClient({ connectionString: "postgres://fake" });
    await client.query("SELECT 1");

    const main = state.instances[0]!;
    expect(main.queries).toEqual(["SELECT 1"]); // straight to the user query, no SETs
    expect(main.queries.some((q) => q.startsWith("SET "))).toBe(false);
  });
});
