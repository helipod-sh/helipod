---
title: Foundation — Schema & Typed-API Codegen
slug: schema-codegen
status: design (implementation-ready)
audience: engineering (internal)
slice: Foundation
depends_on: [monorepo-tooling-skeleton]
---

# Schema & Typed-API Codegen

> Clean-room design. We studied the *shape* of Convex's generated `_generated/` files and
> concave's `codegen` behavior (FSL — reference only, never copied) to fix the interop
> contract; the implementation below is our own. Where this doc cites a `convex/server` or
> `convex/values` type name, that is a deliberate **interop fact**: the published `convex`
> npm package is a normal dependency of a Stackbase app (the locked compatibility approach in
> [strategy.md](../strategy.md)), and we reuse its public *type-level* machinery so that the
> standard `convex/react` `useQuery` type-checks against the `api` we emit. Reusing a
> published package's public types is not copying FSL source.

Companion reads: [system-design](../system-design.md) §4 (execution model), [internals/01](../internals/01-storage.md)
(table registry, Id codec), [internals/04](../internals/04-query-engine.md) (index model, tiebreakers),
[internals/05](../internals/05-udf-execution.md) (the analyzed-function manifest we consume),
[internals/07](../internals/07-platform-services.md) (`syncRuntimeMetadata`, schema docs),
[scalability-spectrum](../scalability-spectrum.md) (seam-table rows 1–2, 7).

---

## 1. Purpose & boundaries

### What it owns

Codegen is the **build-time bridge from the app's authored source of truth to typed,
machine-readable artifacts** that both the app's TypeScript and the engine consume. Given:

1. `convex/schema.ts` — the developer's `defineSchema`/`defineTable` declarations, and
2. the **analyzed-function manifest** — the static analysis of `convex/**/*.ts` exports
   (produced by the UDF layer's `analyzeUdfModule`, [internals/05](../internals/05-udf-execution.md)),

it produces:

- **`convex/_generated/api.{d.ts,js}`** — the typed `api` / `internal` (`internalApi`) reference
  trees: module path → `FunctionReference`. This is what makes `useQuery(api.messages.list, …)`
  fully type-checked on both client and server.
- **`convex/_generated/dataModel.d.ts`** — `DataModel`, `Doc<Table>`, `Id<Table>`, `TableNames`,
  validator-derived document types, and the **reserved `ShardKeys` seam type**.
- **`convex/_generated/server.{d.ts,js}`** — `query`/`mutation`/`action` (+ `internal*`,
  `httpAction`) bound to the app's `DataModel`, plus `QueryCtx`/`MutationCtx`/`ActionCtx`,
  `DatabaseReader`/`DatabaseWriter`.
- A **parsed, serializable `SchemaDefinition`** — the engine-facing source of truth for
  table validators (write validation), **index definitions** (with implicit tiebreakers
  resolved), search/vector index config, and the **reserved per-table shard key**. The engine's
  `SchemaService` ([internals/05](../internals/05-udf-execution.md)), `IndexManager`
  ([internals/04](../internals/04-query-engine.md)), `DocStore.setupSchema`
  ([internals/01](../internals/01-storage.md)), and `syncRuntimeMetadata`
  ([internals/07](../internals/07-platform-services.md)) all read this one structure.

It owns two parse paths (**runtime analysis** preferred, **static AST** fallback — both surfaced
to the CLI as `stackbase codegen` / `stackbase codegen --static`), a `ValidatorJSON` ↔ TS-type
codec, deterministic file emission, and the `schema.ts` **shard-key superset** authoring shim.

### What it does NOT own

- **It does not analyze functions.** The `AnalyzedFunctionManifest` is produced by the UDF
  execution component ([internals/05](../internals/05-udf-execution.md)); codegen *consumes* its
  shape. Codegen depends on that contract; it does not run user code's logic, only reads exported
  metadata (runtime mode) or parses source (static mode).
- **It does not own the index-key codec.** The order-preserving `encodeIndexKey`/`compareIndexKeys`
  lives in the query engine ([internals/04](../internals/04-query-engine.md)). Codegen emits *index
  field lists*; it never encodes keys. (This is why §9's property tests are about parse/emit
  determinism and validator round-trips — **not** key ordering or OCC, which belong to the engine
  and transactor components.)
- **It does not validate documents at runtime, persist schema, or talk to a `DocStore`.** It emits
  the `SchemaDefinition` value; the engine's `SchemaService` enforces it and `syncRuntimeMetadata`
  persists it.
- **It does not own `_generated/server.js`'s runtime behavior** beyond re-exporting Convex's
  `*Generic` function constructors — the registration/analysis semantics belong to the executor.
- **It is not the CLI.** `packages/cli`'s `dev` watch loop *calls* codegen; the watch/debounce/push
  orchestration is the CLI's.

> Boundary in one line: **codegen turns declarations into types + a parsed schema; the engine turns
> the parsed schema into behavior.**

---

## 2. The interop strategy (why the generated files are thin)

The single most important design decision: **the generated `.d.ts` delegate type derivation to
`convex/server`'s public generics rather than re-deriving TypeScript types by hand.** Convex's
`DataModelFromSchemaDefinition<typeof schema>`, `ApiFromModules<…>`, `FilterApi<…>`,
`FunctionReference<…>`, and `GenericId<…>` already encode the exact static contract the
`convex/react` client expects. We emit files that *reference `typeof schema`* and *`typeof
import("../module")`* and let TypeScript do the inference.

Three consequences, all of which serve the mandate:

1. **Zero type-derivation drift.** We cannot disagree with the client about what `useQuery(api.x.y,
   args)` accepts, because the same generics judge both. This is how we hit the *Convex-grade DX
   bar* (strategy.md) without reimplementing Convex's type algebra.
2. **The `api` type is provably topology-independent.** `FunctionReference` carries
   `{type, visibility, args, returns}` — nothing about tiers, shards, or transport. So the generated
   `api` is byte-identical at Tier 0 and Tier 2: scaling the backend cannot change the client's type
   contract (the cross-spectrum invariant, [scalability-spectrum §4](../scalability-spectrum.md)).
3. **We still own everything Convex doesn't have:** the *parsed* `SchemaDefinition` (engine-facing),
   the **shard-key seam**, the static-fallback parser, index lowering, deterministic emission, and
   error UX.

Where we cannot delegate (the `--static` path, where modules are not imported so `typeof` is
unavailable), we fall back to our own `ValidatorJSON → TS-type` emitter — a documented,
lower-fidelity mode. Runtime mode is the default and the quality bar.

---

## 3. The contracts (exact TypeScript)

All types below are exported from `@stackbase/codegen`. Names that mirror `convex/*` are interop
facts and are called out.

### 3.1 ValidatorJSON — the serializable validator form

Structurally mirrors Convex's `ValidatorJSON` wire shape (interop fact: it is what
`validator.json` produces and what `v`-validators round-trip through), so the same JSON crosses the
codegen ↔ engine ↔ wire boundaries unchanged.

