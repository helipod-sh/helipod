/**
 * `@stackbase/docstore-sqlite` — the MVCC `DocStore` over SQLite, plus the Node
 * (`node:sqlite`) database adapter. The default Tier 0 storage backend.
 */
export type { DatabaseAdapter, PreparedStatement, RunResult, SqlValue, SqlRow } from "./adapter";
export { NodeSqliteAdapter, type NodeSqliteOptions } from "./node-adapter";
export { BunSqliteAdapter, type BunSqliteOptions } from "./bun-adapter";
export { SqliteDocStore } from "./sqlite-docstore";
