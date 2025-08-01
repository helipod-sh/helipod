# Postgres Storage Adapter (Slice 6c) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a single-node Postgres storage backend (`PostgresDocStore implements DocStore`) selectable by a connection string, with zero application-code or app-schema-migration changes, proven identical to SQLite by a shared conformance suite and a real-container E2E.

**Architecture:** A new package `packages/docstore-postgres` implements the async `DocStore` contract on a narrow async `PgClient` seam (the Postgres analogue of SQLite's synchronous `DatabaseAdapter`). One production client ships in v1 — `NodePgClient` over `pg` (runs on Node and Bun); a test-only `PgliteClient` over `@electric-sql/pglite` gives hermetic, real-Postgres-semantics coverage under Node. All user data lives in three fixed physical tables discriminated by `table_id`, so an app-schema change needs no DDL. Set-based `DISTINCT ON`/`LATERAL` queries replace SQLite's per-row loops. A `pg_advisory_lock` enforces the single-writer invariant. `makeStore` selects the backend by connection string.

**Tech Stack:** TypeScript, Bun (package manager + runtime), vitest (runs under Node), `pg` (node-postgres), `@electric-sql/pglite` (test only), `@stackbase/values` (`convexToJson`/`jsonToConvex`), `@stackbase/id-codec` (`encodeStorageTableId`/`decodeStorageTableId`), `@stackbase/index-key-codec`, Docker (E2E).

## Global Constraints

- **Bun only** — `bun install` / `bun run`. Never npm/pnpm/yarn. Add deps by editing `package.json` and running `bun install`.
- **The engine must never learn which database it is on.** No Postgres/SQLite specifics may leak out of `packages/docstore-*`. Do not import `pg`, `pglite`, or Postgres SQL anywhere outside `packages/docstore-postgres` (its `test/` may import pglite).
- **No application-schema migrations.** The physical schema is three fixed tables created idempotently once; it never changes as the app evolves. Do not generate per-table DDL.
- **The `DocStore` contract is the only cross-seam surface** (`packages/docstore/src/types.ts`). `PostgresDocStore` implements it exactly; behavioral parity with `SqliteDocStore` is defined by the shared conformance suite.
- **Value fidelity:** the document `value` column is `TEXT` holding `JSON.stringify(convexToJson(value))`, never `JSONB`. Index keys are `BYTEA` (byte-wise ordered). Timestamps are `BIGINT` round-tripped as JS `bigint`.
- **Seam normalization contract:** a `PgClient.query` returns `int8` columns as JS `bigint` and `bytea` columns as `Uint8Array`; `bytea` params are accepted as `Uint8Array`. Each client impl converts to/from its driver's native types (`pg`: `int8`→string, `bytea`→Buffer; PGlite: `Uint8Array`). `PostgresDocStore` only ever sees normalized `bigint`/`Uint8Array`.
- **Set-based queries:** `index_scan`, `scan`, `previous_revisions`, and `write` each issue at most one round trip. No per-row query loops.
- **TDD, frequent commits.** Every task: failing test → verify fail → implement → verify pass → commit. Commit messages end with a blank line then `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.
- **Verification greps for real failures:** a passing `test` does NOT imply passing `typecheck`. After each task run `bun run --filter @stackbase/docstore-postgres typecheck` and confirm zero `error TS`.
- **Reference, do not copy:** mirror `packages/docstore-sqlite/src/sqlite-docstore.ts`'s structure and semantics; translate SQL to Postgres. Do not copy FSL `.reference/` code.

---

## File Structure

**New package `packages/docstore-postgres/`:**
- `package.json` — deps: `pg`; devDeps: `@electric-sql/pglite`, `@types/pg`, `vitest`, `typescript`, `tsup`; workspace dep `@stackbase/docstore`, `@stackbase/values`, `@stackbase/id-codec`, `@stackbase/index-key-codec`. Scripts mirror `docstore-sqlite` (`build`/`test`/`typecheck`/`clean`).
- `tsconfig.json`, `tsup.config.ts` — copy from `packages/docstore-sqlite`.
- `src/pg-client.ts` — the seam: `PgValue`, `PgRow`, `PgQuerier`, `PgClient` interfaces (+ the fixed advisory-lock key constant).
- `src/node-pg-client.ts` — `NodePgClient implements PgClient` over `pg`, with type normalization + `bytea`/`int8` marshaling.
- `src/schema.ts` — the `SCHEMA_SQL` DDL string.
- `src/postgres-docstore.ts` — `PostgresDocStore implements DocStore`.
- `src/index.ts` — exports `PostgresDocStore`, `NodePgClient`, and seam types.
- `test/pglite-client.ts` — test-only `PgliteClient implements PgClient` over `@electric-sql/pglite`.
- `test/docstore.test.ts` — calls the shared conformance suite with a PGlite factory + env-gated real-PG factory; plus any Postgres-specific unit tests.

**Shared test support:**
- `packages/docstore/test-support/conformance.ts` (new) — exported `runDocStoreConformance(makeStore, teardown?)` + helpers, holding the assertions currently inline in `docstore-sqlite`'s test.
- `packages/docstore/package.json` — add an export/path for `test-support` if needed (it is imported only by tests).

**Modified:**
- `packages/docstore/src/types.ts` — add `close(): void | Promise<void>` to `DocStore`.
- `packages/docstore-sqlite/test/docstore.test.ts` — becomes a thin caller of the shared suite.
- `packages/cli/src/boot.ts` — `makeStore` returns `DocStore`, selects backend by connection string; `BootResult.store: DocStore`.
- `packages/cli/src/dev-options.ts` (and/or serve/binary option parsing) — accept `--database-url` + `STACKBASE_DATABASE_URL`.
- `packages/cli/src/*` shutdown path — `await store.close()`.
- `packages/cli/test/postgres-e2e.test.ts` (new) — Docker/Postgres ship-gate E2E.
- `docs/enduser/self-hosting.md`, `CLAUDE.md` — docs + status.

---

## Task 1: Package scaffold, `PgClient` seam, schema, `setupSchema`, `PgliteClient`

**Files:**
- Create: `packages/docstore-postgres/package.json`, `tsconfig.json`, `tsup.config.ts`, `src/pg-client.ts`, `src/schema.ts`, `src/postgres-docstore.ts`, `src/index.ts`, `test/pglite-client.ts`, `test/setup-schema.test.ts`
- Reference: `packages/docstore-sqlite/{package.json,tsconfig.json,tsup.config.ts}`, `packages/docstore-sqlite/src/sqlite-docstore.ts:33-90`

**Interfaces:**
- Consumes: `DocStore`, `SchemaSetupOptions` from `@stackbase/docstore`.
- Produces:
  - `PgValue = null | number | bigint | string | Uint8Array | boolean`
  - `PgRow = Record<string, PgValue>`
  - `interface PgQuerier { query(text: string, params?: readonly PgValue[]): Promise<PgRow[]> }`
  - `interface PgClient extends PgQuerier { transaction<T>(fn: (tx: PgQuerier) => Promise<T>): Promise<T>; acquireWriterLock(): Promise<void>; close(): Promise<void> }`
  - `const ADVISORY_LOCK_KEY = 0x5354424153454e31n` (a fixed bigint; "STBASEN1")
  - `class PostgresDocStore implements DocStore` (constructed as `new PostgresDocStore(client: PgClient)`), with `setupSchema` implemented; other methods added in later tasks.
  - `class PgliteClient implements PgClient` (test-only), constructed `new PgliteClient()` (in-memory).

- [ ] **Step 1: Scaffold the package.** Create `packages/docstore-postgres/package.json`:

```json
{
  "name": "@stackbase/docstore-postgres",
  "version": "0.0.0",
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": { ".": { "types": "./dist/index.d.ts", "import": "./dist/index.js" } },
  "scripts": {
    "build": "tsup",
    "test": "vitest run",
    "typecheck": "tsc --noEmit",
    "clean": "rm -rf dist .turbo"
  },
  "dependencies": {
    "pg": "^8.13.1",
    "@stackbase/docstore": "workspace:*",
    "@stackbase/values": "workspace:*",
    "@stackbase/id-codec": "workspace:*",
    "@stackbase/index-key-codec": "workspace:*"
  },
  "devDependencies": {
    "@electric-sql/pglite": "^0.2.17",
    "@types/pg": "^8.11.10",
    "tsup": "^8.0.0",
    "typescript": "^5.5.0",
    "vitest": "^2.0.0"
  }
}
```

Copy `tsconfig.json` and `tsup.config.ts` verbatim from `packages/docstore-sqlite`. Then run `bun install` from the repo root.

- [ ] **Step 2: Write the seam.** `packages/docstore-postgres/src/pg-client.ts`:

```ts
/**
 * The narrow async SQL seam the Postgres DocStore sits on — the analogue of docstore-sqlite's
 * synchronous DatabaseAdapter. A PgClient is the ONLY thing that knows a concrete Postgres driver
 * (pg, Bun.SQL, PGlite). Its normalization contract is load-bearing: `query` returns int8 columns
 * as JS bigint and bytea columns as Uint8Array, and accepts bytea params as Uint8Array. Each impl
 * converts to/from its driver's native types so PostgresDocStore only sees bigint/Uint8Array.
 */
export type PgValue = null | number | bigint | string | Uint8Array | boolean;
export type PgRow = Record<string, PgValue>;

export interface PgQuerier {
  /** Run a parameterized query ($1,$2,…); returns normalized rows. */
  query(text: string, params?: readonly PgValue[]): Promise<PgRow[]>;
}

export interface PgClient extends PgQuerier {
  /** Run `fn` in one BEGIN/COMMIT (ROLLBACK on throw); `tx` is pinned to a single connection. */
  transaction<T>(fn: (tx: PgQuerier) => Promise<T>): Promise<T>;
  /** Take the process-lifetime single-writer advisory lock; throw if already held elsewhere. */
  acquireWriterLock(): Promise<void>;
  close(): Promise<void>;
}

/** Fixed application key for pg_advisory_lock (single-writer guard). */
export const ADVISORY_LOCK_KEY = 0x5354424153454e31n;
```

- [ ] **Step 3: Write the schema DDL.** `packages/docstore-postgres/src/schema.ts` — the Postgres translation of `sqlite-docstore.ts:33-58` (TEXT value, BYTEA keys/ids, BIGINT ts, BOOLEAN deleted). **Export it as an array of single statements**, run one-per-`query()` by `setupSchema` — this sidesteps spec §9 trap #2 (PGlite's `query()` accepts only ONE statement; `pg` tolerates many — a per-statement loop is portable across both, and each `IF NOT EXISTS` statement is independently idempotent):

```ts
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
];
```

- [ ] **Step 4: Write the DocStore skeleton with `setupSchema`.** `packages/docstore-postgres/src/postgres-docstore.ts`:

```ts
import type {
  ConflictStrategy, DocStore, DocumentLogEntry, DocumentValue, IndexWrite, Interval,
  LatestDocument, Order, PrevRevQuery, ResolvedDocument, SchemaSetupOptions, ShardId,
  TimestampRange, InternalDocumentId,
} from "@stackbase/docstore";
import { getPrevRevQueryKey } from "@stackbase/docstore";
import { encodeStorageTableId, decodeStorageTableId } from "@stackbase/id-codec";
import { convexToJson, jsonToConvex, type JSONValue, type Value } from "@stackbase/values";
import type { PgClient, PgQuerier, PgRow, PgValue } from "./pg-client";
import { ADVISORY_LOCK_KEY } from "./pg-client";
import { SCHEMA_STATEMENTS } from "./schema";

