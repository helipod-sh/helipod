import { describe, it, expect } from "vitest";
import { runDocStoreConformance } from "@helipod/docstore/test-support/conformance";
import { newDocumentId } from "@helipod/id-codec";
import type { PgClient, PgRow, PgValue } from "../src/pg-client";
import { PostgresDocStore } from "../src/postgres-docstore";
import { NodePgClient } from "../src/node-pg-client";
import { PgliteClient } from "./pglite-client";

// Always: hermetic PGlite (real Postgres semantics, no Docker, runs under Node).
// Coverage split for `index_scan`'s streaming-vs-buffered branch (see `postgres-docstore.ts`,
// `if (this.db.queryStream) { ... streaming ... } else { ... buffered ... }`):
// this run's client is a plain `PgliteClient`, which DOES define `queryStream` (see
// `test/pglite-client.ts`), so every `index_scan` here already takes the STREAMING branch.
// The buffered fallback is exercised separately below by `BufferedPglite`.
runDocStoreConformance(
  "postgres (pglite)",
  async () => {
    const s = new PostgresDocStore(new PgliteClient());
    await s.setupSchema();
    return s;
  },
  async (s) => {
    await (s as PostgresDocStore).close();
  },
);

// Buffered-path coverage: a `PgliteClient` subclass with `queryStream` undefined, so
// `index_scan`'s `if (this.db.queryStream)` check is falsy and every scan in this run takes the
// buffered `await this.db.query(...)` branch instead — same conformance contract, other branch.
class BufferedPglite extends PgliteClient {
  // @ts-expect-error — narrowing PgliteClient's concrete `queryStream` method to `undefined` so
  // `index_scan`'s `if (this.db.queryStream)` check is falsy; PgClient itself declares the method
  // optional, only PgliteClient's own (non-subclass) type narrows it to always-present.
  override queryStream: PgClient["queryStream"] = undefined;
}
runDocStoreConformance(
  "postgres (pglite, buffered index_scan)",
  async () => {
    const s = new PostgresDocStore(new BufferedPglite());
    await s.setupSchema();
    return s;
  },
  async (s) => {
    await (s as PostgresDocStore).close();
  },
);

// The Postgres `load_documents` buffers its whole result before yielding, so a caller-side
// generator break can't bound it — the `limit` MUST reach the SQL. Spy on the emitted query text
// to prove the LIMIT clause is present (and absent when no limit is requested).
describe("postgres load_documents limit is pushed into the SQL", () => {
  class SpyClient extends PgliteClient {
    readonly queries: string[] = [];
    override async query(text: string, params?: readonly PgValue[]): Promise<PgRow[]> {
      this.queries.push(text);
      return super.query(text, params);
    }
  }

  async function collect<T>(gen: AsyncGenerator<T>): Promise<T[]> {
    const out: T[] = [];
    for await (const x of gen) out.push(x);
    return out;
  }

  it("emits a LIMIT clause only when a limit is given", async () => {
    const spy = new SpyClient();
    const store = new PostgresDocStore(spy);
    await store.setupSchema();
    const id = newDocumentId(20001);
    await store.write([{ ts: 1n, id, prev_ts: null, value: { id, value: { n: 1 } } }], [], "Error");
    await store.write([{ ts: 2n, id, prev_ts: 1n, value: { id, value: { n: 2 } } }], [], "Error");

    spy.queries.length = 0;
    await collect(store.load_documents({ minInclusive: 1n, maxExclusive: 100n }, "asc", 1));
    const withLimit = spy.queries.filter((q) => /FROM documents WHERE ts >=/.test(q));
    expect(withLimit.length).toBe(1);
    expect(withLimit[0]).toMatch(/LIMIT \$\d+/);

    spy.queries.length = 0;
    await collect(store.load_documents({ minInclusive: 1n, maxExclusive: 100n }, "asc"));
    const noLimit = spy.queries.filter((q) => /FROM documents WHERE ts >=/.test(q));
    expect(noLimit.length).toBe(1);
    expect(noLimit[0]).not.toMatch(/LIMIT/);

    await store.close();
  });
});

// Additionally: a real Postgres server when HELIPOD_TEST_DATABASE_URL is set (skipped otherwise).
const REAL_PG = process.env.HELIPOD_TEST_DATABASE_URL;
if (REAL_PG) {
  runDocStoreConformance(
    "postgres (real)",
    async () => {
      const s = new PostgresDocStore(new NodePgClient({ connectionString: REAL_PG }));
      await s.setupSchema();
      // isolate: truncate ALL persisted tables so each test starts clean. Must include the
      // Receipted-Outbox tables (client_mutations, client_floors) — omitting them lets those
      // tables accumulate across tests on a persistent server, breaking the table-wide
      // sweep/prune count assertions (PGlite gets a fresh in-process DB per test and never hit this).
      await (s as any).db.query(
        "TRUNCATE documents, indexes, persistence_globals, client_mutations, client_floors",
      );
      return s;
    },
    async (s) => {
      await (s as PostgresDocStore).close();
    },
  );
}
