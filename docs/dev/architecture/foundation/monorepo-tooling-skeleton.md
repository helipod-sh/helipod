---
title: Foundation — Monorepo & Tooling Skeleton
status: design (implementation-ready)
slice: Foundation
component: monorepo-tooling-skeleton
audience: engineering (internal)
depends_on: []
---

# Foundation — Monorepo & Tooling Skeleton

> **Updated 2025-06-07 — migrated to Bun.** The repo now uses **Bun workspaces** (the package
> manager + runtime) with **Turborepo** orchestration and **vitest** (run under Bun); `pnpm` is no
> longer used. The workspace globs + the dependency `catalog` live in the root `package.json`
> (`"workspaces": { "packages": [...], "catalog": {...} }`); the lockfile is `bun.lock`. Top-level
> dirs: `packages/` (engine + SDK), `components/` (pluggable components), `apps/`, `examples/`.
> Commands: `bun install`, `bun run build|test|typecheck`, `bun run --filter <pkg> <script>`.
> The `pnpm`-specific details below are **historical** (the original design); the structure/intent
> still applies, only the package manager changed.

> Clean-room design. Where this doc names a Convex/`@concavejs` type, it is reproducing a
> **public interop fact** (the validator JSON wire shape, the value total order, the document-id
> string format) so our `AnalyzedModule` / schema export / value encoding are byte-compatible with
> tools a developer already trusts. No FSL source was copied; see [`.reference/README.md`](../../../../.reference/README.md).

This is the **first thing built in the Foundation slice** and the only component every other
component imports. It is two things welded together:

1. **The monorepo & tooling skeleton** — the pnpm workspace, the shared TypeScript build graph
   (project references + `tsc -b`), the task orchestration (topological build/test/typecheck/lint),
   the `stackbase` / `pnpm` command surface, and the **dependency-direction lint rule** that keeps
   the engine pure.
2. **The zero-dependency shared contracts** — three pure-TypeScript packages (`@stackbase/values`,
   `@stackbase/errors`, `@stackbase/contracts`) at the root of the dependency graph that define the
   `Value` union, the `v`/`Validator` + `defineSchema`/`defineTable` authoring surface, `Id<Table>`,
   the `StackbaseError` HTTP-mapped hierarchy, `AnalyzedModule`, and the serializable
   cross-process primitives (`ShardId`, `SerializedKeyRange`, `WriteInvalidation`).

The component carries **no engine logic**. It carries the *contracts* the engine and everything
around it agree on, and the *structure* that makes the [scalability mandate](../scalability-spectrum.md)
mechanically true: **package boundaries are the tier-split points**, so a Tier 2 host, a standalone
sync-node, or a Postgres committer is a *new leaf package*, never an edit to `packages/server`.

---

## 1. Purpose & boundaries

### 1.1 What it owns

- **The pnpm workspace**: `pnpm-workspace.yaml`, the root `package.json` script surface, the
  reserved directory slots (`packages/adapters/*`, `packages/runtime-*`, `packages/transport-*`).
- **The shared TypeScript config**: `tsconfig.base.json`, the project-reference graph, the root
  `tsconfig.json` that builds everything topologically with `tsc -b`.
- **Task orchestration**: `turbo.json` (or the pnpm-recursive fallback) wiring `build`, `dev`,
  `typecheck`, `test`, `lint`, `depcruise` to run in dependency order.
- **The `stackbase` command surface**: the bin entry, the `CliCommand` registry contract, and the
  top-level dispatcher (`stackbase <cmd>`, `--help`, `--version`). Command *bodies* (`dev`, `deploy`,
  `codegen`, `init`) are owned by their components; this owns the *surface* they plug into.
- **The dependency-direction enforcement**: the `dependency-cruiser` ruleset + ESLint
  `no-restricted-imports` guards that make "the engine imports only interfaces, never a
  driver/host/transport/socket" a CI failure, not a code-review hope.
- **`@stackbase/values`** — the Convex-compatible authoring & value contract (zero third-party deps):
  `Value`, `GenericId`/`Id`, `compareValues`, the value↔JSON codec, `Validator`/`v`, `ValidatorJSON`,
  `Infer`, `ConvexError`, `defineSchema`/`defineTable`, and the schema export JSON.
- **`@stackbase/errors`** — the `StackbaseError` HTTP-mapped hierarchy + helpers.
- **`@stackbase/contracts`** — `AnalyzedModule` (+ analyzed types), the serializable invalidation
  primitives (`ShardId`, `SerializedKeyRange`, `WriteInvalidation`), and **the physical home for
  every cross-package interface seam** (`DocStore`, `SyncWebSocket`, `Transactor`, …). This component
  creates the package, the file layout, `AnalyzedModule`, and the invalidation types; **sibling
  Foundation specs author the signatures of their own interfaces inside it.**

### 1.2 What it does NOT own

- **Any implementation.** No SQL, no isolate, no socket, no transactor, no query planner. Those are
  `packages/server`, `packages/adapters/*`, `packages/runtime-*`.
- **The order-preserving index-key byte codec** (`encodeIndexKey`/`compareIndexKeys`). That is the
  **query-engine** component ([internals/04](../internals/04-query-engine.md)). This component owns
  the *normative value total order* (`compareValues`) that the codec's bytes **must** reproduce — the
  codec's ordering property test uses our `compareValues` as its oracle, but the bytes live there.
- **The document-id codec** (varint+fletcher16+base32 encode/decode). That is **storage**
  ([internals/01](../internals/01-storage.md)). This component owns only the `Id<Table>` *type* and
  the `v.id(table)` *validator*; the runtime string ↔ bytes conversion is storage's.
- **Module analysis logic** (`analyzeModule`). That is **UDF execution**
  ([internals/05](../internals/05-udf-execution.md)). This component owns the `AnalyzedModule`
  *type* only.
- **The full signatures of `DocStore`, `SyncWebSocket`, `Transactor`, `UdfExec`, `AuthResolver`,
  …** — those are authored by their owning component specs. This component reserves their *home* and
  enforces *who may import them*.

### 1.3 The one-sentence contract

> Everything in the repo imports `@stackbase/values` / `@stackbase/errors` / `@stackbase/contracts`;
> nothing in those three imports anything else; `packages/server` imports only those three (never a
> leaf); a new backend or host is a new leaf package. CI fails if any of those sentences becomes
> false.

---

## 2. The dependency graph (the architecture this component encodes)

