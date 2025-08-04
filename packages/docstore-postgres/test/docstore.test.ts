import { runDocStoreConformance } from "@stackbase/docstore/test-support/conformance";
import { PostgresDocStore } from "../src/postgres-docstore";
import { NodePgClient } from "../src/node-pg-client";
import { PgliteClient } from "./pglite-client";

// Always: hermetic PGlite (real Postgres semantics, no Docker, runs under Node).
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

// Additionally: a real Postgres server when STACKBASE_TEST_DATABASE_URL is set (skipped otherwise).
const REAL_PG = process.env.STACKBASE_TEST_DATABASE_URL;
if (REAL_PG) {
  runDocStoreConformance(
    "postgres (real)",
    async () => {
      const s = new PostgresDocStore(new NodePgClient({ connectionString: REAL_PG }));
      await s.setupSchema();
      // isolate: truncate the three tables so each test starts clean
      await (s as any).db.query("TRUNCATE documents, indexes, persistence_globals");
      return s;
    },
    async (s) => {
      await (s as PostgresDocStore).close();
    },
  );
}