```ts
export type JSONValue =
  | null | boolean | number | string
  | JSONValue[] | { [k: string]: JSONValue };

export type ValidatorJSON =
  | { type: "null" }
  | { type: "any" }
  | { type: "boolean" }
  | { type: "number" }                                   // float64
  | { type: "bigint" }                                   // int64
  | { type: "string" }
  | { type: "bytes" }
  | { type: "literal"; value: JSONValue }
  | { type: "id"; tableName: string }                    // v.id("table")
  | { type: "array"; value: ValidatorJSON }
  | { type: "object"; value: Record<string, ObjectFieldJSON> }
  | { type: "record"; keys: ValidatorJSON; values: ObjectFieldJSON }
  | { type: "union"; value: ValidatorJSON[] };

export interface ObjectFieldJSON {
  readonly fieldType: ValidatorJSON;
  readonly optional: boolean;                            // v.optional(...)
}
```

### 3.2 SchemaDefinition — the engine-facing source of truth

This is the parsed, **serializable** structure (not the Convex authoring value — see §3.3). It is a
**key interface**: the engine's `SchemaService`, `IndexManager`, `DocStore.setupSchema`, and
`syncRuntimeMetadata` all consume it.

```ts
export interface SchemaDefinition {
  /** Keyed by user table name (e.g. "messages"). System tables are NOT included here. */
  readonly tables: Readonly<Record<string, ParsedTableDefinition>>;
  /** defineSchema({ schemaValidation }); default true. When false, writes are not validated. */
  readonly schemaValidation: boolean;
  /** true when no schema.ts exists — DataModel degrades to AnyDataModel (schemaless). */
  readonly schemaless: boolean;
  /** Content hash of the *normalized* schema; feeds syncRuntimeMetadata's version
   *  (internals/07) so the engine only re-applies index/schema metadata when it truly changed. */
  readonly hash: string;
}

export interface ParsedTableDefinition {
  readonly name: string;
  /** The table's object validator. {type:"any"} when the table is schemaless. */
  readonly documentType: ValidatorJSON;
  /** Indexes with implicit trailing tiebreakers already appended (see §6.3). */
  readonly indexes: readonly IndexDefinition[];
  readonly searchIndexes: readonly SearchIndexDefinition[];
  readonly vectorIndexes: readonly VectorIndexDefinition[];
  /** RESERVED scale seam (rows 1–2). undefined unless the table opted in (§7).
   *  Inert at Tier 0; read by the Tier-2 ShardRouter with no codegen change. */
  readonly shardKey?: ShardKeyDefinition;
}

export interface IndexDefinition {
  readonly name: string;                          // descriptor, e.g. "by_conversation"
  /** User fields followed by the implicit ["_creationTime","_id"] tiebreakers. */
  readonly fields: readonly string[];
}

export interface SearchIndexDefinition {
  readonly name: string;
  readonly searchField: string;
  readonly filterFields: readonly string[];
}

export interface VectorIndexDefinition {
  readonly name: string;
  readonly vectorField: string;
  readonly dimensions: number;
  readonly filterFields: readonly string[];
}

export interface ShardKeyDefinition {
  /** Document field the partition is keyed on, e.g. "conversationId". */
  readonly field: string;
  /** Validator of that field; must be required and a scalar/id (§7 validation). */
  readonly validator: ValidatorJSON;
}
```

### 3.3 DataModelFromSchema — the type-level derivation

A **key interface** other components import instead of reaching into `convex/server` directly. It
operates on the *authoring value* type (`typeof schema`), exactly like Convex's own generic, so
`Doc`/`Id` are inferred from validators with **no hand-written interfaces**.