```
 LAYER 0  zero-dependency shared contracts   (THIS component — pure TS, no npm runtime deps)
 ────────────────────────────────────────────────────────────────────────────
   @stackbase/values     Value · Id · compareValues · value↔JSON · Validator · v ·
                         ValidatorJSON · Infer · ConvexError · defineSchema · defineTable
   @stackbase/errors     StackbaseError hierarchy (+ helpers)         depends: (none)
   @stackbase/contracts  AnalyzedModule · ShardId · SerializedKeyRange · WriteInvalidation ·
                         + interface seam (DocStore, SyncWebSocket, Transactor, …)
                                                                       depends (type-only): values, errors

 LAYER 1  the engine                          (sibling Foundation components; THIS reserves the slot + rule)
 ────────────────────────────────────────────────────────────────────────────
   @stackbase/server     transactor · query engine · index manager · sync handler · UDF host glue ·
                         schema service.  MAY import: values, errors, contracts.
                         MUST NOT import: any adapter / runtime / transport / host module.

 LAYER 2  leaf implementations               (THIS component RESERVES the slots; filled by this & later slices)
 ────────────────────────────────────────────────────────────────────────────
   packages/adapters/*       DocStore / BlobStore drivers     sqlite-node (now) · postgres · d1 (later)
   packages/runtime-*        hosts                            runtime-embedded (now) · runtime-node · runtime-cloudflare (later)
   packages/transport-*      transports                       transport-loopback (now) · transport-ws · transport-capnweb (later)

 CLIENT / TOOLING            (sibling components; THIS scaffolds their package.json + slot)
 ────────────────────────────────────────────────────────────────────────────
   @stackbase/client · @stackbase/react · @stackbase/cli · @stackbase/codegen
   apps/dashboard · examples/*
```

**The sacred direction (enforced by §8):** edges point *down* only. A leaf may import the engine and
the contracts; the engine may import only the contracts; the contracts import nothing outside Layer 0.
There is **no edge from `@stackbase/server` to any leaf** — that is the property that lets Endpoint B
(WhatsApp-scale) attach as new leaves with zero engine rewrite.

> "Zero-dependency" = **zero third-party runtime dependencies**. The three Layer-0 packages have an
> empty `dependencies` block in `package.json` (dev-deps for the build are fine). Intra-Layer-0
> *type-only* edges (`contracts` → `values`/`errors`) are permitted and are the only edges at the
> base of the graph.

---

## 3. Workspace skeleton

### 3.1 File layout

```
stackbase/
  package.json                 # root: scripts, devDependencies, packageManager: pnpm@9
  pnpm-workspace.yaml
  turbo.json                   # task graph (topological)
  tsconfig.base.json           # shared compiler options
  tsconfig.json                # solution file: references every package (tsc -b root)
  eslint.config.js             # flat config + no-restricted-imports guards
  .dependency-cruiser.cjs      # the architectural dependency rules
  vitest.workspace.ts          # test discovery across packages
  .npmrc                       # link-workspace-packages=true, save-workspace-protocol=rolling
  packages/
    values/                    # @stackbase/values   (Layer 0)
      package.json  tsconfig.json  tsup.config.ts
      src/
        index.ts               # re-exports value + validator + id
        value.ts               # Value, JSONValue, compareValues, convexToJson, jsonToConvex
        id.ts                  # GenericId, Id
        validator.ts           # Validator, v, ValidatorJSON, Infer, ObjectType
        convex-error.ts        # ConvexError (user-thrown, value-carrying)
        server.ts              # subpath @stackbase/values/server: defineSchema, defineTable, schema JSON
      test/
        value.order.prop.test.ts        # compareValues total-order property tests
        value.codec.prop.test.ts        # convexToJson/jsonToConvex round-trip
        validator.json.test.ts          # v.* -> ValidatorJSON snapshot + round-trip
    errors/                    # @stackbase/errors   (Layer 0)
      src/index.ts             # StackbaseError + families + helpers
      test/errors.test.ts
    contracts/                 # @stackbase/contracts (Layer 0)
      src/
        index.ts
        analyzed.ts            # AnalyzedModule, AnalyzedFunction, UdfType, Visibility, ...
        invalidation.ts        # ShardId, SerializedKeyRange, WriteInvalidation, serializeTimestamp
        seam/                  # interface homes (signatures authored by owning specs)
          docstore.ts          # DocStore, TimestampOracle, DatabaseAdapter      (storage / 01)
          transactor.ts        # Transactor, CommitResult, ChangeStreamConsumer  (txn / 02)
          sync.ts              # SyncWebSocket, SyncProtocolHandler, ServerMessage(02/03)
          executor.ts          # UdfExec, UdfExecutionAdapter, RuntimeServices    (udf / 05)
          runtime.ts           # RuntimeHost, WriteFanout, ShardRouter (reserved) (06)
          platform.ts          # BlobStore, SearchStore, VecStore, AuthResolver…  (07)
    server/                    # @stackbase/server   (Layer 1) — reserved, engine slice fills it
      package.json  tsconfig.json
      src/index.ts
    adapters/                  # Layer 2 — reserved slot (workspace glob packages/adapters/*)
      sqlite-node/             # filled by the storage slice
    client/  react/  cli/  codegen/
  apps/
    dashboard/                 # later slice — slot reserved
  examples/
    chat/                      # runnable sample + integration test target
```

### 3.2 `pnpm-workspace.yaml`

```yaml
packages:
  - "packages/*"
  - "packages/adapters/*"
  - "packages/runtime-*"
  - "packages/transport-*"
  - "apps/*"
  - "examples/*"
```

The globs **are** the reserved slots: dropping `packages/adapters/postgres` or
`packages/runtime-cloudflare` on disk auto-enrolls it with no workspace edit. Internal deps use the
`workspace:*` protocol so they always resolve to the local source.

### 3.3 `tsconfig.base.json` (the shared compiler contract)

```jsonc
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2022"],
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,   // matters: distinguishes {a?:T} from {a:T|undefined}
    "isolatedModules": true,
    "verbatimModuleSyntax": true,         // import type discipline -> reliable dep-cruiser type-only detection
    "composite": true,                    // enables project references / tsc -b
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
    "incremental": true,
    "skipLibCheck": true
  }
}
```

Each package `tsconfig.json` extends this, sets `outDir: dist`, `rootDir: src`, and lists its
workspace deps under `references`. The root `tsconfig.json` references every package so `tsc -b`
(a) orders the build topologically and (b) gives a single repo-wide typecheck. **Project references
are the source of truth for type topology** — even with turbo absent, `tsc -b` builds in the right
order.

### 3.4 Task orchestration — `turbo.json`

```jsonc
{
  "$schema": "https://turbo.build/schema.json",
  "tasks": {
    "build":     { "dependsOn": ["^build"], "outputs": ["dist/**", "*.tsbuildinfo"] },
    "typecheck": { "dependsOn": ["^build"], "outputs": ["*.tsbuildinfo"] },
    "test":      { "dependsOn": ["^build"], "outputs": ["coverage/**"] },
    "dev":       { "cache": false, "persistent": true },
    "lint":      { "dependsOn": [] }
  }
}
```

`^build` = "build my workspace dependencies first" → topological. Turbo is a *cache+scheduler*; the
correctness floor is `tsc -b` + pnpm, so turbo is replaceable. Root scripts:

