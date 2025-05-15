/**
 * `DatabaseAdapter` backed by Bun's built-in `bun:sqlite` — the **primary** runtime adapter
 * (fast, stable, and what the single-binary `bun build --compile` target uses). Loaded
 * lazily via `createRequire` so the package stays importable under Node too; instantiate
 * `NodeSqliteAdapter` there instead.
 *
 * Structural types are declared inline to avoid a `bun-types` build dependency; the shape
 * is validated at runtime under Bun (see test/bun-smoke.ts).
 */
import { createRequire } from "node:module";
import type { DatabaseAdapter, PreparedStatement, RunResult, SqlRow, SqlValue } from "./adapter";

interface BunStatement {
  all(...params: SqlValue[]): SqlRow[];
  get(...params: SqlValue[]): SqlRow | undefined;
  run(...params: SqlValue[]): { changes: number | bigint; lastInsertRowid: number | bigint };
}
interface BunDatabase {
  exec(sql: string): void;
  prepare(sql: string): BunStatement;
  close(): void;
}
type BunDatabaseCtor = new (path: string, options?: { safeIntegers?: boolean }) => BunDatabase;

class BunStatementWrapper implements PreparedStatement {
  constructor(private readonly stmt: BunStatement) {}

  run(...params: SqlValue[]): RunResult {
    const r = this.stmt.run(...params);
    return { changes: Number(r.changes), lastInsertRowid: r.lastInsertRowid };
  }

  get(...params: SqlValue[]): SqlRow | undefined {
    return this.stmt.get(...params);
  }

  all(...params: SqlValue[]): SqlRow[] {
    return this.stmt.all(...params);
  }
}

export interface BunSqliteOptions {
  /** File path, or ":memory:" (default). */
  path?: string;
}

export class BunSqliteAdapter implements DatabaseAdapter {
  private readonly db: BunDatabase;

  constructor(options: BunSqliteOptions = {}) {
    const bunRequire = createRequire(import.meta.url);
    const { Database } = bunRequire("bun:sqlite") as { Database: BunDatabaseCtor };
    // safeIntegers → INTEGER columns read as bigint (64-bit timestamps stay exact).
    this.db = new Database(options.path ?? ":memory:", { safeIntegers: true });
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;");
  }

  exec(sql: string): void {
    this.db.exec(sql);
  }

  prepare(sql: string): PreparedStatement {
    return new BunStatementWrapper(this.db.prepare(sql));
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
