# Runtime Document Validation (D5, phase 1) — Design Spec

**Status:** proposed (awaiting review)
**Date:** 2025-08-12
**Scope decision (confirmed):** documents first. Function-argument validation (`mutation({ args, handler })` + codegen) is an explicit fast-follow, **not** in this slice.

## Problem

The `@stackbase/test` conformance suite (branch `test-harness-slice`, finding **D5**) proved the engine does **no runtime validation**. The machinery exists but is wired nowhere:

- Each `TableDefinition` builds a strict `documentValidator = v.object(fields)`, but the engine only ever receives the schema as **JSON** (`SchemaDefinitionJSON`), and there is **no `ValidatorJSON → Validator` reconstructor**.
- The `IndexCatalog` built from `schemaJson` retains only **table numbers + index field lists** — it drops `documentType` and the `schemaValidation` flag.
- `handleDbInsert` / `handleDbReplace` (`packages/executor/src/kernel.ts`) write the value straight through — no `.check()` call.
- `DocumentValidationError` / `ArgumentValidationError` are defined in `@stackbase/errors` but **never thrown** by the engine.

Consequence: a wrong-typed, extra-field, or missing-required-field document is **silently persisted**. For a "realistic BaaS" this is the highest-priority integrity gap — corrupt data breaks queries, indexes, and reactive re-execution downstream.

## Goal

Strict, Convex-parity validation of **documents against `schema.ts` on every write** (`insert` + `replace`), so a non-conforming write is **rejected** (`DocumentValidationError`, a non-retryable `UserError` surfaced to the caller) instead of stored. Honor the existing `schemaValidation` flag as the escape hatch. Enabling this must keep the whole monorepo suite green (backward-compat audit is part of the slice).

## Non-goals (deferred / out of scope)

- **Function-argument validation** — the `mutation({ args, handler })` / `query({ args, handler })` authoring surface + arg-type codegen. Fast-follow slice.
- **Cross-table `v.id` enforcement** — `IdValidator.check` stays `typeof === "string"` (an id minted for another table is still accepted). Unchanged here.
- The unrelated engine bugs the harness surfaced: scheduler `undefined`-return crash, client `QueryFailed` silent-drop. Separate small fixes.

## Existing facts this design builds on (verified)

- `Validator.check(value, path, out: ValidationFailure[]): void` — pushes `{ path, message }`. `ObjectValidator.check` is **strict**: rejects `missing required field`, `unexpected extra field`, and honors `optional`. `UnionValidator` tries each member; `AnyValidatorImpl.check` accepts anything.
- `TableDefinitionJSON.documentType: ValidatorJSON` (an `{ type: "object", value: { field: { fieldType, optional } } }` for a table). `SchemaDefinitionJSON.schemaValidation: boolean` (`?? true`).
- `compose.ts` `addSchema(schemaJson, ...)` already destructures `tdef.documentType` (compose.ts:135) for index/relation extraction — the JSON is in hand at catalog-build time.
- Stored docs carry system fields `_id` + `_creationTime` that are **not** schema fields — so validating a stored doc against the strict object validator would fail on those. Validation must target the **user value** (insert: pre-system-field-injection; replace: with system fields stripped first).
- Undeclared-table writes already throw (`requireTable` → "unknown table") — no separate "table not in schema" rule needed.

## Design

### 1. `validatorFromJson` — the JSON→Validator bridge (`@stackbase/values`)

Add `validatorFromJson(json: ValidatorJSON): Validator` that reconstructs a live `Validator` from its JSON, **reusing the existing `.check()` methods** (one source of validation truth — no parallel `checkJson` walker that could drift). A `switch (json.type)` over every kind: `null|boolean|number|bigint|string|bytes|any|id|literal|array|record|union|object`. For `object`, rebuild each field's validator and re-apply `optional` (wrap in the optional carrier). Export it.

Rationale: the engine holds JSON, not live validators; the `v` builder + harness already validate via `.check()`; reconstructing keeps them identical.

### 2. Carry `documentType` + `schemaValidation` into the catalog

