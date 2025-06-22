# authz Relation Ops (`none`/`every`/`isNot`) + Multi-Level Chains Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `none`/`every`/`isNot` relation operators and multi-level relation chains to read-policy predicates, extending the shipped `some`/`is` semi-join resolver.

**Architecture:** Entirely within `packages/executor/src/policy.ts`. The five to-many/to-one ops all reduce to collecting a parent-id set and emitting an `in`/`notIn` membership `FilterExpr` (`some`→`in`, `none`/`isNot`→`notIn`, `every`→`notIn` over the negated leaf, `is`→`in`). Multi-level = the leaf is resolved by a recursive `resolveWhere` (against the child/target table) instead of `compileWhere`, bounded by a depth cap of 4 (throw). The `RelationRegistry` and kernel/runtime wiring from the prior slice already support this — no schema, compose, kernel, or runtime change.

**Tech Stack:** TypeScript, Bun (package manager + runtime), Turborepo, vitest. Builds on the merged relation-predicates slice (`resolveWhere`, `compileWhere`, `RelationRegistry`, the rule-context `db` reader).

## Global Constraints

- **Bun toolchain:** `bun run build`, `bun run typecheck`, `bun run test`; single package `bun run --filter <pkg> test`. Never pnpm/npm.
- **Ops:** to-many `some`/`none`/`every`; to-one `is`/`isNot`. Each resolves to a plain `in`/`notIn` `FilterExpr` over the parent scan (composes under AND/OR/NOT).
- **`every` is vacuously true:** a parent with zero related rows matches (`_id notIn S(¬leaf)`).
- **Multi-level:** the leaf of a relation clause is resolved by recursive `resolveWhere(leaf, childCtx)` against the child/target table; `ResolveCtx` carries `depth` (entry 0); a relation clause resolves its leaf at `depth+1`; `depth+1 > 4` throws `relation nesting exceeds max depth 4 on "<table>"`. Fail-closed.
- **Safety:** `compileWhere` throws on ANY of the five relation keys (it only ever sees innermost field-pred leaves; a relation key reaching it is a bug, never a silent over-permit).
- **Edge cases:** null/missing to-one fk → excluded from both `is` and `isNot` (a missing field never satisfies `in`/`notIn` in `evaluateFilter`); empty collected set → `some`/`is` deny (`in []`), `none`/`every`/`isNot` admit (`notIn []`).
- **No query-engine changes;** reuse `db.query(table, "by_creation").collect()` + `evaluateFilter` + `compileWhere`.
- **TDD, frequent commits.** Each task ends green (`build`/`typecheck`/`test`) with one commit.
- `noUncheckedIndexedAccess: true` — index accesses may need `!`/guards.

---

## File Structure

- `packages/executor/src/policy.ts` (**modify**) — extend `RelationClause`, `isRelationClause`, `compileField` guard; add `ResolveCtx.depth`; replace `resolveSome`/`resolveIs` with shared collectors + `resolveNone`/`resolveEvery`/`resolveIsNot`; recursive leaf resolution + depth cap; seed `depth: 0` in `resolveReadPolicy`.
- `packages/executor/test/resolve-where.test.ts` (**modify**) — add unit cases for the new ops, multi-level, depth throw, vacuous `every`, null-fk, guard.
- `components/authz/test/relation-policy.test.ts` (**modify**) — add a multi-level (2-hop team share) integration + reactive case.
- `components/authz/README.md` (**modify**) — document the 3 new ops, `every` vacuous rule, multi-level + depth cap, null-fk note.

---

## Task 1: Extend the resolver — `none`/`every`/`isNot` + multi-level + depth cap

**Files:**
- Modify: `packages/executor/src/policy.ts`
- Test: `packages/executor/test/resolve-where.test.ts`

