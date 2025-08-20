# Runtime Document Validation (D5 phase 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reject wrong-typed / extra-field / missing-required-field documents against `schema.ts` on every `insert`/`replace`, instead of silently persisting them.

**Architecture:** A new `validatorFromJson` bridge reconstructs a live `@stackbase/values` `Validator` from the `ValidatorJSON` the engine already holds; `compose.ts` builds each table's validator once and stores it on the catalog's `TableMeta`; `handleDbInsert`/`handleDbReplace` (`packages/executor/src/kernel.ts`) run `.check()` on the user value and throw `DocumentValidationError` on failure. Existing writes that violate their own schemas are audited and fixed so the suite stays green.

**Tech Stack:** TypeScript, Bun workspaces + Turborepo, vitest (under Node). Packages: `@stackbase/values`, `@stackbase/executor`, `@stackbase/component`, `@stackbase/test`, plus audit targets (`@stackbase/storage`, `components/{scheduler,workflow,authz}`, `examples/*`, `@stackbase/cli`).

## Global Constraints

- **Scope is documents only.** Do NOT add a `mutation({ args, handler })` argument-validator surface or touch codegen — that is a separate fast-follow slice.
- **Reuse `Validator.check()` — one source of validation truth.** No parallel JSON-walking validator. `validatorFromJson` reconstructs real `Validator` instances.
- **Validate the user value, not the stored doc.** Insert: the incoming value has no system fields. Replace: strip `_id` and `_creationTime` before validating (`ObjectValidator` is strict and would reject them as extra fields).
- **Honor `schemaValidation` (default `true`).** When a schema was defined with `{ schemaValidation: false }`, skip document validation for its tables. `v.any()` fields accept anything.
- **`DocumentValidationError`** (already in `@stackbase/errors`, a non-retryable `UserError`) is the only error thrown on a schema mismatch. Message: `document in "<table>" does not match schema: <path>: <message>[; ...]` (first 3 failures).
- **Every commit leaves its own package's tests green.** Enforcement (Task 3) may turn other packages' suites red; Tasks 4–5 restore full-monorepo green. Do not merge until Task 6 shows `build && typecheck && test` fully green.
- **Commit trailer:** end every commit message with `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.
- Tests run under Node/vitest (`globalThis.Bun` is undefined) — no Bun-only APIs in tests.

## File Structure

- `packages/values/src/validator-from-json.ts` — **new.** `validatorFromJson(json: ValidatorJSON): AnyValidator`. Depends on `./validator` (`v`, types) + `./json` (`jsonToConvex`, for `literal`).
- `packages/values/src/index.ts` — **modify.** Re-export `validatorFromJson`.
- `packages/executor/src/catalog.ts` — **modify.** `TableMeta` gains `documentValidator?: AnyValidator | null` + `schemaValidation?: boolean`; `addTable` accepts + stores them.
- `packages/executor/src/kernel.ts` — **modify.** A `validateDocumentForWrite` helper; call it in `handleDbInsert` and `handleDbReplace`; import `validate` + `DocumentValidationError`.
- `packages/component/src/compose.ts` — **modify.** `addSchema` passes `tableDef.documentType` + `schemaJson.schemaValidation` into `catalog.addTable`.
- Audit targets (Task 4): `packages/storage/src/*`, `components/scheduler/src/*`, `components/workflow/src/*`, `components/authz/src/*`, `examples/chat/convex/*`, `examples/auth-demo/convex/*` — schema or write fixes only where a real mismatch exists.
- `packages/test/test/conformance/validators.test.ts` — **rewrite** (Task 5): D5 "not validated" → "validated".
- `docs/enduser/testing.md` — **modify** (Task 5): flip the validation-divergence note to "enforced".
- `packages/cli/test/validation-e2e.test.ts` — **new** (Task 6).

---

### Task 1: `validatorFromJson` bridge

**Files:**
- Create: `packages/values/src/validator-from-json.ts`
- Modify: `packages/values/src/index.ts`
- Test: `packages/values/test/validator-from-json.test.ts`

**Interfaces:**
- Consumes: `ValidatorJSON`, `ObjectFieldJSON`, `AnyValidator`, `v`, `validate` (from `./validator`); `jsonToConvex` (from `./json`).
- Produces: `validatorFromJson(json: ValidatorJSON): AnyValidator`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/values/test/validator-from-json.test.ts
import { describe, it, expect } from "vitest";
import { v, validate, validatorFromJson } from "../src";

/** A rebuilt validator must accept/reject exactly what the original does. */
function agrees(orig: ReturnType<typeof v.string>, good: unknown, bad: unknown) {
  const rebuilt = validatorFromJson(orig.toJSON());
  expect(validate(rebuilt, good as never)).toEqual([]);
  expect(validate(rebuilt, bad as never).length).toBeGreaterThan(0);
}