function asBigInt(v: PgValue | undefined): bigint {
  return typeof v === "bigint" ? v : BigInt(v as number | string);
}
function asBigIntOrNull(v: PgValue | undefined): bigint | null {
  return v === null || v === undefined ? null : asBigInt(v);
}

export class PostgresDocStore implements DocStore {
  constructor(private readonly db: PgClient) {}

  private serializeValue(value: DocumentValue): string {
    return JSON.stringify(convexToJson(value as Value));
  }
  private parseValue(text: string): DocumentValue {
    return jsonToConvex(JSON.parse(text) as JSONValue) as DocumentValue;
  }

  async setupSchema(_options?: SchemaSetupOptions): Promise<void> {
    // One idempotent statement per query() — portable across single-statement (PGlite) and
    // multi-statement (pg) drivers. Engine-authored text, no interpolation.
    for (const stmt of SCHEMA_STATEMENTS) await this.db.query(stmt);
  }

  async close(): Promise<void> {
    await this.db.close();
  }
}
```

(Leave the other `DocStore` methods for later tasks. TypeScript will error that the class does not fully implement `DocStore` — that is expected until Task 5; to keep the package compiling in the meantime, add temporary `// @ts-expect-error incomplete until Task N` stubs is NOT allowed; instead implement each remaining method as `throw new Error("not implemented")` with the correct signature so the class satisfies the interface. List those stubs explicitly:)

```ts
  async write(): Promise<void> { throw new Error("not implemented"); }
  async get(): Promise<LatestDocument | null> { throw new Error("not implemented"); }
  async *index_scan(): AsyncGenerator<readonly [Uint8Array, LatestDocument]> { throw new Error("not implemented"); }
  async *load_documents(): AsyncGenerator<DocumentLogEntry> { throw new Error("not implemented"); }
  async previous_revisions(): Promise<Map<string, DocumentLogEntry>> { throw new Error("not implemented"); }
  async scan(): Promise<LatestDocument[]> { throw new Error("not implemented"); }
  async count(): Promise<number> { throw new Error("not implemented"); }
  async maxTimestamp(): Promise<bigint> { throw new Error("not implemented"); }
  async getGlobal(): Promise<JSONValue | null> { throw new Error("not implemented"); }
  async writeGlobal(): Promise<void> { throw new Error("not implemented"); }
  async writeGlobalIfAbsent(): Promise<boolean> { throw new Error("not implemented"); }
```

(Each later task replaces the matching stub with its real signature + body. Keep the imports even if unused now; typecheck of unused imports is off in this repo — verify.)

- [ ] **Step 5: Write `index.ts`.**

```ts
/** `@stackbase/docstore-postgres` — the MVCC DocStore over Postgres, plus the pg-based client. */
export type { PgClient, PgQuerier, PgRow, PgValue } from "./pg-client";
export { ADVISORY_LOCK_KEY } from "./pg-client";
export { NodePgClient } from "./node-pg-client";
export { PostgresDocStore } from "./postgres-docstore";
```

(`NodePgClient` does not exist yet — create a minimal placeholder `src/node-pg-client.ts` exporting an empty `export class NodePgClient {}` to keep the barrel compiling; Task 2 fills it in. If you prefer, omit the `NodePgClient` export line until Task 2 and add it then.)

- [ ] **Step 6: Write the test-only `PgliteClient`.** `packages/docstore-postgres/test/pglite-client.ts`:

```ts
import { PGlite } from "@electric-sql/pglite";
import type { PgClient, PgQuerier, PgRow, PgValue } from "../src/pg-client";
import { ADVISORY_LOCK_KEY } from "../src/pg-client";

/**
 * Test-only PgClient over PGlite (real Postgres in WASM, in-process, single connection).
 * PGlite already uses Uint8Array for bytea both ways; it returns int8 as string by default, so we
 * parse int8 → bigint here (verify empirically — this is the documented BYTEA/int8 trap). Because
 * PGlite is a single in-process connection, `transaction` runs BEGIN/COMMIT on the same handle and
 * `acquireWriterLock` is a no-op that always succeeds (contention is unobservable with one connection;
 * the real guard is exercised against real Postgres in Task 6 / the Docker E2E).
 */
export class PgliteClient implements PgClient {
  private readonly pg = new PGlite();

  private normalizeRow(row: Record<string, unknown>): PgRow {
    const out: PgRow = {};
    for (const [k, v] of Object.entries(row)) {
      // PGlite returns int8 as string; parse to bigint. bytea is already Uint8Array. Others pass through.
      out[k] = typeof v === "string" && /^-?\d+$/.test(v) && k.endsWith("ts") ? BigInt(v) : (v as PgValue);
    }
    return out;
  }

  async query(text: string, params?: readonly PgValue[]): Promise<PgRow[]> {
    const res = await this.pg.query(text, params as unknown[] | undefined);
    return (res.rows as Record<string, unknown>[]).map((r) => this.normalizeRow(r));
  }

  async transaction<T>(fn: (tx: PgQuerier) => Promise<T>): Promise<T> {
    await this.pg.query("BEGIN");
    try {
      const result = await fn(this);
      await this.pg.query("COMMIT");
      return result;
    } catch (e) {
      await this.pg.query("ROLLBACK");
      throw e;
    }
  }

  async acquireWriterLock(): Promise<void> {
    // Single in-process connection: contention is unobservable. No-op. (Real guard: Task 6 + E2E.)
    void ADVISORY_LOCK_KEY;
  }

  async close(): Promise<void> {
    await this.pg.close();
  }
}
```

> Implementer note: the `k.endsWith("ts")` heuristic for int8→bigint is fragile. Prefer PGlite's typed parsers if available (`new PGlite({ parsers: { 20: (v) => BigInt(v) } })` — OID 20 is int8), and drop the heuristic. Verify empirically what PGlite returns for `BIGINT` and `BYTEA` columns with a scratch query before committing, and use the robust mechanism. The conformance suite (Task 5) is the backstop.