```jsonc
// package.json (root)
{
  "packageManager": "pnpm@9.x",
  "scripts": {
    "build":     "turbo run build",
    "dev":       "turbo run dev --parallel",
    "typecheck": "tsc -b",
    "test":      "vitest run",
    "lint":      "eslint .",
    "depcruise": "depcruise packages --config .dependency-cruiser.cjs",
    "check":     "pnpm typecheck && pnpm lint && pnpm depcruise && pnpm test"
  }
}
```

`pnpm check` is the single CI gate. `pnpm depcruise` is the architectural gate (§8).

### 3.5 The `stackbase` command surface

`packages/cli/package.json` declares `"bin": { "stackbase": "./dist/bin.js" }`. This component ships
the **dispatcher + registry contract**; commands register into it from their owning components.

```ts
// @stackbase/cli — owned-skeleton (bodies are other components')
export interface CliContext {
  cwd: string;
  env: Record<string, string | undefined>;
  logger: Logger;                       // structured, level-aware; DX-critical
  stdout: NodeJS.WritableStream;
  stderr: NodeJS.WritableStream;
}

export interface CliCommand {
  readonly name: string;                // "dev" | "deploy" | "codegen" | "init"
  readonly summary: string;             // one line for `stackbase --help`
  readonly usage?: string;
  run(ctx: CliContext, argv: string[]): Promise<number>;  // resolves to a process exit code
}

export interface CommandRegistry {
  register(command: CliCommand): void;
  get(name: string): CliCommand | undefined;
  list(): readonly CliCommand[];
}

/** Top-level entry: parse `stackbase <cmd> ...`, handle --help/--version, dispatch. */
export function runCli(
  registry: CommandRegistry,
  argv: string[],
  ctx: CliContext,
): Promise<number>;
```

The target end-user surface (commands filled by later components, surface owned here):

```bash
stackbase init      # scaffold a convex/ project + stackbase.config.ts
stackbase dev       # watch convex/, push, run the embedded Tier-0 engine + sync   (Foundation: runtimes/cli)
stackbase codegen   # emit convex/_generated/* from schema + AnalyzedModule         (Foundation: codegen)
stackbase deploy    # later slice
stackbase --help / --version
```

---

## 4. `@stackbase/values` — the Convex-compatible authoring & value contract

This is the load-bearing interop package. Its outputs (`ValidatorJSON`, the schema export JSON, the
value↔JSON encoding) must be **byte-identical** to what a Convex client/codegen expects, because they
flow into `AnalyzedModule`, over the wire, and into generated types.

### 4.1 `Value` and `Id`

```ts
// @stackbase/values/value.ts

/** The Convex-compatible value universe. This is the ONLY data the engine persists/transports. */
export type Value =
  | null
  | boolean
  | number                                   // IEEE-754 float64  (v.number / v.float64)
  | bigint                                   // signed int64       (v.int64 / v.bigint)
  | string                                   // UTF-8
  | ArrayBuffer                              // bytes              (v.bytes)
  | ReadonlyArray<Value>                     // array
  | { [key: string]: Value | undefined };    // object; an `undefined` field == absent

/** Wire form: strict JSON. `Value` is NOT JSON (bigint/ArrayBuffer/NaN/-0 need escaping). */
export type JSONValue =
  | null | boolean | number | string
  | JSONValue[]
  | { [key: string]: JSONValue };
```

```ts
// @stackbase/values/id.ts

/** Branded document id. The string format & codec are storage's; this is the TYPE only. */
export type GenericId<TableName extends string = string> = string & {
  readonly __tableName: TableName;
};
export type Id<TableName extends string = string> = GenericId<TableName>;
```

### 4.2 `compareValues` — the normative total order

This is the canonical ordering the whole engine sorts and ranges by. The **query-engine's byte codec
must reproduce this order** (its property test asserts `compareIndexKeys(encode(a), encode(b)) ===
compareValues(a, b)`). Cross-type order is **by type tag, not numeric** — `5.0` (number) sorts before
`3n` (bigint) because the number *type* precedes the bigint *type*:

```ts
export type Cmp = -1 | 0 | 1;

/**
 * Total order over Value. Cross-type order (by tag):
 *   null < boolean < number < bigint < string < bytes < array < object
 * Within-type:
 *   number  — IEEE-754 float64 order via the codec transform; -0 === +0; NaN canonicalized
 *             to the single largest number-typed value.
 *   bigint  — signed numeric.
 *   string  — UTF-8 code-unit (lexicographic on the encoded octets).
 *   bytes   — unsigned byte lexicographic; shorter-is-smaller on shared prefix.
 *   array   — element-wise compareValues; shorter-is-smaller on shared prefix.
 *   object  — compare by entries sorted on key (UTF-8), as a flattened (key, value, key, value…)
 *             tuple; `undefined` fields are treated as absent.
 */
export function compareValues(a: Value, b: Value): Cmp;

/** Convenience predicates built on compareValues. */
export function valuesEqual(a: Value, b: Value): boolean;
```

> The scalar cross-type order (`null < boolean < number < bigint < string < bytes`) is the
> interop-locked part from [internals/04](../internals/04-query-engine.md). The `array`/`object`
> tail position is **our** extension; see open issue O-1.

### 4.3 Value ↔ JSON codec (interop-locked)

```ts
/** Encode a Value to strict JSON using Convex's escape conventions. */
export function convexToJson(value: Value): JSONValue;
/** Decode JSON (in Convex escape form) back to a Value. Throws ValueDecodeError on malformed input. */
export function jsonToConvex(json: JSONValue): Value;
```

Encoding rules (must match exactly):

| Value | JSON encoding |
|---|---|
| `null` / `boolean` / `string` | as-is |
| finite `number` (not `-0`) | JSON number |
| `NaN`, `±Infinity`, `-0` | `{ "$float": "<base64 of 8 LE float64 bytes>" }` |
| `bigint` | `{ "$integer": "<base64 of 8 LE int64 bytes>" }` |
| `ArrayBuffer` | `{ "$bytes": "<base64>" }` |
| `Value[]` | JSON array of encoded elements |
| object | JSON object of encoded fields; a field whose value is `undefined` is **omitted** |
| object whose own key starts with `$` | escaped (reserved-prefix rule) so `{ "$foo": … }` round-trips unambiguously |

The reserved-`$`-prefix rule and the `$integer`/`$bytes`/`$float` tags are Convex facts; they are why
this codec is a **property-tested round-trip** (§9), not a casual `JSON.stringify`.

### 4.4 `Validator`, `v`, and `ValidatorJSON`

```ts
// @stackbase/values/validator.ts

export type OptionalProperty = "optional" | "required";

/** A validator. The type params are phantom (compile-time); `.json` is the runtime payload. */
export interface Validator<
  Type = unknown,
  IsOptional extends OptionalProperty = "required",
  FieldPaths extends string = never,
> {
  /** phantom — never read at runtime */
  readonly type: Type;
  readonly isOptional: IsOptional;
  readonly fieldPaths: FieldPaths;
  /** the serializable, interop-locked form */
  readonly json: ValidatorJSON;
  /** runtime check; returns a typed error path on failure (no throw) */
  validate(value: Value, path?: string[]): ValidationFailure | null;
}

export interface ValidationFailure {
  path: string[];                 // e.g. ["author", "name"]
  message: string;                // human readable
  expected: string;               // validator kind expected
}
```

