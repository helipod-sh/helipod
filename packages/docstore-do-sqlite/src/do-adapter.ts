/**
 * `DatabaseAdapter` backed by a **Durable Object's** embedded SQLite (`ctx.storage.sql`) — the
 * Cloudflare-native Tier 0 storage backend (Slice 2 of the DO-native host program;
 * `docs/superpowers/plans/2026-03-20-cloudflare-do-native-host-roadmap.md`). DO-SQLite's SQL API is
 * **synchronous** (`sql.exec(query, ...bindings)` returns a cursor synchronously), which is a direct
 * structural match for the existing synchronous `DatabaseAdapter` contract — an easier fit than the
 * async Postgres adapter.
 *
 * ## Injection, not import (the neutrality invariant)
 * The engine must NEVER know it is on Cloudflare. So this adapter takes the DO's SQL surface as
 * CONSTRUCTOR INPUT — a `{ sql, transactionSync }` pair the DO host (Slice 3) pulls off its own
 * `ctx.storage` and hands in — exactly as `docstore-sqlite`/`docstore-postgres` are constructed with
 * their drivers. Nothing above this leaf ever references a Cloudflare type.
 *
 * The injected surface is declared here as minimal STRUCTURAL interfaces (`SqlStorageLike` /
 * `SqlStorageCursorLike` / a `transactionSync` closure runner) — mirroring `bun-adapter.ts`, which
 * declares its `bun:sqlite` shape inline "to avoid a build dependency". A real DO's typed
 * `ctx.storage.sql` (`SqlStorage` from `@cloudflare/workers-types`) and `ctx.storage.transactionSync`
 * structurally satisfy these, so the host wires them in with zero casts and this package needs no
 * `@cloudflare/workers-types` dependency of its own.
 *
 * ## The three DO-SQLite deviations from a normal SQLite driver (all handled here)
 * 1. **No `BEGIN`/`COMMIT`/`SAVEPOINT` via `exec`.** DO-SQLite rejects transaction-control SQL; the
 *    only way to get an atomic multi-statement unit is `ctx.storage.transactionSync(fn)`. So
 *    `transaction()` delegates to the injected `transactionSync` — it does NOT emit `BEGIN`/`COMMIT`
 *    the way `node-adapter`/`bun-adapter` do.
 * 2. **Values are `ArrayBuffer | string | number | null`.** BLOB columns read back as `ArrayBuffer`
 *    (not `Uint8Array`), and INTEGER columns read back as `number` (there is no `bigint`/safe-integer
 *    read mode like `setReadBigInts`/`safeIntegers`). The read path re-wraps `ArrayBuffer → Uint8Array`
 *    so the DocStore sees the same `Uint8Array` blobs every other adapter yields; integers stay
 *    `number` and the DocStore's `asBigInt` widens them (see the precision note below).
 * 3. **Bindings are `ArrayBuffer | ArrayBufferView | string | number | null` — `bigint` is NOT a
 *    documented binding type.** The DocStore binds logical timestamps as `bigint`; the bind path
 *    narrows those to `number` before they reach `sql.exec`.
 *
 * ## The `bigint`/`number` precision note (why `number` is safe here)
 * Stackbase's only INTEGER columns are logical timestamps (`ts`/`prev_ts`/`commit_ts` — a per-store
 * monotonic `MAX(ts)+1` counter seeded at 1) and millisecond wall-clocks (`created_at`/`updated_at`).
 * Both stay far under `Number.MAX_SAFE_INTEGER` (2^53): a single DO would need ~9 quadrillion commits
 * to overflow, and ms-time overflows in year ~+287000. Document ids and index keys are BLOBs, never
 * integers. So round-tripping timestamps through `number` is lossless in every reachable state — and
 * the bind path throws loudly rather than silently truncate if a value ever exceeds the safe range.
 *
 * ## The 10 GB ceiling
 * A write past a Durable Object's hard 10 GB limit fails with `SQLITE_FULL`; the adapter classifies
 * that ONE failure into a typed `DatabaseFullError` (see `errors.ts`) instead of an opaque throw,
 * while every other error (constraint violations, etc.) propagates untouched.
 */