```ts
import type {
  DataModelFromSchemaDefinition,
  SchemaDefinition as ConvexSchemaValue,   // the value returned by defineSchema(...)
  GenericSchema,
  GenericDataModel,
} from "convex/server";

/**
 * Type-level DataModel for a Stackbase/Convex schema authoring value.
 *
 * SCALE SEAM (critical): this delegates to Convex's generic and deliberately does
 * NOT fold in shard-key metadata. Therefore DataModel — and hence Doc, Id, and the
 * entire generated `api` — is byte-identical whether or not any table declares a
 * shard key. Shard keys are surfaced in a structurally *separate* type
 * (ShardKeysFromSchema) so adopting sharding can never perturb app-visible types.
 */
export type DataModelFromSchema<
  S extends ConvexSchemaValue<GenericSchema, boolean>,
> = DataModelFromSchemaDefinition<S>;

/** Reserved seam, type level: table name → its shard-key field, or null. */
export type ShardKeysFromSchema<S> = {
  readonly [T in keyof TablesOf<S>]: ShardKeyFieldOf<TablesOf<S>[T]>;
};
// TablesOf / ShardKeyFieldOf read the phantom brand stamped by the §7 superset
// `defineTable().shardKey(f)`; exact extraction is an impl detail proven by type tests (§9).
```

### 3.4 AnalyzedFunctionManifest — the input we consume

Owned by the UDF component ([internals/05](../internals/05-udf-execution.md)); restated here as the
**input contract** codegen depends on. Codegen reads `functions` (for the api tree) and ignores
`httpRoutes`/`cronSpecs` for the api tree (they have other consumers).

```ts
export type UdfType = "query" | "mutation" | "action" | "httpAction";
export type Visibility = "public" | "internal";

export interface AnalyzedFunction {
  readonly name: string;                 // export name, e.g. "list"
  readonly udfType: UdfType;
  readonly visibility: Visibility;
  readonly args: ValidatorJSON;          // argument validator
  readonly returns: ValidatorJSON | null;// return validator (null = unspecified)
  readonly pos?: SourcePos;
}

export interface AnalyzedModule {
  /** Normalized module path: "messages", "chat/messages" (no extension, POSIX separators). */
  readonly path: string;
  readonly componentPath?: string;       // root = undefined (components deferred)
  readonly functions: readonly AnalyzedFunction[];
  readonly httpRoutes: readonly { path: string; method: string }[];
  readonly cronSpecs: readonly { name: string }[];
}

export type AnalyzedFunctionManifest = readonly AnalyzedModule[];

export interface SourcePos { readonly file: string; readonly line: number; readonly column: number; }
```

### 3.5 Generated artifacts & the top-level functions

```ts
export interface GeneratedFile {
  /** Path relative to convexDir, e.g. "_generated/api.d.ts". POSIX separators. */
  readonly path: string;
  readonly content: string;              // exact bytes to write (already formatted)
}

export interface GeneratedApi        { readonly files: readonly GeneratedFile[]; } // api.d.ts, api.js
export interface GeneratedDataModel  { readonly files: readonly GeneratedFile[]; } // dataModel.d.ts
export interface GeneratedServer     { readonly files: readonly GeneratedFile[]; } // server.d.ts, server.js

export interface GeneratedBundle {
  readonly files: readonly GeneratedFile[];   // union of all of the above, de-duped, sorted
  readonly schema: SchemaDefinition;          // engine consumes this directly
  readonly warnings: readonly CodegenWarning[];
}

export interface CodegenOptions {
  readonly convexDir: string;                 // e.g. "convex"
  readonly mode?: "runtime" | "static";       // default "runtime", auto-fallback to "static"
  readonly outDir?: string;                   // default `${convexDir}/_generated`
  readonly emitJs?: boolean;                  // default true (.js shims alongside .d.ts)
  readonly header?: string;                   // banner; default = standard "do not edit" header
}

export interface CodegenInput {
  readonly schema: SchemaDefinition;
  readonly manifest: AnalyzedFunctionManifest;
}

// ---- pure generators (no IO) ----
export function generateApi(manifest: AnalyzedFunctionManifest, options: CodegenOptions): GeneratedApi;
export function generateDataModel(schema: SchemaDefinition, options: CodegenOptions): GeneratedDataModel;
export function generateServer(schema: SchemaDefinition, options: CodegenOptions): GeneratedServer;
export function generateAll(input: CodegenInput, options: CodegenOptions): GeneratedBundle;

// ---- IO: write only changed files (idempotent) ----
export interface WriteResult {
  readonly written: readonly string[];        // absolute paths actually rewritten
  readonly unchanged: readonly string[];      // skipped (byte-identical on disk)
}
export function writeGenerated(
  result: GeneratedApi | GeneratedDataModel | GeneratedServer | GeneratedBundle,
  options: CodegenOptions,
): Promise<WriteResult>;
```

### 3.6 Parse / source abstractions

```ts
export interface SchemaSource  { parse(): Promise<SchemaParseResult>; }
export interface ManifestSource { analyze(): Promise<AnalyzedFunctionManifest>; }

export interface SchemaParseResult {
  readonly schema: SchemaDefinition;
  readonly warnings: readonly CodegenWarning[];
}

// Runtime mode: import the already-evaluated authoring values and read their public surface.
export function parseSchemaFromValue(schemaValue: unknown): SchemaParseResult;     // typeof schema → SchemaDefinition
export class RuntimeSchemaSource implements SchemaSource {}                        // imports `${convexDir}/schema`
export class RuntimeManifestSource implements ManifestSource {}                    // wraps the executor's ModuleRegistry + analyzeUdfModule

// Static mode: TS AST parse, no module evaluation.
export function parseSchemaFromSource(sourceText: string, fileName: string): SchemaParseResult;
export class StaticSchemaSource implements SchemaSource {}
export class StaticManifestSource implements ManifestSource {}

// Validator codec (used by static emission, engine validation interop, and error messages).
export function validatorToJson(validator: unknown): ValidatorJSON;               // live convex validator → JSON
export function jsonToValidator(json: ValidatorJSON): unknown;                    // inverse (round-trip, static)
export function validatorToTsType(json: ValidatorJSON, ctx?: TypeEmitContext): string;
export interface TypeEmitContext { readonly idType: (table: string) => string; } // e.g. table => `Id<"${table}">`
```