describe("validatorFromJson", () => {
  it("round-trips scalar validators", () => {
    agrees(v.string(), "x", 1);
    agrees(v.number(), 1, "x");
    agrees(v.int64(), 1n, 1);
    agrees(v.boolean(), true, "x");
    agrees(v.null(), null, 1);
    agrees(v.id("users"), "abc", 1);
    agrees(v.literal("a"), "a", "b");
  });

  it("round-trips containers (array/record/union/object) and optional", () => {
    agrees(v.array(v.number()), [1, 2], [1, "x"]);
    agrees(v.record(v.string(), v.number()), { a: 1 }, { a: "x" });
    agrees(v.union(v.literal("a"), v.literal("b")), "b", "c");
    // object: strict — missing required and extra field both fail
    const obj = v.object({ a: v.number(), b: v.optional(v.string()) });
    const rebuilt = validatorFromJson(obj.toJSON());
    expect(validate(rebuilt, { a: 1 } as never)).toEqual([]); // b optional → omission ok
    expect(validate(rebuilt, { a: 1, b: "y" } as never)).toEqual([]);
    expect(validate(rebuilt, { a: "x" } as never).length).toBeGreaterThan(0); // wrong type
    expect(validate(rebuilt, {} as never).length).toBeGreaterThan(0); // missing required a
    expect(validate(rebuilt, { a: 1, c: 9 } as never).length).toBeGreaterThan(0); // extra field
  });

  it("round-trips nested objects", () => {
    const nested = v.object({ inner: v.object({ n: v.number() }) });
    const rebuilt = validatorFromJson(nested.toJSON());
    expect(validate(rebuilt, { inner: { n: 1 } } as never)).toEqual([]);
    expect(validate(rebuilt, { inner: { n: "x" } } as never).length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run it — expect FAIL** (`validatorFromJson` undefined)

Run: `cd packages/values && ../../node_modules/.bin/vitest run test/validator-from-json.test.ts`
Expected: FAIL — `validatorFromJson is not a function` / import error.

- [ ] **Step 3: Implement `validator-from-json.ts`**

```ts
// packages/values/src/validator-from-json.ts
import { v, type AnyValidator, type PropertyValidators, type ValidatorJSON } from "./validator";
import { jsonToConvex } from "./json";
import type { Value } from "./value";

type Literal = string | number | bigint | boolean;

/**
 * Reconstruct a live `Validator` from the `ValidatorJSON` the engine stores (schema arrives
 * as JSON, not live validators). Reuses the concrete `v.*` validators — so validation semantics
 * are identical to the `v` builder and the test harness, never a second implementation.
 */
export function validatorFromJson(json: ValidatorJSON): AnyValidator {
  switch (json.type) {
    case "null": return v.null();
    case "boolean": return v.boolean();
    case "number": return v.number();
    case "bigint": return v.int64();
    case "string": return v.string();
    case "bytes": return v.bytes();
    case "any": return v.any();
    case "id": return v.id(json.tableName);
    case "literal": return v.literal(jsonToConvex(json.value) as Literal);
    case "array": return v.array(validatorFromJson(json.value));
    case "record": return v.record(validatorFromJson(json.keys), validatorFromJson(json.values));
    case "union": return v.union(...json.value.map(validatorFromJson));
    case "object": {
      const fields: PropertyValidators = {};
      for (const [key, field] of Object.entries(json.value)) {
        const inner = validatorFromJson(field.fieldType);
        fields[key] = field.optional ? v.optional(inner) : inner;
      }
      return v.object(fields);
    }
  }
}

// Keep an explicit reference so `Value` import is used if the tsconfig is strict about unused imports.
export type { Value };
```

If the trailing `export type { Value }` trips an "unused" lint, drop it and the `Value` import — it is only there to avoid an unused-import error; remove whichever your toolchain complains about.

- [ ] **Step 4: Export it.** In `packages/values/src/index.ts`, add:

```ts
export { validatorFromJson } from "./validator-from-json";
```

- [ ] **Step 5: Run — expect PASS**

Run: `cd packages/values && ../../node_modules/.bin/vitest run test/validator-from-json.test.ts`
Expected: PASS (3 tests). Then `cd /Volumes/Projects/concave-dev && bun run build --filter @stackbase/values && bun run typecheck --filter @stackbase/values` — green.

- [ ] **Step 6: Commit**

```bash
git add packages/values && git commit -m "feat(values): validatorFromJson — reconstruct a Validator from ValidatorJSON

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Carry the document validator into the catalog

**Files:**
- Modify: `packages/executor/src/catalog.ts`
- Modify: `packages/component/src/compose.ts:43` (the `catalog.addTable(fullName, info.tableNumber)` call inside `addSchema`)
- Test: `packages/executor/test/catalog-validator.test.ts`

**Interfaces:**
- Consumes: `validatorFromJson`, `AnyValidator`, `validate`, `ValidatorJSON` (from `@stackbase/values`).
- Produces: `TableMeta.documentValidator?: AnyValidator | null`, `TableMeta.schemaValidation?: boolean`; `addTable(name, tableNumber, documentType?: ValidatorJSON, schemaValidation?: boolean)`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/executor/test/catalog-validator.test.ts
import { describe, it, expect } from "vitest";
import { SimpleIndexCatalog } from "../src/catalog";
import { v, validate } from "@stackbase/values";

describe("catalog carries the document validator", () => {
  it("builds a validator from documentType when schemaValidation is on", () => {
    const cat = new SimpleIndexCatalog();
    const docType = v.object({ n: v.number() }).toJSON();
    cat.addTable("messages", 5, docType, true);
    const meta = cat.getTable("messages")!;
    expect(meta.documentValidator).toBeTruthy();
    expect(validate(meta.documentValidator!, { n: 1 } as never)).toEqual([]);
    expect(validate(meta.documentValidator!, { n: "x" } as never).length).toBeGreaterThan(0);
  });

  it("leaves documentValidator null when schemaValidation is off", () => {
    const cat = new SimpleIndexCatalog();
    cat.addTable("messages", 5, v.object({ n: v.number() }).toJSON(), false);
    expect(cat.getTable("messages")!.documentValidator).toBeNull();
  });

  it("leaves documentValidator null when no documentType is given (back-compat)", () => {
    const cat = new SimpleIndexCatalog();
    cat.addTable("messages", 5);
    expect(cat.getTable("messages")!.documentValidator ?? null).toBeNull();
  });
});
```

- [ ] **Step 2: Run — expect FAIL** (`addTable` takes 2 args; `documentValidator` undefined)

Run: `cd packages/executor && ../../node_modules/.bin/vitest run test/catalog-validator.test.ts`
Expected: FAIL — type error / `documentValidator` is `undefined`.

- [ ] **Step 3: Modify `catalog.ts`**

Add the import + extend `TableMeta` + `addTable`:

```ts
// top of packages/executor/src/catalog.ts, with the existing imports
import { validatorFromJson, type AnyValidator, type ValidatorJSON } from "@stackbase/values";
```

```ts
export interface TableMeta {
  name: string;
  tableNumber: number;
  /** The table's document validator, built from schema.ts. Null when schemaValidation is off or
   *  the table has no object documentType. The kernel runs this on every insert/replace. */
  documentValidator?: AnyValidator | null;
  /** Whether the owning schema had schemaValidation enabled (default true). */
  schemaValidation?: boolean;
}
```

Update `addTable` (keep the 2-arg callers working via optional params):

```ts
  addTable(
    name: string,
    tableNumber: number,
    documentType?: ValidatorJSON,
    schemaValidation?: boolean,
  ): this {
    const enabled = schemaValidation !== false;
    const documentValidator =
      enabled && documentType && documentType.type === "object" ? validatorFromJson(documentType) : null;
    const meta: TableMeta = { name, tableNumber, documentValidator, schemaValidation: enabled };
    this.tables.set(name, meta);
    this.tablesByNumber.set(tableNumber, meta);
    if (!this.indexesByTable.has(name)) this.indexesByTable.set(name, []);
    return this;
  }
```

(`addIndex`'s internal `this.addTable(spec.table, spec.tableNumber)` fallback stays 2-arg — it only fires for a table not already added, which never happens for schema tables since `addSchema` adds the table first. Leave it.)

- [ ] **Step 4: Thread it through `compose.ts`.** In `packages/component/src/compose.ts`'s `addSchema`, change the `addTable` call (currently `catalog.addTable(fullName, info.tableNumber);`) to pass the document type + the schema flag:

```ts
    catalog.addTable(fullName, info.tableNumber, tableDef.documentType, schemaJson.schemaValidation);
```

(`tableDef` is the `TableDefinitionJSON` in scope; `schemaJson` is the `SchemaDefinitionJSON` param of `addSchema` and has `.schemaValidation`.)

- [ ] **Step 5: Run — expect PASS**

Run: `cd packages/executor && ../../node_modules/.bin/vitest run test/catalog-validator.test.ts`
Then: `cd /Volumes/Projects/concave-dev && bun run build --filter @stackbase/executor --filter @stackbase/component && bun run typecheck --filter @stackbase/executor --filter @stackbase/component`
Expected: PASS + green. (The full suite is NOT expected green yet — enforcement lands in Task 3.)

- [ ] **Step 6: Commit**

```bash
git add packages/executor packages/component && git commit -m "feat(executor): carry document validator + schemaValidation on TableMeta

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Enforce validation in the write path

**Files:**
- Modify: `packages/executor/src/kernel.ts` (`handleDbInsert`, `handleDbReplace`, imports, a new helper)
- Test: `packages/executor/test/write-validation.test.ts`

**Interfaces:**
- Consumes: `TableMeta` (from `./catalog`), `validate` (from `@stackbase/values`), `DocumentValidationError` (from `@stackbase/errors`).
- Produces: enforcement behavior — a schema-violating insert/replace throws `DocumentValidationError`.

**Note:** enabling enforcement here will likely turn OTHER packages' suites red (their existing writes may violate their schemas). That is expected and is fixed in Task 4. This task's green bar is `packages/executor`'s own tests.

- [ ] **Step 1: Write the failing test.** Use the executor's existing test harness for driving syscalls. Find the pattern in an existing kernel test (e.g. `packages/executor/test/*.test.ts` that builds a `SimpleIndexCatalog` + runs `handleDbInsert` via the runtime/executor). Model this test on the closest existing one; the assertions to add:

```ts
// packages/executor/test/write-validation.test.ts
// Build a runtime/executor over a schema with `docs: { n: v.number() }` (indexed by_creation),
// using the SAME setup the other executor tests use (SimpleIndexCatalog.addTable with the
// documentType from v.object({ n: v.number() }).toJSON(), schemaValidation true).
import { describe, it, expect } from "vitest";
// ...import the same harness/util the sibling executor tests use...

describe("write-path document validation", () => {
  it("rejects an insert whose value violates the schema", async () => {
    // insert { n: "not-a-number" } -> rejects with a DOCUMENT_VALIDATION error whose message
    // mentions the table + field.
    await expect(runInsert("docs", { n: "not-a-number" })).rejects.toThrow(/does not match schema/);
  });
  it("accepts a valid insert", async () => {
    await expect(runInsert("docs", { n: 1 })).resolves.toBeTruthy();
  });
  it("rejects an insert with an extra field", async () => {
    await expect(runInsert("docs", { n: 1, extra: true })).rejects.toThrow(/does not match schema/);
  });
  it("rejects a replace whose value violates the schema, but ignores system fields", async () => {
    const id = await runInsert("docs", { n: 1 });
    // replace with a doc that still carries _id/_creationTime (as from a get) + a valid n -> OK
    const cur = await runGet(id);
    await expect(runReplace(id, { ...cur, n: 2 })).resolves.toBeDefined();
    // replace with a bad n -> rejects
    await expect(runReplace(id, { ...cur, n: "x" })).rejects.toThrow(/does not match schema/);
  });
  it("does not validate when schemaValidation is off (table added with false)", async () => {
    // a table added via addTable(name, num, docType, false) accepts a wrong-typed insert
    await expect(runInsertLoose("loose", { n: "x" })).resolves.toBeTruthy();
  });
  it("accepts anything for a v.any() field", async () => {
    await expect(runInsertAny("blobs", { data: { arbitrary: [1, "two"] } })).resolves.toBeTruthy();
  });
});
```

Replace the `runInsert`/`runReplace`/`runGet` placeholders with the concrete driving calls used by the sibling executor tests (they already construct an executor + catalog; reuse that scaffolding rather than inventing a new one).

- [ ] **Step 2: Run — expect FAIL** (bad inserts currently succeed)

Run: `cd packages/executor && ../../node_modules/.bin/vitest run test/write-validation.test.ts`
Expected: FAIL — the reject-cases resolve instead of rejecting.

- [ ] **Step 3: Implement enforcement in `kernel.ts`.**

Extend the errors import (line 7) and add the values import:

```ts
import { DocumentNotFoundError, DocumentValidationError, ForbiddenOperationError, FunctionNotFoundError } from "@stackbase/errors";
import { validate } from "@stackbase/values";
import type { TableMeta } from "./catalog";
```

Add the helper (near `enforceWrite` / `requireTable`):

```ts
/** Validate a user-provided document value against the table's schema validator (if any). */
function validateDocumentForWrite(meta: TableMeta | undefined, tableName: string, value: DocumentValue): void {
  const validator = meta?.documentValidator;
  if (!validator) return;
  const failures = validate(validator, value as Value);
  if (failures.length > 0) {
    const detail = failures.slice(0, 3).map((f) => `${f.path}: ${f.message}`).join("; ");
    throw new DocumentValidationError(`document in "${tableName}" does not match schema: ${detail}`);
  }
}
```

In `handleDbInsert`, after `const { tableNumber, fullName } = requireTable(ctx, table);`, validate the user value before constructing the stored doc:

```ts
  const { tableNumber, fullName } = requireTable(ctx, table);
  const converted = jsonToConvex(value) as DocumentValue;
  validateDocumentForWrite(ctx.catalog.getTable(fullName), fullName, converted);
  const id = newDocumentId(tableNumber);
  const docId = encodeInternalDocumentId(id);
  const doc: DocumentValue = { ...converted, _id: docId, _creationTime: Number(ctx.snapshotTs) };
```

In `handleDbReplace`, after `requireOwnTable(ctx, meta.name);` and the missing-doc check, validate the incoming value with system fields stripped:

```ts
  const converted = jsonToConvex(value) as DocumentValue;
  const { _id: _omitId, _creationTime: _omitCt, ...userFields } = converted;
  validateDocumentForWrite(meta, meta.name, userFields as DocumentValue);
  const newDoc: DocumentValue = { ...converted, _id: id, _creationTime: (oldDoc["_creationTime"] as number) ?? Number(ctx.snapshotTs) };
```

(Reuse `converted` for `newDoc` instead of the current inline `jsonToConvex(value)`.)

Ensure `Value` is imported in `kernel.ts` (it is used by the helper cast); it is almost certainly already imported — if not, add it to the `@stackbase/values` import.

- [ ] **Step 4: Run — expect PASS**

Run: `cd packages/executor && ../../node_modules/.bin/vitest run test/write-validation.test.ts`
Then: `cd /Volumes/Projects/concave-dev && bun run typecheck --filter @stackbase/executor && cd packages/executor && ../../node_modules/.bin/vitest run`
Expected: the new file PASSES and `packages/executor`'s own suite stays green. (Cross-package suites may now be red — Task 4.)

- [ ] **Step 5: Commit**

```bash
git add packages/executor && git commit -m "feat(executor): enforce schema validation on insert/replace (DocumentValidationError)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Backward-compat audit — green every package whose writes now validate

**Files:** (only where a REAL mismatch is found)
- `packages/storage/src/*` (the `_storage` writes vs `storageTableDefinition`)
- `components/scheduler/src/*`, `components/workflow/src/*`, `components/authz/src/*`
- `examples/chat/convex/*`, `examples/auth-demo/convex/*`
- Any other package a full-suite run flags.

**Interfaces:** none new. This is discovery + repair.

**This is an investigation task — the exact fixes are found by running the suite, not pre-listed.** Follow this method:

- [ ] **Step 1: Find the fallout.** Run the full suite and capture every failing package:

Run: `cd /Volumes/Projects/concave-dev && bun run test 2>&1 | tee /tmp/validation-fallout.txt`
Note every package with a `DocumentValidationError` / "does not match schema" failure. (Skip `@stackbase/test`'s `validators.test.ts` — that intentional flip is Task 5.)

- [ ] **Step 2: Triage each failure with this decision rule.** For each violating write:
  - **The schema under-declares a field the write legitimately sets** → add the field to the table's `schema.ts` (correct the schema).
  - **The field is genuinely dynamic** (e.g. a workflow step result, scheduler job `args`, an event payload — arbitrary user JSON) → type it `v.any()` in the schema (the intended escape hatch), OR `v.optional(...)` if it is sometimes absent.
  - **The write sets a wrong type / a stale/extra field** → fix the WRITE to match the declared schema (this is a real latent bug the validation just surfaced).
  - **A whole subsystem's tables are intentionally schemaless / dynamic** → only as a last resort, define that component's schema with `{ schemaValidation: false }`; prefer per-field `v.any()`.

  Likely suspects to check first (verify each against its `schema.ts`):
  - `packages/storage`: `_createPending` inserts `{ status, key, size, contentType, sha256, visibility, expiresAt }`; `_finalize` replaces `{ ...existing, status, size, sha256 }`. Confirm `storageTableDefinition` declares exactly these field types (esp. nullable `size`/`sha256`/`contentType`/`expiresAt` → `v.union(v.number(), v.null())` or `v.optional`).
  - `components/scheduler`: the jobs table — `args` and any result/error fields are dynamic → `v.any()`.
  - `components/workflow`: `workflows`/`steps`/`events` — step results, `context`, event payloads are dynamic → `v.any()`.
  - `components/authz`: roles/assignments rows vs their schema.
  - `examples/{chat,auth-demo}`: their `convex/` mutations vs `schema.ts`.

- [ ] **Step 3: Apply the minimal fix per failure**, re-running that package's tests after each (`bun run --filter <pkg> test`). Do NOT weaken a test to pass — fix the schema or the write.

- [ ] **Step 4: Re-run the whole suite** until every package EXCEPT `@stackbase/test`'s validators file is green.

Run: `cd /Volumes/Projects/concave-dev && bun run test 2>&1 | tail -20`
Expected: all green except (possibly) `@stackbase/test`'s `validators.test.ts` (Task 5).

- [ ] **Step 5: Commit** (one commit; list what changed and why in the body).

```bash
git add -A && git commit -m "fix: reconcile existing writes with schema validation (back-compat audit)

<body: per-package, note schema-field-added vs write-fixed vs v.any() for dynamic fields>

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Flip the conformance suite + docs (D5 resolved)

**Files:**
- Rewrite: `packages/test/test/conformance/validators.test.ts`
- Modify: `docs/enduser/testing.md` (the "Differences from Convex" validation bullet)

**Interfaces:** none new. Uses `@stackbase/test`'s `createTestStackbase`.

- [ ] **Step 1: Rewrite `validators.test.ts`** from asserting NON-enforcement to asserting enforcement. Replace the three `DIVERGES from Convex ...` tests with:

```ts
import { it, expect, describe, beforeEach, afterEach } from "vitest";
import { createTestStackbase, type TestStackbase } from "../../src";
import { defineSchema, defineTable, v } from "@stackbase/values";

describe("conformance — runtime document validation (enforced)", () => {
  let t: TestStackbase;
  const schema = defineSchema({
    nums: defineTable({ n: v.number() }),
    picks: defineTable({ c: v.union(v.literal("a"), v.literal("b")) }),
    nested: defineTable({ o: v.object({ k: v.number() }) }),
    anys: defineTable({ data: v.any() }),
    opt: defineTable({ a: v.number(), b: v.optional(v.string()) }),
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mod = { ins: (table: string) => (async (ctx: any, a: any) => ctx.db.insert(table, a)) } as any;
  const modules = {
    "mod.ts": {
      insNums: async (ctx: any, a: any) => ctx.db.insert("nums", a),
      insPicks: async (ctx: any, a: any) => ctx.db.insert("picks", a),
      insNested: async (ctx: any, a: any) => ctx.db.insert("nested", a),
      insAny: async (ctx: any, a: any) => ctx.db.insert("anys", a),
      insOpt: async (ctx: any, a: any) => ctx.db.insert("opt", a),
    } as any,
    "schema.ts": { default: schema },
  };
  beforeEach(async () => { t = await createTestStackbase({ modules }); });
  afterEach(async () => { await t.close(); });

  it("rejects a wrong-typed insert", async () => {
    await expect(t.mutation("mod:insNums", { n: "x" })).rejects.toThrow(/does not match schema/);
  });
  it("accepts a valid insert", async () => {
    await expect(t.mutation("mod:insNums", { n: 1 })).resolves.toBeTruthy();
  });
  it("rejects an extra field and a missing required field", async () => {
    await expect(t.mutation("mod:insNums", { n: 1, extra: 1 })).rejects.toThrow(/does not match schema/);
    await expect(t.mutation("mod:insOpt", {})).rejects.toThrow(/does not match schema/);
  });
  it("rejects a non-member of a union, accepts a member", async () => {
    await expect(t.mutation("mod:insPicks", { c: "z" })).rejects.toThrow(/does not match schema/);
    await expect(t.mutation("mod:insPicks", { c: "a" })).resolves.toBeTruthy();
  });
  it("rejects a wrong nested-field type", async () => {
    await expect(t.mutation("mod:insNested", { o: { k: "x" } })).rejects.toThrow(/does not match schema/);
  });
  it("allows omission of an optional field", async () => {
    await expect(t.mutation("mod:insOpt", { a: 1 })).resolves.toBeTruthy();
  });
  it("accepts anything for a v.any() field", async () => {
    await expect(t.mutation("mod:insAny", { data: { arbitrary: [1, "two", true] } })).resolves.toBeTruthy();
  });
});
```

Delete the stray `mod` helper line if unused (keep the file clean — only the `modules` object is needed).

- [ ] **Step 2: Add a schemaValidation-off test** in the same file:

```ts
it("does not validate when schemaValidation is disabled", async () => {
  const loose = defineSchema({ nums: defineTable({ n: v.number() }) }, { schemaValidation: false });
  const tl = await createTestStackbase({
    modules: { "mod.ts": { ins: async (ctx: any, a: any) => ctx.db.insert("nums", a) } as any, "schema.ts": { default: loose } },
  });
  try {
    await expect(tl.mutation("mod:ins", { n: "not-a-number" })).resolves.toBeTruthy();
  } finally { await tl.close(); }
});
```

- [ ] **Step 3: Update `docs/enduser/testing.md`.** In the "Differences from Convex" section, change the validation bullet FROM "Schema validators are compile-time + structural, not runtime-enforced — Stackbase does not currently reject a wrong-typed write at runtime" TO a statement that document validation IS now enforced (a wrong-typed / extra-field / missing-required write is rejected with a `DocumentValidationError`; disable per-schema with `{ schemaValidation: false }` or per-field with `v.any()`). Keep the other four divergences unchanged.

- [ ] **Step 4: Run — expect PASS + full green**

Run: `cd packages/test && ../../node_modules/.bin/vitest run test/conformance/validators.test.ts`
Then: `cd /Volumes/Projects/concave-dev && bun run build && bun run typecheck && bun run test 2>&1 | tail -12`
Expected: the flipped file PASSES; whole monorepo `Tasks: N successful, N total` fully green.

- [ ] **Step 5: Commit**

```bash
git add packages/test docs/enduser/testing.md && git commit -m "test(test): flip validators conformance to enforced + docs (D5 resolved)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: E2E through the real server + final verification

**Files:**
- Create: `packages/cli/test/validation-e2e.test.ts`

**Interfaces:** none new. Boots a real `stackbase dev`/`serve` and drives it, mirroring an existing `packages/cli/test/*-e2e.test.ts`.

- [ ] **Step 1: Write the E2E test** modeled on the closest existing CLI E2E (e.g. `action-e2e.test.ts` / `http-action-e2e.test.ts` — reuse its boot + `POST /api/run` client helpers). Assertions:
  - a `POST /api/run` mutation that inserts a well-typed document COMMITS (200 + read-back shows the row);
  - a `POST /api/run` mutation that inserts a wrong-typed document is REJECTED (the response carries a document-validation error; the row is NOT persisted on read-back);
  - (reactivity intact) a valid insert still fans out to a WS subscription opened before the write.

Use the existing fixture-app + boot scaffolding from the sibling E2E test; only the schema (one typed field) + the two mutations (valid vs invalid write) are new.

- [ ] **Step 2: Run — expect PASS**

Run: `cd packages/cli && ../../node_modules/.bin/vitest run test/validation-e2e.test.ts`
Expected: PASS.

- [ ] **Step 3: Final full-monorepo verification**

Run: `cd /Volumes/Projects/concave-dev && bun run build && bun run typecheck && bun run test 2>&1 | tail -12`
Expected: all green — `Tasks: N successful, N total`.

- [ ] **Step 4: Commit**

```bash
git add packages/cli && git commit -m "test(cli): E2E — schema validation rejects bad writes through the real server

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Self-Review (author)

- **Spec coverage:** §Design.1 `validatorFromJson` → Task 1; §Design.2 catalog carriage → Task 2; §Design.3 enforce in insert/replace + error → Task 3; §Design.4 escape hatch (`schemaValidation`/`v.any()`) → Tasks 2–3 (built in) + Task 5 (asserted); §Design.5 backward-compat audit → Task 4; §Testing unit → Task 1, kernel → Task 3, conformance flip + docs → Task 5, E2E → Task 6, regression → Tasks 5–6. All six spec build-order steps mapped.
- **Sequencing/green-per-commit:** Tasks 1–2 green in isolation; Task 3 green in `@stackbase/executor` (cross-package red expected + documented); Task 4 greens all non-`@stackbase/test` packages; Task 5 flips the conformance file + asserts full green; Task 6 E2E + final green. Only Task 6 (and Task 5's tail) assert full-monorepo green.
- **Type consistency:** `documentValidator?: AnyValidator | null` + `schemaValidation?: boolean` on `TableMeta` (Task 2) are consumed by `validateDocumentForWrite(meta, ...)` (Task 3); `addTable(name, tableNumber, documentType?, schemaValidation?)` signature is the one `compose.ts` calls (Task 2); `validatorFromJson(json)` (Task 1) is used by `addTable` (Task 2). Names consistent across tasks.
- **Placeholder note:** Task 3's test and Task 6's test intentionally reference the sibling-test scaffolding (`runInsert`/boot helpers) rather than inlining a full executor/server harness — this is deliberate reuse of existing patterns the implementer must locate, not a content gap; the assertions and expected behaviors are fully specified. Task 4 is an investigation task whose exact fixes are discovered by running the suite; its method, decision rule, suspects, and fix patterns are fully specified.
