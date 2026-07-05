/** `@helipod/docstore-postgres` — the MVCC DocStore over Postgres, plus the pg-based client. */
export type { PgClient, PgQuerier, PgRow, PgValue } from "./pg-client";
export { ADVISORY_LOCK_KEY } from "./pg-client";
export { NodePgClient, pgSessionTimeoutStatements } from "./node-pg-client";
export type { PgSessionTimeouts } from "./node-pg-client";
// `BunSqlClient` (native `Bun.SQL`, single-node v1 — see its own doc comment) is selected by
// `packages/cli/src/boot.ts`'s `makePgClient` under the Bun runtime (`helipod dev`/`serve`'s
// production runtime); `NodePgClient` remains the fallback under Node.
export { BunSqlClient } from "./bun-sql-client";
export { PostgresDocStore, ReadOnlyStoreError } from "./postgres-docstore";
export type { PostgresDocStoreOptions, PgCommitGuard } from "./postgres-docstore";