### 3.7 Errors & warnings

```ts
export type CodegenErrorCode =
  | "SCHEMA_PARSE_FAILED" | "SCHEMA_INVALID" | "INDEX_INVALID"
  | "SHARD_KEY_INVALID" | "MANIFEST_INVALID" | "API_PATH_COLLISION"
  | "RESERVED_NAME" | "WRITE_FAILED";

export class CodegenError extends Error {
  readonly code: CodegenErrorCode;
  readonly pos?: SourcePos;                  // file:line:col when known
  readonly path?: readonly string[];         // logical path, e.g. ["messages","by_conversation"]
  readonly remedy?: string;                  // one-line "how to fix"
}

export interface CodegenWarning {
  readonly code: string;                     // e.g. "STATIC_VALIDATOR_DEGRADED"
  readonly message: string;
  readonly pos?: SourcePos;
}
```

---

## 4. Generated file templates (exact output)

These are the literal shapes emitted. They are intentionally close to Convex's so a Convex app is
drop-in. Worked example uses the WhatsApp schema from
[scalability-spectrum §2](../scalability-spectrum.md).

### 4.1 `_generated/api.d.ts` (runtime mode)

```ts
/* eslint-disable */
/**
 * Generated `api` utility. DO NOT EDIT — regenerate with `stackbase codegen`.
 * Commit this file.
 */
import type * as conversations from "../conversations.js";
import type * as messages from "../messages.js";
import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  conversations: typeof conversations;
  messages: typeof messages;
}>;

export declare const api: FilterApi<typeof fullApi, FunctionReference<any, "public">>;
export declare const internal: FilterApi<typeof fullApi, FunctionReference<any, "internal">>;
export { internal as internalApi };   // Stackbase alias (see §10 decision)
```

### 4.2 `_generated/api.js`

```js
import { anyApi } from "convex/server";
export const api = anyApi;
export const internal = anyApi;
export const internalApi = anyApi;
```

> `anyApi` is a runtime Proxy whose property access yields `FunctionReference` placeholders; the
> *types* come entirely from `api.d.ts`. Modules with **no public functions** are omitted from
> `api`'s tree and surface only under `internal` — `FilterApi` does this at the type level; we still
> emit every analyzed module into `fullApi` so visibility is decided once, by the types.

### 4.3 `_generated/api.d.ts` (static mode)

When modules cannot be imported, `typeof messages` is unavailable, so we emit explicit references
built from the manifest's analyzed validators:

```ts
import type { ApiFromModules, FilterApi, FunctionReference } from "convex/server";
export declare const api: {
  messages: {
    list: FunctionReference<"query", "public", { conversationId: string }, any>;
    send: FunctionReference<"mutation", "public", { conversationId: string; body: string }, any>;
  };
};
export declare const internal: { /* internal-visibility fns */ };
```

Lower fidelity (return types collapse to `any` unless a `returns` validator was declared); a
`STATIC_API_DEGRADED` warning is attached. Runtime mode is preferred and is the default.

### 4.4 `_generated/dataModel.d.ts` (schema present)

```ts
/* eslint-disable */
/** Generated data model types. DO NOT EDIT. Commit this file. */
import type {
  DataModelFromSchemaDefinition,
  DocumentByName,
  TableNamesInDataModel,
} from "convex/server";
import type { GenericId } from "convex/values";
import schema from "../schema.js";

export type DataModel = DataModelFromSchemaDefinition<typeof schema>;
export type TableNames = TableNamesInDataModel<DataModel>;
export type Doc<TableName extends TableNames> = DocumentByName<DataModel, TableName>;
export type Id<TableName extends TableNames> = GenericId<TableName>;

/**
 * RESERVED SCALE SEAM (rows 1–2). Each table → its partition/shard key field, or null.
 * Structurally independent of `DataModel`: declaring a shard key never changes Doc/Id/api.
 * Inert at Tier 0; the Tier-2 ShardRouter reads it with no app-code edit.
 */
export type ShardKeys = {
  conversations: null;
  messages: "conversationId";          // surfaced automatically when messages opts in (§7)
};
```

### 4.5 `_generated/dataModel.d.ts` (schemaless — no `schema.ts`)

```ts
import type { AnyDataModel } from "convex/server";
import type { GenericId } from "convex/values";
export type DataModel = AnyDataModel;
export type TableNames = string;
export type Doc<TableName extends string> = any;
export type Id<TableName extends string> = GenericId<TableName>;
export type ShardKeys = Record<string, null>;
```

### 4.6 `_generated/server.d.ts` and `server.js`

```ts
// server.d.ts
import type {
  ActionBuilder, MutationBuilder, QueryBuilder, HttpActionBuilder,
  GenericActionCtx, GenericMutationCtx, GenericQueryCtx,
  GenericDatabaseReader, GenericDatabaseWriter,
} from "convex/server";
import type { DataModel } from "./dataModel.js";

export declare const query: QueryBuilder<DataModel, "public">;
export declare const internalQuery: QueryBuilder<DataModel, "internal">;
export declare const mutation: MutationBuilder<DataModel, "public">;
export declare const internalMutation: MutationBuilder<DataModel, "internal">;
export declare const action: ActionBuilder<DataModel, "public">;
export declare const internalAction: ActionBuilder<DataModel, "internal">;
export declare const httpAction: HttpActionBuilder;

export type QueryCtx = GenericQueryCtx<DataModel>;
export type MutationCtx = GenericMutationCtx<DataModel>;
export type ActionCtx = GenericActionCtx<DataModel>;
export type DatabaseReader = GenericDatabaseReader<DataModel>;
export type DatabaseWriter = GenericDatabaseWriter<DataModel>;
```