**Interfaces:**
- Consumes (shipped): `compileWhere`, `WhereInput`, `PolicyPredicate`, `TablePolicy`, `RuleContext`, `RelationRegistry`, `ResolveCtx`, `resolveWhere`, `resolveReadPolicy`, module-frozen `ALWAYS_TRUE`/`ALWAYS_FALSE`; `evaluateFilter`/`FilterExpr` from `@stackbase/query-engine`; `Value` from `@stackbase/values`.
- Produces:
  - `RelationClause = { some: WhereInput } | { none: WhereInput } | { every: WhereInput } | { is: WhereInput } | { isNot: WhereInput }`.
  - `ResolveCtx` gains `depth: number`.
  - `const MAX_RELATION_DEPTH = 4`.
  - `resolveWhere`/`resolveReadPolicy` signatures unchanged (external), but `resolveReadPolicy` seeds `depth: 0`.

- [ ] **Step 1: Write the failing tests**

First, **update the existing `ctx` fixture** (currently `const ctx = { parentTable: "documents", relations, db: fakeDb };`) to add the now-required `depth` field — otherwise the shipped single-level tests fail typecheck once `ResolveCtx.depth` is required:

```ts
const ctx = { parentTable: "documents", relations, db: fakeDb, depth: 0 };
```

Then append the new fixtures + cases below (the existing file already defines `fakeDb`, `relations` for `documents`/`document_shares`/`orgs`; `evaluateFilter` is NOT yet imported, so add the import):

```ts
import { evaluateFilter } from "@stackbase/query-engine";

describe("resolveWhere — none / every / isNot", () => {
  it("none → parent `_id notIn [matching back-refs]`", async () => {
    expect(await resolveWhere({ sharedWith: { none: { userId: "u1" } } }, ctx)).toEqual({
      op: "and", clauses: [{ op: "neq", field: "_id", value: "d3" }],
    });
  });

  it("every → parent `_id notIn [back-refs of children FAILING the leaf]` (vacuously true for none)", async () => {
    // children failing userId==u1 are s2 (userId u2) → back-ref d9 → notIn [d9]
    expect(await resolveWhere({ sharedWith: { every: { userId: "u1" } } }, ctx)).toEqual({
      op: "and", clauses: [{ op: "neq", field: "_id", value: "d9" }],
    });
  });

  it("isNot → parent `<fk> notIn [matching target _ids]`", async () => {
    expect(await resolveWhere({ orgId: { isNot: { ownerId: "u1" } } }, ctx)).toEqual({
      op: "and", clauses: [{ op: "neq", field: "orgId", value: "o1" }],
    });
  });

  it("empty match: none/isNot admit (notIn []→always-true)", async () => {
    expect(await resolveWhere({ sharedWith: { none: { userId: "nobody" } } }, ctx)).toEqual({ op: "and", clauses: [] });
  });

  it("null/missing to-one fk is excluded from isNot (fail-closed)", async () => {
    const expr = await resolveWhere({ orgId: { isNot: { ownerId: "u1" } } }, ctx); // orgId notIn [o1]
    // a parent doc with NO orgId field must NOT match (missing field fails neq)
    expect(evaluateFilter({ _id: "x", title: "no-org" } as never, expr!)).toBe(false);
    // a doc whose orgId is o2 (not o1) matches
    expect(evaluateFilter({ _id: "y", orgId: "o2" } as never, expr!)).toBe(true);
  });
});

describe("resolveWhere — multi-level chains", () => {
  // documents --sharedWith(some)--> document_shares --team(is)--> teams --members(some)--> team_members
  const CHILD2 = {
    document_shares: [{ _id: "s1", documentId: "d3", team: "t1", _creationTime: 1 }],
    teams: [{ _id: "t1", _creationTime: 1 }, { _id: "t2", _creationTime: 2 }],
    team_members: [{ _id: "m1", teamId: "t1", userId: "u1", _creationTime: 1 }],
  } as Record<string, unknown[]>;
  const db2 = { query: (t: string) => ({ collect: async () => CHILD2[t] ?? [] }) } as never;
  const relations2 = {
    toMany: new Map([
      ["documents", new Map([["sharedWith", { table: "document_shares", field: "documentId" }]])],
      ["teams", new Map([["members", { table: "team_members", field: "teamId" }]])],
    ]),
    toOne: new Map([["document_shares", new Map([["team", "teams"]])]]),
  } as never;
  const ctx2 = { parentTable: "documents", relations: relations2, db: db2, depth: 0 };

  it("resolves a 3-hop chain to the correct parent membership", async () => {
    // doc d3 is shared with team t1, and u1 is a member of t1 → d3 visible
    expect(await resolveWhere(
      { sharedWith: { some: { team: { is: { members: { some: { userId: "u1" } } } } } } }, ctx2,
    )).toEqual({ op: "or", clauses: [{ op: "eq", field: "_id", value: "d3" }] });
  });

  it("throws when nesting exceeds max depth 4", async () => {
    // self-referential node.parent chain, 5 `is` levels deep
    const nodeRel = { toMany: new Map(), toOne: new Map([["node", new Map([["parent", "node"]])]]) } as never;
    const nctx = { parentTable: "node", relations: nodeRel, db: { query: () => ({ collect: async () => [] }) } as never, depth: 0 };
    const p5 = { parent: { is: { parent: { is: { parent: { is: { parent: { is: { parent: { is: { x: 1 } } } } } } } } } } };
    await expect(resolveWhere(p5, nctx)).rejects.toThrow(/max depth 4/);
  });
});

describe("compileWhere guard covers all relation keys", () => {
  it("throws on none/every/isNot keys too", () => {
    for (const k of ["none", "every", "isNot"]) {
      expect(() => compileWhere({ x: { [k]: { a: 1 } } } as never)).toThrow(/relation clause/);
    }
  });
});
```

