/**
 * The narrow SQL seam the DocStore sits on. A `DatabaseAdapter` is the *only* thing that
 * knows about a concrete SQLite driver — swap it (node:sqlite, bun:sqlite, better-sqlite3,
 * D1) without touching `SqliteDocStore`. Integer columns are read as `bigint` so 64-bit
 * timestamps survive.
 */
export type SqlValue = null | number | bigint | string | Uint8Array;
export type SqlRow = Record<string, SqlValue>;

export interface RunResult {
  changes: number;
  lastInsertRowid: number | bigint;
}

export interface PreparedStatement {
  run(...params: SqlValue[]): RunResult;
  get(...params: SqlValue[]): SqlRow | undefined;
  all(...params: SqlValue[]): SqlRow[];
}

export interface DatabaseAdapter {
  exec(sql: string): void;
  prepare(sql: string): PreparedStatement;
  /** Run `fn` inside a single SQL transaction (BEGIN/COMMIT, ROLLBACK on throw). */
  transaction<T>(fn: () => T): T;
  close(): void;
}