```js
// server.js — re-export Convex's generic constructors verbatim (interop fact: these emit
// the standard RegisteredQuery/Mutation/Action objects the executor's analyzeUdfModule reads).
import {
  actionGeneric, httpActionGeneric,
  internalActionGeneric, internalMutationGeneric, internalQueryGeneric,
  mutationGeneric, queryGeneric,
} from "convex/server";
export const query = queryGeneric;
export const internalQuery = internalQueryGeneric;
export const mutation = mutationGeneric;
export const internalMutation = internalMutationGeneric;
export const action = actionGeneric;
export const internalAction = internalActionGeneric;
export const httpAction = httpActionGeneric;
```

Binding `query`/`mutation`/etc. to `DataModel` is what makes `ctx.db.query("messages")` know the
row type and reject unknown table names — the end-to-end safety the slice promises.

---

## 5. Package / module / file layout

`packages/codegen` (provided by `monorepo-tooling-skeleton`: Bun workspace, shared `tsconfig.base`,
vitest, the `convex` peer dep). Engine logic never imports a DB driver; codegen never imports a
runtime host.

```
packages/codegen/
  package.json                     # name "@stackbase/codegen"; peerDeps: convex; deps: typescript (static parser)
  src/
    index.ts                       # public surface (everything in §3)
    options.ts                     # CodegenOptions, defaults, outDir resolution
    errors.ts                      # CodegenError, CodegenWarning, codes
    schema/
      validator-json.ts            # ValidatorJSON, validatorToJson, jsonToValidator
      validator-tstype.ts          # validatorToTsType (static emission + messages)
      schema-definition.ts         # SchemaDefinition + ParsedTableDefinition + Index/Search/Vector defs
      data-model-type.ts           # DataModelFromSchema / ShardKeysFromSchema (type-only)
      index-lowering.ts            # implicit tiebreakers + standard-index synthesis (§6.3)
      shard-key.ts                 # ShardKeyDefinition extraction + validation (§7)
      parse-runtime.ts             # parseSchemaFromValue, RuntimeSchemaSource
      parse-static.ts              # parseSchemaFromSource, StaticSchemaSource (TS AST)
      hash.ts                      # canonical-JSON content hash → SchemaDefinition.hash
    manifest/
      analyzed-types.ts            # AnalyzedFunctionManifest input contract (§3.4)
      source-runtime.ts            # RuntimeManifestSource (uses executor analysis)
      source-static.ts             # StaticManifestSource (TS AST)
      api-tree.ts                  # manifest → nested {module → fn} tree + visibility split + collisions
    generate/
      api.ts                       # generateApi
      data-model.ts                # generateDataModel
      server.ts                    # generateServer
      all.ts                       # generateAll (parse → lower → emit), assembles GeneratedBundle
      emit.ts                      # banner, module-path imports, stable ordering, formatter
      module-path.ts               # file path ↔ api path normalization (Convex rules)
    write/
      write-generated.ts           # writeGenerated: diff-on-disk, write-if-changed, mkdir -p
  authoring/                       # the schema superset shim (shipped to apps that shard)
    define-table.ts                # defineTable superset with .shardKey(field) (§7)
  test/
    fixtures/                      # sample convex/ dirs (incl. the WhatsApp schema)
    golden/                        # expected _generated/ outputs (snapshot)
    typecheck/                     # tsd/expect-type compile fixtures (positive + negative)
```

`generateAll` is the orchestrator:

```
parse schema (runtime|static)
  → lower indexes (append _creationTime,_id; synthesize standard indexes)
  → extract & validate shard keys
  → hash → SchemaDefinition
analyze functions (runtime|static) → manifest
emit api / dataModel / server  → GeneratedBundle{ files, schema, warnings }
```

The CLI calls `generateAll` then `writeGenerated`. The engine, separately, calls the same parse path
(or receives the `SchemaDefinition` from the bundle) — **one parser, one source of truth**, so the
types the app sees and the indexes the engine builds can never disagree.

---

## 6. Key algorithms

### 6.1 Runtime schema parse (`parseSchemaFromValue`)

`import("${convexDir}/schema")` yields a Convex `SchemaDefinition` value. Walk `.tables`; for each
`TableDefinition`: read its object validator (`.validator` → `.json` ⇒ `ValidatorJSON`), `.indexes`
(`{indexDescriptor, fields}`), `.searchIndexes`, `.vectorIndexes`, and our shard-key brand (§7).
Convert to `ParsedTableDefinition`. Read `schemaValidation` off the schema value. This is the
high-fidelity path — types come from the real validators.

### 6.2 Static schema parse (`parseSchemaFromSource`)

Parse `schema.ts` with the TypeScript compiler API (`ts.createSourceFile`). Locate the
`defineSchema({...})` call; for each property, locate the `defineTable({...})` call and its chained
`.index(name, [fields])` / `.searchIndex(...)` / `.vectorIndex(...)` / `.shardKey(field)`. Lower each
validator *expression* (`v.string()`, `v.object({...})`, `v.union(...)`, `v.id("t")`, …) into
`ValidatorJSON` by structural recognition of the call tree. Non-statically-resolvable validators
(imported constants, computed expressions) lower to `{type:"any"}` with a `STATIC_VALIDATOR_DEGRADED`
warning. Used when imports are unsafe/unavailable; documented as lower fidelity.

