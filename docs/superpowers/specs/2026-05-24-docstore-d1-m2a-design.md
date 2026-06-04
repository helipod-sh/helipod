# `@stackbase/docstore-d1` (Slice-6 M2a) — Design Spec

**Date:** 2026-05-24
**Status:** Design (pre-plan). Brainstorming complete; awaiting user review before the implementation plan.
**Slice:** M2a of Slice-6 M2 (`.global()`/D1 cross-shard reads). The **standalone** relational D1 store — the foundation the rest of M2 (M2b routing, M2c reactivity, M2d fan-out) builds on. Decomposition + decisions per `docs/superpowers/specs/2026-05-15-slice6-m2-global-reads-notes.md` and the parent spec `docs/superpowers/specs/2026-03-20-multishard-crossshard-slice6-design.md` §6.4 (T5).

## Goal

A new `@stackbase/docstore-d1` package: a **relational, column-per-field** store for `.global()` tables on Cloudflare D1, with real `CREATE UNIQUE INDEX` global-unique constraints and D1-Sessions read-your-writes. Standalone and independently testable — **not** wired into the engine yet (that's M2b).

## Why this is a new store, not a variant

Every existing adapter (`docstore-sqlite`/`docstore-postgres`/`docstore-do-sqlite`) is a **schemaless MVCC log** — app tables/fields are opaque JSON values, so `schema.ts` evolves with zero migrations, but a field is never a real column and `.unique()` can't be a real constraint. `.global()`'s entire purpose is **global-unique** constraints and relational global reads the MVCC log structurally cannot provide. So the D1 store is **schema-ful**: each field is a typed column and `.unique()` is a `CREATE UNIQUE INDEX`. The tradeoff — real constraints in exchange for schema-evolution-as-DDL — is exactly why it's its own store and its own slice. Reference (studied, never copied — FSL): `.reference/lunora/packages/d1/`.

## Locked scope decisions

- **Test substrate (tiered, mirrors the postgres PGlite+container story):** the behavior suite runs on **local `bun:sqlite`** behind the async `D1Client` seam (fast lane, hermetic) AND on **miniflare's real D1** (workerd SQLite) as a serial-lane ship gate.
- **Migrations (create-only in M2a):** M2a generates fresh DDL (`CREATE TABLE`/`CREATE INDEX`/`CREATE UNIQUE INDEX`) from `schema.ts`. Schema *evolution* (introspect → diff → `ALTER TABLE`/add-column/add-index) is a deferred follow-on, not M2a.
- **Own interface, not `DocStore`:** M2a defines its own narrow store surface; bridging it to the engine's query/reactive path is M2b.

## Architecture

New package **`packages/docstore-d1`** (`@stackbase/docstore-d1`). Structure mirrors `@lunora/d1`'s shape (in our own clean-room code):

### 1. The `D1Client` seam (`src/d1-client.ts`)

A narrow async client the store depends on — the engine/store never imports a D1 driver directly (same discipline as `docstore-postgres`'s `PgClient`):

```ts
export interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  all<T = Record<string, unknown>>(): Promise<{ results: T[]; meta: { changes?: number; last_row_id?: number } }>;
  run(): Promise<{ meta: { changes?: number } }>;
}
export interface D1Client {
  prepare(sql: string): D1PreparedStatement;
  batch(statements: D1PreparedStatement[]): Promise<void>;
  /** D1 Sessions read-your-writes: run reads against a session anchored at `bookmark`; the returned
   *  client's operations carry the session, and `latestBookmark()` yields the post-write bookmark. */
  withSession(bookmark?: string): { client: D1Client; latestBookmark(): string | undefined };
  exec(sql: string): Promise<void>; // multi-statement DDL
}
```

Two implementations:
- **`src/binding-d1-client.ts`** — over the real Cloudflare D1 binding (`env.DB`, `DurableObjectStorage`-adjacent), using `db.withSession(bookmark)` (D1 Sessions API). Production.
- **Test substrates:** a `bun:sqlite`-backed `D1Client` (`test/support/sqlite-d1-client.ts`, async-wrapping the synchronous `bun:sqlite` API; `withSession` is a no-op bookmark stub) for the fast lane; and a miniflare-real-D1 client for the serial ship-gate.

### 2. Schema → DDL (`src/ddl.ts`, create-only)

`schema.ts` → SQLite DDL. For each `.global()` table:
- `CREATE TABLE "<table>" ("_id" TEXT PRIMARY KEY, "_creationTime" REAL NOT NULL, <field columns>)`.
- **Column types** from the field validator: `v.string()`/`v.id()`→`TEXT`, `v.number()`/`v.int64()`→`REAL`/`INTEGER`, `v.boolean()`→`INTEGER` (0/1), `v.object()`/`v.array()`/`v.record()`/`v.any()`→`TEXT` (JSON-encoded), `v.optional(x)` → the inner column type, nullable. A small `columnTypeFor(validator)` maps our `@stackbase/values` validator JSON to a column type.
- **`.unique()` field → `CREATE UNIQUE INDEX "uq_<table>_<field>" ON "<table>"("<field>")`.**
- **Declared indexes → `CREATE INDEX "idx_<table>_<name>" ON "<table>"(<cols>)`.**
- Nested/JSON columns store `JSON.stringify(value)`; reads `JSON.parse`. `_id` is the app's `Id` string.

### 3. The store (`src/d1-doc-store.ts`)

`class D1DocStore` over a `D1Client`, with the own narrow interface:
- `applyDdl(schema)` — run the create-only DDL (idempotent `CREATE TABLE IF NOT EXISTS` / `CREATE UNIQUE INDEX IF NOT EXISTS`).
- `insert(table, doc)` → `INSERT` a row (columns from fields, JSON for nested); a `.unique()` violation surfaces a typed `UniqueConstraintError` (map the SQLite `UNIQUE constraint failed` error).
- `get(table, id)` → `SELECT … WHERE _id = ?` → reconstruct the doc (JSON-decode nested columns).
- `patch(table, id, partial)` / `replace(table, id, doc)` / `delete(table, id)`.
- `queryByIndex(table, index, range)` → `SELECT … WHERE <indexed cols> …` (the relational read `.global()` needs; the range→SQL mapping mirrors the index-key semantics).
- All methods accept an optional `bookmark` and the store threads it through `client.withSession(bookmark)`, returning the `latestBookmark()` on writes (the Sessions read-your-writes primitive M2b threads end-to-end via `x-d1-bookmark`).

### 4. Value ↔ row codec (`src/codec.ts`)

`docToRow(schema, table, doc)` / `rowToDoc(schema, table, row)` — the field↔column mapping (typed columns + JSON for nested), using the schema to know which columns are JSON. Pure + unit-tested.

## Data flow (M2a, standalone)

```
schema.ts (.global() tables) ──ddl──► D1Client.exec(CREATE TABLE/INDEX)
insert/patch/delete(doc) ──codec──► D1Client.prepare(INSERT/UPDATE/DELETE).bind().run()
get/queryByIndex ──────────────────► D1Client.prepare(SELECT).bind().all() ──codec──► doc(s)
.unique() violation ───────────────► UniqueConstraintError
bookmark ──────────────────────────► client.withSession(bookmark) → latestBookmark()
```
No engine, no routing, no reactivity — that's M2b+.

## Error handling

- **Unique violation** → typed `UniqueConstraintError { table, field, message }` (parse SQLite's `UNIQUE constraint failed: <table>.<field>`), so M2b/callers can surface it as a coded write rejection.
- **Missing table / bad column** → a clear error naming the table/field (a `.global()` doc whose schema wasn't `applyDdl`'d).
- **Bookmark** on a substrate without Sessions (bun:sqlite) → no-op (reads are already consistent locally), so the fast lane behaves.

## Testing

- **Behavior suite (`test/d1-behavior.ts`)** — a shared suite (like the docstore conformance suite is shared) exercising insert/get/patch/replace/delete, `queryByIndex` ranges, a **unique-violation → `UniqueConstraintError`**, a multi-field index, JSON round-trip of nested values, and a bookmark round-trip (no-op on sqlite, real on D1).
  - **Fast lane (`test/d1-doc-store.test.ts`):** run the suite against the `bun:sqlite` `D1Client`.
  - **Serial ship-gate (`test/d1-real-e2e.test.ts`):** run the same suite against **miniflare's real D1** (workerd SQLite) — proves the real Sessions bookmark + real SQL dialect. `*-e2e.test.ts` → serial lane.
- Unit tests for `ddl.ts` (schema→DDL strings, unique/index) and `codec.ts` (doc↔row, JSON columns) — pure, fast.

## Package layout

- **New:** `packages/docstore-d1/` — `package.json` (deps: `@stackbase/values` for validator introspection; dev: `bun:sqlite`/`better-sqlite3` for the fast substrate, `miniflare` for the ship gate, tsup/vitest/typescript), `tsconfig.json`, `tsup.config.ts`, `src/{index,d1-client,binding-d1-client,ddl,codec,d1-doc-store}.ts`, `test/{support/sqlite-d1-client,d1-behavior,d1-doc-store.test,d1-real-e2e.test}.ts`.
- Engine untouched (M2a is standalone).

## Non-goals (explicit — these are M2b–M2e)

- **`.global()` schema mode + routing** (schema-load recognizing `.global()`, write-through from the shard-DO, routing global reads to D1) — M2b.
- **Global reactivity** (poll-based invalidation of global subscriptions) — M2c.
- **Cross-shard fan-out reads** — M2d.
- **The `x-d1-bookmark` end-to-end header wiring** through the request path — M2b (M2a provides the store-level bookmark primitive only).
- **Schema migrations / `ALTER TABLE`** (create-only in M2a) — deferred follow-on.
- **Reactive queries over D1 / live global queries** — M2c.
- Wiring into the MVCC-log `DocStore` seam / the query engine — M2b.
