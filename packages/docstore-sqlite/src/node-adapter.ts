/**
 * `DatabaseAdapter` backed by Node's built-in `node:sqlite` (no native dependency — keeps
 * the Tier 0 binary self-contained). Integer columns are read as `bigint` via
 * `setReadBigInts(true)` so logical timestamps beyond 2^53 are exact.
 *
 * `node:sqlite` is newer than most bundlers' builtin lists, so we load it through
 * `createRequire` at runtime (avoiding static ESM resolution) and keep types via a
 * type-only import.
 */
import { createRequire } from "node:module";
import type * as NodeSqlite from "node:sqlite";
import type { DatabaseAdapter, PreparedStatement, RunResult, SqlRow, SqlValue } from "./adapter";

class NodeStatement implements PreparedStatement {
  constructor(private readonly stmt: NodeSqlite.StatementSync) {
    stmt.setReadBigInts(true);
  }

  run(...params: SqlValue[]): RunResult {
    const r = this.stmt.run(...params);
    return { changes: Number(r.changes), lastInsertRowid: r.lastInsertRowid };
  }

  get(...params: SqlValue[]): SqlRow | undefined {
    return this.stmt.get(...params) as SqlRow | undefined;
  }

  all(...params: SqlValue[]): SqlRow[] {
    return this.stmt.all(...params) as SqlRow[];
  }
}

export interface NodeSqliteOptions {
  /** File path, or ":memory:" (default). */
  path?: string;
}

export class NodeSqliteAdapter implements DatabaseAdapter {
  private readonly db: NodeSqlite.DatabaseSync;

  constructor(options: NodeSqliteOptions = {}) {
    // Lazy require (named `nodeRequire`, not `require`) so neither the bundler nor a
    // non-Node runtime resolves `node:sqlite` unless this adapter is actually instantiated.
    const nodeRequire = createRequire(import.meta.url);
    const { DatabaseSync } = nodeRequire("node:sqlite") as typeof NodeSqlite;
    this.db = new DatabaseSync(options.path ?? ":memory:");
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;");
  }

  exec(sql: string): void {
    this.db.exec(sql);
  }

  prepare(sql: string): PreparedStatement {
    return new NodeStatement(this.db.prepare(sql));
  }

  transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }

  close(): void {
    this.db.close();
  }
}