- [ ] **Step 2: Run — verify it fails**

Run: `bun run --filter @stackbase/executor test resolve-where`
Expected: FAIL — `none`/`every`/`isNot` unhandled (treated as unknown / thrown by the old guard), multi-level leaf throws (old `compileWhere(leaf)` rejects nested), no `depth` on `ResolveCtx`.

- [ ] **Step 3: Implement in `policy.ts`**

**(a)** Replace the `RelationClause` type:

```ts
export type RelationClause =
  | { some: WhereInput } | { none: WhereInput } | { every: WhereInput }
  | { is: WhereInput } | { isNot: WhereInput };
```

**(b)** Add `depth` to `ResolveCtx`:

```ts
export interface ResolveCtx {
  parentTable: string;
  relations: RelationRegistry;
  db: GuestDatabaseReader;
  depth: number;
}
```

**(c)** Replace the `compileField` relation-key guard (the `if ("some" in ops || "is" in ops)` block) with:

```ts
  if ("some" in ops || "none" in ops || "every" in ops || "is" in ops || "isNot" in ops)
    throw new Error(`relation clause keys (some/none/every/is/isNot) cannot appear in a field predicate — they are resolved only by resolveWhere`);
```

**(d)** Add the depth constant near the top of the resolver section:

```ts
const MAX_RELATION_DEPTH = 4;

/** Build the child rule-context for resolving a relation clause's leaf, enforcing the depth cap. */
function childCtx(ctx: ResolveCtx, table: string): ResolveCtx {
  const depth = ctx.depth + 1;
  if (depth > MAX_RELATION_DEPTH)
    throw new Error(`relation nesting exceeds max depth ${MAX_RELATION_DEPTH} on "${ctx.parentTable}"`);
  return { parentTable: table, relations: ctx.relations, db: ctx.db, depth };
}
```

**(e)** Replace `isRelationClause`, `resolveSome`, `resolveIs`, and `resolveClause` with:

