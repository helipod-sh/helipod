# authz Relation Predicates (`some` / `is`) — design

**Status:** approved (brainstorming) — 2025-06-07
**Slice:** `@stackbase/authz` relation predicates — successor to the merged Layer 1 row-policies slice (`beef5df`).
**Predecessor context:** Layer 1 shipped kernel-enforced, reactive row policies with **field-predicate** `WhereInput` compiled to `FilterExpr`, a rule-context with a policy-free txn-bound `db` reader, and `privileged`-only bypass. This slice adds **relation predicates** so a read policy can filter by *related* rows ("docs shared with me", "rows whose org I own") — the README's Level 3 sharing capability — while staying reactive.

---

## 1. Goal

Let a read policy express visibility in terms of related tables:

```ts
read: ({ auth }) => ({
  OR: [
    { ownerId: auth.userId },                          // field predicate (Layer 1)
    { sharedWith: { some: { userId: auth.userId } } }, // to-many: a share row names me
    { orgId:      { is:   { ownerId: auth.userId } } },// to-one: I own the parent org
  ],
})
```

Sharing must be **reactive**: inserting/deleting a `document_shares` row live-updates the affected `documents` subscription. Enforcement stays kernel-side and unbypassable, exactly as Layer 1.

---

## 2. Locked decisions (from brainstorming)

1. **Scope: `some` (to-many) + `is` (to-one), single relational level.** The leaf of a relation clause is field-predicates-only (the Layer 1 `WhereInput`). Deferred: `none` / `every` / `isNot`, and multi-level relation chains (`sharedWith.some.team.is.members.some…`).
2. **Declaration: schema `.relation()` for to-many; `v.id` field for to-one.** A to-many relation is declared once on the table (`.relation(name, { table, field })`); a to-one `is` reads the parent's `v.id("target")` field — no declaration.
3. **Evaluation: semi-join pre-pass.** Each relation clause is resolved once — query the related table with the leaf predicate, collect the matching id-set, rewrite the clause to a parent `in` membership filter. The parent scan then runs as pure field predicates. **No query-engine changes** — the child query reuses the rule-context's existing `db` reader, so its read-set records automatically.

---

## 3. Public API

### 3.1 Schema: `.relation()` (to-many only)

`TableDefinition` (in `packages/values/src/schema.ts`) gains:

```ts
relation(name: string, spec: { table: string; field: string }): this
```

- `name` — the relation name used in policies (`sharedWith`).
- `table` — the **child** table holding the back-reference rows (`document_shares`).
- `field` — the child field that references THIS table's `_id` (`documentId`).

Declarations are serialized in the table's exported JSON as a `relations` array (`{ name, table, field }[]`), alongside `fields`/`indexes`/`shardKey`. `.relation()` on a table with no `_id`-referencing child is still valid syntactically; correctness of `field`/`table` is validated at compose time (§4).

To-one relations are **not** declared — `{ orgId: { is: … } }` uses the parent field `orgId`, whose `v.id("orgs")` validator already carries the target table (`{ type: "id", tableName: "orgs" }` in the schema JSON).

### 3.2 Policy: relation clauses in `WhereInput`

A field entry's value may now be a **relation clause**:

```ts
type RelationClause =
  | { some: WhereInput }   // to-many; the key is a declared relation name
  | { is: WhereInput };    // to-one; the key is a v.id field on the parent
```

So `WhereInput`'s field value becomes `Value | FieldOps | RelationClause`. Discrimination is unambiguous: a value object with a `some` or `is` key is a relation clause; otherwise it is `FieldOps` (whose keys are `eq/ne/lt/lte/gt/gte/in/notIn/isNull`). The relation clause's inner `WhereInput` is **field-predicates-only** in v1.

**Safety rule (must not silently over-permit):** `compileWhere` is relation-unaware and is used to compile leaves. It MUST throw when it encounters a `some`/`is` key in a field condition — otherwise a nested relation clause in a leaf would match no `FieldOps` operator and compile to *always-true* (a silent, over-permissive read). So a nested `some`/`is` (unsupported in v1) is a hard error surfaced by `compileWhere`, never a silent allow. Relation clauses are handled ONLY by `resolveWhere` (§5), which is the single entry point that recognizes them.