**Cross-mode equivalence is a tested invariant** (§9): for statically-analyzable schemas, runtime and
static parse must produce the *same* `SchemaDefinition`.

### 6.3 Index lowering (`index-lowering.ts`)

The engine's read-set/cursor machinery requires every index key to be globally unique and totally
ordered ([internals/04](../internals/04-query-engine.md)). Codegen is the single place that resolves
this so codegen and engine agree:

- **Append implicit tiebreakers.** Every declared index `["status"]` becomes
  `["status","_creationTime","_id"]`. (Open issue from internals/04 — whether `_creationTime` is
  always appended or only `_id` — is resolved here, once, and both the generated `DataModel` index
  metadata and the engine read this lowered list.)
- **Synthesize standard indexes.** Add `by_creation_time = ["_creationTime","_id"]` and
  `by_id = ["_id"]` to every table (these back un-indexed scans and `db.get`).
- **De-dupe & validate.** Reject duplicate index names, empty field lists, fields not present in the
  document validator (unless schemaless), and indexes over system fields the user can't index on.
  Errors are `INDEX_INVALID` with `path:[table,index]`.

### 6.4 Manifest → api tree (`api-tree.ts`)

- **Module path normalization** (`module-path.ts`, Convex rules): `convex/messages.ts` → `messages`;
  `convex/chat/messages.ts` → `chat.messages` (nested namespace); `convex/foo/index.ts` → `foo`;
  reject path segments that aren't valid TS identifiers (`API_PATH_COLLISION`/`RESERVED_NAME`).
- **Build nested object** from dotted paths; each leaf is a function export. Reserve `api`,
  `internal`, `internalApi` as top-level names.
- **Visibility is decided by the types**, not by us splitting the tree: we emit every module into
  `fullApi`; `FilterApi<…, "public">` / `"internal">` partitions it. (Static mode partitions
  manually from `AnalyzedFunction.visibility`.)
- **Collisions** (two exports mapping to one api path) → `API_PATH_COLLISION` with both `pos`.

### 6.5 Deterministic emission (`emit.ts`, `write-generated.ts`)

- **Stable ordering.** Tables, fields, indexes, modules, and functions are emitted in a fixed
  (lexicographic) order regardless of input order → output is a pure function of input *content*.
- **Idempotent writes.** `writeGenerated` reads each target file; if byte-identical, it is left
  untouched (preserves mtime, avoids re-triggering the dev watcher / editor reloads). Only changed
  files are rewritten; parent dirs `mkdir -p`'d.
- **No external formatter.** Output is pre-formatted to a fixed style; no Prettier dependency, so
  codegen has no formatting-config coupling and runs in any environment.

---

## 7. The shard-key seam (rows 1–2) — how it is reserved

The mandate ([strategy.md](../strategy.md), [scalability-spectrum §2.1](../scalability-spectrum.md)):
*a conversation is a shard → single-writer-per-shard = unbounded write scale.* The Foundation
obligation is that **the shard key lives in the data model and threads through to the engine, declared
once in schema, surfaced by codegen with zero hand-edits** — even though Tier 0 has exactly one shard
`"default"` and ignores it.

### Declaration (opt-in, Convex-superset)

Default Stackbase apps author schema with pure `convex/server` `defineTable` (full Convex compat,
no shard key). A table that wants to be shardable imports `defineTable` from `@stackbase/codegen/authoring`
— a **structural superset**:

```ts
// convex/schema.ts  — the ONLY change to adopt sharding later
import { defineSchema } from "convex/server";
import { defineTable } from "@stackbase/codegen/authoring";  // superset of convex/server's
import { v } from "convex/values";

export default defineSchema({
  messages: defineTable({
    conversationId: v.id("conversations"),
    authorId: v.id("users"),
    body: v.string(),
  })
    .index("by_conversation", ["conversationId"])
    .shardKey("conversationId"),          // <-- reserved seam; inert at Tier 0
});
```

`@stackbase/codegen/authoring`'s `defineTable` returns a value **assignable to Convex's
`TableDefinition`** (it *is* one, plus a non-enumerable `__stackbaseShardKey` brand), so
`defineSchema` from `convex/server` still accepts it and `DataModelFromSchemaDefinition<typeof schema>`
is unchanged. `.shardKey(f)` is type-checked to require `f` be a key of the table's validator.

```ts
// authoring/define-table.ts (sketch)
export function defineTable<T>(documentSchema: T) {
  const base = convexDefineTable(documentSchema);          // the real convex builder
  return Object.assign(base, {
    __stackbaseShardKey: undefined as string | undefined,
    shardKey(field: keyof InferFields<T> & string) {
      (this as any).__stackbaseShardKey = field;
      return this;                                          // still a convex TableDefinition
    },
  });
}
```

### Why this preserves the cross-tier invariant

- **`DataModelFromSchema` ignores the brand** (§3.3): `Doc`, `Id`, `DataModel`, and the entire `api`
  are byte-identical whether or not `.shardKey` was called. The shard key is surfaced only in the
  *separate* `ShardKeys` type and in `SchemaDefinition.tables[t].shardKey`. **Tested invariant**
  (§9): generating with vs without `.shardKey` yields identical `api.d.ts` and identical `DataModel`;
  only `dataModel.d.ts`'s `ShardKeys` line and the parsed `SchemaDefinition` differ.