```ts
function isRelationClause(cond: unknown): cond is RelationClause {
  if (cond === null || typeof cond !== "object" || Array.isArray(cond) || cond instanceof ArrayBuffer) return false;
  return "some" in cond || "none" in cond || "every" in cond || "is" in cond || "isNot" in cond;
}

/** Collect the set of parent back-ref ids for a to-many relation whose child rows match (or, if
 *  `negate`, FAIL) the recursively-resolved leaf. Used by some/none (matching) and every (negated). */
async function collectToManyIds(relName: string, leaf: WhereInput, ctx: ResolveCtx, negate: boolean): Promise<Value[]> {
  const rel = ctx.relations.toMany.get(ctx.parentTable)?.get(relName);
  if (!rel) throw new Error(`unknown relation "${relName}" on table "${ctx.parentTable}"`);
  const leafExpr = await resolveWhere(leaf, childCtx(ctx, rel.table));
  const rows = await ctx.db.query(rel.table, "by_creation").collect();
  const ids = new Set<Value>();
  for (const row of rows) {
    const matches = leafExpr === null ? true : evaluateFilter(row, leafExpr);
    if (matches !== negate) {
      const ref = (row as Record<string, unknown>)[rel.field];
      if (ref !== undefined) ids.add(ref as Value);
    }
  }
  return [...ids];
}

/** Collect the set of matching target `_id`s for a to-one (v.id) field, against the resolved leaf. */
async function collectToOneIds(fieldName: string, leaf: WhereInput, ctx: ResolveCtx): Promise<Value[]> {
  const targetTable = ctx.relations.toOne.get(ctx.parentTable)?.get(fieldName);
  if (!targetTable) throw new Error(`field "${fieldName}" is not a reference (v.id) on table "${ctx.parentTable}"`);
  const leafExpr = await resolveWhere(leaf, childCtx(ctx, targetTable));
  const rows = await ctx.db.query(targetTable, "by_creation").collect();
  const ids = new Set<Value>();
  for (const row of rows) {
    if (leafExpr === null || evaluateFilter(row, leafExpr)) {
      const id = (row as Record<string, unknown>)._id;
      if (id !== undefined) ids.add(id as Value);
    }
  }
  return [...ids];
}

async function resolveClause(key: string, cond: unknown, ctx: ResolveCtx): Promise<FilterExpr> {
  if (isRelationClause(cond)) {
    if ("some" in cond) return compileWhere({ _id: { in: await collectToManyIds(key, cond.some, ctx, false) } }) ?? ALWAYS_FALSE;
    if ("none" in cond) return compileWhere({ _id: { notIn: await collectToManyIds(key, cond.none, ctx, false) } }) ?? ALWAYS_TRUE;
    if ("every" in cond) return compileWhere({ _id: { notIn: await collectToManyIds(key, cond.every, ctx, true) } }) ?? ALWAYS_TRUE;
    if ("is" in cond) return compileWhere({ [key]: { in: await collectToOneIds(key, cond.is, ctx) } }) ?? ALWAYS_FALSE;
    return compileWhere({ [key]: { notIn: await collectToOneIds(key, cond.isNot, ctx) } }) ?? ALWAYS_TRUE;
  }
  return compileWhere({ [key]: cond } as WhereInput) ?? ALWAYS_TRUE;
}
```

> `resolveNode` and `resolveWhere` are unchanged (they call `resolveClause`). The `cond.some`/`cond.none`/etc. accesses narrow correctly because `isRelationClause` is a type guard over the union.

**(f)** Seed `depth: 0` in `resolveReadPolicy`:

```ts
export async function resolveReadPolicy(
  policy: TablePolicy, rc: RuleContext, parentTable: string, relations: RelationRegistry,
): Promise<FilterExpr | null> {
  if (!policy.read) return null;
  return resolveWhere(await policy.read(rc), { parentTable, relations, db: rc.db, depth: 0 });
}
```

- [ ] **Step 4: Run — verify it passes**

