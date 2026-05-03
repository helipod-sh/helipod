/**
 * Unit tests for the DO-SQLite-specific seams that the shared conformance suite can't reach directly:
 * the `bigint → number` bind narrowing, the `ArrayBuffer → Uint8Array` read wrap, the mandatory use of
 * `transactionSync` (never BEGIN/COMMIT SQL), and the `SQLITE_FULL → DatabaseFullError` classification
 * (which a 10 GB write would trigger in production but is unreachable in a unit test, so it is proven
 * at the classifier + adapter boundary against a synthetic error).
 */
import { describe, it, expect } from "vitest";
import { DoSqliteAdapter, type SqlStorageLike, type SqlStorageCursorLike } from "../src/do-adapter";
import { DatabaseFullError, isDatabaseFullError } from "../src/errors";
import { MemorySqlStorage } from "./memory-sql-storage";

function makeAdapter() {
  const storage = new MemorySqlStorage();
  const adapter = new DoSqliteAdapter({ sql: storage, transactionSync: storage.transactionSync });
  return { storage, adapter };
}

describe("DoSqliteAdapter value marshalling", () => {
  it("narrows bigint bindings to number (DO-SQLite has no bigint binding type)", () => {
    const { adapter } = makeAdapter();
    adapter.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, ts INTEGER)");
    // The stand-in THROWS on a bigint binding; a successful insert proves the adapter narrowed it.
    expect(() => adapter.prepare("INSERT INTO t (id, ts) VALUES (?, ?)").run(1, 9_000_000_000_000n)).not.toThrow();
    const row = adapter.prepare("SELECT ts FROM t WHERE id = ?").get(1);
    expect(row!.ts).toBe(9_000_000_000_000); // read back as number
  });

  it("throws (never truncates) a bigint beyond Number.MAX_SAFE_INTEGER", () => {
    const { adapter } = makeAdapter();
    adapter.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, ts INTEGER)");
    expect(() => adapter.prepare("INSERT INTO t (id, ts) VALUES (?, ?)").run(1, 9_007_199_254_740_993n)).toThrow(
      /exceeds Number.MAX_SAFE_INTEGER/,
    );
  });

  it("re-wraps ArrayBuffer BLOB results as Uint8Array (what the DocStore expects)", () => {
    const { adapter } = makeAdapter();
    adapter.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, blob BLOB)");
    const bytes = new Uint8Array([1, 2, 3, 250]);
    adapter.prepare("INSERT INTO t (id, blob) VALUES (?, ?)").run(1, bytes);
    const row = adapter.prepare("SELECT blob FROM t WHERE id = ?").get(1);
    expect(row!.blob).toBeInstanceOf(Uint8Array); // NOT ArrayBuffer
    expect(Array.from(row!.blob as Uint8Array)).toEqual([1, 2, 3, 250]);
  });

  it("reports RunResult.changes from the cursor's rowsWritten (0 for an ignored INSERT OR IGNORE)", () => {
    const { adapter } = makeAdapter();
    adapter.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)");
    expect(adapter.prepare("INSERT OR IGNORE INTO t (id, v) VALUES (?, ?)").run(1, "a").changes).toBe(1);
    expect(adapter.prepare("INSERT OR IGNORE INTO t (id, v) VALUES (?, ?)").run(1, "b").changes).toBe(0);
  });
});

describe("DoSqliteAdapter transactions (via transactionSync, never BEGIN/COMMIT SQL)", () => {
  it("commits a closure's writes atomically", () => {
    const { adapter } = makeAdapter();
    adapter.exec("CREATE TABLE t (id INTEGER PRIMARY KEY)");
    adapter.transaction(() => {
      adapter.prepare("INSERT INTO t (id) VALUES (?)").run(1);
      adapter.prepare("INSERT INTO t (id) VALUES (?)").run(2);
    });
    expect(adapter.prepare("SELECT COUNT(*) AS n FROM t").get()!.n).toBe(2);
  });

  it("rolls the WHOLE transaction back when the closure throws — no partial write lands", () => {
    const { adapter } = makeAdapter();
    adapter.exec("CREATE TABLE t (id INTEGER PRIMARY KEY)");
    expect(() =>
      adapter.transaction(() => {
        adapter.prepare("INSERT INTO t (id) VALUES (?)").run(1); // lands, then...
        throw new Error("boom"); // ...must roll back with the transaction
      }),
    ).toThrow("boom");
    expect(adapter.prepare("SELECT COUNT(*) AS n FROM t").get()!.n).toBe(0);
  });

  it("cannot open a transaction with BEGIN through exec (DO-SQLite forbids it)", () => {
    const { adapter } = makeAdapter();
    expect(() => adapter.exec("BEGIN")).toThrow(/transaction-control/i);
  });
});

describe("SQLITE_FULL → DatabaseFullError classification", () => {
  it("isDatabaseFullError matches SQLITE_FULL by code and by message, but not constraint errors", () => {
    expect(isDatabaseFullError({ code: "SQLITE_FULL" })).toBe(true);
    expect(isDatabaseFullError(new Error("SQLITE_FULL: database or disk is full"))).toBe(true);
    expect(isDatabaseFullError(new Error("database or disk is full"))).toBe(true);
    expect(isDatabaseFullError(new Error("SQLITE_CONSTRAINT: UNIQUE constraint failed"))).toBe(false);
    expect(isDatabaseFullError(new Error("SQLITE_BUSY"))).toBe(false);
    expect(isDatabaseFullError(null)).toBe(false);
  });

  it("the adapter wraps a full-storage throw into a typed DatabaseFullError, preserving cause", () => {
    // A synthetic SqlStorage whose exec throws the DO 10 GB failure — the unreachable-in-a-unit-test
    // production path, proven at the adapter boundary.
    const original = new Error("SQLITE_FULL: database or disk is full");
    const fullStorage: SqlStorageLike = {
      exec(): SqlStorageCursorLike {
        throw original;
      },
    };
    const adapter = new DoSqliteAdapter({ sql: fullStorage, transactionSync: (fn) => fn() });
    try {
      adapter.exec("INSERT INTO t VALUES (1)");
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(DatabaseFullError);
      expect((err as DatabaseFullError).code).toBe("DATABASE_FULL");
      expect((err as DatabaseFullError).cause).toBe(original);
    }
  });

  it("passes a non-full error (e.g. a constraint violation) through untouched", () => {
    const constraint = new Error("SQLITE_CONSTRAINT: UNIQUE constraint failed");
    const storage: SqlStorageLike = {
      exec(): SqlStorageCursorLike {
        throw constraint;
      },
    };
    const adapter = new DoSqliteAdapter({ sql: storage, transactionSync: (fn) => fn() });
    expect(() => adapter.exec("INSERT INTO t VALUES (1)")).toThrow(constraint);
  });
});