`TableMeta` (returned by `catalog.getTable`/`getTableByNumber`) gains `documentValidator: Validator | null` (built once via `validatorFromJson(tdef.documentType)` at `addTable` time, or `null` when `schemaValidation` is off / documentType isn't an object) — plus the schema's `schemaValidation: boolean`. `compose.ts` passes `tdef.documentType` and the schema's `schemaValidation` through `addSchema`/`catalog.addTable`. Building the validator once at compose-time (not per write) keeps the hot path cheap.

### 3. Validate in the write path (`kernel.ts`)

- **`handleDbInsert`**: after `requireTable`, if the table has a `documentValidator`, run `documentValidator.check(userValue, "", failures)` on the **incoming user value** (system fields not yet added). On `failures.length > 0`, throw `DocumentValidationError` before staging the write.
- **`handleDbReplace`**: build the value-to-validate by **omitting `_id` and `_creationTime`** from the incoming value, then `check` it. (Replace re-derives system fields regardless.) Throw on failure.
- Failure message: `` `document in "<table>" does not match schema: <path>: <message>[; <path>: <message>...]` `` (cap at the first few failures). `DocumentValidationError` extends `UserError` → non-retryable → surfaces to the caller as a rejection (harness `t.mutation` rejects; the WS client gets a `MutationFailed`).

### 4. Enforcement policy / escape hatch

- Validation runs iff the table's schema had `schemaValidation !== false` (Convex-parity default `true`).
- `defineSchema(tables, { schemaValidation: false })` disables **all** document validation for that schema — the migration/loose-write escape hatch.
- `v.any()` fields accept anything (built-in per-field escape hatch).

### 5. Backward-compat audit (the bulk of the work)

`schemaValidation` defaults `true` but was never enforced, so existing writes may violate their own schemas. Turn validation on, run the full suite, and reconcile every failure by fixing the **write** (or the **schema** if the schema was wrong). Audit surface, in priority order:

- `packages/storage` — the `_storage` system table writes (`_createPending`/`_insertReady`/`_finalize`/`_delete`) vs `storageTableDefinition`.
- Component tables: `components/scheduler` (jobs), `components/workflow` (`workflows`/`steps`/`events`), `components/authz` (roles/assignments).
- `examples/chat`, `examples/auth-demo` (their `convex/` writes).
- Any `t.run`/admin-path writes that bypass user functions but still hit `handleDbInsert`.

Each failure is a real latent bug (a write that doesn't match its declared schema) or a schema that under-declares — both worth fixing.

## Testing

- **Unit** (`packages/values`): `validatorFromJson` round-trips — for each validator kind, `validatorFromJson(v.X().toJSON())` accepts/rejects the same values the live `v.X()` does (drive representative pass + fail cases, incl. nested object/union/optional/array/record/id/literal).
- **Conformance flip** (`packages/test`): rewrite `validators.test.ts` from "D5: writes are NOT validated" to "writes ARE validated" — wrong-typed insert/replace → `rejects` with `DocumentValidationError`; optional omission OK; union member OK / non-member rejected; extra field rejected; missing required rejected; `v.any()` accepts; `defineSchema(..., { schemaValidation: false })` disables. Update `docs/enduser/testing.md`: the validation-divergence note flips from "not enforced" to **enforced** (D5 resolved); the other four divergences stay.
- **E2E** (`packages/cli`): through the real `stackbase dev`/`serve` — a client mutation writing a bad document receives a rejection (not a silent commit); a valid write still commits + fans out reactively.
- **Regression:** full monorepo `build && typecheck && test` green after the audit fixes.

## Build order (for the implementation plan)

1. `validatorFromJson` + unit tests (`@stackbase/values`), self-contained.
2. Carry `documentValidator` + `schemaValidation` into `TableMeta`/catalog via `compose.ts` (no enforcement yet; assert the validator is present on `getTable`).
3. Enforce in `handleDbInsert`/`handleDbReplace` + `DocumentValidationError` message; a focused kernel/executor test proving reject-on-bad, accept-on-good, replace-strips-system-fields.
4. Backward-compat audit + fixes (iterate until the full suite is green with validation on).
5. Flip `@stackbase/test` `validators.test.ts` + update `testing.md` (D5 resolved).
6. E2E through `stackbase dev`/`serve` + final full-suite green.

## Dependencies / sequencing note

Steps 5–6 assert against `@stackbase/test`, so this slice should branch **after** `test-harness-slice` lands (merge/PR that first). Steps 1–4 are engine-only and don't depend on it.