Run: `bun run --filter @stackbase/executor test resolve-where`
Expected: PASS — all new ops, multi-level 3-hop, depth-5 throw, vacuous `every`, null-fk, and the widened guard.

- [ ] **Step 5: Whole workspace green + commit**

Run: `bun run build && bun run typecheck && bun run test`
Expected: PASS — the shipped single-level `some`/`is` tests (`resolve-where.test.ts`, `relation-enforce.test.ts`, authz `relation-policy.test.ts`) stay green: `some`/`is` behavior is unchanged, and the recursive leaf resolve degrades to `compileWhere` for field-pred leaves.

```bash
git add packages/executor/src/policy.ts packages/executor/test/resolve-where.test.ts
git commit -m "feat(executor): relation ops none/every/isNot + multi-level chains (depth-capped)"
```

---

## Task 2: authz multi-level e2e + reactive contract + docs

**Files:**
- Modify: `components/authz/test/relation-policy.test.ts`, `components/authz/README.md`

**Interfaces:**
- Consumes: Task 1's ops through the full stack (`composeComponents` builds the `RelationRegistry` for the extra tables; `resolveReadPolicy` resolves the multi-level policy). No new product source.

- [ ] **Step 1: Write the failing test**

Append a new `describe` to `components/authz/test/relation-policy.test.ts` (reuse its imports + the local `systemModules()` with `_system:insertDocument`/`_system:deleteDocument`):

```ts
describe("authz multi-level relation policy (team sharing)", () => {
  // documents --sharedWith--> document_shares --team(v.id)--> teams --members--> team_members
  const authzTeam = defineAuthz({
    policies: { documents: { read: ({ auth }) => ({
      sharedWith: { some: { team: { is: { members: { some: { userId: auth.userId } } } } } },
    }) } },
  });
  const schema = defineSchema({
    documents: defineTable({ title: v.string() }).relation("sharedWith", { table: "document_shares", field: "documentId" }),
    document_shares: defineTable({ documentId: v.id("documents"), team: v.id("teams") }),
    teams: defineTable({ name: v.string() }).relation("members", { table: "team_members", field: "teamId" }),
    team_members: defineTable({ teamId: v.id("teams"), userId: v.string() }),
  });
  async function makeRuntime() {
    const c = composeComponents({ schemaJson: schema.export(), moduleMap: {
      "docs:list": query(async (ctx) => ctx.db.query("documents", "by_creation").collect()),
    } }, [auth, authzTeam]);
    return EmbeddedRuntime.create({
      store: new SqliteDocStore(new NodeSqliteAdapter()),
      catalog: c.catalog, modules: c.moduleMap, systemModules: systemModules(),
      componentNames: c.componentNames, contextProviders: c.contextProviders,
      policyRegistry: c.policyRegistry, policyProviders: c.policyProviders, relationRegistry: c.relationRegistry,
    });
  }

  it("a doc shared with a team the caller belongs to is visible; reactively on membership change", async () => {
    const r = await makeRuntime();
    const { token, userId } = (await r.run<{ token: string; userId: string }>("auth:signUp", { email: "u@b.co", password: "pw" })).value;
    const team = (await r.runSystem<string>("_system:insertDocument", { table: "teams", fields: { name: "eng" } })).value;
    const doc = (await r.runSystem<string>("_system:insertDocument", { table: "documents", fields: { title: "spec" } })).value;
    await r.runSystem("_system:insertDocument", { table: "document_shares", fields: { documentId: doc, team } });

    // Not a member yet → not visible.
    expect((await r.run<any[]>("docs:list", {}, { identity: token })).value).toEqual([]);

    // Subscribe, then add the caller to the team → the doc appears live (inner-relation reactivity).
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
    expect(last()).toEqual([]);

    const membership = (await r.runSystem<string>("_system:insertDocument", { table: "team_members", fields: { teamId: team, userId } })).value;
    await new Promise((res) => setTimeout(res, 50));
    expect((last() as any[]).map((d) => d.title)).toEqual(["spec"]);   // joined team → doc revealed live

    await r.runSystem("_system:deleteDocument", { id: membership });
    await new Promise((res) => setTimeout(res, 50));
    expect(last()).toEqual([]);                                        // left team → doc hidden live
  });
});
```

