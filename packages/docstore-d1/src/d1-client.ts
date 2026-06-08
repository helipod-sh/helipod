export interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
  run(): Promise<{ changes: number }>;
}
export interface D1Session { client: D1Client; latestBookmark(): string | undefined; }
export interface D1BatchStatement { sql: string; params: unknown[]; }
export interface D1Client {
  prepare(sql: string): D1PreparedStatement;
  exec(sql: string): Promise<void>;             // multi-statement DDL
  withSession(bookmark?: string): D1Session;    // D1 Sessions read-your-writes
  /** Run all statements in ONE atomic transaction. Rejects (rolling back) on any failure;
   *  a unique-index violation must surface as UniqueConstraintError. */
  batch(statements: D1BatchStatement[]): Promise<void>;
}
export class UniqueConstraintError extends Error {
  constructor(public readonly table: string, public readonly field: string) {
    super(`unique constraint violation on ${table}.${field}`);
    this.name = "UniqueConstraintError";
  }
}