- **One declaration, full propagation.** `schema.ts` → parser → `ShardKeyDefinition` →
  `SchemaDefinition.tables[t].shardKey` → (a) generated `ShardKeys` type, (b)
  `syncRuntimeMetadata` persisted schema doc ([internals/07](../internals/07-platform-services.md)),
  (c) at Tier 2, `ShardRouter.getShardForDocument(doc)` reads the field from the row. No engine or
  app rewrite — promoting to per-conversation sharding is *turning on the router* + this one
  already-present line.

### Validation

If a table declares a shard key it must be **honest**: the field exists in the document validator,
is **required** (not `v.optional`), and is a scalar or `v.id(...)` (the partitionable types). Violation
is `SHARD_KEY_INVALID` (declaring the seam wrong is a hard error; *not* declaring one is fine). At
Tier 0 the value is still recorded but never used to route — the seam is present and inert.

---

## 8. Tier 0 behavior (now) & the scale path (later)

### Tier 0 — single binary, today

Codegen runs inside the CLI: `stackbase codegen` (one-shot) and inside `stackbase dev`'s watch loop
(on `convex/**` change → regenerate → write-if-changed → push). At Tier 0:

- **Runtime mode** imports `convex/schema` and analyzes `convex/**` via the in-process executor's
  module registry (no network — same address space as the embedded runtime,
  [internals/06](../internals/06-runtimes-topology.md)).
- Emits `convex/_generated/` (committed to VCS — required for the app to typecheck, the same
  contract as Convex).
- The parsed `SchemaDefinition` is handed to the embedded runtime so `DocStore.setupSchema`,
  `SchemaService`, and `IndexManager` build indexes; `syncRuntimeMetadata` persists schema +
  index metadata, versioned by `SchemaDefinition.hash` so re-pushes that don't change the schema do
  no work.
- Shard keys are parsed and surfaced but **inert**: the embedded runtime is one shard `"default"`
  ([scalability-spectrum §2.1](../scalability-spectrum.md)).

`stackbase init` scaffolds `convex/` + an empty-but-valid `_generated/` so a fresh project typechecks
before the first `dev`.

### The scale path — attaches with no app-code/engine rewrite

Two independent guarantees make Endpoint B (WhatsApp-class) reachable as *config + adapters*:

