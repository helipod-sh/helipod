# authz Relation Predicates (`some` / `is`) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a read policy filter by related rows — to-many `some` (a declared child table) and to-one `is` (a `v.id` field) — reactively, by resolving each relation clause to an id-set and rewriting it into a parent `in` membership filter.

**Architecture:** Semi-join pre-pass. A new async `resolveWhere` (executor `policy.ts`) queries the related table through the rule-context's existing policy-free, txn-bound `db` reader, collects the matching id-set, and rewrites the clause via Layer 1's `compileWhere` into `{ _id: { in: […] } }` (to-many) or `{ fk: { in: […] } }` (to-one). The parent scan then runs as pure field predicates. **No query-engine changes.** Relations are declared with a new schema `.relation()` builder (to-many) or derived from `v.id` fields (to-one), aggregated at compose into a `RelationRegistry` threaded through `KernelContext` like Layer 1's `policyRegistry`.

**Tech Stack:** TypeScript, Bun (package manager + runtime), Turborepo, vitest. Builds directly on the merged Layer 1 row-policies slice (`policy.ts` `compileWhere`/`mergeReadPolicy`, the rule-context, `KernelContext.policyRegistry`/`getRuleContext`).

## Global Constraints

- **Bun toolchain:** `bun install`, `bun run build`, `bun run typecheck`, `bun run test`; single package `bun run --filter <pkg> test`. Never pnpm/npm.
- **Scope:** to-many `some` + to-one `is`, **single relational level** (the leaf is field-predicates-only). No `none`/`every`/`isNot`, no multi-level chains.
- **No query-engine changes.** The semi-join uses the existing guest reader (`db.query(table, "by_creation").collect()`) + `evaluateFilter` + Layer 1's `compileWhere`.
- **Safety (must not silently over-permit):** `compileWhere` MUST throw on a `some`/`is` key — a nested relation in a leaf is a hard error, never a silent always-true. Relation clauses are recognized ONLY by `resolveWhere`.
- **Reactivity:** the semi-join child query records its read-set through the normal kernel path (it shares the call's `txn`), so share/unshare live-updates the parent subscription. No new reactivity machinery.
- **Bypass/enforcement unchanged from Layer 1:** privileged bypass only; the rule-context's `db` reader is policy-free (semi-join queries are not re-gated) but txn-bound. Write policies are unchanged.
- **TDD, frequent commits.** Each task ends green (`build`/`typecheck`/`test`) and with one commit.
- `noUncheckedIndexedAccess: true` is set in the base tsconfig — index accesses may need `!`/guards.

---

## File Structure

- `packages/values/src/schema.ts` (**modify**) — `TableDefinition.relation()` builder; `relations` on `TableDefinitionJSON`; `RelationJSON` type.
- `packages/executor/src/policy.ts` (**modify**) — `RelationClause`/`RelationRegistry`/`ResolveCtx` types; async `resolveWhere` + `resolveReadPolicy`; `compileWhere` relation-key guard.
- `packages/component/src/compose.ts` (**modify**) — `buildRelationRegistry` (to-many from `relations` JSON + to-one from `v.id` fields) with typo guards; add `relationRegistry` to `ComposedProject`.
- `packages/executor/src/kernel.ts` (**modify**) — `KernelContext.relationRegistry`; the 3 read-path call-sites call `resolveReadPolicy`.
- `packages/executor/src/executor.ts` (**modify**) — `RunOptions.relationRegistry`; thread onto the main `KernelContext` (empty on the policy-free base ctx).
- `packages/runtime-embedded/src/runtime.ts` (**modify**) — `EmbeddedRuntimeOptions.relationRegistry`; pass through every non-privileged run call-site.
- `components/authz/README.md` (**modify**) — document `.relation()` + `some`/`is` + the index caveat.
- Tests: `packages/values/test/relation.test.ts`, `packages/executor/test/resolve-where.test.ts`, `packages/component/test/relation-registry.test.ts`, `components/authz/test/relation-policy.test.ts`.

---

## Task 1: Schema `.relation()` builder

**Files:**
- Modify: `packages/values/src/schema.ts`
- Test: `packages/values/test/relation.test.ts`

**Interfaces:**
- Produces: `RelationJSON = { name: string; table: string; field: string }`; `TableDefinitionJSON.relations: RelationJSON[]`; `TableDefinition.relation(name, { table, field }): this`.

- [ ] **Step 1: Write the failing test**

Create `packages/values/test/relation.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { defineTable, v } from "../src/index";

describe("TableDefinition.relation", () => {
  it("serializes declared to-many relations into the table JSON", () => {
    const t = defineTable({ ownerId: v.string(), orgId: v.id("orgs") })
      .relation("sharedWith", { table: "document_shares", field: "documentId" });
    expect(t.export().relations).toEqual([{ name: "sharedWith", table: "document_shares", field: "documentId" }]);
  });

  it("defaults to an empty relations array when none are declared", () => {
    expect(defineTable({ a: v.string() }).export().relations).toEqual([]);
  });

  it("is chainable with index()/shardKey()", () => {
    const t = defineTable({ conversationId: v.id("conversations"), body: v.string() })
      .index("by_conv", ["conversationId"])
      .relation("reactions", { table: "reactions", field: "messageId" })
      .shardKey("conversationId");
    const j = t.export();
    expect(j.relations).toEqual([{ name: "reactions", table: "reactions", field: "messageId" }]);
    expect(j.indexes).toHaveLength(1);
    expect(j.shardKey).toBe("conversationId");
  });
});
```

- [ ] **Step 2: Run — verify it fails**

Run: `bun run --filter @stackbase/values test relation`
Expected: FAIL — `relation` is not a function / `relations` undefined on the JSON.

- [ ] **Step 3: Implement**

In `packages/values/src/schema.ts`, add the `RelationJSON` type near the other JSON interfaces:

```ts
export interface RelationJSON {
  /** Relation name used in policies (e.g. "sharedWith"). */
  name: string;
  /** The child table holding the back-reference rows. */
  table: string;
  /** The child field that references THIS table's `_id`. */
  field: string;
}
```

Add `relations` to `TableDefinitionJSON` (after `shardKey`):

```ts
  /** Declared to-many relations (scale-seam #2 / row-policy relation predicates). */
  relations: RelationJSON[];
```

In the `TableDefinition` class, add a private field (next to `shardKeyField`):

```ts
  private readonly relationsList: RelationJSON[] = [];
```

Add the builder method (after `shardKey`):

```ts
  /** Declare a to-many relation: rows in `table` whose `field` references this table's `_id`. */
  relation(name: string, spec: { table: string; field: string }): this {
    this.relationsList.push({ name, table: spec.table, field: spec.field });
    return this;
  }
```

Add `relations` to the `export()` return object:

```ts
      relations: this.relationsList,
```

- [ ] **Step 4: Run — verify it passes**

Run: `bun run --filter @stackbase/values test relation`
Expected: PASS.

- [ ] **Step 5: Whole workspace green + commit**

Run: `bun run build && bun run typecheck && bun run test`
Expected: PASS (adding a required JSON field with a default `[]` doesn't break existing schema consumers — verify).

```bash
git add packages/values/src/schema.ts packages/values/test/relation.test.ts
git commit -m "feat(values): TableDefinition.relation() — declare to-many relations in the schema"
```

---

## Task 2: `resolveWhere` semi-join + `compileWhere` guard

**Files:**
- Modify: `packages/executor/src/policy.ts`
- Test: `packages/executor/test/resolve-where.test.ts`

**Interfaces:**
- Consumes: Layer 1's `compileWhere`, `WhereInput`, `FieldOps`, `PolicyPredicate`, `TablePolicy`, `RuleContext`, `ALWAYS_TRUE`/`ALWAYS_FALSE` (module-local); `FilterExpr`/`evaluateFilter` from `@stackbase/query-engine`; `GuestDatabaseReader` from `./guest`; `Value` from `@stackbase/values`.
- Produces:
  - `RelationClause = { some?: WhereInput } | { is?: WhereInput }`.
  - `RelationRegistry = { toMany: ReadonlyMap<string, ReadonlyMap<string, { table: string; field: string }>>; toOne: ReadonlyMap<string, ReadonlyMap<string, string>> }`.
  - `ResolveCtx = { parentTable: string; relations: RelationRegistry; db: GuestDatabaseReader }`.
  - `async resolveWhere(where: PolicyPredicate, ctx: ResolveCtx): Promise<FilterExpr | null>`.
  - `async resolveReadPolicy(policy: TablePolicy, rc: RuleContext, parentTable: string, relations: RelationRegistry): Promise<FilterExpr | null>`.
  - `compileWhere` now throws on a `some`/`is` field-condition key.

- [ ] **Step 1: Write the failing test**

Create `packages/executor/test/resolve-where.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { resolveWhere, compileWhere, type RelationRegistry } from "../src/policy";
import type { GuestDatabaseReader } from "../src/guest";
import type { DocumentValue } from "@stackbase/docstore";

const CHILD: Record<string, DocumentValue[]> = {
  document_shares: [
    { _id: "s1", documentId: "d3", userId: "u1", _creationTime: 1 } as unknown as DocumentValue,
    { _id: "s2", documentId: "d9", userId: "u2", _creationTime: 2 } as unknown as DocumentValue,
  ],
  orgs: [
    { _id: "o1", ownerId: "u1", _creationTime: 1 } as unknown as DocumentValue,
    { _id: "o2", ownerId: "u2", _creationTime: 2 } as unknown as DocumentValue,
  ],
};
const fakeDb = { query: (t: string) => ({ collect: async () => CHILD[t] ?? [] }) } as unknown as GuestDatabaseReader;
const relations: RelationRegistry = {
  toMany: new Map([["documents", new Map([["sharedWith", { table: "document_shares", field: "documentId" }]])]]),
  toOne: new Map([["documents", new Map([["orgId", "orgs"]])]]),
};
const ctx = { parentTable: "documents", relations, db: fakeDb };

describe("resolveWhere", () => {
  it("some → parent `_id in [collected back-refs]`", async () => {
    expect(await resolveWhere({ sharedWith: { some: { userId: "u1" } } }, ctx)).toEqual({
      op: "or", clauses: [{ op: "eq", field: "_id", value: "d3" }],
    });
  });

  it("is → parent `<fk> in [matching target _ids]`", async () => {
    expect(await resolveWhere({ orgId: { is: { ownerId: "u1" } } }, ctx)).toEqual({
      op: "or", clauses: [{ op: "eq", field: "orgId", value: "o1" }],
    });
  });

  it("empty match → always-false (deny)", async () => {
    expect(await resolveWhere({ sharedWith: { some: { userId: "nobody" } } }, ctx)).toEqual({ op: "or", clauses: [] });
  });

  it("combines field + relation clauses under OR", async () => {
    const r = await resolveWhere({ OR: [{ ownerId: "u1" }, { sharedWith: { some: { userId: "u1" } } }] }, ctx);
    expect(r).toEqual({
      op: "or",
      clauses: [
        { op: "eq", field: "ownerId", value: "u1" },
        { op: "or", clauses: [{ op: "eq", field: "_id", value: "d3" }] },
      ],
    });
  });

  it("a no-relation predicate resolves like compileWhere", async () => {
    expect(await resolveWhere({ ownerId: "u1" }, ctx)).toEqual(compileWhere({ ownerId: "u1" }));
  });

  it("throws on an unknown relation name", async () => {
    await expect(resolveWhere({ nope: { some: { userId: "u1" } } }, ctx)).rejects.toThrow(/unknown relation "nope"/);
  });

  it("throws on `is` over a non-reference field", async () => {
    await expect(resolveWhere({ ownerId: { is: { x: 1 } } }, ctx)).rejects.toThrow(/not a reference/);
  });
});

describe("compileWhere relation-key guard", () => {
  it("throws on a some/is key (nested relations are a hard error, never silent-allow)", () => {
    expect(() => compileWhere({ x: { some: { a: 1 } } })).toThrow(/relation clauses .* top level/);
    expect(() => compileWhere({ x: { is: { a: 1 } } })).toThrow(/relation clauses .* top level/);
  });
});
```

- [ ] **Step 2: Run — verify it fails**

Run: `bun run --filter @stackbase/executor test resolve-where`
Expected: FAIL — `resolveWhere` not exported; guard not present.

- [ ] **Step 3: Implement in `policy.ts`**

Add imports at the top (extend the existing ones):

```ts
import { evaluateFilter, type FilterExpr } from "@stackbase/query-engine";
import type { GuestDatabaseReader } from "./guest";
```
(If `FilterExpr` is already imported as a type, merge — do not duplicate the import.)

Add the relation types (after the existing `PolicyContextProvider`):

```ts
export type RelationClause = { some: WhereInput } | { is: WhereInput };

export interface RelationRegistry {
  /** parentTable → relationName → { child table, back-reference field }. */
  toMany: ReadonlyMap<string, ReadonlyMap<string, { table: string; field: string }>>;
  /** parentTable → fieldName → target table (derived from v.id fields). */
  toOne: ReadonlyMap<string, ReadonlyMap<string, string>>;
}

export interface ResolveCtx {
  parentTable: string;
  relations: RelationRegistry;
  db: GuestDatabaseReader;
}
```

In `compileField`, add the relation-key guard as the FIRST thing after `const ops = cond;`:

```ts
  if ("some" in ops || "is" in ops)
    throw new Error(`relation clauses ("some"/"is") are only valid at the top level of a policy (resolved by resolveWhere); nested relations are not supported`);
```

Add the resolver functions at the end of the file:

```ts
function isRelationClause(cond: unknown): cond is RelationClause {
  return cond !== null && typeof cond === "object" && !Array.isArray(cond) && !(cond instanceof ArrayBuffer)
    && ("some" in cond || "is" in cond);
}

async function resolveSome(relName: string, leaf: WhereInput, ctx: ResolveCtx): Promise<FilterExpr> {
  const rel = ctx.relations.toMany.get(ctx.parentTable)?.get(relName);
  if (!rel) throw new Error(`unknown relation "${relName}" on table "${ctx.parentTable}"`);
  const leafExpr = compileWhere(leaf);
  const rows = await ctx.db.query(rel.table, "by_creation").collect();
  const ids = new Set<Value>();
  for (const row of rows) {
    if (leafExpr === null || evaluateFilter(row, leafExpr)) {
      const ref = (row as Record<string, unknown>)[rel.field];
      if (ref !== undefined) ids.add(ref as Value);
    }
  }
  return compileWhere({ _id: { in: [...ids] } }) ?? ALWAYS_FALSE;
}

async function resolveIs(fieldName: string, leaf: WhereInput, ctx: ResolveCtx): Promise<FilterExpr> {
  const targetTable = ctx.relations.toOne.get(ctx.parentTable)?.get(fieldName);
  if (!targetTable) throw new Error(`field "${fieldName}" is not a reference (v.id) on table "${ctx.parentTable}"`);
  const leafExpr = compileWhere(leaf);
  const rows = await ctx.db.query(targetTable, "by_creation").collect();
  const ids = new Set<Value>();
  for (const row of rows) {
    if (leafExpr === null || evaluateFilter(row, leafExpr)) {
      const id = (row as Record<string, unknown>)._id;
      if (id !== undefined) ids.add(id as Value);
    }
  }
  return compileWhere({ [fieldName]: { in: [...ids] } }) ?? ALWAYS_FALSE;
}

async function resolveClause(key: string, cond: unknown, ctx: ResolveCtx): Promise<FilterExpr> {
  if (isRelationClause(cond)) {
    if ("some" in cond) return resolveSome(key, cond.some, ctx);
    return resolveIs(key, cond.is, ctx);
  }
  return compileWhere({ [key]: cond } as WhereInput) ?? ALWAYS_TRUE;
}

async function resolveNode(node: WhereInput, ctx: ResolveCtx): Promise<FilterExpr> {
  const n = node as Record<string, unknown>;
  if (Array.isArray(n.AND)) return { op: "and", clauses: await Promise.all((n.AND as WhereInput[]).map((c) => resolveNode(c, ctx))) };
  if (Array.isArray(n.OR)) return { op: "or", clauses: await Promise.all((n.OR as WhereInput[]).map((c) => resolveNode(c, ctx))) };
  if (n.NOT !== undefined) return { op: "not", clause: await resolveNode(n.NOT as WhereInput, ctx) };
  const clauses: FilterExpr[] = [];
  for (const [key, cond] of Object.entries(n)) clauses.push(await resolveClause(key, cond, ctx));
  if (clauses.length === 0) return ALWAYS_TRUE;
  return clauses.length === 1 ? clauses[0]! : { op: "and", clauses };
}

/** Async superset of compileWhere: resolves relation clauses via semi-join, then behaves like compileWhere. */
export async function resolveWhere(where: PolicyPredicate, ctx: ResolveCtx): Promise<FilterExpr | null> {
  if (where === undefined || where === true) return null;
  if (where === false) return ALWAYS_FALSE;
  return resolveNode(where, ctx);
}

/** Read-path entry: resolve a table's read policy (with relation clauses) to a post-filter. */
export async function resolveReadPolicy(
  policy: TablePolicy, rc: RuleContext, parentTable: string, relations: RelationRegistry,
): Promise<FilterExpr | null> {
  if (!policy.read) return null;
  return resolveWhere(await policy.read(rc), { parentTable, relations, db: rc.db });
}
```

> `ALWAYS_TRUE`/`ALWAYS_FALSE` are the frozen module-local sentinels from Layer 1 — reuse them, do not redefine. `Value` and `WhereInput`/`compileWhere`/`PolicyPredicate`/`TablePolicy`/`RuleContext` are already in this file.

- [ ] **Step 4: Run — verify it passes**

Run: `bun run --filter @stackbase/executor test resolve-where`
Expected: PASS (all `resolveWhere` cases + the guard).

- [ ] **Step 5: Whole workspace green + commit**

Run: `bun run build && bun run typecheck && bun run test`
Expected: PASS (the existing `policy.test.ts` still green; the guard only fires on `some`/`is`, which no existing test uses).

```bash
git add packages/executor/src/policy.ts packages/executor/test/resolve-where.test.ts
git commit -m "feat(executor): resolveWhere semi-join for relation predicates + compileWhere relation-key guard"
```

---

## Task 3: Relation registry extraction (compose)

**Files:**
- Modify: `packages/component/src/compose.ts`
- Test: `packages/component/test/relation-registry.test.ts`

**Interfaces:**
- Consumes: Task 1's `TableDefinitionJSON.relations`; Task 2's `RelationRegistry`; `getFullTableName` from `@stackbase/id-codec`; the object-validator JSON shape `{ type: "object", value: { field: { fieldType: { type: "id", tableName } } } }`.
- Produces: `ComposedProject.relationRegistry: RelationRegistry`; compose-time typo guards.

- [ ] **Step 1: Write the failing test**

Create `packages/component/test/relation-registry.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { composeComponents } from "../src/index";
import { defineSchema, defineTable, v } from "@stackbase/values";

const schema = defineSchema({
  orgs: defineTable({ ownerId: v.string() }),
  documents: defineTable({ ownerId: v.string(), orgId: v.id("orgs") })
    .relation("sharedWith", { table: "document_shares", field: "documentId" }),
  document_shares: defineTable({ documentId: v.id("documents"), userId: v.string() }),
});

describe("relation registry", () => {
  it("extracts to-many from .relation() and to-one from v.id fields", () => {
    const { relationRegistry } = composeComponents({ schemaJson: schema.export(), moduleMap: {} }, []);
    expect(relationRegistry.toMany.get("documents")?.get("sharedWith")).toEqual({ table: "document_shares", field: "documentId" });
    expect(relationRegistry.toOne.get("documents")?.get("orgId")).toBe("orgs");
    expect(relationRegistry.toOne.get("document_shares")?.get("documentId")).toBe("documents");
  });

  it("rejects a relation to an unknown table", () => {
    const bad = defineSchema({ documents: defineTable({ a: v.string() }).relation("r", { table: "ghost", field: "x" }) });
    expect(() => composeComponents({ schemaJson: bad.export(), moduleMap: {} }, [])).toThrow(/unknown table "ghost"/);
  });

  it("rejects a relation whose back-reference field is not on the child table", () => {
    const bad = defineSchema({
      documents: defineTable({ a: v.string() }).relation("r", { table: "shares", field: "missing" }),
      shares: defineTable({ documentId: v.id("documents") }),
    });
    expect(() => composeComponents({ schemaJson: bad.export(), moduleMap: {} }, [])).toThrow(/unknown field "missing"/);
  });
});
```

- [ ] **Step 2: Run — verify it fails**

Run: `bun run --filter @stackbase/component test relation-registry`
Expected: FAIL — `relationRegistry` not on `ComposedProject`.

- [ ] **Step 3: Implement in `compose.ts`**

Add imports:

```ts
import type { RelationRegistry } from "@stackbase/executor";
import type { TableDefinitionJSON, SchemaDefinitionJSON } from "@stackbase/values";
```
(Merge with existing imports; `getFullTableName` is already imported.)

Add `relationRegistry` to `ComposedProject`:

```ts
  relationRegistry: RelationRegistry;
```

Add the builder function above `composeComponents`:

```ts
function buildRelationRegistry(
  appSchema: SchemaDefinitionJSON,
  components: ComponentDefinition[],
): RelationRegistry {
  // Resolve every table's JSON keyed by its full name (app tables are bare; components prefixed).
  const tableJson: Record<string, TableDefinitionJSON> = {};
  for (const [name, tdef] of Object.entries(appSchema.tables)) tableJson[getFullTableName(name, "")] = tdef;
  for (const c of components)
    for (const [name, tdef] of Object.entries(c.schema.export().tables)) tableJson[getFullTableName(name, c.name)] = tdef;

  const toMany = new Map<string, Map<string, { table: string; field: string }>>();
  const toOne = new Map<string, Map<string, string>>();

  for (const [full, tdef] of Object.entries(tableJson)) {
    // to-one: v.id fields on this table
    if (tdef.documentType.type === "object") {
      const m = new Map<string, string>();
      for (const [fieldName, f] of Object.entries(tdef.documentType.value))
        if (f.fieldType.type === "id") m.set(fieldName, f.fieldType.tableName);
      if (m.size > 0) toOne.set(full, m);
    }
    // to-many: declared relations (child tables are app/root tables in v1)
    for (const rel of tdef.relations ?? []) {
      const childFull = getFullTableName(rel.table, "");
      const child = tableJson[childFull];
      if (!child) throw new Error(`relation "${rel.name}" on "${full}" references unknown table "${rel.table}"`);
      if (child.documentType.type === "object" && !(rel.field in child.documentType.value))
        throw new Error(`relation "${rel.name}" on "${full}" references unknown field "${rel.field}" on "${rel.table}"`);
      if (!toMany.has(full)) toMany.set(full, new Map());
      toMany.get(full)!.set(rel.name, { table: childFull, field: rel.field });
    }
  }
  return { toMany, toOne };
}
```

In `composeComponents`, after the `policyRegistry`/`policyProviders` aggregation, add:

```ts
  const relationRegistry = buildRelationRegistry(app.schemaJson, components);
```

Add `relationRegistry` to the returned object.

- [ ] **Step 4: Run — verify it passes**

Run: `bun run --filter @stackbase/component test relation-registry`
Expected: PASS.

- [ ] **Step 5: Whole workspace green + commit**

Run: `bun run build && bun run typecheck && bun run test` → PASS.

```bash
git add packages/component/src/compose.ts packages/component/test/relation-registry.test.ts
git commit -m "feat(component): extract RelationRegistry (to-many .relation + to-one v.id) at compose"
```

---

## Task 4: Kernel + executor + runtime wiring

**Files:**
- Modify: `packages/executor/src/kernel.ts`, `packages/executor/src/executor.ts`, `packages/runtime-embedded/src/runtime.ts`
- Test: `packages/executor/test/relation-enforce.test.ts`

**Interfaces:**
- Consumes: Task 2's `RelationRegistry`, `resolveReadPolicy`; Layer 1's `KernelContext`/`RunOptions`/rule-context plumbing.
- Produces: `KernelContext.relationRegistry: RelationRegistry`; `RunOptions.relationRegistry?`; `EmbeddedRuntimeOptions.relationRegistry?`; read handlers use `resolveReadPolicy`.

- [ ] **Step 1: Write the failing test**

Create `packages/executor/test/relation-enforce.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { SqliteDocStore, NodeSqliteAdapter } from "@stackbase/docstore-sqlite";
import { MonotonicTimestampOracle } from "@stackbase/docstore";
import { SingleWriterTransactor } from "@stackbase/transactor";
import { QueryRuntime } from "@stackbase/query-engine";
import { encodeStorageIndexId } from "@stackbase/id-codec";
import { InlineUdfExecutor, SimpleIndexCatalog, mutation, query } from "../src/index";
import type { PolicyRegistry, PolicyContextProvider, RelationRegistry } from "../src/policy";

async function harness() {
  const store = new SqliteDocStore(new NodeSqliteAdapter());
  await store.setupSchema();
  const transactor = new SingleWriterTransactor(store, new MonotonicTimestampOracle());
  const queryRuntime = new QueryRuntime(store);
  const catalog = new SimpleIndexCatalog();
  for (const [t, n] of [["documents", 6001], ["document_shares", 6002]] as const) {
    catalog.addTable(t, n);
    catalog.addIndex({ table: t, tableNumber: n, index: "by_creation", fields: [], indexId: encodeStorageIndexId(n, "by_creation") });
  }
  return new InlineUdfExecutor({ transactor, queryRuntime, catalog });
}

// A document is readable if a document_shares row names the caller.
const registry: PolicyRegistry = new Map([
  ["documents", { read: () => ({ sharedWith: { some: { userId: "u1" } } }) }],
]);
const relations: RelationRegistry = {
  toMany: new Map([["documents", new Map([["sharedWith", { table: "document_shares", field: "documentId" }]])]]),
  toOne: new Map(),
};
const provider: PolicyContextProvider[] = [{ namespace: "authz", build: () => ({ auth: { userId: "u1" } }) }];

describe("relation-predicate enforcement", () => {
  it("a shared document is visible; an unshared one is not; privileged sees all", async () => {
    const ex = await harness();
    const d1 = (await ex.run<{ _id: string }>(mutation(async (ctx) => ({ _id: await ctx.db.insert("documents", { title: "shared" }) })), {}, { privileged: true })).value._id;
    const d2 = (await ex.run<{ _id: string }>(mutation(async (ctx) => ({ _id: await ctx.db.insert("documents", { title: "secret" }) })), {}, { privileged: true })).value._id;
    await ex.run(mutation(async (ctx) => ctx.db.insert("document_shares", { documentId: d1, userId: "u1" })), {}, { privileged: true });

    const opts = { policyRegistry: registry, policyProviders: provider, relationRegistry: relations };
    const visible = await ex.run<any[]>(query(async (ctx) => ctx.db.query("documents", "by_creation").collect()), {}, opts);
    expect(visible.value.map((d) => d.title)).toEqual(["shared"]);          // only d1

    const secret = await ex.run<any>(query(async (ctx) => ctx.db.get(d2)), {}, opts);
    expect(secret.value).toBeNull();                                        // unshared → null

    const all = await ex.run<any[]>(query(async (ctx) => ctx.db.query("documents", "by_creation").collect()), {}, { privileged: true });
    expect(all.value.length).toBe(2);                                       // privileged sees both
  });
});
```

- [ ] **Step 2: Run — verify it fails**

Run: `bun run --filter @stackbase/executor test relation-enforce`
Expected: FAIL — `relationRegistry` not accepted / relation clause not resolved (both docs returned, or a throw).

- [ ] **Step 3: Thread through `kernel.ts`**

Change the policy import to add `resolveReadPolicy` and `RelationRegistry`:

```ts
import { evalWritePolicy, mergeReadPolicy, resolveReadPolicy } from "./policy";
import type { PolicyRegistry, RuleContext, RelationRegistry } from "./policy";
```
(Drop `evalReadPolicy` from the import if it is no longer referenced anywhere in kernel.ts; keep `evaluateFilter` — still used by `handleDbGet`.)

Add to `KernelContext` (after `getRuleContext`):

```ts
  /** Declared relations (to-many + to-one), for resolving relation predicates in read policies. */
  readonly relationRegistry: RelationRegistry;
```

In `handleDbGet`, replace the `evalReadPolicy(...)` call with:

```ts
      const expr = await resolveReadPolicy(policy, await ctx.getRuleContext(), meta.name, ctx.relationRegistry);
```

In `handleDbQuery` AND `handleDbPaginate`, replace the `mergeReadPolicy(query.filters, await evalReadPolicy(policy, await ctx.getRuleContext()))` expression with:

```ts
      query.filters = mergeReadPolicy(query.filters, await resolveReadPolicy(policy, await ctx.getRuleContext(), tableName, ctx.relationRegistry));
```

- [ ] **Step 4: Thread through `executor.ts`**

Add to the policy type import:

```ts
import type { PolicyRegistry, PolicyContextProvider, RuleContext, RelationRegistry } from "./policy";
```

Add to `RunOptions` (after `policyProviders`):

```ts
  /** Declared relations, consulted by the kernel when resolving relation predicates. */
  relationRegistry?: RelationRegistry;
```

In the `runInTransaction` callback, add an **empty** `relationRegistry` to the `baseKctx` object literal (an empty `RelationRegistry` is `{ toMany: new Map(), toOne: new Map() }`) — the base ctx is policy-free, so its relation registry is never consulted, but the field must exist to satisfy the `KernelContext` type. Add to `baseKctx`:

```ts
          relationRegistry: { toMany: new Map(), toOne: new Map() },
```

Then, on the main `kctx` (built by spreading `baseKctx`), override it with the caller's registry — extend the existing `kctx` construction line:

```ts
        const kctx: KernelContext = { ...baseKctx, policyRegistry: options.policyRegistry ?? new Map(), getRuleContext, relationRegistry: options.relationRegistry ?? baseKctx.relationRegistry };
```

- [ ] **Step 5: Thread through `runtime.ts`**

Add `import type { RelationRegistry } from "@stackbase/executor";` (merge with existing). Add to `EmbeddedRuntimeOptions`:

```ts
  relationRegistry?: RelationRegistry;
```

In `create`, after `const policyProviders = ...`:

```ts
    const relationRegistry = options.relationRegistry;
```

Add `relationRegistry` to every non-privileged `executor.run(...)` options object (the `runQuery`/`runMutation` closures and the public `run` method — NOT `runSystem`), mirroring `policyRegistry`. Add it to the constructor params + a stored private field the public `run` reads (mirror `policyRegistry` exactly).

- [ ] **Step 6: Run — verify it passes**

Run: `bun run --filter @stackbase/executor test relation-enforce`
Expected: PASS — shared doc visible, unshared `get` → null, privileged sees both.

- [ ] **Step 7: Whole workspace green + commit**

Run: `bun run build && bun run typecheck && bun run test`
Expected: PASS (Layer 1 row-policy tests still green — a policy with no relation clause resolves identically via `resolveWhere`; the empty relation registry is inert).

```bash
git add packages/executor/src/kernel.ts packages/executor/src/executor.ts packages/runtime-embedded/src/runtime.ts packages/executor/test/relation-enforce.test.ts
git commit -m "feat(executor): thread RelationRegistry; read handlers resolve relation predicates"
```

---

## Task 5: authz end-to-end + reactive sharing contract

**Files:**
- Modify: `components/authz/README.md`
- Test: `components/authz/test/relation-policy.test.ts`

**Interfaces:**
- Consumes: everything above, through `composeComponents` + `EmbeddedRuntime` + `defineAuthz`. No new authz source is required — `defineAuthz({ policies })` already forwards policies; relation clauses flow through `resolveReadPolicy`. The app schema declares `.relation()`; `composeComponents` returns `relationRegistry`; the test passes it to `EmbeddedRuntime.create`.
- Produces: the headline reactive-sharing proof + policy-author docs.

- [ ] **Step 1: Write the failing test**

Create `components/authz/test/relation-policy.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { SqliteDocStore, NodeSqliteAdapter } from "@stackbase/docstore-sqlite";
import { composeComponents } from "@stackbase/component";
import { EmbeddedRuntime } from "@stackbase/runtime-embedded";
import { defineSchema, defineTable, v } from "@stackbase/values";
import { query, mutation, type RegisteredFunction } from "@stackbase/executor";
import { auth } from "@stackbase/auth";
import { defineAuthz } from "../src/define-authz";

function systemModules(): Record<string, RegisteredFunction> {
  return { "_system:insertDocument": mutation(async (ctx, a: { table: string; fields: Record<string, unknown> }) =>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await ctx.db.insert(a.table, a.fields as any)) };
}

// A document is readable if it is shared with the caller (a document_shares row names them).
const authz = defineAuthz({
  policies: { documents: { read: ({ auth }) => ({ sharedWith: { some: { userId: auth.userId } } }) } },
});

const appSchema = defineSchema({
  documents: defineTable({ title: v.string() }).relation("sharedWith", { table: "document_shares", field: "documentId" }),
  document_shares: defineTable({ documentId: v.id("documents"), userId: v.string() }),
});

async function makeRuntime() {
  const composed = composeComponents({ schemaJson: appSchema.export(), moduleMap: {
    "docs:list": query(async (ctx) => ctx.db.query("documents", "by_creation").collect()),
  } }, [auth, authz]);
  return EmbeddedRuntime.create({
    store: new SqliteDocStore(new NodeSqliteAdapter()),
    catalog: composed.catalog, modules: composed.moduleMap, systemModules: systemModules(),
    componentNames: composed.componentNames, contextProviders: composed.contextProviders,
    policyRegistry: composed.policyRegistry, policyProviders: composed.policyProviders,
    relationRegistry: composed.relationRegistry,
  });
}

describe("authz relation policy (sharing)", () => {
  it("only shared documents are visible", async () => {
    const r = await makeRuntime();
    const { token, userId } = (await r.run<{ token: string; userId: string }>("auth:signUp", { email: "u@b.co", password: "pw" })).value;
    const d1 = (await r.runSystem<string>("_system:insertDocument", { table: "documents", fields: { title: "shared" } })).value;
    await r.runSystem("_system:insertDocument", { table: "documents", fields: { title: "secret" } });
    expect((await r.run<any[]>("docs:list", {}, { identity: token })).value).toEqual([]); // nothing shared yet
    await r.runSystem("_system:insertDocument", { table: "document_shares", fields: { documentId: d1, userId } });
    const seen = (await r.run<any[]>("docs:list", {}, { identity: token })).value;
    expect(seen.map((d) => d.title)).toEqual(["shared"]);
  });

  it("REACTIVE: sharing/unsharing live-updates a subscribed docs:list", async () => {
    const r = await makeRuntime();
    const { token, userId } = (await r.run<{ token: string; userId: string }>("auth:signUp", { email: "bob@b.co", password: "pw" })).value;
    const d1 = (await r.runSystem<string>("_system:insertDocument", { table: "documents", fields: { title: "d1" } })).value;

    const sent: any[] = [];
    const sock = { sent, send: (x: string) => sent.push(JSON.parse(x)), bufferedAmount: 0, close: () => {} };
    const last = (): unknown => {
      for (let i = sent.length - 1; i >= 0; i--)
        for (const m of [...(sent[i]?.modifications ?? [])].reverse())
          if (m.type === "QueryUpdated" && m.queryId === 1) return m.value;
      return undefined;
    };
    r.handler.connect("s1", sock);
    await r.handler.handleMessage("s1", JSON.stringify({ type: "SetAuth", token }));
    await r.handler.handleMessage("s1", JSON.stringify({ type: "ModifyQuerySet", add: [{ queryId: 1, udfPath: "docs:list", args: {} }], remove: [] }));
    expect(last()).toEqual([]);                                             // unshared → empty

    const shareId = (await r.runSystem<string>("_system:insertDocument", { table: "document_shares", fields: { documentId: d1, userId } })).value;
    await new Promise((res) => setTimeout(res, 50));
    expect((last() as any[]).length).toBe(1);                              // share → appears live

    await r.runSystem("_system:deleteDocument", { id: shareId });
    await new Promise((res) => setTimeout(res, 50));
    expect(last()).toEqual([]);                                            // unshare → disappears live
  });
});
```

> The reactive test uses `_system:deleteDocument`. Confirm the local `systemModules()` includes it; if not present, add it: `"_system:deleteDocument": mutation(async (ctx, a: { id: string }) => { await ctx.db.delete(a.id); return null; })`.

- [ ] **Step 2: Run — verify it fails**

Run: `bun run --filter @stackbase/authz test relation-policy`
Expected: FAIL — until the full chain (schema relation → registry → resolveWhere → kernel) is wired, the relation clause doesn't filter / the subscription doesn't flip.

- [ ] **Step 3: Add `_system:deleteDocument` to the test's `systemModules()` if missing**

Ensure the test's local `systemModules()` returns both `_system:insertDocument` and `_system:deleteDocument` (code shown in the Step 1 note). No product-source change is needed for Task 5 — the behavior is delivered by Tasks 1–4; this task proves it end-to-end through `defineAuthz`.

- [ ] **Step 4: Run — verify it passes**

Run: `bun run --filter @stackbase/authz test relation-policy`
Expected: PASS — only shared docs visible; the subscription gains the doc on share and loses it on unshare.

- [ ] **Step 5: Document in `components/authz/README.md`**

In the row-policies region (near where `read` policies / the complexity ladder Level 3 are described), add a concise "Relation predicates" note:

```markdown
**Relation predicates (`some` / `is`).** A read policy can filter by related rows:
- `{ sharedWith: { some: { userId: auth.userId } } }` — to-many: a row in the related
  child table names the caller. Declare the relation on the table:
  `defineTable({...}).relation("sharedWith", { table: "document_shares", field: "documentId" })`.
- `{ orgId: { is: { ownerId: auth.userId } } }` — to-one: follow a `v.id` field to its row
  and test it (no declaration needed).

Both are **reactive** — a write to the related table live-updates the subscription — and the leaf
of a relation clause is field-predicates-only (nested relations are not yet supported). Performance
note: v1 scans the related table per clause; declaring an index on the child's filtered field is
recommended and will be used once index push-down lands.
```

- [ ] **Step 6: Whole workspace green + commit**

Run: `bun run build && bun run typecheck && bun run test`
Expected: PASS (all prior slices green).

```bash
git add components/authz/test/relation-policy.test.ts components/authz/README.md
git commit -m "test(authz): relation-predicate sharing — only-shared-visible + reactive share/unshare; docs"
```

---

## Self-Review (completed by plan author)

**Spec coverage:**
- §3.1 `.relation()` → Task 1. §3.2 `WhereInput` relation clauses + safety guard → Task 2. §4 relation registry + typo guards → Task 3. §5 `resolveWhere` semi-join → Task 2. §6 enforcement integration (3 read call-sites, get, write unchanged) → Task 4. §7 reactivity → proven in Task 5's reactive test. §8 perf caveat → documented in Task 5's README note. §9 testing → each task's tests. §10 file structure → matches. §11 out-of-scope → not built. ✅

**Placeholder scan:** No TBD/TODO; every code step is complete. Task 4 Step 4 gives the concrete empty registry (`{ toMany: new Map(), toOne: new Map() }`) for `baseKctx` and the exact main-`kctx` override line. ✅

**Type consistency:** `RelationRegistry` shape (`{ toMany, toOne }`) identical across Tasks 2 (definition), 3 (build), 4 (thread). `RelationJSON`/`relations` from Task 1 consumed by Task 3's extraction. `resolveReadPolicy(policy, rc, parentTable, relations)` defined in Task 2, called with `(policy, rc, tableName|meta.name, ctx.relationRegistry)` in Task 4. Registry keys are resolved full names (`getFullTableName(t,"")`) in Task 3, matched by the kernel's `tableName`/`meta.name` in Task 4. `by_creation` default index used consistently for the semi-join scans. ✅
```