- [ ] **Step 7: Write the failing test.** `packages/docstore-postgres/test/setup-schema.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { PostgresDocStore } from "../src/postgres-docstore";
import { PgliteClient } from "./pglite-client";

describe("setupSchema", () => {
  it("creates the three physical tables idempotently", async () => {
    const client = new PgliteClient();
    const store = new PostgresDocStore(client);
    await store.setupSchema();
    await store.setupSchema(); // idempotent — second call must not throw

    const rows = await client.query(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name`,
    );
    const names = rows.map((r) => r.table_name);
    expect(names).toContain("documents");
    expect(names).toContain("indexes");
    expect(names).toContain("persistence_globals");
    await store.close();
  });
});
```

- [ ] **Step 8: Run it — expect FAIL** (module/impl not present or throws): `bun run --filter @stackbase/docstore-postgres test setup-schema` → FAIL.
- [ ] **Step 9: Implement** — Steps 2-6 above provide the code; ensure it compiles and the test passes.
- [ ] **Step 10: Run — expect PASS**, then `bun run --filter @stackbase/docstore-postgres typecheck` (grep: zero `error TS`).
- [ ] **Step 11: Commit.**

```bash
git add packages/docstore-postgres bun.lock package.json
git commit -m "feat(docstore-postgres): package scaffold, PgClient seam, schema + setupSchema

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: `NodePgClient` (the `pg` driver + type marshaling) + `write` + `get`

**Files:**
- Create/replace: `packages/docstore-postgres/src/node-pg-client.ts`
- Modify: `packages/docstore-postgres/src/postgres-docstore.ts` (replace the `write`/`get` stubs)
- Test: `packages/docstore-postgres/test/write-get.test.ts`

**Interfaces:**
- Consumes: `PgClient`/`PgQuerier`/`PgValue` (Task 1), `DocumentLogEntry`/`ConflictStrategy`/`LatestDocument`/`InternalDocumentId` from `@stackbase/docstore`, `encodeStorageTableId` from `@stackbase/id-codec`.
- Produces:
  - `class NodePgClient implements PgClient`, constructed `new NodePgClient(opts: { connectionString: string })`. Marshals: on the way IN, any `Uint8Array` param → `Buffer.from(u8)` (pg wants Buffer for bytea); on the way OUT, `int8` (OID 20) → `bigint` and `bytea` (OID 17) → `Uint8Array`. Uses a single pooled/pinned connection appropriate for a single-writer engine.
  - `PostgresDocStore.write(documents, indexUpdates, conflictStrategy, shardId?)` and `.get(id, readTimestamp?)` fully implemented.

- [ ] **Step 1: Write the failing test.** `packages/docstore-postgres/test/write-get.test.ts` (uses PGlite so it runs hermetically under Node):

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { PostgresDocStore } from "../src/postgres-docstore";
import { PgliteClient } from "./pglite-client";
import { newDocumentId, encodeStorageTableId } from "@stackbase/id-codec";
import type { DocumentLogEntry, InternalDocumentId } from "@stackbase/docstore";

const TABLE = 10001;
let store: PostgresDocStore;
beforeEach(async () => {
  store = new PostgresDocStore(new PgliteClient());
  await store.setupSchema();
});
function rev(id: InternalDocumentId, ts: bigint, prevTs: bigint | null, body: string | null): DocumentLogEntry {
  return { ts, id, prev_ts: prevTs, value: body === null ? null : { id, value: { body, n: ts } } };
}

describe("write + get (MVCC point read)", () => {
  it("reads the newest revision visible at a read timestamp and round-trips bigint", async () => {
    const id = newDocumentId(TABLE);
    await store.write([rev(id, 1n, null, "v1")], [], "Error");
    await store.write([rev(id, 2n, 1n, "v2")], [], "Error");

    expect(await store.get(id, 0n)).toBeNull();
    expect((await store.get(id, 1n))!.value.value.body).toBe("v1");
    const latest = (await store.get(id))!;
    expect(latest.value.value.body).toBe("v2");
    expect(latest.ts).toBe(2n);           // bigint, not number/string
    expect(latest.prev_ts).toBe(1n);
    expect((latest.value.value as { n: bigint }).n).toBe(2n); // value fidelity: bigint preserved
  });

  it("hides a tombstoned document but preserves history", async () => {
    const id = newDocumentId(TABLE);
    await store.write([rev(id, 1n, null, "v1")], [], "Error");
    await store.write([rev(id, 2n, 1n, null)], [], "Error"); // tombstone
    expect(await store.get(id)).toBeNull();
    expect((await store.get(id, 1n))!.value.value.body).toBe("v1");
  });

  it("Overwrite replaces a revision at the same ts; Error would collide", async () => {
    const id = newDocumentId(TABLE);
    await store.write([rev(id, 1n, null, "a")], [], "Error");
    await store.write([rev(id, 1n, null, "b")], [], "Overwrite"); // same (table,id,ts) → replace
    expect((await store.get(id, 1n))!.value.value.body).toBe("b");
  });
});
```

- [ ] **Step 2: Run — expect FAIL** (`write`/`get` throw "not implemented"): `bun run --filter @stackbase/docstore-postgres test write-get` → FAIL.

- [ ] **Step 3: Implement `NodePgClient`.** `packages/docstore-postgres/src/node-pg-client.ts`:

```ts
import pg from "pg";
import type { PgClient, PgQuerier, PgRow, PgValue } from "./pg-client";
import { ADVISORY_LOCK_KEY } from "./pg-client";

const { Client, types } = pg;

// int8 (OID 20) → bigint (pg defaults to string). Set on a per-client type map, not globally.
const INT8_OID = 20;

function toDriverParams(params?: readonly PgValue[]): unknown[] | undefined {
  if (!params) return undefined;
  // pg wants a Buffer for bytea; convert Uint8Array → Buffer. bigint is serialized fine by pg as text.
  return params.map((p) => (p instanceof Uint8Array ? Buffer.from(p) : p));
}
function normalizeValue(v: unknown): PgValue {
  if (v === null || v === undefined) return null;
  if (Buffer.isBuffer(v)) return new Uint8Array(v); // bytea → Uint8Array
  return v as PgValue; // int8 handled by the type parser below → bigint
}
function normalizeRows(rows: Record<string, unknown>[]): PgRow[] {
  return rows.map((r) => {
    const out: PgRow = {};
    for (const [k, val] of Object.entries(r)) out[k] = normalizeValue(val);
    return out;
  });
}

export class NodePgClient implements PgClient {
  private readonly client: pg.Client;
  private connected = false;

  constructor(opts: { connectionString: string }) {
    this.client = new Client({
      connectionString: opts.connectionString,
      // Per-client type map: int8 (OID 20) → bigint; every other OID keeps pg's default parser.
      types: {
        getTypeParser: ((oid: number, format: unknown) =>
          oid === INT8_OID ? (val: string) => BigInt(val) : (types.getTypeParser as any)(oid, format)) as any,
      } as any,
    });
  }

  private async ensure(): Promise<void> {
    if (!this.connected) { await this.client.connect(); this.connected = true; }
  }

  async query(text: string, params?: readonly PgValue[]): Promise<PgRow[]> {
    await this.ensure();
    const res = await this.client.query(text, toDriverParams(params));
    return normalizeRows(res.rows as Record<string, unknown>[]);
  }

  async transaction<T>(fn: (tx: PgQuerier) => Promise<T>): Promise<T> {
    await this.ensure();
    await this.client.query("BEGIN");
    try {
      const result = await fn(this); // single-writer: reuse the one pinned connection
      await this.client.query("COMMIT");
      return result;
    } catch (e) {
      await this.client.query("ROLLBACK");
      throw e;
    }
  }

  async acquireWriterLock(): Promise<void> {
    await this.ensure();
    // session-level, non-blocking: fail fast if another engine holds it.
    const rows = await this.query(`SELECT pg_try_advisory_lock($1) AS ok`, [ADVISORY_LOCK_KEY]);
    if (rows[0]?.ok !== true) {
      throw new Error("another Stackbase engine is already connected to this database (advisory lock held)");
    }
  }