The **interop-locked** serialized union (this is the wire shape consumed by `AnalyzedModule`, codegen,
schema service, dashboard — it must match Convex):

```ts
export type ValidatorJSON =
  | { type: "null" }
  | { type: "number" }                                          // float64
  | { type: "bigint" }                                          // int64
  | { type: "boolean" }
  | { type: "string" }
  | { type: "bytes" }
  | { type: "any" }
  | { type: "literal"; value: JSONValue }                       // value in convexToJson form
  | { type: "id"; tableName: string }
  | { type: "array"; value: ValidatorJSON }
  | { type: "object"; value: Record<string, ObjectFieldJSON> }
  | { type: "record"; keys: ValidatorJSON; values: ObjectFieldJSON }
  | { type: "union"; value: ValidatorJSON[] };

export interface ObjectFieldJSON {
  fieldType: ValidatorJSON;
  optional: boolean;
}
```

The `v` factory (each returns a `Validator` with the right phantom type and `.json`):

```ts
export const v: {
  id<T extends string>(tableName: T): Validator<GenericId<T>>;
  null(): Validator<null>;
  number(): Validator<number>;
  float64(): Validator<number>;
  bigint(): Validator<bigint>;
  int64(): Validator<bigint>;
  boolean(): Validator<boolean>;
  string(): Validator<string>;
  bytes(): Validator<ArrayBuffer>;
  any(): Validator<any>;

  literal<L extends string | number | bigint | boolean>(value: L): Validator<L>;
  array<V extends Validator<any, "required", any>>(element: V): Validator<Infer<V>[]>;
  object<T extends PropertyValidators>(fields: T): Validator<ObjectType<T>, "required", FieldPathsOf<T>>;
  record<
    K extends Validator<string | GenericId<string>, "required", any>,
    V extends Validator<any, "required", any>,
  >(keys: K, values: V): Validator<Record<Infer<K>, Infer<V>>>;
  union<T extends Validator<any, "required", any>[]>(...members: T): Validator<Infer<T[number]>>;

  /** wraps a validator as optional; `.json` is the inner json — optionality is captured by the
   *  enclosing object field's `optional: true`. */
  optional<V extends Validator<any, OptionalProperty, any>>(
    value: V,
  ): Validator<Infer<V> | undefined, "optional", V["fieldPaths"]>;
};

export type PropertyValidators = Record<string, Validator<any, OptionalProperty, any>>;

/** Extract the TypeScript type a validator describes (load-bearing for codegen/DX). */
export type Infer<V extends Validator<any, any, any>> = V["type"];

/** Map a property-validator record to its object type, honoring optional fields. */
export type ObjectType<T extends PropertyValidators> =
  { [K in keyof T as T[K]["isOptional"] extends "optional" ? K : never]?: Infer<T[K]> } &
  { [K in keyof T as T[K]["isOptional"] extends "optional" ? never : K]:  Infer<T[K]> };
```

`v.optional(x).json === x.json`; the `optional` boolean is emitted by `v.object`/`defineTable` when it
walks fields. This matches Convex and is why object optionality lives on `ObjectFieldJSON.optional`,
not on a wrapper node.

### 4.5 `ConvexError` (compat — user-thrown, value-carrying)

```ts
// @stackbase/values/convex-error.ts
/** Thrown inside user functions with structured, client-visible data. Distinct from the engine's
 *  StackbaseError taxonomy: the engine catches this and maps it to a 400-class application error
 *  whose `data` is the (convexToJson-encoded) payload. */
export class ConvexError<TData extends Value = Value> extends Error {
  readonly name: "ConvexError";
  readonly data: TData;
  constructor(data: TData);
}
```

### 4.6 `defineSchema` / `defineTable` (subpath `@stackbase/values/server`)

Mirrors `convex/server` so `convex/schema.ts` authored against Convex *or* Stackbase produces the same
export JSON. The export JSON is the **schema-as-source-of-truth** consumed by codegen, the schema
service, and the dashboard.

```ts
// @stackbase/values/server.ts

export interface IndexDefinitionJSON       { indexDescriptor: string; fields: string[]; }
export interface SearchIndexDefinitionJSON { indexDescriptor: string; searchField: string; filterFields: string[]; }
export interface VectorIndexDefinitionJSON { indexDescriptor: string; vectorField: string; dimensions: number; filterFields: string[]; }

export interface TableDefinitionJSON {
  tableName: string;
  documentType: ValidatorJSON;             // normally an "object" validator
  indexes: IndexDefinitionJSON[];
  searchIndexes?: SearchIndexDefinitionJSON[];
  vectorIndexes?: VectorIndexDefinitionJSON[];
}

export interface SchemaDefinitionJSON {
  tables: TableDefinitionJSON[];
  schemaValidation: boolean;
}

export interface TableDefinition<
  Document = any,
  FieldPaths extends string = string,
  Indexes extends Record<string, string[]> = {},
> {
  index<Name extends string, Fields extends [FieldPaths, ...FieldPaths[]]>(
    name: Name,
    fields: Fields,
  ): TableDefinition<Document, FieldPaths, Indexes & { [k in Name]: Fields }>;
  searchIndex(name: string, cfg: { searchField: FieldPaths; filterFields?: FieldPaths[] }): this;
  vectorIndex(name: string, cfg: { vectorField: FieldPaths; dimensions: number; filterFields?: FieldPaths[] }): this;
  /** serialize to the wire schema */
  export(): TableDefinitionJSON;
  /** the document validator (internal carrier; consumed by SchemaService) */
  readonly validator: Validator<Document, "required", FieldPaths>;
}

export function defineTable<T extends PropertyValidators>(
  documentSchema: T,
): TableDefinition<ObjectType<T>, FieldPathsOf<T>>;
export function defineTable<V extends Validator<any, "required", any>>(
  documentSchema: V,
): TableDefinition<Infer<V>>;

export interface SchemaDefinition<Schema extends Record<string, TableDefinition> = any> {
  readonly tables: Schema;
  readonly schemaValidation: boolean;
  export(): SchemaDefinitionJSON;
}

export function defineSchema<Schema extends Record<string, TableDefinition<any, any, any>>>(
  schema: Schema,
  options?: { schemaValidation?: boolean },     // default true
): SchemaDefinition<Schema>;
```

Every index implicitly carries trailing `_creationTime` then `_id` tiebreakers (the query-engine
materializes this when it lowers `IndexDefinitionJSON` to a physical index; the *type* records only
the user-named fields, matching Convex). The **shard/partition key** the scalability mandate requires
is just an ordinary indexed field on the document (e.g. `conversationId`) — no schema-API change is
needed for it to exist; §7.2 explains how the router later hashes on it.

