# `@stackbase/docstore-d1` (Slice-6 M2a) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A standalone `@stackbase/docstore-d1` package — a relational, column-per-field store for `.global()` tables on Cloudflare D1, with real `CREATE UNIQUE INDEX` global-unique constraints and a D1-Sessions bookmark primitive.

**Architecture:** Schema JSON → create-only DDL (`CREATE TABLE`/columns/indexes) behind a narrow async `D1Client` seam (mirrors `docstore-postgres`'s `PgClient`). A `D1DocStore` does insert/get/patch/replace/delete/queryByIndex over typed columns (nested values as JSON), mapping SQLite `UNIQUE constraint failed` to a typed `UniqueConstraintError`. Tested via a shared behavior suite on a `better-sqlite3` fast substrate AND a miniflare real-D1 serial gate.

**Tech Stack:** TypeScript (ESM), `@stackbase/values` (schema/validator JSON), `better-sqlite3` (fast test substrate, node-compatible), `miniflare` (real-D1 gate), `tsup`, `vitest`.

## Global Constraints

- **Standalone — NOT engine-wired.** M2a builds only the store; `.global()` schema-mode/routing (M2b), reactivity (M2c), fan-out (M2d), `x-d1-bookmark` end-to-end wiring, and migrations are NON-GOALS.
- **Own interface, not the MVCC-log `DocStore`.** The column-per-field model does not implement `@stackbase/docstore`'s interface.
- **Create-only DDL.** Fresh `CREATE TABLE IF NOT EXISTS` / `CREATE [UNIQUE] INDEX IF NOT EXISTS` from `schema.ts`. No `ALTER TABLE`/schema-evolution.
- **The engine never imports a D1 driver directly** — all D1 access goes through the `D1Client` seam (same discipline as `docstore-postgres`'s `PgClient`). Production = the real `env.DB` binding; tests = `better-sqlite3` / miniflare behind the seam.
- **Clean-room.** `.reference/lunora/packages/d1/` (FSL) is studied for shape only, NEVER copied.
- **Column-type mapping (exact):** `string`/`id` → `TEXT`; `number` → `REAL`; `bigint` → `TEXT` (full i64 precision, JS number can't hold it); `boolean` → `INTEGER` (0/1); `bytes` → `BLOB`; `null` → `TEXT`; `literal` → the literal's JS type; `array`/`record`/`object`/`union`/`any` → `TEXT` (JSON-encoded). Optional field → nullable column.
- Tests run under **Node/vitest** (not Bun), so the fast substrate is `better-sqlite3` (synchronous, wrapped async), NOT `bun:sqlite`. Two lanes: fast (`*.test.ts`) + serial real-D1 gate (`*-e2e.test.ts`). Run `bun run --filter @stackbase/docstore-d1 build` on every task.

---

## Canonical Interfaces (defined in Task 1, referenced throughout)

```ts
// @stackbase/values — schema.ts (Task 1 additions)
export interface IndexDefinitionJSON { indexDescriptor: string; fields: string[]; unique?: boolean; }
// TableDefinition.index gains an optional 3rd arg: index(name, fields, opts?: { unique?: boolean })

// @stackbase/docstore-d1 — src/d1-client.ts (Task 1)
export interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
  run(): Promise<{ changes: number }>;
}
export interface D1Session { client: D1Client; latestBookmark(): string | undefined; }
export interface D1Client {
  prepare(sql: string): D1PreparedStatement;
  exec(sql: string): Promise<void>;             // multi-statement DDL
  withSession(bookmark?: string): D1Session;    // D1 Sessions read-your-writes
}
export class UniqueConstraintError extends Error {
  constructor(public readonly table: string, public readonly field: string) {
    super(`unique constraint violation on ${table}.${field}`);
    this.name = "UniqueConstraintError";
  }
}

// src/ddl.ts (Task 2)
export function columnTypeFor(v: import("@stackbase/values").ValidatorJSON): string;
export function isJsonColumn(v: import("@stackbase/values").ValidatorJSON): boolean;
export function tableDdl(name: string, table: import("@stackbase/values").TableDefinitionJSON): string[];
export function schemaDdl(schema: import("@stackbase/values").SchemaDefinitionJSON): string[];

// src/codec.ts (Task 3)
export function docToRow(table: import("@stackbase/values").TableDefinitionJSON, doc: Record<string, unknown>): Record<string, unknown>;
export function rowToDoc(table: import("@stackbase/values").TableDefinitionJSON, row: Record<string, unknown>): Record<string, unknown>;

// src/d1-doc-store.ts (Task 5)
export interface QueryRange { index: string; eq?: Record<string, unknown>; limit?: number; }
export class D1DocStore {
  constructor(client: D1Client, schema: import("@stackbase/values").SchemaDefinitionJSON);
  applyDdl(): Promise<void>;
  insert(table: string, doc: Record<string, unknown>, bookmark?: string): Promise<{ bookmark?: string }>;
  get(table: string, id: string): Promise<Record<string, unknown> | null>;
  patch(table: string, id: string, partial: Record<string, unknown>, bookmark?: string): Promise<{ bookmark?: string }>;
  replace(table: string, id: string, doc: Record<string, unknown>, bookmark?: string): Promise<{ bookmark?: string }>;
  delete(table: string, id: string, bookmark?: string): Promise<{ bookmark?: string }>;
  queryByIndex(table: string, range: QueryRange): Promise<Record<string, unknown>[]>;
}
```

---

### Task 1: Scaffold `@stackbase/docstore-d1` + `D1Client` seam + `.unique()` schema addition

**Files:**
- Create: `packages/docstore-d1/{package.json,tsconfig.json,tsup.config.ts}`, `packages/docstore-d1/src/{d1-client.ts,index.ts}`
- Modify: `packages/values/src/schema.ts` (add `unique` to `IndexDefinitionJSON` + `index()` opts)
- Test: `packages/values/test/schema-unique.test.ts`, `packages/docstore-d1/test/seam.test.ts`

**Interfaces:** Produces `D1Client`/`D1PreparedStatement`/`D1Session`/`UniqueConstraintError` (Canonical); `IndexDefinitionJSON.unique`.

- [ ] **Step 1: Create `packages/docstore-d1/package.json`**

```json
{
  "name": "@stackbase/docstore-d1",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "exports": { ".": { "types": "./dist/index.d.ts", "import": "./dist/index.js" } },
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "scripts": {
    "build": "tsup",
    "test": "vitest run --exclude 'test/*-e2e.test.ts'",
    "test:e2e": "vitest run test/*-e2e.test.ts",
    "typecheck": "tsc --noEmit",
    "clean": "rm -rf dist .turbo"
  },
  "dependencies": { "@stackbase/values": "workspace:*" },
  "devDependencies": {
    "better-sqlite3": "^11.8.0",
    "@types/better-sqlite3": "^7.6.12",
    "miniflare": "^3.20241205.0",
    "@types/node": "catalog:",
    "tsup": "catalog:",
    "typescript": "catalog:",
    "vitest": "catalog:"
  }
}
```

- [ ] **Step 2: Create `tsconfig.json`** (mirror `packages/docstore-postgres/tsconfig.json`)

```json
{ "extends": "../../tsconfig.base.json", "compilerOptions": { "rootDir": ".", "outDir": "dist", "types": ["node"] }, "include": ["src", "test"] }
```

- [ ] **Step 3: Create `tsup.config.ts`**

```ts
import { defineConfig } from "tsup";
export default defineConfig({ entry: ["src/index.ts"], format: ["esm"], dts: true, sourcemap: true, clean: true, target: "es2022" });
```

- [ ] **Step 4: Write the failing schema test `packages/values/test/schema-unique.test.ts`**

```ts
import { describe, it, expect } from "vitest";
import { defineTable, v } from "../src/index";

describe("defineTable().index unique option", () => {
  it("marks an index unique in the exported JSON", () => {
    const t = defineTable({ email: v.string() }).index("by_email", ["email"], { unique: true });
    const json = t.export();
    expect(json.indexes[0]).toEqual({ indexDescriptor: "by_email", fields: ["email"], unique: true });
  });
  it("a plain index is not unique (back-compat: no `unique` key when false)", () => {
    const t = defineTable({ box: v.string() }).index("by_box", ["box"]);
    expect(t.export().indexes[0]).toEqual({ indexDescriptor: "by_box", fields: ["box"] });
  });
});
```

- [ ] **Step 5: Run it — verify it fails**

Run: `bun run --filter @stackbase/values test schema-unique`
Expected: FAIL (`index()` takes no 3rd arg; no `unique` in the JSON).

- [ ] **Step 6: Edit `packages/values/src/schema.ts`** — add `unique?` to `IndexDefinitionJSON` and the `index()` opts:

Change:
```ts
export interface IndexDefinitionJSON {
  indexDescriptor: string;
  fields: string[];
}
```
to:
```ts
export interface IndexDefinitionJSON {
  indexDescriptor: string;
  fields: string[];
  /** Column-per-field stores (D1/`.global()`) render this as `CREATE UNIQUE INDEX`. Omitted (not
   *  `false`) for a plain index, so existing exported JSON is byte-for-byte unchanged. */
  unique?: boolean;
}
```
And change `index()`:
```ts
  index(name: string, fields: Array<Extract<keyof F, string>>): this {
    this.indexes.push({ indexDescriptor: name, fields: fields as string[] });
    return this;
  }
```
to:
```ts
  index(name: string, fields: Array<Extract<keyof F, string>>, opts?: { unique?: boolean }): this {
    this.indexes.push({ indexDescriptor: name, fields: fields as string[], ...(opts?.unique ? { unique: true } : {}) });
    return this;
  }
```

- [ ] **Step 7: Run the schema test — PASS**

Run: `bun run --filter @stackbase/values test schema-unique && bun run --filter @stackbase/values build`
Expected: 2/2 PASS, build exit 0. (The spread guarantees no `unique` key for plain indexes — back-compat.)

- [ ] **Step 8: Create `packages/docstore-d1/src/d1-client.ts`** — the exact `D1Client`/`D1PreparedStatement`/`D1Session`/`UniqueConstraintError` from Canonical Interfaces.

- [ ] **Step 9: Create `packages/docstore-d1/src/index.ts`**

```ts
export type { D1Client, D1PreparedStatement, D1Session } from "./d1-client";
export { UniqueConstraintError } from "./d1-client";
```

- [ ] **Step 10: Write `packages/docstore-d1/test/seam.test.ts`** (proves the package loads + the error type)

```ts
import { describe, it, expect } from "vitest";
import { UniqueConstraintError } from "../src/index";
describe("@stackbase/docstore-d1 seam", () => {
  it("UniqueConstraintError carries table + field", () => {
    const e = new UniqueConstraintError("users", "email");
    expect(e).toBeInstanceOf(Error);
    expect(e.name).toBe("UniqueConstraintError");
    expect([e.table, e.field]).toEqual(["users", "email"]);
  });
});
```

- [ ] **Step 11: Install + run + build**

Run: `bun install && bun run --filter @stackbase/docstore-d1 test && bun run --filter @stackbase/docstore-d1 build && bun run --filter @stackbase/values build`
Expected: PASS; build exit 0. (`bun install` links the new package + `better-sqlite3`/`miniflare`.)

- [ ] **Step 12: Commit**

```bash
git add packages/docstore-d1 packages/values/src/schema.ts packages/values/test/schema-unique.test.ts bun.lock
git commit -m "feat(d1): scaffold @stackbase/docstore-d1 + D1Client seam; add IndexDefinitionJSON.unique"
```

---

### Task 2: `ddl.ts` — schema → create-only DDL

**Files:**
- Create: `packages/docstore-d1/src/ddl.ts`
- Modify: `packages/docstore-d1/src/index.ts`
- Test: `packages/docstore-d1/test/ddl.test.ts`

**Interfaces:**
- Consumes: `ValidatorJSON`/`TableDefinitionJSON`/`SchemaDefinitionJSON` from `@stackbase/values` (an object `documentType` is `{ type:"object", value: Record<string, { fieldType: ValidatorJSON; optional: boolean }> }` — read `packages/values/src/validator.ts` to confirm).
- Produces: `columnTypeFor`, `isJsonColumn`, `tableDdl`, `schemaDdl`.

- [ ] **Step 1: Write the failing test `packages/docstore-d1/test/ddl.test.ts`**

```ts
import { describe, it, expect } from "vitest";
import { defineSchema, defineTable, v } from "@stackbase/values";
import { columnTypeFor, tableDdl, schemaDdl } from "../src/ddl";

const schema = defineSchema({
  users: defineTable({ email: v.string(), age: v.number(), active: v.boolean(), tags: v.array(v.string()), bio: v.optional(v.string()) })
    .index("by_email", ["email"], { unique: true })
    .index("by_age", ["age"]),
}).export();

describe("columnTypeFor", () => {
  it("maps validator json types to sqlite column types", () => {
    expect(columnTypeFor({ type: "string" })).toBe("TEXT");
    expect(columnTypeFor({ type: "number" })).toBe("REAL");
    expect(columnTypeFor({ type: "boolean" })).toBe("INTEGER");
    expect(columnTypeFor({ type: "bigint" })).toBe("TEXT");
    expect(columnTypeFor({ type: "array", value: { type: "string" } })).toBe("TEXT"); // JSON
    expect(columnTypeFor({ type: "id", tableName: "users" })).toBe("TEXT");
  });
});

describe("tableDdl", () => {
  const stmts = tableDdl("users", schema.tables.users!);
  it("creates the table with _id PK, _creationTime, typed columns, optional→nullable", () => {
    const create = stmts.find((s) => s.startsWith("CREATE TABLE"))!;
    expect(create).toContain(`"_id" TEXT PRIMARY KEY`);
    expect(create).toContain(`"_creationTime" REAL NOT NULL`);
    expect(create).toContain(`"email" TEXT NOT NULL`);
    expect(create).toContain(`"age" REAL NOT NULL`);
    expect(create).toContain(`"active" INTEGER NOT NULL`);
    expect(create).toContain(`"tags" TEXT NOT NULL`); // array → JSON TEXT
    expect(create).toContain(`"bio" TEXT`); // optional → no NOT NULL
    expect(create).not.toContain(`"bio" TEXT NOT NULL`);
  });
  it("emits a UNIQUE index for a unique index and a plain INDEX otherwise", () => {
    expect(stmts.some((s) => /CREATE UNIQUE INDEX .* ON "users" \("email"\)/.test(s))).toBe(true);
    expect(stmts.some((s) => /CREATE INDEX .* ON "users" \("age"\)/.test(s))).toBe(true);
  });
});

describe("schemaDdl", () => {
  it("flattens all tables' DDL", () => {
    expect(schemaDdl(schema).some((s) => s.startsWith("CREATE TABLE"))).toBe(true);
  });
});
```

- [ ] **Step 2: Run it — verify it fails**

Run: `bun run --filter @stackbase/docstore-d1 test ddl`
Expected: FAIL (`../src/ddl` not found).

- [ ] **Step 3: Create `packages/docstore-d1/src/ddl.ts`**

```ts
import type { SchemaDefinitionJSON, TableDefinitionJSON, ValidatorJSON } from "@stackbase/values";

const JSON_TYPES = new Set(["array", "record", "object", "union", "any"]);

/** SQLite column type for a field validator (see the plan's Global Constraints mapping). */
export function columnTypeFor(v: ValidatorJSON): string {
  switch (v.type) {
    case "number": return "REAL";
    case "boolean": return "INTEGER";
    case "bytes": return "BLOB";
    case "literal":
      return typeof v.value === "number" ? "REAL" : typeof v.value === "boolean" ? "INTEGER" : "TEXT";
    // string, id, bigint, null → TEXT; array/record/object/union/any → JSON TEXT
    default: return "TEXT";
  }
}

export function isJsonColumn(v: ValidatorJSON): boolean {
  return JSON_TYPES.has(v.type);
}

/** Create-only DDL for one table: CREATE TABLE + CREATE [UNIQUE] INDEX (all `IF NOT EXISTS`). */
export function tableDdl(name: string, table: TableDefinitionJSON): string[] {
  const doc = table.documentType;
  if (doc.type !== "object") throw new Error(`docstore-d1: table "${name}" documentType must be an object`);
  const cols: string[] = [`"_id" TEXT PRIMARY KEY`, `"_creationTime" REAL NOT NULL`];
  for (const [field, def] of Object.entries(doc.value)) {
    cols.push(`"${field}" ${columnTypeFor(def.fieldType)}${def.optional ? "" : " NOT NULL"}`);
  }
  const stmts = [`CREATE TABLE IF NOT EXISTS "${name}" (${cols.join(", ")})`];
  for (const idx of table.indexes) {
    const cols2 = idx.fields.map((f) => `"${f}"`).join(", ");
    const prefix = idx.unique ? "uq" : "idx";
    stmts.push(
      `CREATE ${idx.unique ? "UNIQUE " : ""}INDEX IF NOT EXISTS "${prefix}_${name}_${idx.indexDescriptor}" ON "${name}" (${cols2})`,
    );
  }
  return stmts;
}

export function schemaDdl(schema: SchemaDefinitionJSON): string[] {
  return Object.entries(schema.tables).flatMap(([n, t]) => tableDdl(n, t));
}
```

- [ ] **Step 4: Export from `index.ts`** — add:

```ts
export { columnTypeFor, isJsonColumn, tableDdl, schemaDdl } from "./ddl";
```

- [ ] **Step 5: Run + build**

Run: `bun run --filter @stackbase/docstore-d1 test ddl && bun run --filter @stackbase/docstore-d1 build`
Expected: PASS, build exit 0. (If the object `documentType.value` field shape differs from `{ fieldType, optional }`, read `packages/values/src/validator.ts`'s `ObjectFieldJSON` and adjust the `Object.entries(doc.value)` destructure — but keep the DDL output identical.)

- [ ] **Step 6: Commit**

```bash
git add packages/docstore-d1/src/ddl.ts packages/docstore-d1/src/index.ts packages/docstore-d1/test/ddl.test.ts
git commit -m "feat(d1): schema→DDL — columnTypeFor + create-only CREATE TABLE/INDEX (unique-aware)"
```

---

### Task 3: `codec.ts` — doc ↔ row

**Files:**
- Create: `packages/docstore-d1/src/codec.ts`
- Modify: `packages/docstore-d1/src/index.ts`
- Test: `packages/docstore-d1/test/codec.test.ts`

**Interfaces:**
- Consumes: `isJsonColumn` (Task 2); `TableDefinitionJSON`.
- Produces: `docToRow`, `rowToDoc`.

- [ ] **Step 1: Write the failing test `packages/docstore-d1/test/codec.test.ts`**

```ts
import { describe, it, expect } from "vitest";
import { defineSchema, defineTable, v } from "@stackbase/values";
import { docToRow, rowToDoc } from "../src/codec";

const users = defineSchema({
  users: defineTable({ email: v.string(), age: v.number(), active: v.boolean(), tags: v.array(v.string()), bio: v.optional(v.string()) }),
}).export().tables.users!;

describe("docToRow / rowToDoc", () => {
  it("round-trips scalars, a boolean (0/1), a JSON array, and an absent optional", () => {
    const doc = { _id: "u1", _creationTime: 100, email: "a@b.c", age: 30, active: true, tags: ["x", "y"] };
    const row = docToRow(users, doc);
    expect(row).toMatchObject({ _id: "u1", _creationTime: 100, email: "a@b.c", age: 30, active: 1, tags: `["x","y"]`, bio: null });
    const back = rowToDoc(users, row);
    expect(back).toEqual({ _id: "u1", _creationTime: 100, email: "a@b.c", age: 30, active: true, tags: ["x", "y"] });
    expect(back).not.toHaveProperty("bio"); // absent optional stays absent
  });
  it("preserves a present optional", () => {
    const back = rowToDoc(users, docToRow(users, { _id: "u2", _creationTime: 1, email: "e", age: 1, active: false, tags: [], bio: "hi" }));
    expect(back.bio).toBe("hi");
    expect(back.active).toBe(false);
  });
});
```

- [ ] **Step 2: Run it — verify it fails**

Run: `bun run --filter @stackbase/docstore-d1 test codec`
Expected: FAIL (module not found).

- [ ] **Step 3: Create `packages/docstore-d1/src/codec.ts`**

```ts
import type { TableDefinitionJSON } from "@stackbase/values";
import { isJsonColumn } from "./ddl";

function fields(table: TableDefinitionJSON): Array<[string, { fieldType: import("@stackbase/values").ValidatorJSON; optional: boolean }]> {
  const doc = table.documentType;
  if (doc.type !== "object") throw new Error("docstore-d1: documentType must be an object");
  return Object.entries(doc.value);
}

/** App doc → a SQLite row: booleans→0/1, bigint→string, nested (array/object/…)→JSON, absent→null. */
export function docToRow(table: TableDefinitionJSON, doc: Record<string, unknown>): Record<string, unknown> {
  const row: Record<string, unknown> = { _id: doc._id, _creationTime: doc._creationTime };
  for (const [field, def] of fields(table)) {
    const val = doc[field];
    if (val === undefined || val === null) { row[field] = null; continue; }
    row[field] = isJsonColumn(def.fieldType)
      ? JSON.stringify(val)
      : def.fieldType.type === "boolean"
        ? (val ? 1 : 0)
        : def.fieldType.type === "bigint"
          ? String(val)
          : val;
  }
  return row;
}

/** SQLite row → app doc: reverse of docToRow. A null column for an OPTIONAL field is omitted. */
export function rowToDoc(table: TableDefinitionJSON, row: Record<string, unknown>): Record<string, unknown> {
  const doc: Record<string, unknown> = { _id: row._id, _creationTime: row._creationTime };
  for (const [field, def] of fields(table)) {
    const cell = row[field];
    if (cell === null || cell === undefined) continue; // absent/optional stays absent
    doc[field] = isJsonColumn(def.fieldType)
      ? JSON.parse(cell as string)
      : def.fieldType.type === "boolean"
        ? Boolean(cell)
        : def.fieldType.type === "bigint"
          ? BigInt(cell as string)
          : cell;
  }
  return doc;
}
```

- [ ] **Step 4: Export from `index.ts`** — add: `export { docToRow, rowToDoc } from "./codec";`

- [ ] **Step 5: Run + build**

Run: `bun run --filter @stackbase/docstore-d1 test codec && bun run --filter @stackbase/docstore-d1 build`
Expected: PASS, build exit 0.

- [ ] **Step 6: Commit**

```bash
git add packages/docstore-d1/src/codec.ts packages/docstore-d1/src/index.ts packages/docstore-d1/test/codec.test.ts
git commit -m "feat(d1): doc↔row codec — typed columns, JSON for nested, optional omission"
```

---

### Task 4: `sqlite-d1-client.ts` — the `better-sqlite3` test substrate

**Files:**
- Create: `packages/docstore-d1/test/support/sqlite-d1-client.ts`
- Test: `packages/docstore-d1/test/sqlite-d1-client.test.ts`

**Interfaces:**
- Consumes: `D1Client`/`D1PreparedStatement`/`D1Session` (Task 1).
- Produces: `sqliteD1Client(): D1Client` — an in-memory `better-sqlite3`-backed client (async-wrapping the sync API; `withSession` returns the same client with a no-op bookmark, since local SQLite is already read-your-writes consistent).

- [ ] **Step 1: Write the failing test `packages/docstore-d1/test/sqlite-d1-client.test.ts`**

```ts
import { describe, it, expect } from "vitest";
import { sqliteD1Client } from "./support/sqlite-d1-client";

describe("sqliteD1Client", () => {
  it("execs DDL, runs an insert, and reads it back", async () => {
    const c = sqliteD1Client();
    await c.exec(`CREATE TABLE t ("_id" TEXT PRIMARY KEY, "n" REAL)`);
    const ins = await c.prepare(`INSERT INTO t ("_id","n") VALUES (?,?)`).bind("a", 1).run();
    expect(ins.changes).toBe(1);
    const { results } = await c.prepare(`SELECT * FROM t WHERE "_id"=?`).bind("a").all();
    expect(results).toEqual([{ _id: "a", n: 1 }]);
  });
  it("surfaces the raw SQLite UNIQUE message so the store can map it", async () => {
    const c = sqliteD1Client();
    await c.exec(`CREATE TABLE t ("_id" TEXT PRIMARY KEY, "e" TEXT); CREATE UNIQUE INDEX uq ON t ("e")`);
    await c.prepare(`INSERT INTO t ("_id","e") VALUES (?,?)`).bind("a", "x").run();
    await expect(c.prepare(`INSERT INTO t ("_id","e") VALUES (?,?)`).bind("b", "x").run()).rejects.toThrow(/UNIQUE constraint failed/);
  });
  it("withSession returns a working client (bookmark is a no-op locally)", async () => {
    const c = sqliteD1Client();
    const s = c.withSession(undefined);
    await s.client.exec(`CREATE TABLE t ("_id" TEXT PRIMARY KEY)`);
    expect(s.latestBookmark()).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run it — verify it fails**

Run: `bun run --filter @stackbase/docstore-d1 test sqlite-d1-client`
Expected: FAIL (module not found).

- [ ] **Step 3: Create `packages/docstore-d1/test/support/sqlite-d1-client.ts`**

```ts
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
```

- [ ] **Step 4: Run + build**

Run: `bun run --filter @stackbase/docstore-d1 test sqlite-d1-client && bun run --filter @stackbase/docstore-d1 build`
Expected: 3/3 PASS. (If `better-sqlite3` fails to load under the test runner, confirm it installed a prebuilt binary; it's a devDep only, never shipped.)

- [ ] **Step 5: Commit**

```bash
git add packages/docstore-d1/test/support/sqlite-d1-client.ts packages/docstore-d1/test/sqlite-d1-client.test.ts
git commit -m "test(d1): better-sqlite3 D1Client substrate for the fast lane"
```

---

### Task 5: `d1-doc-store.ts` + the shared behavior suite (fast lane)

**Files:**
- Create: `packages/docstore-d1/src/d1-doc-store.ts`, `packages/docstore-d1/test/d1-behavior.ts` (shared suite), `packages/docstore-d1/test/d1-doc-store.test.ts` (runs it on the sqlite substrate)
- Modify: `packages/docstore-d1/src/index.ts`

**Interfaces:**
- Consumes: `D1Client`/`UniqueConstraintError` (T1), `schemaDdl` (T2), `docToRow`/`rowToDoc` (T3), `sqliteD1Client` (T4).
- Produces: `D1DocStore` + `QueryRange` (Canonical); `d1BehaviorSuite(makeClient)`.

- [ ] **Step 1: Write the shared behavior suite `packages/docstore-d1/test/d1-behavior.ts`** (a function taking a client factory — reused by both lanes)

```ts
import { describe, it, expect } from "vitest";
import { defineSchema, defineTable, v } from "@stackbase/values";
import { D1DocStore } from "../src/d1-doc-store";
import { UniqueConstraintError, type D1Client } from "../src/index";

const schema = defineSchema({
  users: defineTable({ email: v.string(), age: v.number(), tags: v.array(v.string()), bio: v.optional(v.string()) })
    .index("by_email", ["email"], { unique: true })
    .index("by_age", ["age"]),
}).export();

/** The shared D1 store behavior suite — run against any D1Client substrate. */
export function d1BehaviorSuite(name: string, makeClient: () => D1Client | Promise<D1Client>): void {
  describe(`D1DocStore behavior — ${name}`, () => {
    async function store(): Promise<D1DocStore> {
      const s = new D1DocStore(await makeClient(), schema);
      await s.applyDdl();
      return s;
    }

    it("insert → get round-trips (nested JSON + absent optional)", async () => {
      const s = await store();
      await s.insert("users", { _id: "u1", _creationTime: 1, email: "a@b.c", age: 30, tags: ["x"] });
      expect(await s.get("users", "u1")).toEqual({ _id: "u1", _creationTime: 1, email: "a@b.c", age: 30, tags: ["x"] });
    });

    it("a .unique() violation throws UniqueConstraintError(table, field)", async () => {
      const s = await store();
      await s.insert("users", { _id: "u1", _creationTime: 1, email: "dup@x.c", age: 1, tags: [] });
      await expect(s.insert("users", { _id: "u2", _creationTime: 2, email: "dup@x.c", age: 2, tags: [] }))
        .rejects.toMatchObject({ name: "UniqueConstraintError", table: "users", field: "email" });
    });

    it("patch merges, replace overwrites, delete removes", async () => {
      const s = await store();
      await s.insert("users", { _id: "u1", _creationTime: 1, email: "a", age: 1, tags: [] });
      await s.patch("users", "u1", { age: 2 });
      expect((await s.get("users", "u1"))!.age).toBe(2);
      await s.replace("users", "u1", { _id: "u1", _creationTime: 1, email: "b", age: 9, tags: ["z"] });
      expect(await s.get("users", "u1")).toMatchObject({ email: "b", age: 9, tags: ["z"] });
      await s.delete("users", "u1");
      expect(await s.get("users", "u1")).toBeNull();
    });

    it("queryByIndex returns matching rows", async () => {
      const s = await store();
      await s.insert("users", { _id: "u1", _creationTime: 1, email: "a", age: 20, tags: [] });
      await s.insert("users", { _id: "u2", _creationTime: 2, email: "b", age: 20, tags: [] });
      await s.insert("users", { _id: "u3", _creationTime: 3, email: "c", age: 99, tags: [] });
      const rows = await s.queryByIndex("users", { index: "by_age", eq: { age: 20 } });
      expect(rows.map((r) => r._id).sort()).toEqual(["u1", "u2"]);
    });
  });
}
```

- [ ] **Step 2: Write `packages/docstore-d1/test/d1-doc-store.test.ts`** (runs the suite on the fast substrate — this is the RED for Task 5)

```ts
import { d1BehaviorSuite } from "./d1-behavior";
import { sqliteD1Client } from "./support/sqlite-d1-client";
d1BehaviorSuite("better-sqlite3", () => sqliteD1Client());
```

- [ ] **Step 3: Run it — verify it fails**

Run: `bun run --filter @stackbase/docstore-d1 test d1-doc-store`
Expected: FAIL (`../src/d1-doc-store` not found).

- [ ] **Step 4: Create `packages/docstore-d1/src/d1-doc-store.ts`**

```ts
import type { SchemaDefinitionJSON, TableDefinitionJSON } from "@stackbase/values";
import type { D1Client } from "./d1-client";
import { UniqueConstraintError } from "./d1-client";
import { schemaDdl } from "./ddl";
import { docToRow, rowToDoc } from "./codec";

export interface QueryRange { index: string; eq?: Record<string, unknown>; limit?: number; }

const q = (id: string) => `"${id}"`;

/** Map a SQLite `UNIQUE constraint failed: <table>.<col>` error to a typed UniqueConstraintError. */
function mapError(e: unknown, table: string): never {
  const msg = e instanceof Error ? e.message : String(e);
  const m = /UNIQUE constraint failed:\s*[^.]+\.(\w+)/.exec(msg);
  if (m) throw new UniqueConstraintError(table, m[1]!);
  throw e;
}

/** A relational, column-per-field store over a D1Client (create-only DDL). Standalone — not wired
 *  into the engine (that's M2b). */
export class D1DocStore {
  constructor(private readonly client: D1Client, private readonly schema: SchemaDefinitionJSON) {}

  private table(name: string): TableDefinitionJSON {
    const t = this.schema.tables[name];
    if (!t) throw new Error(`docstore-d1: unknown table "${name}" (not in schema)`);
    return t;
  }

  async applyDdl(): Promise<void> {
    for (const stmt of schemaDdl(this.schema)) await this.client.exec(stmt);
  }

  async insert(table: string, doc: Record<string, unknown>, bookmark?: string): Promise<{ bookmark?: string }> {
    const session = this.client.withSession(bookmark);
    const row = docToRow(this.table(table), doc);
    const cols = Object.keys(row);
    const sql = `INSERT INTO ${q(table)} (${cols.map(q).join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`;
    try {
      await session.client.prepare(sql).bind(...cols.map((c) => row[c])).run();
    } catch (e) {
      mapError(e, table);
    }
    return { bookmark: session.latestBookmark() };
  }

  async get(table: string, id: string): Promise<Record<string, unknown> | null> {
    const { results } = await this.client.prepare(`SELECT * FROM ${q(table)} WHERE ${q("_id")} = ?`).bind(id).all();
    return results[0] ? rowToDoc(this.table(table), results[0] as Record<string, unknown>) : null;
  }

  async patch(table: string, id: string, partial: Record<string, unknown>, bookmark?: string): Promise<{ bookmark?: string }> {
    const current = await this.get(table, id);
    if (!current) throw new Error(`docstore-d1: patch of missing ${table}/${id}`);
    return this.replace(table, id, { ...current, ...partial, _id: id }, bookmark);
  }

  async replace(table: string, id: string, doc: Record<string, unknown>, bookmark?: string): Promise<{ bookmark?: string }> {
    const session = this.client.withSession(bookmark);
    const row = docToRow(this.table(table), { ...doc, _id: id });
    const cols = Object.keys(row).filter((c) => c !== "_id");
    const sql = `UPDATE ${q(table)} SET ${cols.map((c) => `${q(c)} = ?`).join(", ")} WHERE ${q("_id")} = ?`;
    try {
      await session.client.prepare(sql).bind(...cols.map((c) => row[c]), id).run();
    } catch (e) {
      mapError(e, table);
    }
    return { bookmark: session.latestBookmark() };
  }

  async delete(table: string, id: string, bookmark?: string): Promise<{ bookmark?: string }> {
    const session = this.client.withSession(bookmark);
    await session.client.prepare(`DELETE FROM ${q(table)} WHERE ${q("_id")} = ?`).bind(id).run();
    return { bookmark: session.latestBookmark() };
  }

  async queryByIndex(table: string, range: QueryRange): Promise<Record<string, unknown>[]> {
    const eq = range.eq ?? {};
    const keys = Object.keys(eq);
    const where = keys.length ? `WHERE ${keys.map((k) => `${q(k)} = ?`).join(" AND ")}` : "";
    const limit = range.limit ? ` LIMIT ${Number(range.limit)}` : "";
    const { results } = await this.client
      .prepare(`SELECT * FROM ${q(table)} ${where}${limit}`)
      .bind(...keys.map((k) => eq[k]))
      .all();
    return (results as Record<string, unknown>[]).map((r) => rowToDoc(this.table(table), r));
  }
}
```

- [ ] **Step 5: Export from `index.ts`** — add:

```ts
export { D1DocStore, type QueryRange } from "./d1-doc-store";
```

- [ ] **Step 6: Run + build + typecheck**

Run: `bun run --filter @stackbase/docstore-d1 test && bun run --filter @stackbase/docstore-d1 build && bun run --filter @stackbase/docstore-d1 typecheck`
Expected: all suites PASS (ddl, codec, sqlite-client, seam, + d1-doc-store behavior 4/4), build exit 0, typecheck clean.

- [ ] **Step 7: Commit**

```bash
git add packages/docstore-d1/src/d1-doc-store.ts packages/docstore-d1/src/index.ts packages/docstore-d1/test/d1-behavior.ts packages/docstore-d1/test/d1-doc-store.test.ts
git commit -m "feat(d1): D1DocStore — insert/get/patch/replace/delete/queryByIndex + UniqueConstraintError + shared behavior suite"
```

---

### Task 6: `binding-d1-client.ts` + the miniflare real-D1 ship gate (serial lane)

**Files:**
- Create: `packages/docstore-d1/src/binding-d1-client.ts`, `packages/docstore-d1/test/d1-real-e2e.test.ts`
- Modify: `packages/docstore-d1/src/index.ts`

**Interfaces:**
- Consumes: `D1Client` seam (T1), the behavior suite `d1BehaviorSuite` (T5).
- Produces: `bindingD1Client(db)` adapting a real Cloudflare D1 binding to `D1Client`, incl. `withSession(bookmark)` via the D1 Sessions API.

- [ ] **Step 1: Create `packages/docstore-d1/src/binding-d1-client.ts`** (the production adapter over the real D1 binding)

```ts
import type { D1Client, D1PreparedStatement, D1Session } from "./d1-client";

/** Minimal structural shape of the Cloudflare D1 binding we use (avoids a hard @cloudflare/workers-types
 *  dep in the engine — same discipline as the other adapters' driver seams). */
export interface D1BindingStatement { bind(...v: unknown[]): D1BindingStatement; all(): Promise<{ results: unknown[] }>; run(): Promise<{ meta: { changes: number } }>; }
export interface D1Binding {
  prepare(sql: string): D1BindingStatement;
  exec(sql: string): Promise<unknown>;
  withSession?(bookmark?: string): D1Binding & { getBookmark?(): string | null };
}

/** Adapt a real Cloudflare D1 binding (`env.DB`) to the D1Client seam. Uses D1's Sessions API for
 *  read-your-writes when the binding supports `withSession`; degrades to the plain binding otherwise. */
export function bindingD1Client(db: D1Binding): D1Client {
  const wrapStmt = (s: D1BindingStatement): D1PreparedStatement => ({
    bind: (...v: unknown[]) => wrapStmt(s.bind(...v)),
    all: async () => ({ results: (await s.all()).results as never }),
    run: async () => ({ changes: (await s.run()).meta.changes }),
  });
  const wrap = (binding: D1Binding, sessioned?: { getBookmark?(): string | null }): D1Client => ({
    prepare: (sql) => wrapStmt(binding.prepare(sql)),
    exec: async (sql) => { await binding.exec(sql); },
    withSession: (bookmark?: string): D1Session => {
      const s = binding.withSession ? binding.withSession(bookmark) : binding;
      return { client: wrap(s, s as { getBookmark?(): string | null }), latestBookmark: () => (s as { getBookmark?(): string | null }).getBookmark?.() ?? undefined };
    },
  });
  return wrap(db);
}
```

- [ ] **Step 2: Export from `index.ts`** — add:

```ts
export { bindingD1Client, type D1Binding } from "./binding-d1-client";
```

- [ ] **Step 3: Write the serial real-D1 gate `packages/docstore-d1/test/d1-real-e2e.test.ts`** — run the SAME behavior suite against miniflare's real D1

```ts
import { Miniflare } from "miniflare";
import { d1BehaviorSuite } from "./d1-behavior";
import { bindingD1Client } from "../src/index";

/** Boot a fresh miniflare D1 (workerd's real SQLite) per client. This proves the real D1 SQL dialect
 *  + Sessions bookmark path — the fidelity the better-sqlite3 fast lane can't. Serial lane. */
async function realD1Client() {
  const mf = new Miniflare({ modules: true, script: "export default {};", d1Databases: { DB: ":memory:" } });
  const db = await mf.getD1Database("DB");
  return bindingD1Client(db as never);
}

d1BehaviorSuite("miniflare real D1", () => realD1Client());
```

- [ ] **Step 4: Run the real-D1 gate**

Run: `bun run --filter @stackbase/docstore-d1 build && bun run --filter @stackbase/docstore-d1 test:e2e`
Expected: the behavior suite passes against real D1 (4/4). If miniflare's D1 API surface differs (`getD1Database`, `withSession`, `getBookmark` names), adjust `bindingD1Client`/the harness to miniflare's actual shape — but the suite assertions stay identical (that's the whole point: one suite, two substrates). If miniflare can't provide D1 in this environment, report it — do NOT weaken or fake the gate; mark it a documented real-substrate gate like the other real-container gates.

- [ ] **Step 5: Full package + monorepo check**

Run: `bun run --filter @stackbase/docstore-d1 test && bun run --filter @stackbase/docstore-d1 typecheck && bun run build`
Expected: fast lane green, typecheck clean, monorepo build green (the new package + the `@stackbase/values` change).

- [ ] **Step 6: Commit**

```bash
git add packages/docstore-d1/src/binding-d1-client.ts packages/docstore-d1/src/index.ts packages/docstore-d1/test/d1-real-e2e.test.ts
git commit -m "feat(d1): real D1 binding client + miniflare real-D1 ship gate (shared behavior suite, both substrates)"
```

---

## Self-Review

**1. Spec coverage:**
- Column-per-field DDL (CREATE TABLE + typed columns + JSON) → Task 2. ✓
- `.unique()` → CREATE UNIQUE INDEX → Task 1 (schema `unique` flag) + Task 2 (DDL). ✓
- D1Client seam (real binding + local substrate) → Task 1 (interface) + Task 4 (better-sqlite3) + Task 6 (binding). ✓
- Own store interface (insert/get/patch/replace/delete/queryByIndex + UniqueConstraintError + withSession) → Task 5. ✓
- `withSession(bookmark)` Sessions primitive → Task 1 (seam), Task 5 (threaded), Task 6 (real). ✓
- doc↔row codec (typed + JSON) → Task 3. ✓
- Behavior suite on both substrates → Task 5 (sqlite fast) + Task 6 (miniflare real). ✓
- Create-only (no ALTER/migrations); standalone (no engine wiring) → enforced by the Global Constraints + task scope. ✓

**2. Placeholder scan:** No TBD/handle-cases. Tasks 5-Step 4 and 6-Step 4 note "adjust to the actual object-field / miniflare API shape if it differs" — these are concrete verify-against-a-named-source instructions (read `validator.ts`; match miniflare's real API), not placeholders; the assertions and output are fully specified.

**3. Type consistency:** `D1Client`/`D1PreparedStatement`/`D1Session`/`UniqueConstraintError` (T1) used identically in T4/T5/T6; `columnTypeFor`/`isJsonColumn`/`schemaDdl` (T2) consumed by codec (T3) + store (T5); `docToRow`/`rowToDoc` (T3) used by the store (T5); `D1DocStore`/`QueryRange` (T5) used by the behavior suite; `IndexDefinitionJSON.unique` (T1) read by `tableDdl` (T2). Consistent.
