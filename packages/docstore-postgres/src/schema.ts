/** The three fixed physical tables, one statement per element. Created once, idempotently;
 *  never altered as the app evolves. Run one-per-query so a single-statement driver (PGlite)
 *  and a multi-statement one (pg) behave identically. */
export const SCHEMA_STATEMENTS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS documents (
     table_id    TEXT   NOT NULL,
     internal_id BYTEA  NOT NULL,
     ts          BIGINT NOT NULL,
     prev_ts     BIGINT,
     value       TEXT,
     PRIMARY KEY (table_id, internal_id, ts)
   )`,
  `CREATE INDEX IF NOT EXISTS documents_by_ts ON documents (ts)`,
  `CREATE TABLE IF NOT EXISTS indexes (
     index_id    TEXT   NOT NULL,
     key         BYTEA  NOT NULL,
     ts          BIGINT NOT NULL,
     table_id    TEXT,
     internal_id BYTEA,
     deleted     BOOLEAN NOT NULL DEFAULT FALSE,
     PRIMARY KEY (index_id, key, ts)
   )`,
  `CREATE TABLE IF NOT EXISTS persistence_globals (
     key   TEXT PRIMARY KEY,
     value TEXT NOT NULL
   )`,
  // Commit-timestamp sequence (Fenced Frontier B1, D1). `commitWrite` draws `nextval` from it
  // inside the commit transaction so the ts lands atomically with its rows. Seeded exactly once
  // (sentinel-gated) in `setupSchema` — see PostgresDocStore.setupSchema.
  `CREATE SEQUENCE IF NOT EXISTS stackbase_ts`,
  // Additive shard column (D6). One ALTER per element (single-statement drivers like PGlite).
  // Existing deployments upgrade in place; pre-existing rows read as 'default' via the DEFAULT.
  `ALTER TABLE documents ADD COLUMN IF NOT EXISTS shard_id TEXT NOT NULL DEFAULT 'default'`,
  `ALTER TABLE indexes   ADD COLUMN IF NOT EXISTS shard_id TEXT NOT NULL DEFAULT 'default'`,
];