---

## 5. `@stackbase/errors` — the HTTP-mapped error hierarchy

One structured hierarchy; every error knows its own HTTP status and retryability, so the HTTP/sync
layers serialize any thrown value uniformly with no `switch`.

```ts
// @stackbase/errors

export interface StackbaseErrorJSON {
  error: string;          // human-readable message
  code: string;           // stable machine-readable code, e.g. "ARGUMENT_VALIDATION"
  retryable: boolean;
  data?: JSONValue;       // optional structured payload (already JSON)
}

export abstract class StackbaseError extends Error {
  abstract readonly code: string;
  abstract readonly httpStatus: number;
  readonly retryable: boolean;
  readonly data?: JSONValue;
  constructor(message: string, options?: { cause?: unknown; data?: JSONValue; retryable?: boolean });
  toJSON(): StackbaseErrorJSON;
  /** Rebuild a transport error on the client into a typed instance (best-effort by `code`). */
  static fromJSON(json: StackbaseErrorJSON): StackbaseError;
}
```

Families (status fixed per family; `code` unique per subclass):

```ts
// 400 — caller mistakes
export abstract class UserError extends StackbaseError { readonly httpStatus = 400; readonly retryable = false; }
export class ArgumentValidationError    extends UserError { readonly code = "ARGUMENT_VALIDATION"; }   // carries .data: ValidationFailure
export class DocumentNotFoundError      extends UserError { readonly code = "DOCUMENT_NOT_FOUND"; }
export class DocumentValidationError    extends UserError { readonly code = "DOCUMENT_VALIDATION"; }
export class FunctionNotFoundError      extends UserError { readonly code = "FUNCTION_NOT_FOUND"; }
export class FunctionTypeMismatchError  extends UserError { readonly code = "FUNCTION_TYPE_MISMATCH"; }
export class QueryError                 extends UserError { readonly code = "QUERY_ERROR"; }
export class IndexNotFoundError         extends UserError { readonly code = "INDEX_NOT_FOUND"; }
export class SystemFieldModificationError extends UserError { readonly code = "SYSTEM_FIELD_MODIFICATION"; }
export class SchedulingError            extends UserError { readonly code = "SCHEDULING_ERROR"; }
export class ForbiddenOperationError    extends UserError { readonly code = "FORBIDDEN_OPERATION"; } // fetch()/setTimeout() in query/mutation

// 401 / 403
export class AuthenticationError extends StackbaseError { readonly httpStatus = 401; readonly code = "UNAUTHENTICATED"; readonly retryable = false; }
export class AuthorizationError  extends StackbaseError { readonly httpStatus = 403; readonly code = "FORBIDDEN"; readonly retryable = false; readonly requiredRole?: string; }
export class InternalFunctionAccessError extends StackbaseError { readonly httpStatus = 403; readonly code = "INTERNAL_FUNCTION_ACCESS"; readonly retryable = false; readonly functionPath: string; }

// 409 — optimistic concurrency (PUBLIC; retryable). Distinct from the transactor's internal conflict sentinel.
export class ConflictError    extends StackbaseError { readonly httpStatus = 409; readonly retryable = true; readonly code = "CONFLICT"; }
export class OccConflictError extends ConflictError  { readonly code = "OCC_CONFLICT"; }

// 500 — internal
export abstract class SystemError extends StackbaseError { readonly httpStatus = 500; readonly retryable = false; }
export class DatabaseError            extends SystemError { readonly code = "DATABASE_ERROR"; }
export class StorageError             extends SystemError { readonly code = "STORAGE_ERROR"; }
export class StorageNotConfiguredError extends SystemError { readonly code = "STORAGE_NOT_CONFIGURED"; }
export class UdfExecutionError        extends SystemError { readonly code = "UDF_EXECUTION_ERROR"; }
export class ModuleLoadError          extends SystemError { readonly code = "MODULE_LOAD_ERROR"; }

// 503 — transient/retryable
export abstract class TransientError extends StackbaseError { readonly httpStatus = 503; readonly retryable = true; readonly retryAfterMs?: number; }
export class TimeoutError            extends TransientError { readonly code = "TIMEOUT"; }
export class RateLimitError          extends TransientError { readonly code = "RATE_LIMIT"; }
export class ServiceUnavailableError extends TransientError { readonly code = "SERVICE_UNAVAILABLE"; }

// helpers
export function isStackbaseError(e: unknown): e is StackbaseError;
export function isRetryableError(e: unknown): boolean;
export function getHttpStatus(e: unknown): number;                 // non-StackbaseError -> 500
export function toStackbaseError(e: unknown): StackbaseError;       // normalize ANY thrown value
```

**Naming discipline (locked):** the public, client-visible OCC error is `OccConflictError` (409,
retryable). The transactor's *internal* control-flow conflict signal — the thing the retry loop
catches and never lets escape to a client — is a **separate, non-exported** type owned by the
transactor component (working name `OccConflictSignal`). They must never be the same class; a test in
the transactor asserts an `OccConflictSignal` never reaches `toStackbaseError` without being converted.
`toStackbaseError` is the single normalization point the HTTP and sync layers call so an unexpected
`throw "oops"` still becomes a well-formed 500 envelope, never a leaked stack trace.

---

## 6. `@stackbase/contracts` — AnalyzedModule, invalidation primitives, the interface seam

### 6.1 `AnalyzedModule` (owned here; produced by the UDF-execution component)

```ts
// @stackbase/contracts/analyzed.ts

export type UdfType   = "query" | "mutation" | "action" | "httpAction";
export type Visibility = "public" | "internal";

export interface SourcePosition { line: number; column: number; }

export interface AnalyzedFunction {
  name: string;                          // export name
  udfType: UdfType;
  visibility: Visibility;
  args: ValidatorJSON | null;            // null = no/`v.any()` arg validator
  returns: ValidatorJSON | null;
  pos?: SourcePosition;
}

export interface AnalyzedHttpRoute {
  path: string;
  method: "GET" | "POST" | "PUT" | "DELETE" | "PATCH" | "OPTIONS";
  pos?: SourcePosition;
}

export interface AnalyzedCronSpec {
  name: string;
  schedule: { type: "cron"; cronspec: string } | { type: "interval"; seconds: number };
  functionPath: string;
  args?: JSONValue;
}

export interface AnalyzedModule {
  functions: AnalyzedFunction[];
  httpRoutes: AnalyzedHttpRoute[];
  cronSpecs: AnalyzedCronSpec[];
}

/** Declared here so codegen/cli/dashboard share the type; IMPLEMENTED by the UDF-execution component. */
export type AnalyzeModule = (module: unknown) => AnalyzedModule;
```

