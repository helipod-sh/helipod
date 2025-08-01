# Slice 6c — Postgres storage adapter — Design Spec

**Date:** 2025-07-31
**Status:** Approved design — ready for implementation plan
**Build-order slice:** 6c (the last piece of "Production deploy tooling"; 6a Docker self-host ✅, 6b `deploy` push ✅, 6d single binary ✅ all shipped)

## 1. Goal

Let a Stackbase deployment use **Postgres** as its storage backend instead of the default single-file SQLite, selected purely by configuration (a connection string) with **no application code changes** — the same `convex/` functions, schema, and reactive semantics run unchanged. This delivers the locked "storage is pluggable; ship SQLite + Postgres" decision and gives operators a managed-Postgres / networked-durability option for single-node deployments.

**Non-goal (explicitly deferred):** multi-node / distributed operation. Postgres here is a **single-writer drop-in** — one engine process owns the database, exactly as with SQLite. Horizontal scale-out (multiple engine nodes sharing one Postgres, a distributed transactor) stays in the deferred Tier 2, unchanged by this slice. We add the *storage backend* now; we do not turn Stackbase into a clustered system.

## 2. Background: why this is small

The engine never learns which database it is on — it speaks only the async `DocStore` interface (`packages/docstore/src/types.ts`). Critically, **the physical schema does not model the user's application schema.** All user data lives in three fixed physical tables:

- `documents` — the append-only MVCC log: `{ ts, id, table_id, value, prev_ts }`.
- `indexes` — index entries: `{ ts, index_id, key, table_id, doc_id, deleted }`.
- `persistence_globals` — a small key/value table for engine metadata.

A user "table" is just a `table_id` discriminator on rows; a user index is rows in `indexes`; adding a field to a document changes only the JSON in a `value` cell. **Therefore an application-schema change requires zero Postgres DDL and zero migrations** — the physical schema is created once, idempotently, and never changes as the app evolves. This is the same design Convex's own backend uses, and it is what makes a Postgres adapter a bounded, self-contained slice rather than an open-ended migrations project. An ORM (Drizzle/Prisma) is explicitly rejected: there is nothing to model or migrate; raw parameterized SQL against three fixed tables is clearer and has no schema-drift surface.

## 3. Architecture

### 3.1 The async `PgClient` seam

`PostgresDocStore` is a **new** `DocStore` implementation (new package `packages/docstore-postgres`), not a variant of `SqliteDocStore`. It sits on a narrow async seam — the Postgres analogue of SQLite's synchronous `DatabaseAdapter`:

```ts
export type PgValue = null | number | bigint | string | Uint8Array | boolean;
export type PgRow = Record<string, PgValue>;

export interface PgClient {
  /** Run a parameterized query ($1,$2,…); returns normalized rows. */
  query(text: string, params?: readonly PgValue[]): Promise<PgRow[]>;
  /** Run `fn` inside a single BEGIN/COMMIT (ROLLBACK on throw); `tx` is pinned to one connection. */
  transaction<T>(fn: (tx: PgQuerier) => Promise<T>): Promise<T>;
  /** Acquire the single-writer advisory lock; throw if already held elsewhere. */
  acquireWriterLock(): Promise<void>;
  close(): Promise<void>;
}

export interface PgQuerier {
  query(text: string, params?: readonly PgValue[]): Promise<PgRow[]>;
}
```

The seam's **normalization contract** is load-bearing and is where the driver-specific traps are quarantined: a `PgClient` implementation MUST return `int8`/`bigint` columns as JS `bigint` (never string) and `bytea` columns as `Uint8Array` (never a hex string or Buffer subtype leak). `PostgresDocStore` is written against normalized `bigint`/`Uint8Array` and never sees a driver's raw representation. This mirrors how `SqliteDocStore` relies on its adapter reading integer columns as `bigint`.

**Why async, and why a separate DocStore.** The SQLite seam is synchronous because `bun:sqlite`/`node:sqlite` are synchronous. Every Postgres client is asynchronous. The methods differ enough (async transactions with a pinned connection, `$1` positional params vs `?`, `RETURNING`, `DISTINCT ON`) that sharing an implementation with `SqliteDocStore` would help neither. They share the *contract* (`DocStore`), not the code — and that contract is what the engine and the conformance suite depend on.

### 3.2 `PostgresDocStore implements DocStore`

Implements every `DocStore` method (§`types.ts`): `setupSchema`, `write`, `get`, `index_scan`, `load_documents`, `previous_revisions`, `scan`, `count`, `maxTimestamp`, `getGlobal`/`writeGlobal`/`writeGlobalIfAbsent`. Behavioral parity with `SqliteDocStore` is defined by the shared conformance suite (§6), which both must pass identically.

### 3.3 Driver implementations behind the seam