import type { DatabaseAdapter, PreparedStatement, RunResult, SqlRow, SqlValue } from "@stackbase/docstore-sqlite";
import { DatabaseFullError, isDatabaseFullError } from "./errors";

/** A DO-SQLite scalar, both as a binding and as a result cell:
 *  `ArrayBuffer | string | number | null` (Cloudflare's `SqlStorageValue`). We additionally accept
 *  `ArrayBufferView` as a binding, which the SQL API also takes for BLOBs. */
type DoSqlValue = ArrayBuffer | ArrayBufferView | string | number | null;

/** The synchronous cursor `SqlStorage.exec` returns. We only need `toArray()` (materialize rows)
 *  and `rowsWritten` (for `RunResult.changes`); the fuller DO cursor (`one`/`raw`/`next`/iteration/
 *  `columnNames`/`rowsRead`) is a structural superset and satisfies this by width. */
export interface SqlStorageCursorLike {
  toArray(): Record<string, DoSqlValue>[];
  /** Rows actually written by the statement — DO-SQLite's counterpart to SQLite's `changes()`
   *  (0 for an `INSERT OR IGNORE` that ignored). */
  readonly rowsWritten: number;
}

/** The narrow slice of Cloudflare's `SqlStorage` (`ctx.storage.sql`) this adapter drives. */
export interface SqlStorageLike {
  exec(query: string, ...bindings: DoSqlValue[]): SqlStorageCursorLike;
}

/** `ctx.storage.transactionSync` — runs `closure` inside ONE synchronous SQLite transaction, rolling
 *  back if it throws. This is DO-SQLite's ONLY transaction primitive (explicit `BEGIN`/`COMMIT` SQL
 *  is rejected), so the adapter cannot fabricate atomicity without it. */
export type TransactionSyncFn = <T>(closure: () => T) => T;

export interface DoSqliteOptions {
  /** The DO's SQL handle — `ctx.storage.sql`. */
  sql: SqlStorageLike;
  /** The DO's synchronous transaction runner — `ctx.storage.transactionSync` (bind it to
   *  `ctx.storage`). Required: without it there is no way to make a multi-statement commit atomic. */
  transactionSync: TransactionSyncFn;
}

/** Narrow a DocStore-side binding (`SqlValue`) to what DO-SQLite's `exec` accepts. The only real work
 *  is `bigint → number` (DO has no bigint binding type); `Uint8Array` blobs and everything else pass
 *  through. Throws — rather than silently truncating — if a `bigint` exceeds the 2^53 safe range
 *  (unreachable for Stackbase's monotonic-counter timestamps; see the module note). */
function toDoBinding(v: SqlValue): DoSqlValue {
  if (typeof v === "bigint") {
    if (v > 9007199254740991n || v < -9007199254740991n) {
      throw new RangeError(
        `[docstore-do-sqlite] integer ${v} exceeds Number.MAX_SAFE_INTEGER; DO-SQLite has no ` +
          `bigint binding type, so it cannot be bound without precision loss`,
      );
    }
    return Number(v);
  }
  return v;
}

/** Re-wrap a DO-SQLite result cell into the `SqlValue` shape the DocStore expects. The one
 *  transformation that matters: BLOB columns come back as `ArrayBuffer`, but the DocStore reads them
 *  as `Uint8Array` (`internal_id`/`key`) — so wrap `ArrayBuffer → Uint8Array`. Integers stay `number`
 *  (the DocStore's `asBigInt` widens them); strings/null pass through. */
function fromDoValue(v: DoSqlValue): SqlValue {
  if (v instanceof ArrayBuffer) return new Uint8Array(v);
  // A DO cursor only ever yields ArrayBuffer for blobs, but a faithful stand-in (or a future runtime)
  // could hand back an ArrayBufferView; normalize that too so downstream never sees a stray view.
  if (ArrayBuffer.isView(v)) return new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
  return v;
}