1. **The `api` type is frozen across tiers.** Because `api`/`Doc`/`Id`/`DataModel` are delegated to
   `convex/server`'s topology-free generics, the client's type contract is identical at Tier 0 and
   Tier 2. Scaling the backend (executor pool, sharded committers, separate sync fleet) changes the
   *runtime*, never the generated `api` (seam-table row 10's "wire encoding swaps, state model
   doesn't" has its type-level analog here: the *type* model never moves). No re-codegen, no
   client diff.
2. **The shard key is already in the data model.** It flowed from `schema.ts` through codegen into
   `SchemaDefinition` and `ShardKeys` from day one. Turning on Tier-2 sharding means the
   `ShardRouter` starts reading a field codegen has surfaced all along — **zero hand-edits** to app
   code or generated types, exactly as the component's scaleSeam requires.

Infinite-scrollback pagination (seam row 7) needs nothing from codegen beyond correct index field
lists with tiebreakers (§6.3): the same `paginate()` app code runs over a 100-row dev table or a
billion-row conversation because the generated `Doc`/`Id`/index types are size- and tier-independent.

---

## 9. Failure & edge handling

| Case | Behavior |
|---|---|
| **No `schema.ts`** | Schemaless: `DataModel = AnyDataModel`, `ShardKeys = Record<string,null>` (§4.5). Warn once. App still typechecks; engine skips write-validation. |
| **`schema.ts` import error (runtime mode)** | Auto-fall back to static parse. If static also fails → `SCHEMA_PARSE_FAILED` with `pos`; **do not overwrite** existing `_generated/` (never clobber a good gen with a broken parse). Non-zero exit in CLI. |
| **Non-resolvable validator (static mode)** | Lower to `{type:"any"}`, attach `STATIC_VALIDATOR_DEGRADED` warning pointing at the field; recommend runtime mode. |
| **Invalid index** (dup name, empty fields, field absent from validator, system-field index) | `INDEX_INVALID`, `path:[table,index]`, refuse to emit. |
| **Invalid shard key** (missing/optional/non-scalar field) | `SHARD_KEY_INVALID` with remedy; refuse to emit. (Absent shard key is *not* an error.) |
| **api path collision / reserved name** (`api`, `internal`, non-identifier segment) | `API_PATH_COLLISION` / `RESERVED_NAME` with both source positions. |
| **`_generated/` not writable** | `WRITE_FAILED` with the path and a remedy (permissions / check VCS ignore). |
| **Unchanged input** | `writeGenerated` writes nothing (byte-diff skip) — no watcher thrash, no spurious VCS churn. |
| **Module exports a non-UDF** (helper) | Ignored for the api tree (only `query`/`mutation`/`action`/`http` exports become references), matching Convex. |
| **`httpAction` / crons** | Not placed in the `api` tree (Convex parity); they remain in the manifest for their own consumers (HTTP router / cron sync). |
| **Schema references `_generated`** | Forbidden cycle; `schema.ts` must not import from `_generated/`. Detected in parse; `SCHEMA_INVALID` with remedy. (Functions importing `_generated` is normal and fine.) |
| **Partial write crash** | Files are written one-by-one but each is atomic (write temp + rename). A crash leaves a mix of old/new valid files; the next `codegen` converges (idempotent). |

CLI surfaces `CodegenError.pos`/`remedy` as a Convex-grade diagnostic (file:line, the offending
path, one-line fix) — DX is the product (strategy.md).

---

## 10. Test strategy

> Scope honesty: codegen owns **no transactions and no key codec**. The prompt's "order-preserving
> codec round-trip/ordering" and "OCC conflict cases" property tests belong to the **query-engine**
> ([internals/04](../internals/04-query-engine.md)) and **transactor**
> ([internals/02](../internals/02-transactions-consistency.md)) components, respectively, and are
> specified there. Codegen's load-bearing properties are *parse fidelity, emit determinism, and
> type-contract invariance* — tested below.

### Unit

- **`validatorToJson` / `jsonToValidator`** for every `v.*` (scalars, `id`, `literal`, `array`,
  `object` with optionals, `record`, nested `union`) and deep nestings.
- **`validatorToTsType`** snapshot tests for each shape, incl. `Id<"t">` mapping, optional → `?`,
  union → `A | B`, record → `Record<K,V>`.
- **Index lowering**: tiebreakers appended; standard indexes synthesized; dup/empty/missing-field
  rejected.
- **Module-path normalization**: `messages.ts`, `chat/messages.ts`, `foo/index.ts`, invalid
  segments, reserved names.
- **api-tree visibility**: public vs internal partition; collisions error with positions.
- **Shard-key extraction**: present / absent / invalid (optional, missing, non-scalar).

### Property tests (where genuinely relevant)

1. **Validator round-trip** — for randomly generated validator trees, `jsonToValidator ∘
   validatorToJson` is structural identity (the codegen-relevant analog of a round-trip property; it
   guards the engine↔codegen↔wire boundary).
2. **Emit determinism / order-independence** — permuting input table/field/index/module/function
   order yields **byte-identical** output (no diff churn); `generate(input)` is a pure function of
   content.
3. **Idempotence** — `writeGenerated` on already-generated output writes **zero** files.
4. **Cross-mode equivalence** — for statically-analyzable fixtures, `RuntimeSchemaSource` and
   `StaticSchemaSource` produce the **same** `SchemaDefinition`.
5. **Scale-seam invariance (the literal seam test)** — for any schema, generating with vs without
   `.shardKey(...)` on any table yields **identical `api.d.ts` and identical `DataModel`**; only the
   `ShardKeys` line and `SchemaDefinition.tables[t].shardKey` differ. This is the executable proof
   that adopting sharding cannot perturb app-visible types.
6. **Hash stability** — `SchemaDefinition.hash` is invariant under input reordering and changes iff
   the normalized schema changes (drives `syncRuntimeMetadata` correctness).

### Type-level / compile tests (the real acceptance gate)

Golden `_generated/` outputs are compiled with `tsc --noEmit` against a fixture that imports the
published `convex/react`:

- **Positive**: `useQuery(api.messages.list, { conversationId })` typechecks; `ctx.db.query("messages")`
  yields `Doc<"messages">`; `Id<"messages">` is assignable where expected.
- **Negative** (`tsd`/`expect-type` `// @ts-expect-error`): wrong arg type, unknown table in
  `db.get`, wrong `Id<"t">`, calling an `internal` function via `api`, wrong return-type usage — each
  must be a **compile error**. These are what prove "Convex-grade end-to-end type safety."

### Integration

- Full WhatsApp fixture (`schema.ts` + modules) → `generateAll` → `tsc` passes; flip `messages` to
  `.shardKey("conversationId")` → re-generate → diff shows **only** `ShardKeys` changed; `tsc` still
  passes; the parsed `SchemaDefinition` now carries the shard key for the engine.
- Golden-file snapshot of every emitted file for the fixture set (catches accidental template drift).

---

## 11. Open issues

- **`internal` vs `internalApi` naming.** Convex's generated export is `internal`; the component spec
  says `internalApi`. Decision in this doc: emit `internal` (drop-in Convex compat) **and** an
  `internalApi` alias. Confirm we keep the alias long-term or deprecate one.
- **Static-mode fidelity ceiling.** Imported/computed validators degrade to `any`. Need to decide
  whether `--static` is "best-effort dev convenience" or must hit a guaranteed fidelity bar (e.g.
  resolve single-file imports). Affects how loudly we steer users to runtime mode.
- **Shard-key authoring ergonomics.** The `@stackbase/codegen/authoring` `defineTable` superset vs a
  pure-comment convention (`// @shardKey conversationId`) the static parser could read with *zero*
  new imports. Superset is type-safe; convention is more drop-in. Pick one primary (this doc favors
  the superset) before apps adopt it, since it is a public authoring surface.
- **Component scoping (deferred).** `componentPath` exists in the manifest but components are out of
  Foundation scope. Confirm the api-tree and `DataModel` generation reserve a clean place for
  per-component namespacing so it layers on without reshaping the generated files.
- **Tiebreaker policy lock.** §6.3 resolves internals/04's open question (`_creationTime,_id` vs
  `_id`) by always appending both. This must match the query engine's cursor/`getStandardIndexes`
  behavior exactly — needs a single shared constant both components import, or a contract test across
  the two packages.
- **`returns`-validator availability.** Convex return validators are optional; when absent, generated
  return types are `any`. Decide whether Stackbase encourages/requires `returns` for full-fidelity
  static mode and tighter client types.
- **Where `SchemaDefinition` is the canonical handoff.** Confirm the engine consumes the
  `GeneratedBundle.schema` value directly (in-process at Tier 0) vs re-parsing — one parser is the
  invariant; we must wire the embedded runtime to the codegen output, not a second parse.