- **`NodePgClient`** (v1, ships) — wraps `pg` (node-postgres). Works under **both Node and Bun**, so it is the single production client for v1. Normalizes `int8`→`bigint` (via `pg.types` parser override for OID 20) and `bytea`→`Uint8Array`.
- **`PgliteClient`** (v1, **test-only**, lives under `test/`) — wraps `@electric-sql/pglite` (real Postgres compiled to WASM, in-process, runs under Node). The hermetic conformance backend. Also normalizes to the seam contract.
- **`BunPgClient`** (deferred fast-follow, NOT built) — would wrap `Bun.SQL` for the JSC-native binary-protocol path when running under Bun. Reserved behind the identical seam so it drops in with zero changes to `PostgresDocStore`; added later *with* its own Bun + real-PG conformance run.

### 3.4 Driver decision & rationale (locked)

**v1 ships `pg`-only** (`NodePgClient`), with `Bun.SQL` reserved as a seam-swappable fast-follow. Reasoning, recorded so it is not relitigated:

1. **Coverage dominates for a storage adapter.** A data-integrity-critical layer must be maximally tested. `pg` runs on Node *and* Bun, so it is covered three ways: PGlite hermetic conformance (Node suite, always-on), an env-gated real-Postgres conformance run, and the Docker ship gate — which exercises the *actual production path* (`serve` under Bun → `pg` → real PG), because production (Docker image / single binary) runs under Bun. `Bun.SQL` is a Bun-only wire client that needs a real PG server, so under the Node vitest suite (see §6.1) it would get **zero** automated coverage — only the Docker smoke. Shipping an under-tested driver for the layer that must never corrupt data is the riskier choice, not the more ambitious one.
2. **The speed win barely applies here.** Storage sits behind a single-writer OCC transactor doing small batched writes and point/range reads. The bottleneck is disk/network round-trips and commit serialization, not driver result-set marshaling — where `Bun.SQL`'s native edge shows up. Tier 0 single-writer Stackbase is not the high-QPS OLTP workload that difference targets.
3. **The seam preserves the option at zero cost.** If profiling ever shows the driver matters under Bun, `BunPgClient` drops in behind the identical `PgClient` interface with no rework of `PostgresDocStore`, and is added with proper Bun + real-PG coverage at that time.

### 3.5 Wiring / backend selection

`makeStore` (`packages/cli/src/boot.ts`) currently returns `SqliteDocStore` and picks the bun/node SQLite adapter via `detectRuntime()`. It changes to:

- Return type widens from `SqliteDocStore` to `DocStore` (`BootResult.store` likewise; `close()` is already on both via the store — confirm the shutdown path calls `store.close()`, which becomes `Promise<void>` for Postgres, `void` for SQLite; the caller must `await` it — verify no sync-close assumption remains).
- Selection: if a Postgres connection string is present (`--database-url <url>` flag or `STACKBASE_DATABASE_URL` env; `postgres://`/`postgresql://` scheme), construct `new PostgresDocStore(new NodePgClient({ connectionString }))`; otherwise the existing SQLite path (`--data`/`dataPath`). SQLite remains the zero-config default — absence of a Postgres URL changes nothing.
- `bootLoaded`/`bootProject`/`serve`/binary all flow through `makeStore`, so all entrypoints gain Postgres support in one place. `dev` gains it too (a developer can point at a local PG), though SQLite stays the `dev` default.

## 4. Physical schema (Postgres)

Created idempotently by `setupSchema()` via a single `CREATE TABLE IF NOT EXISTS …` batch. Postgres-specific column choices:

- **`value` as `TEXT`**, holding the exact `convexToJson(...)` JSON string — *not* `JSONB`. The engine round-trips its own canonical JSON encoding (preserving key order, `$`-prefixed special types, bigint encoding); JSONB would re-sort keys and re-type values, breaking fidelity. This mirrors SQLite storing the value as text.
- **Index keys as `BYTEA`.** Index keys are order-encoded `Uint8Array`s (`@stackbase/index-key-codec`); Postgres compares `BYTEA` **byte-wise**, which matches the encoder's ordering contract exactly (the same property SQLite's `BLOB` comparison gives). Range scans use `key >= $start AND (key < $end)` on the `BYTEA` column.
- **`ts`, `prev_ts`, `doc_id` shard/counter parts as `BIGINT`.** Timestamps are 64-bit `bigint`; `NodePgClient` must parse `int8` back to `bigint` (pg returns `int8` as a string by default — the normalization contract, §3.1).
- **Primary keys / indexes** mirror the SQLite adapter's: `documents (id, ts)`, an index on `(table_id, ts)` for table scans, `indexes (index_id, key, ts)` for ordered index scans, `persistence_globals (key)`. Exact index set is derived from `SqliteDocStore`'s DDL during implementation so scan plans match.