- [ ] **Step 2: Run — verify it fails (or investigate if it passes)**

Run: `bun run --filter @stackbase/authz test relation-policy`
Expected: FAIL before Task 1 is present. WITH Task 1 merged it should PASS — run it to confirm the multi-level chain resolves and the inner-membership reactivity fires end-to-end. If it fails, the bug is real (read-set of the innermost `team_members` scan must join the subscription); do systematic root-cause investigation, do not weaken the assertion.

- [ ] **Step 3: Document in `components/authz/README.md`**

In the relation-predicates area (right after the `some`/`is` note added last slice), add:

```markdown
**More relation operators.** Beyond `some`/`is`, read policies support:
- `{ rel: { none: leaf } }` — to-many: *no* related row matches `leaf`.
- `{ rel: { every: leaf } }` — to-many: *all* related rows match `leaf`. This is **vacuously true** — a
  parent with zero related rows matches. For "at least one AND all match", write
  `{ AND: [{ rel: { some: {} } }, { rel: { every: leaf } }] }`.
- `{ fkField: { isNot: leaf } }` — to-one: the referenced row does *not* match `leaf`. A row whose
  `fkField` is null/absent is excluded from both `is` and `isNot` (there is no referenced row to test).

**Multi-level chains.** A relation clause's leaf may itself contain relation clauses, e.g. a doc shared
with a *team* you belong to:
`{ sharedWith: { some: { team: { is: { members: { some: { userId: auth.userId } } } } } } }`.
Each level is reactive — a write to any table on the chain (including joining/leaving the team) live-updates
the subscription. Nesting is capped at **4 relational levels**; a deeper policy throws at query time.
```

- [ ] **Step 4: Whole workspace green + commit**

Run: `bun run build && bun run typecheck && bun run test`
Expected: PASS (all prior slices green; authz gains the multi-level e2e).

```bash
git add components/authz/test/relation-policy.test.ts components/authz/README.md
git commit -m "test(authz): multi-level team-share policy — reactive on inner membership; docs"
```

---

## Self-Review (completed by plan author)

**Spec coverage:** §2 ops → Task 1 (`RelationClause`, `resolveClause` dispatch). §3 semantics table (`in`/`notIn`, `every`=notIn(¬leaf)) → Task 1 (`resolveClause` + `collectToManyIds` negate). §3.1 edge cases (vacuous every, null-fk, empty-set) → Task 1 unit tests. §4 multi-level + depth cap → Task 1 (`childCtx`, recursive `resolveWhere`, `MAX_RELATION_DEPTH`). §5 guard → Task 1 (c). §6 reactivity → Task 2 reactive test. §7 testing → Tasks 1–2. §8 file structure → matches (policy.ts + tests + README only). §9 out-of-scope → not built. ✅

**Placeholder scan:** No TBD/TODO; every code step is complete. ✅

**Type consistency:** `RelationClause` (5-way union), `ResolveCtx.depth`, `MAX_RELATION_DEPTH`, `childCtx`, `collectToManyIds(relName, leaf, ctx, negate)`, `collectToOneIds(fieldName, leaf, ctx)` defined and used consistently in Task 1. `resolveClause` returns `FilterExpr`; the `in`→`ALWAYS_FALSE` / `notIn`→`ALWAYS_TRUE` fallbacks match `compileWhere`'s never-null-for-a-field-object behavior. Task 2 consumes the ops only through the public `defineAuthz`/`composeComponents`/`EmbeddedRuntime` surface — no internal coupling. ✅
```
