import Database from "better-sqlite3";
import type { D1Client, D1PreparedStatement, D1Session } from "../../src/d1-client";

/** An in-memory better-sqlite3-backed D1Client for the fast lane. better-sqlite3 is synchronous;
 *  the seam is async, so each method wraps a sync call in a resolved Promise. `withSession` is a
 *  no-op bookmark stub — a single local SQLite is already read-your-writes consistent. */
export function sqliteD1Client(): D1Client {
  const db = new Database(":memory:");

  const stmt = (sql: string, bound: unknown[]): D1PreparedStatement => ({
    bind: (...values: unknown[]) => stmt(sql, values),
    all: async () => {
      const prepared = db.prepare(sql);
      // better-sqlite3 throws if you call .all() on a non-returning stmt; `reader` tells us which it is.
      const results = prepared.reader ? (prepared.all(...bound) as Record<string, unknown>[]) : [];
      if (!prepared.reader) prepared.run(...bound);
      return { results: results as never };
    },
    run: async () => {
      const info = db.prepare(sql).run(...bound);
      return { changes: info.changes };
    },
  });

  const client: D1Client = {
    prepare: (sql) => stmt(sql, []),
    exec: async (sql) => { db.exec(sql); },
    withSession: (_bookmark?: string): D1Session => ({ client, latestBookmark: () => undefined }),
  };
  return client;
}
