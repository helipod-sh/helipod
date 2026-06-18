/** `@stackbase/docstore-postgres` — the MVCC DocStore over Postgres, plus the pg-based client. */
export type { PgClient, PgQuerier, PgRow, PgValue } from "./pg-client";
export { ADVISORY_LOCK_KEY } from "./pg-client";
export { NodePgClient, pgSessionTimeoutStatements } from "./node-pg-client";
export type { PgSessionTimeouts } from "./node-pg-client";
// `BunSqlClient` (native `Bun.SQL`, single-node v1 — see its own doc comment) is available for
// direct construction; wiring `stackbase serve`/`dev` to select it under the Bun runtime is a
// follow-up (today's CLI selection logic is unchanged and always uses `NodePgClient`).
export { BunSqlClient } from "./bun-sql-client";
export { PostgresDocStore, ReadOnlyStoreError } from "./postgres-docstore";
export type { PostgresDocStoreOptions, PgCommitGuard } from "./postgres-docstore";
