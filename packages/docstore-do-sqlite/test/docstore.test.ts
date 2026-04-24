/**
 * The FULL shared docstore conformance contract — the identical suite SQLite/Postgres/PGlite run —
 * exercised against `SqliteDocStore` driving `DoSqliteAdapter`, over the faithful `MemorySqlStorage`
 * stand-in for a Durable Object's SQL surface.
 *
 * Fidelity: API-shape conformance, NOT a real-DO run (see the package README). The stand-in enforces
 * the DO-SQLite constraints — synchronous exec, ArrayBuffer blobs, number integers, no bigint
 * bindings, no BEGIN/COMMIT via exec — so a green run proves the adapter speaks the DO SQL contract.
 */
import { runDocStoreConformance } from "@stackbase/docstore/test-support/conformance";
import { SqliteDocStore } from "@stackbase/docstore-sqlite";
import { DoSqliteAdapter } from "../src/do-adapter";
import { MemorySqlStorage } from "./memory-sql-storage";

runDocStoreConformance(
  "do-sqlite (memory stand-in)",
  async () => {
    const storage = new MemorySqlStorage();
    const adapter = new DoSqliteAdapter({
      sql: storage,
      transactionSync: storage.transactionSync,
    });
    const store = new SqliteDocStore(adapter);
    await store.setupSchema();
    // Stash the stand-in so teardown can release the underlying connection.
    (store as unknown as { __storage: MemorySqlStorage }).__storage = storage;
    return store;
  },
  async (store) => {
    (store as unknown as { __storage: MemorySqlStorage }).__storage.close();
  },
);