`AnalyzedModule` is the single artifact the deploy/push path, codegen, the router, and the dashboard
all agree on. Because its `args`/`returns` are `ValidatorJSON` from `@stackbase/values`, the validator
wire shape is the same object whether it was produced by app code, codegen, or introspection.

### 6.2 Serializable invalidation primitives (Foundation obligation, rows 1 & 4 of the scalability table)

The in-memory `KeyRange` (ArrayBuffer-backed) is owned by the query-engine. The **serialized** forms
below are the cross-package/cross-process wire contract and are reserved here so the write-fanout and
sync seams are serializable from day one — even though Tier 0 fan-out is an in-memory function call.

```ts
// @stackbase/contracts/invalidation.ts

/** Partition key. Tier 0 is always DEFAULT_SHARD_ID; Tier 2 derives it from the doc's shard field. */
export type ShardId = string;
export const DEFAULT_SHARD_ID: ShardId = "default";

/** Logical timestamp serialized as a decimal string (JSON has no bigint). */
export type SerializedTimestamp = string;
export function serializeTimestamp(ts: bigint): SerializedTimestamp;
export function deserializeTimestamp(s: SerializedTimestamp): bigint;

export interface SerializedKeyRange {
  tableId: string;                 // "table:<tableHex>" | "index:<tableHex>:<indexName>"
  startKey: string;                // base64 of the order-preserving key bytes
  endKey: string | null;           // null = unbounded to +infinity
  isPoint: boolean;
}

/** The payload a commit publishes to the write-fanout; the sync tier subscribes and intersects it
 *  against each subscription's read ranges. Serializable so Tier 2 can ship it cross-process. */
export interface WriteInvalidation {
  writtenRanges?: SerializedKeyRange[];
  writtenTables?: string[];        // coarse table-level fallback (the v1 invalidation granularity)
  commitTimestamp?: SerializedTimestamp;
  snapshotTimestamp?: SerializedTimestamp;
  shardId?: ShardId;               // present (DEFAULT_SHARD_ID at Tier 0) from day one
}
```

### 6.3 The interface seam (homes here; signatures authored by owning specs)

This component **creates the files and the dependency rule**; each interface's full signature is the
deliverable of its owning component spec. Representative skeletons only:

| Seam file | Interfaces (home) | Owning spec |
|---|---|---|
| `seam/docstore.ts` | `DocStore`, `TimestampOracle`, `DatabaseAdapter`, `DocumentLogEntry`, `LatestDocument` | storage / [01](../internals/01-storage.md) |
| `seam/transactor.ts` | `Transactor`, `TransactionHandle`, `CommitResult`, `ChangeStreamConsumer`, `OplogDelta` | txn / [02](../internals/02-transactions-consistency.md) |
| `seam/sync.ts` | `SyncWebSocket` (incl. `bufferedAmount`), `SyncProtocolHandler`, `SyncUdfExecutor`, `ServerMessage`, `ClientMessage`, `StateVersion` | sync / [03](../internals/03-reactivity-sync.md) |
| `seam/executor.ts` | `UdfExec`, `UdfExecutionAdapter`, `RuntimeServices`, `UdfResult` | udf / [05](../internals/05-udf-execution.md) |
| `seam/runtime.ts` | `RuntimeHost`, `WriteFanout`/`WriteFanoutAdapter`, `ShardRouter`, `SyncShardMap`, `SyncNodeLoadReport`, `SyncTopologyConfig` (reserved) | runtimes / [06](../internals/06-runtimes-topology.md) |
| `seam/platform.ts` | `BlobStore`, `SearchStore`, `VecStore`, `LogSink`, `AuthResolver`, `Principal` | platform / [07](../internals/07-platform-services.md) |

Two seam shapes this component **must** get right at reservation time, because retrofitting them is a
protocol break (scalability rows 5 & 6):

```ts
// seam/sync.ts — versioned, extensible so a non-commit ephemeral kind can be added later
export type ServerMessage =
  | { kind: "Transition"; /* … */ }       // derived from a commit (the only kind Tier 0 needs now)
  | { kind: "Broadcast";  /* … */ }       // RESERVED: presence/typing/read-receipts (non-durable, bypasses the log)
  | { kind: string;       /* forward-compatible */ };

// seam/sync.ts — the abstract socket; NEVER a concrete ws/DO type. Carries bufferedAmount from day one.
export interface SyncWebSocket {
  send(data: string | ArrayBuffer): void;
  close(code?: number, reason?: string): void;
  readonly readyState: number;
  readonly bufferedAmount: number;        // backpressure signal (no-op-ish on loopback, real on Tier 2)
}

// seam/runtime.ts — the publish/subscribe indirection between transactor and sync
export interface WriteFanoutAdapter {
  publish(payload: WriteInvalidation): void | Promise<void>;
  subscribe(listener: (payload: WriteInvalidation) => void): () => void;  // returns unsubscribe
  close(): void | Promise<void>;
}
```

The discipline this component enforces here: **no concrete socket/driver/host type ever appears in a
seam file or in `packages/server`.** A `ServerMessage` union that hard-wires only `Transition`, or a
sync interface that takes a `ws.WebSocket`, is a CI failure waiting to happen (§8) and a rewrite-to-
reach-Endpoint-B (the exact failure the scalability spec forbids).

---

## 7. How it works at Tier 0 (single binary) NOW

### 7.1 The composition

At Tier 0 there are no leaves split out across the network. `stackbase dev` (or an embedded
`createStackbase()`) wires:

```
@stackbase/runtime-embedded  (a Layer-2 leaf)
  ├─ imports @stackbase/server                         (engine: transactor, query, sync handler, executor host)
  ├─ imports @stackbase/adapters/sqlite-node           (DocStore impl)         ← a leaf, chosen here
  ├─ imports @stackbase/transport-loopback             (LoopbackWebSocket)     ← a leaf, chosen here
  └─ constructs a WriteFanoutAdapter = in-memory channel
@stackbase/server  imports ONLY  values · errors · contracts        (never the three leaves above)
```

The engine is handed a `DocStore`, a `SyncWebSocket` factory, and a `WriteFanoutAdapter` **as
interfaces from `@stackbase/contracts`**. It cannot tell it is on SQLite, loopback, and an in-memory
channel — that selection happens one layer out, in the `runtime-embedded` leaf. This is the whole
trick: the seam is a compile-time fact, enforced by §8.

Every contract this component owns is exercised on the Tier-0 hot path:
- `Value` / `convexToJson` — every arg/result crosses the loopback as JSON, decoded to `Value`.
- `v` / `ValidatorJSON` — args validated on entry; `AnalyzedModule.args` drives it.
- `defineSchema` export JSON — applied at start (`schemaBootstrap: "auto"`), feeds the schema service.
- `StackbaseError` — any throw becomes a uniform envelope via `toStackbaseError`.
- `WriteInvalidation` (`shardId: "default"`) — every commit publishes one to the in-memory fanout;
  the sync handler subscribes and does **table-level** intersection (v1 granularity).

