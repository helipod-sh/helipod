/**
 * A FAITHFUL in-process stand-in for a Durable Object's SQL surface (`ctx.storage.sql` +
 * `ctx.storage.transactionSync`), backed by Node's built-in `node:sqlite`. It exists so the shared
 * docstore conformance suite can run against `DoSqliteAdapter` under plain Node/vitest — WITHOUT a
 * real Durable Object (which would need `@cloudflare/vitest-pool-workers`, workerd, and a wrangler
 * config; deferred to the Slice 3 host, see this package's README).
 *
 * "Faithful" is the whole point: this stand-in deliberately reproduces the exact DO-SQLite CONSTRAINTS
 * the adapter must cope with, so that a passing suite actually exercises the adapter's DO-specific
 * code paths rather than papering over them. Specifically it:
 *   - is SYNCHRONOUS (`exec` returns a cursor synchronously; `transactionSync` runs its closure now);
 *   - returns BLOB columns as `ArrayBuffer` (not `Uint8Array`) — forcing the adapter's read-path wrap;
 *   - returns INTEGER columns as `number` — as DO-SQLite does (no bigint read mode);
 *   - REJECTS `bigint` bindings — DO-SQLite has no bigint binding type, so this proves the adapter
 *     narrows `bigint → number` before binding;
 *   - REJECTS `BEGIN`/`COMMIT`/`ROLLBACK`/`SAVEPOINT` through `exec` — as DO-SQLite does, proving the
 *     adapter routes atomicity through `transactionSync`, never through transaction-control SQL;
 *   - exposes `rowsWritten` on the cursor (DO-SQLite's counterpart to SQLite's `changes()`).
 *
 * What it does NOT reproduce: a real workerd SQLite build, the real `SQLITE_FULL` text at 10 GB, or
 * hibernation. Those are the province of the deferred real-DO E2E.
 */
import { createRequire } from "node:module";
import type { SqlStorageLike, SqlStorageCursorLike, TransactionSyncFn } from "../src/do-adapter";

// Load `node:sqlite` lazily via createRequire — same pattern the node adapter uses — so importing
// this module never eagerly resolves the (experimental) builtin unless a stand-in is constructed.
interface NodeStmt {
  all(...params: unknown[]): Record<string, unknown>[];
}
interface NodeDb {
  exec(sql: string): void;
  prepare(sql: string): NodeStmt;
  close(): void;
}

type DoSqlValue = ArrayBuffer | ArrayBufferView | string | number | null;

/** Re-shape a `node:sqlite` result cell to what a DO cursor would yield: BLOBs as `ArrayBuffer`
 *  (node:sqlite hands back a `Uint8Array`/`Buffer`), everything else unchanged. */
function toDoResultValue(v: unknown): DoSqlValue {
  if (v instanceof ArrayBuffer) return v;
  if (ArrayBuffer.isView(v)) {
    // Copy out the exact byte window into a fresh, plain ArrayBuffer (node:sqlite yields a
    // Uint8Array/Buffer for blobs; `.slice()` copies and its `.buffer` is a plain ArrayBuffer).
    const bytes = new Uint8Array(v.buffer as ArrayBuffer, v.byteOffset, v.byteLength);
    return bytes.slice().buffer;
  }
  if (typeof v === "bigint") return Number(v); // node:sqlite may widen; DO always yields number
  return v as DoSqlValue;
}

function toDoRow(row: Record<string, unknown>): Record<string, DoSqlValue> {
  const out: Record<string, DoSqlValue> = {};
  for (const key in row) out[key] = toDoResultValue(row[key]);
  return out;
}

class MemoryCursor implements SqlStorageCursorLike {
  constructor(
    private readonly rows: Record<string, DoSqlValue>[],
    readonly rowsWritten: number,
  ) {}
  toArray(): Record<string, DoSqlValue>[] {
    return this.rows;
  }
}

// DO-SQLite forbids transaction-control statements through `exec`. Match on the leading keyword so
// the stand-in rejects them exactly as the real API does, forcing atomicity through transactionSync.
const TXN_CONTROL = /^\s*(begin|commit|rollback|savepoint|release)\b/i;

export class MemorySqlStorage implements SqlStorageLike {
  private readonly db: NodeDb;

  constructor() {
    const nodeRequire = createRequire(import.meta.url);
    const { DatabaseSync } = nodeRequire("node:sqlite") as { DatabaseSync: new (path: string) => NodeDb };
    this.db = new DatabaseSync(":memory:");
    this.db.exec("PRAGMA foreign_keys = ON;");
  }

  exec(query: string, ...bindings: DoSqlValue[]): SqlStorageCursorLike {
    if (TXN_CONTROL.test(query)) {
      throw new Error(
        `[memory-sql-storage] DO-SQLite rejects transaction-control statements via exec(): ${query.trim().slice(0, 40)}` +
          ` — use transactionSync() instead`,
      );
    }
    for (const b of bindings) {
      if (typeof b === "bigint") {
        throw new TypeError("[memory-sql-storage] DO-SQLite has no bigint binding type");
      }
    }

    // A multi-statement string (the schema DDL) is only ever passed with zero bindings. `node:sqlite`'s
    // prepare() silently compiles just the FIRST statement of such a string, so route it through
    // db.exec() (which runs them all) — mirroring DO-SQLite, where a multi-statement exec runs every
    // statement and yields an empty result. Detection: an inner `;` (the DocStore's single prepared
    // statements never contain one; the schema has many).
    const trimmed = query.trim().replace(/;\s*$/, "");
    if (bindings.length === 0 && trimmed.includes(";")) {
      this.db.exec(query);
      return new MemoryCursor([], 0);
    }

    const stmt = this.db.prepare(trimmed);
    const rows = stmt.all(...bindings); // executes; returns [] for a write with no RETURNING
    // `changes()` reflects the row count of the most recent INSERT/UPDATE/DELETE on this connection —
    // DO-SQLite's `rowsWritten`. (Irrelevant/stale after a pure SELECT, which the adapter ignores.)
    const changes = Number(this.db.prepare("SELECT changes() AS c").all()[0]!.c as number | bigint);
    return new MemoryCursor(rows.map(toDoRow), changes);
  }

  /** `ctx.storage.transactionSync` — the sole atomicity primitive. Implemented with real
   *  BEGIN/COMMIT/ROLLBACK issued DIRECTLY on the underlying connection (bypassing our own `exec`
   *  guard, which is what forbids the adapter from doing this). No nesting is needed: the DocStore
   *  never nests `transaction()` calls. */
  transactionSync: TransactionSyncFn = (closure) => {
    this.db.exec("BEGIN");
    try {
      const result = closure();
      this.db.exec("COMMIT");
      return result;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  };

  close(): void {
    this.db.close();
  }
}
