/**
 * `NodePgClient.listen()` (C8a): a dedicated `pg.Client` is created just for LISTEN (see the
 * method's own doc comment in `node-pg-client.ts` for why). If that dedicated connection connects
 * fine but the `LISTEN "<channel>"` query itself then rejects, the connection must be `end()`ed
 * before the rejection propagates — otherwise a transient LISTEN failure (e.g. a bad channel name,
 * a mid-connect permissions change) leaks a live Postgres connection every time it happens.
 *
 * A real `pg.Client` needs a live Postgres server, which this package's other tests avoid via
 * PGlite — but PGlite has no LISTEN/NOTIFY support at all (see `pglite-client.ts`'s doc comment),
 * so it can't script a "connects, then LISTEN rejects" sequence. Instead, `pg` itself is mocked
 * with a minimal fake `Client` (`connect()` resolves, `query("LISTEN ...")` rejects, `end()` is
 * spied) — a focused unit test of `NodePgClient`'s own error-handling, not an integration test of
 * the driver.
 */
import { describe, it, expect, vi, afterEach } from "vitest";

const state = vi.hoisted(() => ({ instances: [] as FakeClientInstance[] }));

interface FakeClientInstance {
  opts: { connectionString: string };
  ended: boolean;
}

vi.mock("pg", () => {
  class FakeClient implements FakeClientInstance {
    ended = false;
    constructor(public opts: { connectionString: string }) {
      state.instances.push(this);
    }
    async connect(): Promise<void> {}
    on(_event: string, _cb: (...args: unknown[]) => void): void {}
    async query(text: string): Promise<{ rows: unknown[] }> {
      if (text.startsWith("LISTEN")) throw new Error("simulated LISTEN failure");
      return { rows: [] };
    }
    async end(): Promise<void> {
      this.ended = true;
    }
  }
  return {
    default: {
      Client: FakeClient,
      types: { getTypeParser: () => (v: string) => v },
    },
  };
});

// Imported AFTER vi.mock("pg", ...) is declared — vi.mock is hoisted above imports by vitest
// regardless of source order, but keeping the import below the mock keeps the file readable in
// the order things actually happen.
import { NodePgClient } from "../src/node-pg-client";

describe("NodePgClient.listen — C8a listen leak", () => {
  afterEach(() => {
    state.instances.length = 0;
    vi.clearAllMocks();
  });

  it("ends the dedicated LISTEN connection and rethrows when the LISTEN query rejects post-connect", async () => {
    const client = new NodePgClient({ connectionString: "postgres://fake" });
    // The constructor already opened the MAIN connection (a separate Client instance) — confirm
    // it's untouched by the listen() failure below (only the dedicated LISTEN connection should
    // ever be end()ed here).
    expect(state.instances).toHaveLength(1);
    const mainClient = state.instances[0]!;

    await expect(client.listen("stackbase_commits", () => {})).rejects.toThrow("simulated LISTEN failure");

    expect(state.instances).toHaveLength(2); // the dedicated LISTEN connection was created
    const listenerClient = state.instances[1]!;
    expect(listenerClient.ended).toBe(true); // leaked-connection fix: end() was called before rethrow
    expect(mainClient.ended).toBe(false); // the main connection was never touched
  });
});