function rowFromDo(row: Record<string, DoSqlValue>): SqlRow {
  const out: SqlRow = {};
  for (const key in row) out[key] = fromDoValue(row[key]!);
  return out;
}

/** A `PreparedStatement` over DO-SQLite. DO-SQLite has no persistent prepared-statement handle on the
 *  `SqlStorage` surface (and caches compiled SQL by text internally), so each `run`/`get`/`all` simply
 *  re-issues `sql.exec(this.sql, ...bindings)`. The DocStore still caches these wrapper objects, so the
 *  SQL text is built once per query — the same statement-cache ergonomics `node`/`bun` get. */
class DoStatement implements PreparedStatement {
  constructor(
    private readonly adapter: DoSqliteAdapter,
    private readonly sqlText: string,
  ) {}

  run(...params: SqlValue[]): RunResult {
    const cursor = this.adapter.execRaw(this.sqlText, params);
    // DO-SQLite writes are counted by `rowsWritten`; `lastInsertRowid` has no meaning on the
    // WITHOUT ROWID tables the DocStore uses (and the DocStore never reads it), so report 0.
    cursor.toArray(); // force execution so `rowsWritten` is populated even with no RETURNING rows
    return { changes: cursor.rowsWritten, lastInsertRowid: 0 };
  }

  get(...params: SqlValue[]): SqlRow | undefined {
    const rows = this.adapter.execRaw(this.sqlText, params).toArray();
    return rows.length > 0 ? rowFromDo(rows[0]!) : undefined;
  }

  all(...params: SqlValue[]): SqlRow[] {
    return this.adapter.execRaw(this.sqlText, params).toArray().map(rowFromDo);
  }
}

export class DoSqliteAdapter implements DatabaseAdapter {
  private readonly sql: SqlStorageLike;
  private readonly transactionSyncFn: TransactionSyncFn;

  constructor(options: DoSqliteOptions) {
    this.sql = options.sql;
    this.transactionSyncFn = options.transactionSync;
  }

  /** Issue one `sql.exec`, converting bindings and classifying a 10 GB `SQLITE_FULL` failure into a
   *  typed `DatabaseFullError`. The single chokepoint every `exec`/statement call funnels through, so
   *  the full-storage classification lives in exactly one place. */
  execRaw(sqlText: string, params: readonly SqlValue[]): SqlStorageCursorLike {
    try {
      return this.sql.exec(sqlText, ...params.map(toDoBinding));
    } catch (err) {
      if (isDatabaseFullError(err)) {
        throw new DatabaseFullError(
          "[docstore-do-sqlite] the Durable Object's 10 GB SQLite limit was reached (SQLITE_FULL)",
          err,
        );
      }
      throw err;
    }
  }

  exec(sql: string): void {
    // `exec()` carries DDL (the multi-statement schema) and other no-result side effects. DO-SQLite's
    // `sql.exec` runs a multi-statement string in one call (bindings only apply to a single statement),
    // so no splitting is needed here. Materialize to surface any FULL error synchronously.
    this.execRaw(sql, []).toArray();
  }

  prepare(sql: string): PreparedStatement {
    return new DoStatement(this, sql);
  }

  transaction<T>(fn: () => T): T {
    // DO-SQLite's ONLY atomic primitive — explicit BEGIN/COMMIT SQL is rejected. A throw inside `fn`
    // propagates out of `transactionSync`, which rolls the whole transaction back (matching the
    // BEGIN/ROLLBACK contract the node/bun adapters implement by hand).
    return this.transactionSyncFn(fn);
  }

  close(): void {
    // A Durable Object's storage lifecycle is owned by the runtime, not the adapter: there is no
    // handle to close and no file to release (unlike node/bun's on-disk databases). The DocStore's
    // graceful-shutdown `close()` still flows here, so this is an intentional no-op.
  }
}
