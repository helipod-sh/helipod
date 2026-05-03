/**
 * `@stackbase/docstore-do-sqlite` — the MVCC `DocStore` over a **Durable Object's** embedded SQLite
 * (`ctx.storage.sql`), via a `DatabaseAdapter` that the DO host injects. The Cloudflare-native Tier 0
 * storage backend; the engine never imports a Cloudflare type — the adapter is handed the DO's SQL
 * surface as constructor input, exactly like the `node`/`bun`/`pg` adapters.
 *
 * The MVCC `DocStore` implementation itself is REUSED verbatim from `@stackbase/docstore-sqlite`
 * (`SqliteDocStore`) — DO-SQLite is SQLite, so only the driver seam differs. Construct as:
 *
 * ```ts
 * import { SqliteDocStore } from "@stackbase/docstore-sqlite";
 * import { DoSqliteAdapter } from "@stackbase/docstore-do-sqlite";
 *
 * // inside a Durable Object:
 * const adapter = new DoSqliteAdapter({
 *   sql: ctx.storage.sql,
 *   transactionSync: ctx.storage.transactionSync.bind(ctx.storage),
 * });
 * const store = new SqliteDocStore(adapter);
 * await store.setupSchema();
 * ```
 */
export { DoSqliteAdapter } from "./do-adapter";
export type {
  DoSqliteOptions,
  SqlStorageLike,
  SqlStorageCursorLike,
  TransactionSyncFn,
} from "./do-adapter";
export { DatabaseFullError, isDatabaseFullError } from "./errors";

// Re-exported for ergonomics so a DO host can construct the whole store from one import. The MVCC
// document-log logic lives in `@stackbase/docstore-sqlite`; DO-SQLite reuses it unchanged.
export { SqliteDocStore } from "@stackbase/docstore-sqlite";
export type { DatabaseAdapter, PreparedStatement, RunResult, SqlValue, SqlRow } from "@stackbase/docstore-sqlite";