### 7.2 The shard key at Tier 0

`shardId` is threaded through `WriteInvalidation` and (in their own specs) `DocStore.write` /
`Transactor` / `TimestampOracle` / `CommitResult` — always `DEFAULT_SHARD_ID`. The *data-model* shard
key is just an ordinary indexed field (`conversationId`) authored with the normal `defineTable(...)
.index("by_conversation", ["conversationId"])` surface — no schema-API change. Tier 0 has exactly one
shard (the whole SQLite DB, one oracle); the types already carry the seam, so Tier 2 sharding is
config, not migration.

---

## 8. The scaleSeam, reserved — package boundaries ARE the tier-split points

The product promise is: **Tier 0 → Tier 2 changes deployment topology, adapters, and config — never
app code, never the engine.** This component makes that mechanical by quarantining all host/transport/
driver code in **leaf packages** and forbidding the engine from importing them.

### 8.1 Reaching Endpoint B is always "add a leaf," never "edit the engine"

| Endpoint-B need | The new leaf | What it implements | Engine edit? |
|---|---|---|---|
| Tier 2 host on Cloudflare | `packages/runtime-cloudflare` | `RuntimeHost` over Durable Objects + DO storage binding | **none** |
| Standalone sync-node fleet | `packages/runtime-sync-node` | `SyncProtocolHandler` behind a real WS server; `ShardRouter`=Distributed | **none** |
| Postgres committer / scale spine | `packages/adapters/postgres` | `DocStore` + `TimestampOracle` over Postgres | **none** |
| Binary delta wire | `packages/transport-*` codec | swap `encodeServerMessage` behind the existing `StateVersion` ack brackets | **none** |
| Cross-process fan-out | a `WriteFanoutAdapter` leaf (Redis/BroadcastChannel) | `publish`/`subscribe` over a bus | **none** |

Each plugs in by implementing an interface from `@stackbase/contracts` and being selected in a runtime
leaf's composition — exactly like SQLite/loopback are selected at Tier 0. The engine never learns which
one it got.

### 8.2 The enforced dependency rule — `.dependency-cruiser.cjs`

This is the load-bearing artifact. CI (`pnpm depcruise`) fails the build on any violation.

```js
// .dependency-cruiser.cjs
module.exports = {
  forbidden: [
    {
      name: "engine-imports-no-leaf",
      comment: "packages/server must never import a driver/host/transport leaf.",
      severity: "error",
      from: { path: "^packages/server/" },
      to:   { path: "^packages/(adapters/|runtime-|transport-)" },
    },
    {
      name: "engine-imports-no-host-module",
      comment: "packages/server must not import host/driver modules — only web-standard globals.",
      severity: "error",
      from: { path: "^packages/server/" },
      to:   { path: "^(node:|ws$|better-sqlite3|@cloudflare/|bun:|pg$|ioredis$)" },
    },
    {
      name: "contracts-stay-pure",
      comment: "Layer-0 packages may depend only on each other.",
      severity: "error",
      from: { path: "^packages/(values|errors|contracts)/" },
      to:   { pathNot: "^(packages/(values|errors|contracts)/|node:|typescript$)" , dependencyTypesNot: ["type-only"] },
    },
    {
      name: "adapters-are-leaves",
      comment: "An adapter may not import another adapter or any runtime/transport.",
      severity: "error",
      from: { path: "^packages/adapters/" },
      to:   { path: "^packages/(adapters/(?!\\1)|runtime-|transport-)" },
    },
    {
      name: "no-circular",
      severity: "error",
      from: {},
      to: { circular: true },
    },
  ],
  options: {
    tsConfig: { fileName: "tsconfig.json" },
    doNotFollow: { path: "node_modules" },
    enhancedResolveOptions: { exportsFields: ["exports"], conditionNames: ["import", "types"] },
  },
};
```

Backed by a fast inline ESLint guard in `eslint.config.js` (so violations surface in-editor too):

```js
// eslint.config.js — applied to packages/server/**
{
  files: ["packages/server/**/*.ts"],
  rules: {
    "no-restricted-imports": ["error", {
      patterns: [
        { group: ["@stackbase/adapters/*", "@stackbase/runtime-*", "@stackbase/transport-*"],
          message: "Engine must import interfaces from @stackbase/contracts, not a leaf." },
        { group: ["node:*", "ws", "better-sqlite3", "pg", "@cloudflare/*", "bun:*"],
          message: "Engine must use web-standard globals, not host/driver modules." },
      ],
    }],
  },
}
```

`import/no-extraneous-dependencies` is also on, so an engine file that imports an *undeclared* driver
fails twice (lint + depcruise). `verbatimModuleSyntax` makes `import type` explicit, so the "pure
contracts" rule can correctly allow type-only intra-Layer-0 edges while forbidding value edges.

### 8.3 Why this is the right cut

The interfaces carry the seam; the **packages carry the interfaces**; the **lint rule carries the
direction.** Because `@stackbase/server` physically cannot name a socket, a SQLite handle, or a DO
binding, "the engine is tier-agnostic" stops being a discipline someone can erode in a hurry and
becomes a property the build proves on every commit. That is the entire contribution of this component
to the scalability mandate.

---

## 9. Failure & edge handling

**Value / codec edges**
- `compareValues` must be a *total* order: reflexive, antisymmetric, transitive, total (every pair
  comparable). `-0` vs `+0` compare equal; `NaN` is canonicalized to one representative and ordered as
  the largest number-typed value (never "incomparable"). Property-tested (§10).
- `jsonToConvex` rejects malformed escapes (`{$integer:"zzz"}`, wrong byte length, both `$bytes` and
  other keys present) with a `ValueDecodeError` (a `UserError` subclass) carrying the offending path —
  never a silent wrong value.
- Reserved `$`-prefixed object keys round-trip via escaping; a user field literally named `$integer`
  must survive `convexToJson`→`jsonToConvex` unchanged.
- `bigint` outside int64 range throws on encode (Convex int64 semantics), not silent truncation.

**Validator edges**
- Recursive/cyclic validators are impossible to construct (`v.*` builds finite trees), but `v.union`
  of zero members and `v.object({})` are valid and have defined JSON (`{type:"union",value:[]}` rejects
  all; empty object accepts `{}`).
- `v.optional(v.optional(x))` collapses to a single optional (idempotent `isOptional`).
- A duplicate index name in `defineTable` throws at definition time (caught before deploy), as does an
  index field path not present in the document validator (best-effort, since `v.any()` disables it).

**Error edges**
- `toStackbaseError(x)` handles: a `StackbaseError` (passthrough), a `ConvexError` (→
  `Argument`-class with `.data`), a native `Error` (→ `UdfExecutionError` 500, message preserved,
  stack in `cause`), and a non-Error throw like `throw "boom"` (→ 500 with a synthesized message).
- `StackbaseError.fromJSON` on an unknown `code` falls back to a generic instance of the family
  implied by an embedded status hint, or a 500 — never throws while handling an error.