  async close(): Promise<void> {
    if (this.connected) { await this.client.end(); this.connected = false; }
  }
}
```

> Implementer note: the `types.getTypeParser` override wiring above is sketched — verify the exact `pg` API for a per-`Client` type parser (some versions accept a `types` object with `getTypeParser(oid, format)`; if per-client wiring is unreliable, fall back to `pg.types.setTypeParser(20, BigInt)` once at module load, documenting the global mutation). What matters: `int8` comes back as `bigint`, `bytea` as `Uint8Array`, verified by the Task 2 tests. Also confirm `pg_try_advisory_lock` returns a JS boolean `true` after normalization (bool OID passes through `normalizeValue` unchanged).

- [ ] **Step 4: Implement `write` + `get`** in `postgres-docstore.ts` (replace the stubs). Note the **in-batch dedup** (last-wins) that reproduces SQLite `INSERT OR REPLACE` and avoids Postgres's "ON CONFLICT cannot affect row twice" error, and the **multi-row `VALUES`** (one round trip, no array-type coercion):

```ts
  async write(
    documents: readonly DocumentLogEntry[],
    indexUpdates: readonly IndexWrite[],
    conflictStrategy: ConflictStrategy,
    _shardId?: ShardId,
  ): Promise<void> {
    // Dedup last-wins to mirror SQLite INSERT OR REPLACE and avoid ON CONFLICT double-affect.
    const docByKey = new Map<string, DocumentLogEntry>();
    for (const e of documents) {
      docByKey.set(`${encodeStorageTableId(e.id.tableNumber)}|${Buffer.from(e.id.internalId).toString("hex")}|${e.ts}`, e);
    }
    const idxByKey = new Map<string, IndexWrite>();
    for (const w of indexUpdates) {
      idxByKey.set(`${w.update.indexId}|${Buffer.from(w.update.key).toString("hex")}|${w.ts}`, w);
    }

    await this.db.transaction(async (tx) => {
      const docs = [...docByKey.values()];
      if (docs.length > 0) {
        const cols = 5;
        const rowsSql = docs.map((_, i) => `($${i * cols + 1},$${i * cols + 2},$${i * cols + 3},$${i * cols + 4},$${i * cols + 5})`).join(",");
        const params: PgValue[] = [];
        for (const e of docs) {
          params.push(
            encodeStorageTableId(e.id.tableNumber),
            e.id.internalId,
            e.ts,
            e.prev_ts,
            e.value === null ? null : this.serializeValue(e.value.value),
          );
        }
        const conflict =
          conflictStrategy === "Overwrite"
            ? ` ON CONFLICT (table_id, internal_id, ts) DO UPDATE SET prev_ts = EXCLUDED.prev_ts, value = EXCLUDED.value`
            : ``; // "Error": plain INSERT — a PK collision raises, matching the strategy.
        await tx.query(
          `INSERT INTO documents (table_id, internal_id, ts, prev_ts, value) VALUES ${rowsSql}${conflict}`,
          params,
        );
      }

      const idxs = [...idxByKey.values()];
      if (idxs.length > 0) {
        const cols = 6;
        const rowsSql = idxs.map((_, i) => `($${i * cols + 1},$${i * cols + 2},$${i * cols + 3},$${i * cols + 4},$${i * cols + 5},$${i * cols + 6})`).join(",");
        const params: PgValue[] = [];
        for (const { ts, update } of idxs) {
          const v = update.value;
          params.push(
            update.indexId,
            update.key,
            ts,
            v.type === "NonClustered" ? encodeStorageTableId(v.docId.tableNumber) : null,
            v.type === "NonClustered" ? v.docId.internalId : null,
            v.type !== "NonClustered", // deleted = true for a "Deleted" entry
          );
        }
        await tx.query(
          `INSERT INTO indexes (index_id, key, ts, table_id, internal_id, deleted) VALUES ${rowsSql}` +
            ` ON CONFLICT (index_id, key, ts) DO UPDATE SET table_id = EXCLUDED.table_id, internal_id = EXCLUDED.internal_id, deleted = EXCLUDED.deleted`,
          params,
        );
      }
    });
  }

  async get(id: InternalDocumentId, readTimestamp?: bigint): Promise<LatestDocument | null> {
    const tableId = encodeStorageTableId(id.tableNumber);
    const rows =
      readTimestamp === undefined
        ? await this.db.query(
            `SELECT ts, prev_ts, value FROM documents WHERE table_id = $1 AND internal_id = $2 ORDER BY ts DESC LIMIT 1`,
            [tableId, id.internalId],
          )
        : await this.db.query(
            `SELECT ts, prev_ts, value FROM documents WHERE table_id = $1 AND internal_id = $2 AND ts <= $3 ORDER BY ts DESC LIMIT 1`,
            [tableId, id.internalId, readTimestamp],
          );
    const row = rows[0];
    if (!row || row.value === null) return null; // missing or tombstone
    return {
      ts: asBigInt(row.ts),
      prev_ts: asBigIntOrNull(row.prev_ts),
      value: { id, value: this.parseValue(row.value as string) },
    };
  }
```

- [ ] **Step 5: Run — expect PASS**: `bun run --filter @stackbase/docstore-postgres test write-get` → 3 passing.
- [ ] **Step 6: Typecheck** — `bun run --filter @stackbase/docstore-postgres typecheck` → zero `error TS`.
- [ ] **Step 7: Commit.**

```bash
git add packages/docstore-postgres
git commit -m "feat(docstore-postgres): NodePgClient (pg) + write/get with bytea/int8 marshaling

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: `scan` + `count` + `maxTimestamp` + globals

**Files:**
- Modify: `packages/docstore-postgres/src/postgres-docstore.ts` (replace `scan`/`count`/`maxTimestamp`/`getGlobal`/`writeGlobal`/`writeGlobalIfAbsent` stubs)
- Test: `packages/docstore-postgres/test/scan-globals.test.ts`

**Interfaces:**
- Consumes: `decodeStorageTableId` from `@stackbase/id-codec`, `encodeStorageTableId`, `JSONValue`.
- Produces: the six methods implemented, set-based (single round trip each).

- [ ] **Step 1: Write the failing test.** `packages/docstore-postgres/test/scan-globals.test.ts`:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { PostgresDocStore } from "../src/postgres-docstore";
import { PgliteClient } from "./pglite-client";
import { newDocumentId, encodeStorageTableId } from "@stackbase/id-codec";
import type { DocumentLogEntry, InternalDocumentId } from "@stackbase/docstore";

const TABLE = 10001;
const TABLE_ID = encodeStorageTableId(TABLE);
let store: PostgresDocStore;
beforeEach(async () => { store = new PostgresDocStore(new PgliteClient()); await store.setupSchema(); });
function rev(id: InternalDocumentId, ts: bigint, prevTs: bigint | null, body: string | null): DocumentLogEntry {
  return { ts, id, prev_ts: prevTs, value: body === null ? null : { id, value: { body, n: ts } } };
}

