/**
 * Placeholder for the `pg`-backed `PgClient` implementation. Task 2 fills this in with a real
 * `pg.Pool`-based client (connection pooling, transaction pinning to one connection, and the
 * `pg_advisory_lock`-based `acquireWriterLock`). Exists now only so `src/index.ts` has a stable
 * export surface for consumers to import against ahead of that task.
 */
export class NodePgClient {}