---

## 4. Relation registry (compose-time)

`composeComponents` already walks every table's schema JSON. It builds a `RelationRegistry`:

```ts
interface RelationRegistry {
  // to-many: parentTable → relationName → { table (child), field (back-ref) }
  toMany: ReadonlyMap<string, ReadonlyMap<string, { table: string; field: string }>>;
  // to-one: parentTable → fieldName → targetTable  (derived from v.id fields)
  toOne:  ReadonlyMap<string, ReadonlyMap<string, string>>;
}
```

- **to-many** entries come from each table's `relations` JSON. Keys use the resolved (root) table name, matching how the kernel resolves `tableName`.
- **to-one** entries are derived by scanning each table's field validators for `{ type: "id", tableName }`.
- **Validation (typo guards):** a `.relation()` whose `table` is not a known composed table, or whose `field` is not a field of that child table, throws at compose time with a named message. (A `v.id` pointing at an unknown table is already a schema concern; not re-validated here.)

`RelationRegistry` is threaded to `KernelContext.relationRegistry` via `RunOptions.relationRegistry`, exactly like Layer 1's `policyRegistry` — from `composeComponents` → `EmbeddedRuntime` → every non-privileged `executor.run`. It is pure schema metadata (no per-call state).

---

## 5. Semi-join resolver (`resolveWhere`, executor `policy.ts`)

A new **async** function supersedes `compileWhere` in the read-policy path:

```ts
interface ResolveCtx {
  parentTable: string;               // the table being queried (resolved/full name)
  relations: RelationRegistry;
  db: GuestDatabaseReader;           // rule-context's policy-free, txn-bound reader
}
async function resolveWhere(where: PolicyPredicate, ctx: ResolveCtx): Promise<FilterExpr | null>;
```

Algorithm (mirrors `compileWhere`, but async and relation-aware):

- `undefined`/`true` → `null`; `false` → always-false; `AND`/`OR`/`NOT` → recurse and combine with `and`/`or`/`not`.
- For each field key `k` with condition `cond`:
  - **`cond` has `some`** → to-many relation. `rel = relations.toMany.get(parentTable)?.get(k)` (missing → error `unknown relation "k" on <parentTable>`). `const rows = await ctx.db.query(rel.table, "by_creation").collect()`; `const leaf = compileWhere(cond.some)`; keep rows where `leaf === null || evaluateFilter(row, leaf)`; collect `row[rel.field]` (dedup) → clause `compileWhere({ _id: { in: ids } })`.
  - **`cond` has `is`** → to-one relation. `target = relations.toOne.get(parentTable)?.get(k)` (missing → error `field "k" is not a reference on <parentTable>`). `const rows = await ctx.db.query(target, "by_creation").collect()`; keep rows matching `compileWhere(cond.is)`; collect `row._id` (dedup) → clause `compileWhere({ [k]: { in: ids } })`.
  - **otherwise** → plain field predicate → `compileWhere({ [k]: cond })`.
- AND the per-field clauses together (single clause returned directly).

Empty id-set → `{ in: [] }` → always-false (correct: no related rows match → clause denies). The returned `FilterExpr` is pure field predicates; Layer 1's `mergeReadPolicy` AND-merges it into the parent query.

`compileWhere` stays pure/sync and is REUSED for the leaf predicates and for the rewritten membership clause — no duplication. Per §3.2's safety rule, `compileWhere` throws on a `some`/`is` key, so a nested relation clause in a leaf is a hard error rather than a silent always-true. `resolveWhere` is the async superset that only does I/O when a relation clause is present.

---

## 6. Enforcement integration

The Layer 1 read path swaps its sync compile for the async resolve:

- **`handleDbQuery` / `handleDbPaginate`:** replace `evalReadPolicy(policy, rc)` with `resolveReadPolicy(policy, rc, tableName, ctx.relationRegistry)`, which is `resolveWhere(await policy.read(rc), { parentTable: tableName, relations, db: rc.db })`; the result is `mergeReadPolicy`d into `query.filters` as today.
- **`handleDbGet`:** resolve the relation clauses (semi-join) to a membership `FilterExpr`, then `evaluateFilter(doc, expr)` against the single fetched doc — fail → `null`. (The `in`-set is computed via the child/target queries; the doc's `_id`/fk is tested against it.)
- **Write policies:** unchanged — they already return a boolean and may call `ctx.db` directly for relation checks.
- **Privileged / no-policy / no-relation:** unchanged. A policy with no relation clause performs zero child queries (`resolveWhere` degrades to `compileWhere`).

`resolveReadPolicy` runs on the rule-context's **policy-free** `db` reader (Layer 1 invariant), so the semi-join's child queries are not themselves re-gated (no re-entrancy) yet still record into the read-set (they share the call's `txn`).

---

## 7. Reactivity & read-set

Each relation clause issues a child/target query through `rc.db`, which routes through the normal kernel read path and calls `ctx.txn.recordRead(range)` for the consumed range. So the parent subscription's read-set = the parent scan range **+** one range per relation clause (the child/target scan). A write to `document_shares` (share/unshare) intersects that range → the `documents` subscription re-runs → the semi-join recomputes the id-set → the row appears/disappears. Same range-level invalidation granularity as the rest of the system; no new reactivity machinery.

---

## 8. Performance (honest caveat)

v1 resolves each relation clause with a **full scan of the child/target table** (the default `by_creation` index) plus an in-memory leaf filter. Consequences:
- Cost is O(child rows) per relation clause per policy evaluation.
- The recorded read-set range is the whole child table, so **any** write to that table re-runs dependent subscriptions (correct, but coarser than a narrowed range).

Acceptable for sharing-sized tables (a user's shares, an org's rows). **Deferred optimization:** select an index for the leaf's equality field to narrow both the scan and the recorded range. This is a pure internal optimization — no API change — and is documented as a known caveat for policy authors (declare an index on the child's filtered field; the engine will use it once index push-down lands).

---

## 9. Testing

- **`resolveWhere` units** (executor): `some` → `{ _id: { in: [...] } }` with the collected/deduped back-refs; `is` → `{ fk: { in: [...] } }` with matching target `_id`s; empty match → always-false; `AND`/`OR`/`NOT` recursion preserved; a no-relation predicate resolves identically to `compileWhere`; an unknown relation name / non-reference `is` field throws.
- **Kernel integration** (SQLite via `EmbeddedRuntime`): seed `documents` + `document_shares`; a doc shared with the caller is visible via `query`, an unshared one is not; `get` of an unshared doc → `null`; `is` (org-ownership) visibility; privileged bypass sees all.
- **Reactive contract (headline):** a subscribed `documents` query gains a row when a `document_shares` row naming the caller is inserted, and loses it when that row is deleted — asserted through the sync handler, mirroring the Layer 1 reactive test.
- **Regression:** the full existing suite (RBAC, Layer 1 row policies, auth, component, executor) stays green — the no-relation path is inert.

---

## 10. File structure

**New**
- `resolveWhere` + relation types + `RelationRegistry` in `packages/executor/src/policy.ts`.
- Relation extraction (+ typo guards) in `packages/component/src/compose.ts`.
- `.relation()` builder + `relations` JSON on `TableDefinition` in `packages/values/src/schema.ts`.
- Unit + integration + reactive tests (`packages/executor/test`, `components/authz/test`).

**Modify**
- `packages/executor/src/kernel.ts` — read path calls `resolveReadPolicy`; `KernelContext.relationRegistry`.
- `packages/executor/src/executor.ts` — `RunOptions.relationRegistry`; thread onto the main `KernelContext` (empty registry on the policy-free base ctx).
- `packages/runtime-embedded/src/runtime.ts` — `EmbeddedRuntimeOptions.relationRegistry`; pass through every non-privileged run call-site.
- `components/authz/README.md` — document `.relation()` + `some`/`is` in read policies + the index caveat.

---

## 11. Out of scope (later slices)

`none` / `every` / `isNot`; multi-level relation chains; `addRelation` / `removeRelation` / `hasRelation` convenience helpers (developers manage child rows with normal, policy-gated mutations for now); usersets / group expansion; index push-down for the semi-join scan; relation predicates in write policies (write rules already use `ctx.db`); typed `Doc<T>`-aware relation names via codegen.