describe("scan / count / maxTimestamp / globals", () => {
  it("scan returns newest live rows only, tombstones excluded, ordered by internal_id", async () => {
    const a = newDocumentId(TABLE), b = newDocumentId(TABLE);
    await store.write([rev(a, 1n, null, "a1")], [], "Error");
    await store.write([rev(b, 2n, null, "b1")], [], "Error");
    await store.write([rev(a, 3n, 1n, null)], [], "Error"); // delete a
    const live = await store.scan(TABLE_ID);
    expect(live.map((d) => d.value.value.body)).toEqual(["b1"]);
    expect(await store.count(TABLE_ID)).toBe(1);
    // snapshot read before the delete still sees both
    expect((await store.scan(TABLE_ID, 2n)).length).toBe(2);
  });

  it("maxTimestamp is the highest committed ts, 0 when empty", async () => {
    expect(await store.maxTimestamp()).toBe(0n);
    const id = newDocumentId(TABLE);
    await store.write([rev(id, 7n, null, "x")], [], "Error");
    expect(await store.maxTimestamp()).toBe(7n);
  });

  it("globals: write/read/if-absent", async () => {
    expect(await store.getGlobal("k")).toBeNull();
    await store.writeGlobal("k", { a: 1 });
    expect(await store.getGlobal("k")).toEqual({ a: 1 });
    expect(await store.writeGlobalIfAbsent("k", { a: 2 })).toBe(false); // already present
    expect(await store.writeGlobalIfAbsent("k2", { b: 3 })).toBe(true);
    expect(await store.getGlobal("k")).toEqual({ a: 1 }); // unchanged
  });
});
```

- [ ] **Step 2: Run — expect FAIL**: `bun run --filter @stackbase/docstore-postgres test scan-globals` → FAIL.

- [ ] **Step 3: Implement** (replace stubs). `scan` and `count` use `DISTINCT ON` (set-based, replacing SQLite's correlated `MAX(ts)` subquery):

```ts
  async scan(tableId: string, readTimestamp?: bigint): Promise<LatestDocument[]> {
    const tableNumber = decodeStorageTableId(tableId);
    const rows =
      readTimestamp === undefined
        ? await this.db.query(
            `SELECT internal_id, ts, prev_ts, value FROM (
               SELECT DISTINCT ON (internal_id) internal_id, ts, prev_ts, value
               FROM documents WHERE table_id = $1
               ORDER BY internal_id ASC, ts DESC
             ) latest WHERE value IS NOT NULL ORDER BY internal_id ASC`,
            [tableId],
          )
        : await this.db.query(
            `SELECT internal_id, ts, prev_ts, value FROM (
               SELECT DISTINCT ON (internal_id) internal_id, ts, prev_ts, value
               FROM documents WHERE table_id = $1 AND ts <= $2
               ORDER BY internal_id ASC, ts DESC
             ) latest WHERE value IS NOT NULL ORDER BY internal_id ASC`,
            [tableId, readTimestamp],
          );
    return rows.map((row) => {
      const id: InternalDocumentId = { tableNumber, internalId: row.internal_id as Uint8Array };
      return {
        ts: asBigInt(row.ts),
        prev_ts: asBigIntOrNull(row.prev_ts),
        value: { id, value: this.parseValue(row.value as string) },
      };
    });
  }

  async count(tableId: string): Promise<number> {
    const rows = await this.db.query(
      `SELECT COUNT(*)::bigint AS n FROM (
         SELECT DISTINCT ON (internal_id) value FROM documents WHERE table_id = $1
         ORDER BY internal_id ASC, ts DESC
       ) latest WHERE value IS NOT NULL`,
      [tableId],
    );
    return Number(rows[0]?.n ?? 0);
  }

  async maxTimestamp(): Promise<bigint> {
    const rows = await this.db.query(`SELECT MAX(ts) AS m FROM documents`);
    const m = rows[0]?.m;
    return m === null || m === undefined ? 0n : asBigInt(m);
  }

  async getGlobal(key: string): Promise<JSONValue | null> {
    const rows = await this.db.query(`SELECT value FROM persistence_globals WHERE key = $1`, [key]);
    return rows[0] ? (JSON.parse(rows[0].value as string) as JSONValue) : null;
  }

  async writeGlobal(key: string, value: JSONValue): Promise<void> {
    await this.db.query(
      `INSERT INTO persistence_globals (key, value) VALUES ($1, $2)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [key, JSON.stringify(value)],
    );
  }

  async writeGlobalIfAbsent(key: string, value: JSONValue): Promise<boolean> {
    const rows = await this.db.query(
      `INSERT INTO persistence_globals (key, value) VALUES ($1, $2)
       ON CONFLICT (key) DO NOTHING RETURNING key`,
      [key, JSON.stringify(value)],
    );
    return rows.length > 0; // a row is RETURNED only when the insert actually happened
  }
```

- [ ] **Step 4: Run — expect PASS**, then typecheck (zero `error TS`).
- [ ] **Step 5: Commit.**

```bash
git add packages/docstore-postgres
git commit -m "feat(docstore-postgres): scan/count/maxTimestamp/globals (set-based DISTINCT ON)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: `index_scan` + `load_documents` + `previous_revisions`

**Files:**
- Modify: `packages/docstore-postgres/src/postgres-docstore.ts` (replace the three stubs)
- Test: `packages/docstore-postgres/test/index-scan.test.ts`

**Interfaces:**
- Consumes: `Interval`, `Order`, `TimestampRange`, `PrevRevQuery`, `getPrevRevQueryKey`, `@stackbase/index-key-codec`'s `encodeIndexKey`.
- Produces: the three methods, each a single set-based statement. `index_scan` filters tombstones/deletions BEFORE `LIMIT`.

- [ ] **Step 1: Write the failing test.** `packages/docstore-postgres/test/index-scan.test.ts` (mirrors how `docstore-sqlite`'s test builds index writes; the critical assertions are ordering, tombstone-skip, and that `limit` counts only live rows):

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { PostgresDocStore } from "../src/postgres-docstore";
import { PgliteClient } from "./pglite-client";
import { newDocumentId, encodeStorageTableId, encodeStorageIndexId } from "@stackbase/id-codec";
import { encodeIndexKey } from "@stackbase/index-key-codec";
import type { DocumentLogEntry, IndexWrite, InternalDocumentId, Interval } from "@stackbase/docstore";

const TABLE = 10001;
const INDEX_ID = encodeStorageIndexId(TABLE, 1);
let store: PostgresDocStore;
beforeEach(async () => { store = new PostgresDocStore(new PgliteClient()); await store.setupSchema(); });

function rev(id: InternalDocumentId, ts: bigint, prevTs: bigint | null, body: string | null): DocumentLogEntry {
  return { ts, id, prev_ts: prevTs, value: body === null ? null : { id, value: { body, n: ts } } };
}
function idxPut(id: InternalDocumentId, key: Uint8Array, ts: bigint): IndexWrite {
  return { ts, update: { indexId: INDEX_ID, key, value: { type: "NonClustered", docId: id } } };
}
function idxDel(key: Uint8Array, ts: bigint): IndexWrite {
  return { ts, update: { indexId: INDEX_ID, key, value: { type: "Deleted" } } };
}
async function collect<T>(g: AsyncGenerator<T>): Promise<T[]> { const o: T[] = []; for await (const x of g) o.push(x); return o; }
const FULL: Interval = { start: new Uint8Array(), end: null };

describe("index_scan / load_documents / previous_revisions", () => {
  it("scans keys in order, resolves docs, skips deletions and doc tombstones", async () => {
    const a = newDocumentId(TABLE), b = newDocumentId(TABLE), c = newDocumentId(TABLE);
    const ka = encodeIndexKey([{ kind: "string", value: "a" }]);
    const kb = encodeIndexKey([{ kind: "string", value: "b" }]);
    const kc = encodeIndexKey([{ kind: "string", value: "c" }]);
    await store.write([rev(a, 1n, null, "A"), rev(b, 1n, null, "B"), rev(c, 1n, null, "C")],
      [idxPut(a, ka, 1n), idxPut(b, kb, 1n), idxPut(c, kc, 1n)], "Error");
    await store.write([rev(b, 2n, 1n, null)], [idxDel(kb, 2n)], "Error"); // delete b (doc + index)

    const asc = await collect(store.index_scan(INDEX_ID, "", 5n, FULL, "asc"));
    expect(asc.map(([, d]) => d.value.value.body)).toEqual(["A", "C"]); // b skipped, order preserved
    const desc = await collect(store.index_scan(INDEX_ID, "", 5n, FULL, "desc"));
    expect(desc.map(([, d]) => d.value.value.body)).toEqual(["C", "A"]);

    // snapshot before deletion sees B too
    const at1 = await collect(store.index_scan(INDEX_ID, "", 1n, FULL, "asc"));
    expect(at1.map(([, d]) => d.value.value.body)).toEqual(["A", "B", "C"]);
  });

  it("limit counts only live rows (tombstones must not shorten the page)", async () => {
    const a = newDocumentId(TABLE), b = newDocumentId(TABLE), c = newDocumentId(TABLE);
    const ka = encodeIndexKey([{ kind: "string", value: "a" }]);
    const kb = encodeIndexKey([{ kind: "string", value: "b" }]);
    const kc = encodeIndexKey([{ kind: "string", value: "c" }]);
    await store.write([rev(a, 1n, null, "A"), rev(b, 1n, null, "B"), rev(c, 1n, null, "C")],
      [idxPut(a, ka, 1n), idxPut(b, kb, 1n), idxPut(c, kc, 1n)], "Error");
    await store.write([rev(b, 2n, 1n, null)], [idxDel(kb, 2n)], "Error"); // b dead
    const page = await collect(store.index_scan(INDEX_ID, "", 5n, FULL, "asc", 2));
    expect(page.map(([, d]) => d.value.value.body)).toEqual(["A", "C"]); // 2 LIVE rows, not [A] short page
  });

  it("load_documents tails the log across a ts range", async () => {
    const a = newDocumentId(TABLE);
    await store.write([rev(a, 1n, null, "v1")], [], "Error");
    await store.write([rev(a, 2n, 1n, "v2")], [], "Error");
    const entries = await collect(store.load_documents({ minInclusive: 1n, maxExclusive: 3n }, "asc"));
    expect(entries.map((e) => e.ts)).toEqual([1n, 2n]);
  });

  it("previous_revisions resolves a batch in one call", async () => {
    const a = newDocumentId(TABLE), b = newDocumentId(TABLE);
    await store.write([rev(a, 1n, null, "A1")], [], "Error");
    await store.write([rev(a, 2n, 1n, "A2")], [], "Error");
    await store.write([rev(b, 2n, null, "B1")], [], "Error");
    const { getPrevRevQueryKey } = await import("@stackbase/docstore");
    const res = await store.previous_revisions([{ id: a, ts: 1n }, { id: b, ts: 5n }]);
    expect(res.get(getPrevRevQueryKey(a, 1n))!.value!.value.value.body).toBe("A1");
    expect(res.get(getPrevRevQueryKey(b, 5n))!.value!.value.value.body).toBe("B1");
  });
});
```

- [ ] **Step 2: Run — expect FAIL**: `bun run --filter @stackbase/docstore-postgres test index-scan` → FAIL.

- [ ] **Step 3: Implement.** `index_scan` — one statement: `DISTINCT ON (key)` picks the newest index entry per key ≤ ts, a `LATERAL` subquery resolves the newest visible document, tombstones/deletions filtered in `WHERE` **before** `LIMIT`:

```ts
  async *index_scan(
    indexId: string,
    _tableId: string,
    readTimestamp: bigint,
    interval: Interval,
    order: Order,
    limit?: number,
  ): AsyncGenerator<readonly [Uint8Array, LatestDocument]> {
    const dir = order === "desc" ? "DESC" : "ASC";
    const params: PgValue[] = [indexId, interval.start, readTimestamp];
    let endClause = "";
    if (interval.end !== null) { endClause = ` AND i.key < $4`; params.push(interval.end); }
    // DISTINCT ON (i.key) with ORDER BY i.key <dir>, i.ts DESC → newest entry per key.
    // LATERAL resolves the pointed doc's newest visible revision. Filter dead rows, THEN limit.
    let sql =
      `SELECT idx.key AS key, doc.ts AS ts, doc.prev_ts AS prev_ts, doc.value AS value,
              idx.table_id AS table_id, idx.internal_id AS internal_id
       FROM (
         SELECT DISTINCT ON (i.key) i.key, i.table_id, i.internal_id, i.deleted
         FROM indexes i
         WHERE i.index_id = $1 AND i.key >= $2 AND i.ts <= $3${endClause}
         ORDER BY i.key ${dir}, i.ts DESC
       ) idx
       LEFT JOIN LATERAL (
         SELECT d.ts, d.prev_ts, d.value FROM documents d
         WHERE d.table_id = idx.table_id AND d.internal_id = idx.internal_id AND d.ts <= $3
         ORDER BY d.ts DESC LIMIT 1
       ) doc ON TRUE
       WHERE idx.deleted = FALSE AND idx.internal_id IS NOT NULL AND doc.value IS NOT NULL
       ORDER BY idx.key ${dir}`;
    if (limit !== undefined) { sql += ` LIMIT $${params.length + 1}`; params.push(BigInt(limit)); }

    const rows = await this.db.query(sql, params);
    for (const row of rows) {
      const docId: InternalDocumentId = {
        tableNumber: decodeStorageTableId(row.table_id as string),
        internalId: row.internal_id as Uint8Array,
      };
      const doc: LatestDocument = {
        ts: asBigInt(row.ts),
        prev_ts: asBigIntOrNull(row.prev_ts),
        value: { id: docId, value: this.parseValue(row.value as string) },
      };
      yield [row.key as Uint8Array, doc] as const;
    }
  }

  async *load_documents(range: TimestampRange, order: Order): AsyncGenerator<DocumentLogEntry> {
    const dir = order === "desc" ? "DESC" : "ASC";
    const rows = await this.db.query(
      `SELECT table_id, internal_id, ts, prev_ts, value FROM documents WHERE ts >= $1 AND ts < $2
       ORDER BY ts ${dir}, table_id ${dir}, internal_id ${dir}`,
      [range.minInclusive, range.maxExclusive],
    );
    for (const row of rows) {
      const id: InternalDocumentId = {
        tableNumber: decodeStorageTableId(row.table_id as string),
        internalId: row.internal_id as Uint8Array,
      };
      const value: ResolvedDocument | null =
        row.value === null ? null : { id, value: this.parseValue(row.value as string) };
      yield { ts: asBigInt(row.ts), id, value, prev_ts: asBigIntOrNull(row.prev_ts) };
    }
  }

  async previous_revisions(queries: readonly PrevRevQuery[]): Promise<Map<string, DocumentLogEntry>> {
    const out = new Map<string, DocumentLogEntry>();
    if (queries.length === 0) return out;
    // One round trip: a VALUES list (with an ordinality tag) LATERAL-joined to the newest visible rev.
    const cols = 4;
    const valuesSql = queries
      .map((_, i) =>
        i === 0
          ? `($${i * cols + 1}::int, $${i * cols + 2}::text, $${i * cols + 3}::bytea, $${i * cols + 4}::bigint)`
          : `($${i * cols + 1}, $${i * cols + 2}, $${i * cols + 3}, $${i * cols + 4})`,
      )
      .join(",");
    const params: PgValue[] = [];
    queries.forEach((q, i) => {
      params.push(i, encodeStorageTableId(q.id.tableNumber), q.id.internalId, q.ts);
    });
    const rows = await this.db.query(
      `SELECT q.ord AS ord, d.ts AS ts, d.prev_ts AS prev_ts, d.value AS value
       FROM (VALUES ${valuesSql}) AS q(ord, table_id, internal_id, ts)
       JOIN LATERAL (
         SELECT dd.ts, dd.prev_ts, dd.value FROM documents dd
         WHERE dd.table_id = q.table_id AND dd.internal_id = q.internal_id AND dd.ts <= q.ts
         ORDER BY dd.ts DESC LIMIT 1
       ) d ON TRUE`,
      params,
    );
    for (const row of rows) {
      const q = queries[Number(row.ord)];
      const value: ResolvedDocument | null =
        row.value === null ? null : { id: q.id, value: this.parseValue(row.value as string) };
      out.set(getPrevRevQueryKey(q.id, q.ts), {
        ts: asBigInt(row.ts), id: q.id, value, prev_ts: asBigIntOrNull(row.prev_ts),
      });
    }
    return out;
  }
```

> Implementer note: verify PGlite/pg accept `LATERAL` and `DISTINCT ON` (both standard Postgres — PGlite is real Postgres, so yes). If the `$3` reuse in `index_scan` (readTimestamp used twice) trips a driver, it is standard Postgres to reuse a positional param; confirm. The `limit` param is passed as `bigint` — if a driver rejects `bigint` for `LIMIT`, pass `Number(limit)` instead (LIMIT is small).

- [ ] **Step 4: Run — expect PASS** (4 tests), then typecheck (zero `error TS`).
- [ ] **Step 5: Commit.**

```bash
git add packages/docstore-postgres
git commit -m "feat(docstore-postgres): index_scan/load_documents/previous_revisions (set-based, tombstone-before-limit)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: Shared conformance suite — extract, wire SQLite (thin caller), wire Postgres (PGlite + env-gated real PG)

**Files:**
- Create: `packages/docstore/test-support/conformance.ts`
- Modify: `packages/docstore/package.json` (expose `./test-support` if a subpath import is needed), `packages/docstore-sqlite/test/docstore.test.ts` (becomes a thin caller), `packages/docstore-postgres/test/docstore.test.ts` (new caller)
- Reference: current assertions in `packages/docstore-sqlite/test/docstore.test.ts` (all 188 lines)

**Interfaces:**
- Consumes: `DocStore` from `@stackbase/docstore`.
- Produces: `export function runDocStoreConformance(makeStore: () => Promise<DocStore>, teardown?: (store: DocStore) => Promise<void>): void` — a function that declares a `describe(...)` block of backend-agnostic assertions. Both backends' test files call it.

**Rationale:** this is the parity proof. It must contain **the same assertions SQLite already passes** (moved, not rewritten) so SQLite stays green and Postgres is held to the identical bar.

- [ ] **Step 1: Extract the suite.** Create `packages/docstore/test-support/conformance.ts`. Move the assertion bodies from `docstore-sqlite/test/docstore.test.ts` into a single exported function. Structure:

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { DocStore, DocumentLogEntry, InternalDocumentId, IndexWrite, Interval } from "../src/types";
import { getPrevRevQueryKey } from "../src/types";
import { newDocumentId, encodeStorageTableId, encodeStorageIndexId } from "@stackbase/id-codec";
import { encodeIndexKey } from "@stackbase/index-key-codec";

const TABLE = 10001;
const TABLE_ID = encodeStorageTableId(TABLE);

function rev(id: InternalDocumentId, ts: bigint, prevTs: bigint | null, body: string | null): DocumentLogEntry {
  return { ts, id, prev_ts: prevTs, value: body === null ? null : { id, value: { body, n: ts } } };
}
async function collect<T>(gen: AsyncGenerator<T>): Promise<T[]> { const o: T[] = []; for await (const x of gen) o.push(x); return o; }

/** The DocStore behavioral contract. Every backend must pass this identically. */
export function runDocStoreConformance(makeStore: () => Promise<DocStore>, teardown?: (s: DocStore) => Promise<void>): void {
  let store: DocStore;
  beforeEach(async () => { store = await makeStore(); });
  afterEach(async () => { if (teardown) await teardown(store); });

  describe("MVCC document revisions", () => {
    it("reads the newest revision visible at a read timestamp", async () => {
      // ... move the exact body from docstore-sqlite/test/docstore.test.ts ...
    });
    // ... move EVERY other `it(...)` from the SQLite test verbatim ...
  });
  // ... move all remaining describe blocks (index_scan, load_documents, previous_revisions, scan/count, globals) ...
}
```

Move **all** `it(...)` blocks from the SQLite test file into this function unchanged (they are already backend-agnostic — they use only the `DocStore` interface + codecs). Keep the helpers (`rev`, `collect`) here.

- [ ] **Step 2: Expose the subpath.** If vitest cannot resolve `@stackbase/docstore/test-support/conformance`, either (a) add to `packages/docstore/package.json` an `exports` entry `"./test-support/conformance": "./test-support/conformance.ts"`, or (b) have consumers import by relative path across packages is not allowed — prefer (a). Confirm the import resolves from both consumer packages.

- [ ] **Step 3: Rewrite the SQLite test as a thin caller.** Replace `packages/docstore-sqlite/test/docstore.test.ts` with:

```ts
import { runDocStoreConformance } from "@stackbase/docstore/test-support/conformance";
import { NodeSqliteAdapter, SqliteDocStore } from "../src/index";

runDocStoreConformance(async () => {
  const store = new SqliteDocStore(new NodeSqliteAdapter()); // in-memory
  await store.setupSchema();
  return store;
});
```

- [ ] **Step 4: Run the SQLite suite — expect PASS unchanged**: `bun run --filter @stackbase/docstore-sqlite test docstore` → all prior assertions green (proves the extraction is faithful).

- [ ] **Step 5: Add the Postgres caller.** Create `packages/docstore-postgres/test/docstore.test.ts`:

```ts
import { runDocStoreConformance } from "@stackbase/docstore/test-support/conformance";
import { PostgresDocStore } from "../src/postgres-docstore";
import { NodePgClient } from "../src/node-pg-client";
import { PgliteClient } from "./pglite-client";

// Always: hermetic PGlite (real Postgres semantics, no Docker, runs under Node).
runDocStoreConformance(
  async () => { const s = new PostgresDocStore(new PgliteClient()); await s.setupSchema(); return s; },
  async (s) => { await (s as PostgresDocStore).close(); },
);

// Additionally: a real Postgres server when STACKBASE_TEST_DATABASE_URL is set (skipped otherwise).
const REAL_PG = process.env.STACKBASE_TEST_DATABASE_URL;
if (REAL_PG) {
  runDocStoreConformance(
    async () => {
      const s = new PostgresDocStore(new NodePgClient({ connectionString: REAL_PG }));
      await s.setupSchema();
      // isolate: truncate the three tables so each test starts clean
      await (s as any).db.query("TRUNCATE documents, indexes, persistence_globals");
      return s;
    },
    async (s) => { await (s as PostgresDocStore).close(); },
  );
}
```

> Implementer note: PGlite's `new PgliteClient()` is a fresh in-memory DB per `makeStore` call, so tests are naturally isolated. For real PG, the `TRUNCATE` in the factory gives per-test isolation on one shared database; confirm the tables exist (setupSchema runs first) before TRUNCATE, or wrap in a try/catch that runs setupSchema then truncate. If the conformance suite's `beforeEach` calls `makeStore` per test, opening a fresh `NodePgClient` connection per test against real PG is acceptable for the test volume.

- [ ] **Step 6: Run the Postgres suite (PGlite path) — expect PASS**: `bun run --filter @stackbase/docstore-postgres test docstore` → the full conformance suite green against PGlite. This is the parity proof.

- [ ] **Step 7: Typecheck both packages** — zero `error TS`.

- [ ] **Step 8: Commit.**

```bash
git add packages/docstore/test-support packages/docstore/package.json packages/docstore-sqlite/test/docstore.test.ts packages/docstore-postgres/test/docstore.test.ts
git commit -m "test(docstore): shared DocStore conformance suite — SQLite + Postgres(PGlite) proven identical

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: Single-writer advisory-lock guard (wired into boot)

**Files:**
- Modify: `packages/docstore-postgres/src/postgres-docstore.ts` (call `acquireWriterLock` in `setupSchema`, or add an explicit boot step — see below)
- Test: `packages/docstore-postgres/test/writer-lock.test.ts` (env-gated real PG; skipped without `STACKBASE_TEST_DATABASE_URL`)

**Interfaces:**
- Consumes: `PgClient.acquireWriterLock` (Task 1/2).
- Produces: after `setupSchema`, `PostgresDocStore` has taken the single-writer advisory lock; a second store on the same real database fails fast.

**Design decision:** call `acquireWriterLock()` at the end of `setupSchema()` (setupSchema is the single boot-time entrypoint every path calls exactly once). PGlite's `acquireWriterLock` is a no-op (single connection), so the conformance suite is unaffected; the real guard is exercised only against real Postgres.

- [ ] **Step 1: Write the failing test.** `packages/docstore-postgres/test/writer-lock.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { PostgresDocStore } from "../src/postgres-docstore";
import { NodePgClient } from "../src/node-pg-client";

const REAL_PG = process.env.STACKBASE_TEST_DATABASE_URL;
const d = REAL_PG ? describe : describe.skip;

d("single-writer advisory lock (real Postgres)", () => {
  it("a second engine on the same database fails fast", async () => {
    const a = new PostgresDocStore(new NodePgClient({ connectionString: REAL_PG! }));
    await a.setupSchema(); // takes the lock
    const b = new PostgresDocStore(new NodePgClient({ connectionString: REAL_PG! }));
    await expect(b.setupSchema()).rejects.toThrow(/already connected|advisory lock/i);
    await a.close(); // releases the session lock
    // after release, a fresh engine can acquire
    const c = new PostgresDocStore(new NodePgClient({ connectionString: REAL_PG! }));
    await c.setupSchema();
    await c.close();
  });
});
```

- [ ] **Step 2: Run — without env it SKIPS; with `STACKBASE_TEST_DATABASE_URL` set it FAILS** (lock not yet wired). Document both. If no real PG is available in the dev environment, note that this task's automated proof defers to the Docker E2E (Task 8), and implement against the described semantics.

- [ ] **Step 3: Implement** — at the end of `setupSchema`:

```ts
  async setupSchema(_options?: SchemaSetupOptions): Promise<void> {
    for (const stmt of SCHEMA_STATEMENTS) await this.db.query(stmt);
    await this.db.acquireWriterLock(); // single-writer invariant — fail fast if another engine holds it
  }
```

(`NodePgClient.acquireWriterLock` from Task 2 uses `pg_try_advisory_lock`; `PgliteClient.acquireWriterLock` is the no-op from Task 1.)

- [ ] **Step 4: Run** — with real PG: PASS; without: SKIP. Verify the PGlite conformance suite (Task 5) still passes (the no-op lock does not break it): `bun run --filter @stackbase/docstore-postgres test` → all green.
- [ ] **Step 5: Typecheck** — zero `error TS`.
- [ ] **Step 6: Commit.**

```bash
git add packages/docstore-postgres
git commit -m "feat(docstore-postgres): pg_advisory_lock single-writer guard (fail-fast on second engine)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: Wire backend selection into `makeStore` + `--database-url`/`STACKBASE_DATABASE_URL` + await close

**Files:**
- Modify: `packages/docstore/src/types.ts` (add `close` to `DocStore`), `packages/cli/src/boot.ts` (`makeStore`, `BootResult.store`), the CLI option parsing (`packages/cli/src/dev-options.ts` and/or serve/binary option resolvers), the shutdown path (`await store.close()`)
- Test: `packages/cli/test/make-store-select.test.ts`
- Add dep: `packages/cli/package.json` → `@stackbase/docstore-postgres: workspace:*`

**Interfaces:**
- Consumes: `PostgresDocStore`, `NodePgClient` from `@stackbase/docstore-postgres`; `DocStore` from `@stackbase/docstore`.
- Produces:
  - `DocStore.close(): void | Promise<void>` (interface addition).
  - `makeStore(opts: { dataPath: string; databaseUrl?: string }): DocStore` — returns `PostgresDocStore` when `databaseUrl` is a `postgres(ql)://` URL, else `SqliteDocStore`.
  - An exported pure helper `isPostgresUrl(s: string | undefined): boolean` (for unit testing selection without connecting).

- [ ] **Step 1: Add `close` to the interface.** In `packages/docstore/src/types.ts`, add to `interface DocStore`:

```ts
  /** Release the backend (checkpoint/close file, or end the Postgres connection). */
  close(): void | Promise<void>;
```

(`SqliteDocStore.close(): void` and `PostgresDocStore.close(): Promise<void>` both satisfy it.)

- [ ] **Step 2: Write the failing test.** `packages/cli/test/make-store-select.test.ts` (tests the pure selector — no real connection):

```ts
import { describe, it, expect } from "vitest";
import { isPostgresUrl } from "../src/boot";

describe("backend selection", () => {
  it("recognizes postgres connection strings", () => {
    expect(isPostgresUrl("postgres://u:p@host:5432/db")).toBe(true);
    expect(isPostgresUrl("postgresql://host/db")).toBe(true);
    expect(isPostgresUrl(undefined)).toBe(false);
    expect(isPostgresUrl("./data/db.sqlite")).toBe(false);
    expect(isPostgresUrl("")).toBe(false);
  });
});
```

- [ ] **Step 3: Run — expect FAIL** (`isPostgresUrl` not exported): `bun run --filter @stackbase/cli test make-store-select` → FAIL.

- [ ] **Step 4: Implement selection in `boot.ts`.** Add the dep (`bun add` is via editing `packages/cli/package.json` `@stackbase/docstore-postgres: workspace:*`, then `bun install`). Then:

```ts
import { NodePgClient, PostgresDocStore } from "@stackbase/docstore-postgres";
import type { DocStore } from "@stackbase/docstore";

export function isPostgresUrl(s: string | undefined): boolean {
  return !!s && /^postgres(ql)?:\/\//.test(s);
}

export function makeStore(opts: { dataPath: string; databaseUrl?: string }): DocStore {
  if (isPostgresUrl(opts.databaseUrl)) {
    return new PostgresDocStore(new NodePgClient({ connectionString: opts.databaseUrl! }));
  }
  const adapter =
    detectRuntime() === "bun" ? new BunSqliteAdapter({ path: opts.dataPath }) : new NodeSqliteAdapter({ path: opts.dataPath });
  return new SqliteDocStore(adapter);
}
```

Update `BootResult.store` type to `DocStore`. Update `makeStore`'s existing single-arg callers: `bootLoaded` now passes `{ dataPath: opts.dataPath, databaseUrl: opts.databaseUrl }` (thread a new optional `databaseUrl` through `bootLoaded`/`bootProject` from the resolved options).

- [ ] **Step 5: Thread the option.** In the CLI option resolvers (`dev-options.ts` and the serve/binary resolvers that build boot opts), read `--database-url <url>` and env `STACKBASE_DATABASE_URL` (flag wins), and pass it into the boot options → `makeStore`. SQLite stays the default when unset. Add the flag to help text where the other storage flags live.

- [ ] **Step 6: Await close on shutdown.** Find every `store.close()` call in the shutdown paths (grep `\.close()` in `packages/cli/src`) and make them `await store.close()` (the enclosing shutdown handlers are already async in `runBinaryServer`/serve/dev — verify). Since `DocStore.close` is now `void | Promise<void>`, `await` is safe for both.

- [ ] **Step 7: Run — expect PASS**: `bun run --filter @stackbase/cli test make-store-select` → PASS.
- [ ] **Step 8: Typecheck** — `bun run --filter @stackbase/cli typecheck` AND `bun run --filter @stackbase/docstore typecheck` → zero `error TS` (the `DocStore.close` addition must not break other implementers/consumers; if a mock `DocStore` in tests lacks `close`, add it).
- [ ] **Step 9: Commit.**

```bash
git add packages/docstore/src/types.ts packages/cli bun.lock
git commit -m "feat(cli): select Postgres backend via --database-url/STACKBASE_DATABASE_URL; await store.close

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 8: Docker E2E ship gate (real Postgres container through `stackbase serve`)

**Files:**
- Create: `packages/cli/test/postgres-e2e.test.ts`
- Reference: `packages/cli/test/deploy-e2e.test.ts` and `packages/cli/test/serve-e2e.test.ts` (existing server-E2E patterns — WebSocket subscription, `POST /api/run`, admin key, spawning `serve`), `docker-compose.yml` / `Dockerfile` for how the repo runs containers in tests.

**Interfaces:**
- Consumes: the real `stackbase serve` entrypoint + `makeStore`'s Postgres path (Task 7).
- Produces: end-to-end proof against a real Postgres container.

**This is the ship gate.** It proves the exact production path (`serve` under Bun → `pg` → real Postgres) that PGlite cannot.

- [ ] **Step 1: Write the E2E test.** `packages/cli/test/postgres-e2e.test.ts`. It must (mirroring `serve-e2e`/`deploy-e2e` harness for spawning `serve` and opening a WS):
  1. Start a `postgres:16` container (via `docker run -d -e POSTGRES_PASSWORD=... -p <randomport>:5432`, or Testcontainers if the repo already uses it — check; otherwise raw `docker run` with `node:child_process`, poll until `pg_isready`/a connection succeeds). Skip the whole suite (`describe.skip`) if `docker` is not available on PATH.
  2. Run `stackbase serve --database-url postgres://postgres:...@localhost:<port>/postgres` with a fixture app + `STACKBASE_ADMIN_KEY`, wait for the ready line.
  3. Open a WebSocket subscription to a query BEFORE writing.
  4. `POST /api/run` a mutation that inserts a row; assert it commits.
  5. Assert the subscription receives the reactive update (fan-out works over Postgres).
  6. `POST /api/run` the query (or read via the socket); assert the row reads back.
  7. Stop `serve`; start a SECOND `serve` on the same `--database-url`; assert it exits/refuses with the single-writer message (advisory-lock guard). Stop it.
  8. Restart `serve` against the same database; assert the row still reads back (persistence across restart).
  9. Teardown: stop `serve`, `docker rm -f` the container. Use a `finally` for cleanup.

Use a generous timeout (`{ timeout: 180_000 }`) — container pull + boot is slow. Reuse the fixture-app pattern from `deploy-e2e` (a `convex/` with a `notes` table + `notes:add`/`notes:list`).

- [ ] **Step 2: Run — expect FAIL first** if any wiring is incomplete, then green once Tasks 1-7 are integrated: `bun run --filter @stackbase/cli test postgres-e2e`. If `docker` is unavailable in the implementer's environment, the suite skips; note in the report that the gate must be run where Docker exists (the controller will run it).

- [ ] **Step 3: Typecheck** — zero `error TS`.
- [ ] **Step 4: Commit.**

```bash
git add packages/cli/test/postgres-e2e.test.ts packages/cli/test/fixtures
git commit -m "test(cli): Postgres E2E ship gate — commit/read/fan-out/persist/single-writer through real serve + container

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 9: Docs + status

**Files:**
- Modify: `docs/enduser/self-hosting.md`, `CLAUDE.md`
- Test: `packages/cli/test/docs-postgres.test.ts` (a small guard test)

- [ ] **Step 1: Write the guard test.** `packages/cli/test/docs-postgres.test.ts` — asserts `docs/enduser/self-hosting.md` documents the Postgres option accurately (contains `STACKBASE_DATABASE_URL`, `--database-url`, a `postgres://` example, and a `postgres` service in a compose snippet), resolving the path relative to `packages/cli` (mirror `docs-binary.test.ts`'s path convention):

```ts
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

describe("self-hosting docs document Postgres", () => {
  it("covers the connection-string option and compose service", () => {
    const doc = readFileSync(join(import.meta.dirname, "../../../docs/enduser/self-hosting.md"), "utf8");
    expect(doc).toContain("STACKBASE_DATABASE_URL");
    expect(doc).toMatch(/--database-url/);
    expect(doc).toMatch(/postgres:\/\//);
    expect(doc).toMatch(/single writer|single-writer/i); // the single-node constraint must be stated
  });
});
```

(Verify the relative path resolves from where vitest runs — `docs-binary.test.ts` uses `import.meta.dirname`; match it. Adjust the `../../../` depth to reach repo root from `packages/cli/test`.)

- [ ] **Step 2: Run — expect FAIL** (docs not yet written): `bun run --filter @stackbase/cli test docs-postgres` → FAIL.

- [ ] **Step 3: Write the docs.** In `docs/enduser/self-hosting.md`, add a "Using Postgres" section: how to set `--database-url postgres://user:pass@host:5432/db` or `STACKBASE_DATABASE_URL`; that SQLite is the zero-config default and Postgres is opt-in; a `docker-compose.yml` snippet adding a `postgres:16` service with a named volume and pointing `serve` at it; the **single-writer constraint** (one engine per database — a second fails fast; this is single-node durability, not clustering); that no schema migration is needed as the app evolves (the physical schema is fixed). In `CLAUDE.md`, move the Postgres adapter from "deferred"/"Honestly deferred" to shipped in the What-works narrative and build-order item 6c, briefly (pg driver, `PgClient` seam, `Bun.SQL` reserved as fast-follow, PGlite-conformance + Docker-E2E-proven, single-writer advisory lock).

- [ ] **Step 4: Run — expect PASS**, typecheck clean.
- [ ] **Step 5: Commit.**

```bash
git add docs/enduser/self-hosting.md CLAUDE.md packages/cli/test/docs-postgres.test.ts
git commit -m "docs(postgres): self-hosting Postgres guide + mark slice 6c shipped

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Final Integrated Verification (controller, after all tasks)

- [ ] `bun run build` → all packages build (grep for `Failed`).
- [ ] `bun run typecheck` → zero `error TS` across the workspace.
- [ ] `bun run test` → full suite green (the Postgres conformance runs against PGlite; the Docker E2E runs where Docker exists — run it explicitly on a Docker host).
- [ ] Grep guard: no `pg`/`pglite`/Postgres SQL imported outside `packages/docstore-postgres` (`grep -rn "from \"pg\"\|@electric-sql/pglite" packages --include=*.ts | grep -v docstore-postgres` → empty).
- [ ] With a real Postgres available, run `STACKBASE_TEST_DATABASE_URL=postgres://… bun run --filter @stackbase/docstore-postgres test` → the conformance suite + writer-lock test green against a real server.
```