`setupSchema()` is safe to call on every boot; it creates nothing that already exists and never alters an existing table.

## 5. Query strategy — set-based, not row-at-a-time

`SqliteDocStore` runs some scans as an outer loop issuing per-row point lookups (an N+1 that is cheap in-process on SQLite but a round-trip disaster over a Postgres socket). `PostgresDocStore` MUST express these as **single set-based SQL statements**:

- **`index_scan`** — one statement using `DISTINCT ON (key)` with `ORDER BY key <order>, ts DESC` over rows with `ts <= readTimestamp` in the `BYTEA` interval, `LEFT JOIN`ed to the newest visible `documents` revision, filtering tombstones, `LIMIT`ed. Yields `[key, LatestDocument]` in index order without a per-key round trip. Streamed as an async generator (cursor or batched fetch) so large scans do not buffer wholesale.
- **`scan(tableId)`** — one `DISTINCT ON (id) … ORDER BY id, ts DESC` over the table's rows at the read timestamp, tombstones filtered.
- **`previous_revisions(queries)`** — one statement over the whole `(id, ts)` batch (e.g. `VALUES` list join or `= ANY($ids)` with a lateral newest-visible pick), returning all requested revisions in a single round trip rather than one query per entry.
- **`write`** — one `transaction(tx => …)`: batch-insert document revisions and index updates. Batches use multi-row `INSERT` (or `UNNEST($1::…[])` array params) to avoid a round trip per row. `ConflictStrategy` (`"Error"` | `"Overwrite"`) maps to plain insert vs `ON CONFLICT (id, ts) DO UPDATE`.
- **`maxTimestamp` / `count` / `getGlobal`** — trivial single aggregates/lookups.

The guiding rule: **one network round trip per `DocStore` call wherever the contract allows**, because every round trip is now real latency.

## 6. Single-writer guard

SQLite gets single-writer for free (one process holds the file). Postgres does not — a second engine pointed at the same database would silently double-write and corrupt the MVCC log. On boot, after `setupSchema`, `PostgresDocStore` calls `acquireWriterLock()`, which takes a **session-level `pg_advisory_lock`** (a fixed application-chosen 64-bit key) on a pinned connection held for the process lifetime. If the lock is already held (another engine is running), boot **fails fast** with a clear operator error ("another Stackbase engine is already connected to this database") rather than starting a corrupting second writer. This encodes the single-node invariant as an enforced runtime guard, not a hope.

## 7. Testing

### 7.1 The runtime reality that shapes the test plan

`bun run test` runs the vitest suite under **Node**, not Bun (vitest's bin has a `#!/usr/bin/env node` shebang; `globalThis.Bun` is `undefined` in the test process — a known, documented property of this repo, already handled by `docstore-sqlite`'s separate `test:bun` smoke). Consequences: the hermetic conformance backend must run under Node (PGlite does), and a `Bun.SQL`-based client could not be exercised by the suite at all — a primary reason `Bun.SQL` is deferred (§3.4).

### 7.2 Shared DocStore conformance suite

The behavioral contract is extracted **once** into a backend-parameterized suite and run against every backend, so SQLite and Postgres are proven identical against the same assertions:

- Extract the assertions currently in `packages/docstore-sqlite/test/docstore.test.ts` into an exported `runDocStoreConformance(makeStore: () => Promise<DocStore>, teardown?: () => Promise<void>)` in a shared test-support location (e.g. `packages/docstore/test-support/conformance.ts`, shipped as a test util, not in the runtime bundle). The backend-agnostic helpers (`rev`, `collect`, id-codec / index-key-codec usage) move with it.
- `docstore-sqlite`'s test file becomes a thin caller: `runDocStoreConformance(async () => { const s = new SqliteDocStore(new NodeSqliteAdapter()); await s.setupSchema(); return s; })`. Its existing coverage must stay green unchanged (this is a refactor, not a rewrite of what SQLite asserts).
- `docstore-postgres`'s test file calls the same suite with a **PGlite**-backed factory (`new PostgresDocStore(new PgliteClient(...))`), giving hermetic, Docker-free, real-Postgres-semantics coverage that runs in the normal Node suite on every `bun run test`.
- An **env-gated real-Postgres** run: when `STACKBASE_TEST_DATABASE_URL` is set, additionally run the same suite against `NodePgClient` pointed at that server — so CI / a developer with a Postgres handy exercises the actual production client against a real server. Skipped (not failed) when the env var is absent, so the default suite stays hermetic.

### 7.3 Ship gate: Docker E2E

The real-artifact gate, consistent with 6a/6b/6d: a test brings up a `postgres` container, runs `stackbase serve --database-url postgres://…` (under Bun, the production runtime) against it, and asserts through the real server: a mutation commits → a query reads it back → the write **fans out reactively** to a WebSocket subscription opened before it → data **persists** across a `serve` restart against the same database → the single-writer guard rejects a second `serve` on the same database. This proves the exact production path (`serve`/Bun/`pg`/real PG) the hermetic suite cannot.

