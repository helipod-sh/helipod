/**
 * The one storage-full failure mode a DO-SQLite adapter has that neither `node:sqlite` nor
 * `bun:sqlite` share: a Durable Object's embedded SQLite is capped at **10 GB per object** and a
 * write past that ceiling hard-fails with `SQLITE_FULL` (see
 * `docs/dev/research/cloudflare-do-native-host.md`). Rather than let that surface as an opaque,
 * driver-shaped throw, the adapter classifies it into this ONE typed error so a host (Slice 3) can
 * catch it and react (shed the write, reshard, page an operator) — the same "typed, not a crash"
 * discipline `docstore-postgres` applies to its `ReadOnlyStoreError`.
 *
 * Only a genuine capacity/disk-full failure is wrapped; a `SQLITE_CONSTRAINT` (e.g. the duplicate
 * `(id, ts)` the conflict-strategy contract relies on rejecting) passes straight through untouched.
 */
export class DatabaseFullError extends Error {
  /** Stable, machine-checkable discriminant — a host can branch on this without instanceof across
   *  a bundling/isolate boundary. */
  readonly code = "DATABASE_FULL" as const;

  constructor(
    message: string,
    /** The original driver error, preserved so the host never loses the underlying detail.
     *  `override` because ES2022's `Error` already declares an optional `cause`. */
    override readonly cause: unknown,
  ) {
    super(message);
    this.name = "DatabaseFullError";
  }
}

/**
 * Does this driver error signal the DO-SQLite 10 GB ceiling (`SQLITE_FULL`)? Cloudflare does not
 * document a stable error CODE for the limit (the SQL API just surfaces SQLite's own text), so we
 * match on the SQLite `SQLITE_FULL` primary-result-code family and its canonical message —
 * "database or disk is full" — while deliberately NOT matching `SQLITE_CONSTRAINT`/`SQLITE_BUSY`/etc.
 * A false negative here degrades gracefully (the raw error still propagates, just untyped); a false
 * positive would mislabel an unrelated failure, so the patterns are kept narrow and full-specific.
 */
export function isDatabaseFullError(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  // SQLite exposes the primary result code as the string "SQLITE_FULL" on `err.code` in most
  // bindings; some (and the DO SQL API) only carry it in the message. Check both.
  if (typeof code === "string" && code.toUpperCase().includes("SQLITE_FULL")) return true;
  const message = (err as { message?: unknown } | null)?.message;
  if (typeof message !== "string") return false;
  return /\bSQLITE_FULL\b/i.test(message) || /database or disk is full/i.test(message);
}