- `data` is required to already be JSON (the throw site encodes via `convexToJson`); `toJSON` never
  re-encodes a live `Value`, avoiding double-encoding bugs.

**Tooling / build edges**
- A new package missing a `references` entry → `tsc -b` still builds (pnpm resolves the symlink) but
  **incremental rebuild misses it**; a `check:references` script (`@monorepo/tsc-references` or a tiny
  custom verifier) asserts every `workspace:*` dep has a matching `tsconfig` reference, run in CI.
- A leaf added under `packages/adapters/*` is auto-enrolled by the glob; if it forgets its own
  `dependency-cruiser`-relevant `tsconfig`, depcruise reports "unresolvable" rather than passing
  silently.
- Version skew of `ValidatorJSON` between a client codegen'd against an older shape and a newer engine:
  `AnalyzedModule` and the schema export JSON are **additive-only** (new optional fields, new union
  members appended); the validator `kind` discriminant never repurposes an existing tag. See O-2.
- The dep-cruiser rule must allow `import type` within Layer 0 but forbid value imports: relies on
  `verbatimModuleSyntax` + `dependencyTypesNot: ["type-only"]`. A regression here would silently let
  the engine couple to a leaf via a "type" that is actually a value — covered by a planted-violation
  test (§10).

---

## 10. Test strategy

**Unit (per package)**
- `@stackbase/values`: each `v.*` constructor → exact `ValidatorJSON` snapshot (interop lock);
  `Infer<>` type-level tests via `tsd`/`expect-type`; `defineTable().export()` and
  `defineSchema().export()` golden JSON for the chat example schema (must match Convex's output for
  the same source).
- `@stackbase/errors`: each subclass → `{code, httpStatus, retryable}` table test; `toJSON`/`fromJSON`
  round-trip; `toStackbaseError` over the failure matrix in §9; assert `OccConflictError` is a
  `ConflictError` and 409+retryable.
- `@stackbase/contracts`: `serializeTimestamp`/`deserializeTimestamp` round-trip across the int64
  range incl. negatives and 0; `WriteInvalidation` is structurally JSON-serializable (no `ArrayBuffer`
  leaks — a test `JSON.parse(JSON.stringify(x))` deep-equals).

**Property tests (the load-bearing ones)**
- **`compareValues` total-order axioms** (fast-check): for random `Value` triples — antisymmetry
  (`cmp(a,b) === -cmp(b,a)`), transitivity (`a≤b ∧ b≤c ⇒ a≤c`), totality (always `-1|0|1`),
  consistency with `valuesEqual`. Dedicated generators for float edges (`-0`, `+0`, `NaN`, `±Inf`,
  subnormals) and bigint sign boundaries. **This is the oracle the query-engine's `encodeIndexKey`
  ordering test consumes** — that codec round-trip/ordering property test (`compareIndexKeys(encode(a),
  encode(b)) === compareValues(a,b)`) lives in the query-engine package but imports `compareValues`
  from here, so the two can never silently disagree.
- **Value↔JSON round-trip** (fast-check): `jsonToConvex(convexToJson(v))` deep-equals `v` for random
  `Value`s, including bytes, bigint, non-finite floats, `undefined` fields, and `$`-prefixed keys.
- **Validator JSON round-trip**: `parse(v.json)` re-serializes to an identical `ValidatorJSON`
  (stable, order-independent for object fields).
- **Error envelope round-trip**: `StackbaseError.fromJSON(e.toJSON()).toJSON()` equals `e.toJSON()`
  across the whole hierarchy.

**Architectural test (the dependency direction)**
- A CI test runs `depcruise` and asserts **zero** violations on the clean tree.
- A **planted-violation** test: a fixture file under `test/fixtures/` that imports
  `@stackbase/adapters/sqlite-node` *as a value* from a `packages/server`-shaped path must make
  depcruise exit non-zero — proving the rule actually bites (guards against a misconfigured rule that
  passes everything). A second fixture importing the same as `import type` must **pass** (proving
  type-only edges are allowed where intended, and forbidden where not).
- `check:references` asserts the `tsconfig` reference graph equals the `workspace:*` dependency graph.

**OCC conflict cases** (noted for completeness): the OCC conflict round-trip — that an
`OccConflictSignal` from the transactor maps to a public `OccConflictError` (409, retryable) and that a
caller's bounded deterministic replay path observes it — is authored in the **transactor** component's
test suite ([02](../internals/02-transactions-consistency.md)); this component only fixes the *public*
`OccConflictError` shape those tests assert against.

---

## 11. Open issues

- **O-1 — array/object position in `compareValues`.** The scalar cross-type order
  (`null<boolean<number<bigint<string<bytes`) is interop-locked from [internals/04]; the `array`/`object`
  tail order and the object-comparison rule (sorted entries vs insertion order) are our extension and
  must be confirmed against Convex's documented value ordering before lock, since the index-key codec
  and cursors inherit it.
- **O-2 — `ValidatorJSON` / schema-export evolution policy.** We commit to additive-only changes
  (new optional fields, appended union members, never repurposing a `type` tag). Need a written
  compatibility contract + a CI snapshot guard before any client codegen ships against it, or Endpoint
  B clients on older bundles break.
- **O-3 — one `contracts` package vs per-subsystem subpaths.** A single interface-seam package is the
  simplest target for the dependency rule but is a churn magnet as six components author into it.
  Decide whether to split into `@stackbase/contracts/{docstore,sync,…}` subpath modules (localizing
  churn, same rule) before the seam files fill up.
- **O-4 — turbo as a hard dep vs pnpm-recursive fallback.** Project references + `tsc -b` are the
  correctness floor; turbo adds caching/scheduling. Decide if turbo is required for `pnpm check` in CI
  or kept optional (some contributors dislike the extra binary). Affects the documented getting-started
  flow (DX).
- **O-5 — `exactOptionalPropertyTypes` blast radius.** It is correct for distinguishing absent vs
  `undefined` fields (which `Value` objects and `v.optional` care about), but it ripples strictness
  into every consumer. Confirm the engine and client packages tolerate it before locking it in
  `tsconfig.base.json`, or scope it to Layer 0 only.
- **O-6 — `ConvexError` mapping fidelity.** Mapping a user-thrown `ConvexError` to a 400-class
  `StackbaseError` while preserving `data` through the sync/HTTP envelope (and the client
  reconstructing it as a `ConvexError`, not a generic error) crosses three components; the exact
  `code` and round-trip need pinning so optimistic-update reconciliation on the client sees the right
  type.
- **O-7 — Node version floor for the value codec.** `convexToJson` uses `DataView`/`Uint8Array` and
  base64; the compatibility doc targets Node 22.5+, Bun, and Workers. Confirm the float64/int64 LE
  byte handling is identical across all three (endianness, `Buffer` vs `atob`) and pick a single
  base64 helper to avoid per-runtime drift.