## 8. Error handling

- **Connection failure at boot** (bad URL, server down, auth) → fail fast with a clear operator message naming the connection target (never the password); do not fall back to SQLite silently (a silent fallback would hide a misconfiguration and split data across two backends).
- **Writer-lock contention** → the §6 fail-fast message.
- **Query errors mid-operation** → propagate as thrown errors up through the async `DocStore` method, exactly as the SQLite path does; the transactor's existing OCC/retry handling is unchanged.
- **Normalization violations** (a driver returning an unexpected type) are prevented by the seam contract and caught by conformance; they are implementation bugs, not runtime conditions.

## 9. Two implementation traps (from the Bun/pg research)

1. **`BYTEA` return type is driver-specific and under-documented** — verify empirically per client what a `bytea` column deserializes to (Buffer / Uint8Array / hex string) and normalize to `Uint8Array` in the `PgClient` impl. The conformance suite's index-key ordering tests are the backstop.
2. **Multi-statement DDL** — `setupSchema`'s batched `CREATE TABLE IF NOT EXISTS …` must run through the client's raw/simple path that accepts multiple statements (for `Bun.SQL` that is `sql.unsafe(ddl)`, *not* the tagged-template/`.simple()` path; for `pg` a single `query(ddl)` with multiple statements is accepted). The DDL text is engine-authored (no interpolation), so `unsafe` is safe here.

## 10. File structure (informs the plan)

- `packages/docstore-postgres/` (new): `src/pg-client.ts` (the `PgClient`/`PgQuerier`/`PgValue` seam + normalization contract), `src/node-pg-client.ts` (`NodePgClient` over `pg`), `src/postgres-docstore.ts` (`PostgresDocStore implements DocStore`), `src/schema.ts` (the DDL), `src/index.ts` (exports `PostgresDocStore`, `NodePgClient`, seam types), `test/pglite-client.ts` (test-only `PgliteClient`), `test/docstore.test.ts` (calls the shared conformance suite with PGlite + env-gated real PG).
- `packages/docstore/test-support/conformance.ts` (new): the shared `runDocStoreConformance` suite + helpers.
- `packages/docstore-sqlite/test/docstore.test.ts` (modify): becomes a thin caller of the shared suite (its assertions move into the shared suite unchanged).
- `packages/cli/src/boot.ts` (modify): `makeStore` returns `DocStore`, selects backend by connection string; verify `store.close()` is awaited on shutdown.
- `packages/cli/src/dev-options.ts` / option parsing (modify): accept `--database-url` and `STACKBASE_DATABASE_URL`.
- `packages/cli/test/` (new): the Docker/Postgres E2E ship-gate test.
- Docs: `docs/enduser/self-hosting.md` (add the Postgres option + `docker-compose` with a `postgres` service); note the single-writer constraint.
- `CLAUDE.md`: move Postgres adapter from deferred to shipped once green.

## 11. Scope

**In scope (v1):** `packages/docstore-postgres` with `PostgresDocStore` + `NodePgClient` (`pg`) behind the async `PgClient` seam; idempotent physical schema; set-based scans; single-writer advisory-lock guard; connection-string backend selection in `makeStore`; the shared conformance suite (SQLite + PGlite + env-gated real PG); the Docker ship-gate E2E; self-hosting docs.

**Out of scope / deferred:** multi-node / distributed transactor (Tier 2, unchanged); the `BunPgClient`/`Bun.SQL` native path (reserved behind the seam); `JSONB` storage; bulk `COPY` import; MySQL or other backends; any application-schema migration tooling (the physical schema is fixed and needs none); a data migration path *between* SQLite and Postgres (an operator picks a backend per deployment; import/export is a separate future concern).

## 12. Success criteria

1. A Stackbase app runs unmodified against Postgres selected by `--database-url` / `STACKBASE_DATABASE_URL`; SQLite remains the zero-config default.
2. `PostgresDocStore` passes the identical shared `DocStore` conformance suite that `SqliteDocStore` passes — against PGlite always, and against a real Postgres when `STACKBASE_TEST_DATABASE_URL` is set.
3. The Docker E2E proves commit → read-back → reactive fan-out → persistence-across-restart → single-writer rejection through the real `serve` server against a real Postgres container.
4. Scans are set-based (verified by inspection: no per-row round-trip loops in `index_scan`/`scan`/`previous_revisions`).
5. `bun run build`, `bun run typecheck`, and `bun run test` are green; the engine has no new knowledge of which backend it is on (no Postgres/SQLite specifics leak out of `packages/docstore-*`).
