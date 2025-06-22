# authz Relation Ops (`none`/`every`/`isNot`) + Multi-Level Chains — design

**Status:** approved (brainstorming) — 2025-06-07
**Slice:** `@stackbase/authz` — successor to the merged relation-predicates slice (`de923d4`), which shipped `some` (to-many) + `is` (to-one), single relational level, via a semi-join resolver.
**Predecessor context:** `resolveWhere` (in `packages/executor/src/policy.ts`) resolves a relation clause by querying the related table through the rule-context's policy-free, txn-bound `db` reader, collecting a matching id-set, and rewriting the clause to a parent `in` membership filter. The `RelationRegistry` (built at compose from every table's `v.id` fields + declared `.relation()`s) and the kernel/runtime wiring already thread through — so this slice touches almost nothing outside `policy.ts`.

---

## 1. Goal

Complete the relation-predicate vocabulary and allow nesting:

- **to-many:** `some` (≥1 related row matches), `none` (0 match), `every` (all match).
- **to-one:** `is` (referenced row matches), `isNot` (referenced row does not match).
- **multi-level:** a relation clause's leaf may itself contain relation clauses (e.g. "a doc shared with a *team* I belong to"), bounded to a safe depth.

```ts
read: ({ auth }) => ({
  OR: [
    { ownerId: auth.userId },
    { sharedWith: { some: { userId: auth.userId } } },                    // single level (shipped)
    { sharedWith: { some: { team: { is: { members: { some: { userId: auth.userId } } } } } } }, // multi-level (this slice)
    { tags: { every: { public: true } } },                               // every
  ],
})
```

---

## 2. Locked decisions (from brainstorming)

1. **Ops:** to-many `some`/`none`/`every`; to-one `is`/`isNot`.
2. **`every` is vacuously true** — a parent with **zero** related rows matches (standard `∀`). Keeps `some`/`none`/`every` clean duals; `NOT(every) == some(¬leaf)`. An author who wants "at least one AND all match" writes `{ AND: [{ rel: { some: {} } }, { rel: { every: leaf } }] }` explicitly.
3. **Multi-level with a depth cap of 4, throwing at the limit.** Each relation clause adds one nesting level; exceeding 4 throws a clear error naming the table. The cap bounds authored nesting depth and per-query cost / read-set fan-out (a deeply-nested policy would issue one full child-table scan per level). It is a cost/sanity guard, not a termination guard — `resolveWhere` recurses on the policy's finite `WhereInput` literal, not the schema graph, so it always terminates regardless. Fail-closed (the query errors, no data leaks) and diagnosable.

---

## 3. Operator semantics

Every to-many op reduces to collecting one parent-id set and a membership rewrite. Let `S(pred)` = `{ child[backref] : child row matches pred }` for the declared to-many relation (`{ table, field }`):

| Op | Meaning | Rewrite |
|---|---|---|
| `some(leaf)` | ≥1 related row matches `leaf` | `{ _id: { in: S(leaf) } }` |
| `none(leaf)` | 0 related rows match `leaf` | `{ _id: { notIn: S(leaf) } }` |
| `every(leaf)` | all related rows match `leaf` (∀) | `{ _id: { notIn: S(¬leaf) } }` |

To-one, with `T(pred)` = `{ target._id : target row matches pred }` for the `v.id` field's target table:

| Op | Meaning | Rewrite |
|---|---|---|
| `is(leaf)` | the referenced row matches `leaf` | `{ fk: { in: T(leaf) } }` |
| `isNot(leaf)` | the referenced row does not match `leaf` | `{ fk: { notIn: T(leaf) } }` |

`¬leaf` for `every` means "a child that does NOT satisfy `leaf`" — i.e. a child is counted into `S(¬leaf)` when `!evaluateFilter(child, leafExpr)`. `every` then denies exactly the parents that have such a violating child, and admits everyone else (including childless parents → vacuous true).

Because every op resolves to a plain `in`/`notIn` `FilterExpr` over the parent scan, they compose correctly under `AND`/`OR`/`NOT`.

### 3.1 Edge cases (documented behavior)
- **`every` over zero related rows → matches (visible).** Vacuous truth, per decision 2.
- **Null / missing to-one fk → excluded from both `is` and `isNot`.** A parent whose `fk` field is absent or null has no referenced row to test; `in`/`notIn` over `T` both exclude it (a missing field never satisfies a comparison in `evaluateFilter`). This is fail-closed (fewer rows visible) and is documented so authors don't expect a null-fk row to satisfy `isNot`.
- **Empty `S`/`T`:** `some`/`is` over an empty set → `in: []` → always-false (deny). `none`/`isNot`/`every` over an empty set → `notIn: []` → always-true (admit). Both are the correct set semantics.

---

## 4. Multi-level recursion + depth cap

The leaf of a relation clause is resolved by a **recursive `resolveWhere(leaf, childCtx)`** against the child (to-many) or target (to-one) table, replacing today's pure `compileWhere(leaf)`:

- `childCtx = { parentTable: childTable, relations, db, depth: ctx.depth + 1 }`.
- Nested relation clauses in the leaf resolve against the child table's own relations, which the `RelationRegistry` already contains (to-one `v.id` fields + declared `.relation()`s). **No new declaration and no compose change.**
- The recursively-resolved leaf `FilterExpr` (which may itself embed a membership from a deeper semi-join) is applied to each child row with `evaluateFilter` to decide membership in `S`/`T`. A `null` resolved leaf (leaf was `true`/empty) normalizes to always-true for matching.

**Depth cap.** `ResolveCtx` gains `depth: number`; `resolveReadPolicy` seeds it at `0`. A relation clause resolves its leaf at `depth + 1`; if `depth + 1 > 4`, throw:
`relation nesting exceeds max depth 4 on "<parentTable>"`.
A top-level relation clause is depth 1; the README's 3-hop team example is depth 3; a 5th nesting level throws. Because a policy is a finite `WhereInput` literal, recursion always terminates — the cap exists to bound cost and read-set fan-out (and to catch an accidentally over-nested / programmatically-generated policy), not to prevent non-termination. The throw propagates out of the read handler and fails the query — fail-closed, no data leak.

---

## 5. Implementation shape (all in `packages/executor/src/policy.ts`)

- **Types:** `RelationClause` becomes `{ some: WhereInput } | { none: WhereInput } | { every: WhereInput } | { is: WhereInput } | { isNot: WhereInput }`; `isRelationClause` recognizes all five keys.
- **Collector:** `resolveSome`/`resolveIs` generalize into shared helpers — one collects a to-many parent-id set `S` for a resolved child predicate; one collects a to-one target-id set `T`. `resolveClause` dispatches the five ops onto them with the right `in`/`notIn` and (for `every`) the negated match test.
- **Recursion:** the child/target predicate is `await resolveWhere(leaf, childCtx)` (depth-incremented), not `compileWhere(leaf)`.
- **Guard:** `compileWhere` (the pure field-pred compiler) throws on **all five** relation keys — it should only ever see innermost field-pred leaves; a relation key reaching it is a bug, never a silent over-permit (safety-critical, extends the existing `some`/`is` guard).
- **Entry:** `resolveReadPolicy` builds the `ResolveCtx` with `depth: 0`. **No kernel, executor, runtime, compose, or schema change.**

---

## 6. Reactivity & performance

Each nesting level issues one full child-table scan through `rc.db`, whose consumed range joins the parent subscription's read-set (the existing mechanism). So a multi-level policy is reactive at **every** level — a write to any related table on the chain (e.g. adding me to a team, deep in a `sharedWith.some.team.is.members.some` policy) intersects that level's range and re-runs the subscription. Cost and read-set fan-out grow with depth, bounded by the cap-4 limit; this is consistent with the shipped v1 full-scan-per-clause tradeoff (index push-down remains the noted follow-up). Documented for policy authors.

---

## 7. Testing

- **`resolveWhere` units** (`packages/executor/test/resolve-where.test.ts`): `none` → `{ _id: { notIn: […] } }`; `every` → `notIn` over the negated leaf, including the **vacuous zero-children → matches** case; `isNot` → `{ fk: { notIn: […] } }`; a **null-fk** parent excluded from both `is` and `isNot`; empty-set `some`→deny / `none`→admit; a **multi-level** (2-hop) leaf resolves through the child table to the correct membership; a **depth-5 (over-nested)** policy throws the max-depth error.
- **Integration** (SQLite via `EmbeddedRuntime`): a `none` or `every` visibility case; a **2-hop team-sharing** case — a doc shared with a team the caller belongs to is visible, one shared with a team they left is not.
- **Reactive contract:** a multi-level (team-share) policy re-runs when an **inner** relation row changes — adding the caller to the team live-reveals the team-shared doc; removing them live-hides it.
- **Regression:** all RBAC, Layer 1 row-policy, and single-level relation tests stay green (the shipped `some`/`is` paths are unchanged behavior; `compileWhere`'s widened guard only fires on relation keys, which no field-pred test uses).

---

## 8. File structure

**Modify**
- `packages/executor/src/policy.ts` — the five ops, the shared collector, recursive leaf resolution, `ResolveCtx.depth` + cap, widened `compileWhere` guard.
- `components/authz/README.md` — document `none`/`every`/`isNot`, the `every` vacuous-true rule, multi-level nesting + the depth-4 cap, and the null-fk note.

**New tests**
- extend `packages/executor/test/resolve-where.test.ts` (unit).
- a multi-level e2e + reactive case in `components/authz/test/relation-policy.test.ts`.

**No changes** to `packages/values` (schema), `packages/component` (compose), `packages/executor/src/kernel.ts`, or `packages/runtime-embedded` — the registry and wiring from the previous slice already support this.

---

## 9. Out of scope (later slices)

`addRelation`/`removeRelation`/`hasRelation` sugar; usersets / group expansion (`"team:eng#member"`); the `effectivePermissions` pre-flattened index; index push-down for the semi-join scans; a configurable depth cap; relation predicates in *write* policies (write rules already use `ctx.db` directly); typed `Doc<T>`-aware relation names via codegen.
