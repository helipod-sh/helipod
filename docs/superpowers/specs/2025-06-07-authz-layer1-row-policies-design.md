# authz Layer 1 — Kernel-Enforced Row Policies (design)

**Status:** approved (brainstorming) — 2025-06-07
**Slice:** `@stackbase/authz` Layer 1, the successor to the merged RBAC-core slice (`086787f`).
**Predecessor context:** RBAC-core shipped `ctx.authz.can/require/roles`, gated `assignRole`/`revokeRole`, Component→Component facades, and the reactive contract (a subscribed `can()` query flips on assign/revoke). This slice makes authorization *enforced by the engine* rather than something app code must remember to call.

---

## 1. Goal

Declare a `read`/`write` policy per app table. The kernel then **automatically filters every read and gates every write** for that table — reactively, and unbypassable from app code. This is the Supabase-RLS / Lunora "row-level security" capability, but reactive: a policy predicate becomes part of the query's read-set, so an authorization change (e.g. a role revocation) live-updates open subscriptions.

Success looks like:

```ts
// declared once
policies: {
  documents: {
    read:  ({ auth }) => auth.can("documents:read")
             ? true : { orgId: { in: /* scopes */ } },
    write: ({ auth }) => auth.can("documents:update"),
  },
}

// every app read is filtered by the kernel — no manual checks
await ctx.db.query("documents").collect()   // → only visible rows
```

---

## 2. Locked decisions (from brainstorming)

1. **Field predicates only (v1).** A read policy returns a field-level predicate (`eq/ne/in/notIn/lt/lte/gt/gte/isNull` + `AND/OR/NOT`) that AND-merges into every read; a write policy returns a boolean. This maps 1:1 onto the query engine's existing `FilterExpr`. Relation predicates (`some/none/every/is`), `count`-through-predicate, and join/`include` gating are **deferred** to a later Layer-1.5 sub-slice.
2. **Fully reactive.** Policy-internal reads (`auth.can()` / `auth.scopesWith()` reading `role_assignments`, and write-rule relation lookups) go through txn-bound readers, so they join the querying function's read-set. Revoking a role live-empties guarded subscriptions. Invalidation granularity is the same range-level the engine already uses.
3. **Privileged bypass only.** Policies are enforced for all normal (non-privileged) calls; `privileged` calls (`_system:*`, admin API, dashboard, migrations) skip enforcement — the same flag that already bypasses the namespace boundary. App code has **no** opt-out in v1. A per-op `ctx.db.unsafe()` may be added later if a real need appears.
4. **Kernel-inline enforcement (Approach A).** Enforcement runs inside the existing kernel syscall handlers, with policy logic factored into a new testable `packages/executor/src/policy.ts`. A generic component `policies` seam lets any component contribute policies; for v1 only `authz` does, and the engine stays authz-agnostic.

---

## 3. Public API

### 3.1 `defineAuthz` gains `policies`

```ts
defineAuthz({
  permissions,          // existing
  roles,                // existing
  policies?: {
    [table: string]: {
      read?:  (ctx: RuleContext) => PolicyPredicate | Promise<PolicyPredicate>,
      write?: (ctx: RuleContext, row: Record<string, unknown>) => boolean | Promise<boolean>,
    }
  },
})
```

- `table` is an **app (root-namespace) table name** (e.g. `"documents"`). (Gating a component's own tables is out of scope for v1.)
- `read` is optional (absent → reads unrestricted); `write` is optional (absent → writes unrestricted). A table listed in `policies` with neither is a no-op (lint-worthy, not an error).

### 3.2 `RuleContext`

```ts
interface RuleContext {
  auth: RuleAuth;
  db: GuestDatabaseReader;   // read-only, txn-bound, namespace of the gated table
}

interface RuleAuth {
  userId: string | null;                                   // resolved caller (null = anonymous)
  identity: string | null;                                 // raw token/claims
  can(permission: string, scope?: Scope): Promise<boolean>;
  roles(scope?: Scope): Promise<string[]>;
  scopesWith(permission: string, type?: string): Promise<string[]>;   // NEW
}

type Scope = { type: string; id: string };
```

`RuleAuth` is built from the composed `auth` + `authz` facades. `RuleAuth.can/roles` are the existing authz-facade methods; `userId`/`identity` come from the `auth` facade. `RuleContext.db` is a **separate** read-only reader in the gated table's namespace, for a write rule's relation lookups (`"is the caller a member of row.orgId?"`).

### 3.3 `scopesWith` (new)

`scopesWith(permission, type?)` returns the scope ids where the caller holds `permission`: read the caller's `role_assignments`, keep those whose role grants `permission` (via `roleGrants`), return their `scopeId`s (deduped), optionally filtered to `scopeType === type`. Global assignments (`scopeType === ""`) are returned as the empty-string scope id — callers using `{ orgId: { in: scopes } }` should special-case a global grant with a preceding `auth.can(permission)` check (as in the `documents` example). Added to both the `ctx.authz` facade and `RuleAuth`.

### 3.4 `PolicyPredicate` / `WhereInput`

```ts
type PolicyPredicate = WhereInput | true | false | undefined;   // true/undefined = unrestricted, false = zero rows

type WhereInput =
  | { [field: string]: ScalarValue | FieldOps }   // bare value = eq; multiple fields = AND
  | { AND: WhereInput[] }
  | { OR:  WhereInput[] }
  | { NOT: WhereInput };

interface FieldOps {
  eq?: ScalarValue; ne?: ScalarValue;
  lt?: ScalarValue; lte?: ScalarValue; gt?: ScalarValue; gte?: ScalarValue;
  in?: ScalarValue[]; notIn?: ScalarValue[];
  isNull?: boolean;
}
```

`WhereInput` is **structurally typed** in v1 (a plain object shape). Full `Doc<T>`-typed field/operator inference via codegen is deferred.

---

## 4. WhereInput → FilterExpr compilation

The query engine's `FilterExpr` (`packages/query-engine/src/filter.ts`) supports `eq/neq/lt/lte/gt/gte` field ops and `and/or/not`. `policy.ts` lowers `WhereInput` onto it **without changing the engine**:

| WhereInput | FilterExpr |
|---|---|
| `{ field: value }` (bare) | `{ op: "eq", field, value }` |
| `{ field: { eq } }` / `ne`/`lt`/`lte`/`gt`/`gte` | corresponding op (`ne`→`neq`) |
| `{ field: { in: [a,b] } }` | `{ op: "or", clauses: [eq a, eq b] }` (empty `in` → always-false) |
| `{ field: { notIn: [a,b] } }` | `{ op: "and", clauses: [neq a, neq b] }` (empty `notIn` → always-true) |
| `{ field: { isNull: true } }` | `{ op: "eq", field, value: null }` (`false` → `neq null`) |
| multiple fields in one object | `and` of each field clause |
| `{ AND: [...] }` / `{ OR: [...] }` / `{ NOT: x }` | `and` / `or` / `not` |
| `true` / `undefined` | no clause added |
| `false` | always-false clause (`{ op: "or", clauses: [] }`) |

An **always-false** clause is `{ op: "or", clauses: [] }` (OR of nothing = false); an **always-true** clause is `{ op: "and", clauses: [] }` (AND of nothing = true). Everything — including a `false` policy — flows through the same filter path, so the index range is recorded uniformly and reactivity is consistent.

---

## 5. Component-system seam (generic)

`defineComponent` gains two optional fields:

```ts
defineComponent({
  // …existing…
  policies?: Record<string, TablePolicy>,          // table → { read?, write? }
  policyContext?: (cctx: ComponentContext) => Record<string, unknown>,  // contributes fields to RuleContext (e.g. { auth })
})
```

`composeComponents` aggregates across enabled components:
- a **`PolicyRegistry`**: `Map<resolvedTableName, TablePolicy>` (v1 keys are root table names). Collision (two components claim the same table) → compose-time error.
- a merged **rule-context builder**: the union of every component's `policyContext(cctx)` output. For v1, `authz` contributes `{ auth: RuleAuth }`; the executor adds `db` to complete the `RuleContext`.

This keeps the executor/kernel ignorant of authz specifically — they consult a registry and call opaque `read`/`write` functions with a rule-context assembled from component contributions.

---

## 6. Enforcement (kernel-inline)

### 6.1 Threading

`InlineUdfExecutor` builds, **once per function call**, alongside the existing facades:
- the `PolicyRegistry` (static, from composition), and
- the per-call **rule-context** `{ ...componentPolicyContext, db: readonlyReader }` (readers txn-bound to the current attempt, so their reads record into the read-set).

Both are attached to `KernelContext` beside `namespace` / `privileged` / `identity`:

```ts
interface KernelContext {
  // …existing…
  readonly policyRegistry: PolicyRegistry;   // empty map when no policies composed
  readonly ruleContext: RuleContext | null;  // null when no policy provider composed
}
```

When `privileged` is true, or the registry has no entry for the table, handlers behave exactly as today (zero overhead, unchanged behavior — preserves all existing tests).

### 6.2 `policy.ts` (pure, unit-tested)

```ts
compileWhere(where: WhereInput | boolean): FilterExpr | null;         // null = no clause (true)
mergeReadPolicy(existing: FilterExpr[] | undefined, policyExpr: FilterExpr | null): FilterExpr[];
async evalRead(policy: TablePolicy, ctx: RuleContext): Promise<FilterExpr | null>;
async checkWrite(policy: TablePolicy, ctx: RuleContext, row): Promise<boolean>;
```

### 6.3 Handler changes (`kernel.ts`)

- **`handleDbQuery` / `handleDbPaginate`:** if gated, `const expr = await evalRead(policy, ruleCtx)` and `query.filters = mergeReadPolicy(query.filters, expr)` before `queryRuntime.collect/paginate`. Range recorded as today.
- **`handleDbGet`:** fetch doc as today; if gated and `policy.read`, `evaluateFilter(doc, expr)` — fail → return `null`. The existing read-recording of the fetched id is unchanged.
- **`handleDbInsert`:** build the candidate row; if gated and `policy.write`, `checkWrite(policy, ruleCtx, candidate)` → `false`/throw → `ForbiddenOperationError("write policy on <table>")`, before any index maintenance.
- **`handleDbReplace` / `handleDbDelete`:** the pre-write `oldDoc` is already fetched; `checkWrite(policy, ruleCtx, oldDoc)` → gate. (Checking the *new* row on replace is deferred; v1 gates on the pre-write row per the locked scope.)

### 6.4 Namespacing

`RuleContext.db` reads in the **gated table's namespace** (root for app tables), so a policy's relation lookups hit the right tables. `RuleAuth.can/roles/scopesWith` internally use the authz facade's own authz-namespace reader (unchanged). Both readers share the call's txn → both reactive.

---

## 7. Reactivity

No new machinery. Because every reader in the rule-context is txn-bound:
- `read` calling `auth.can("documents:read")` reads `authz/role_assignments`; those reads join the current query's read-set.
- A later `authz:revokeRole` writes `role_assignments`; the write-set intersects the subscription's read-set; the query re-runs; the read policy now returns fewer/zero rows; the client is pushed the shrunken result.

This is the RBAC-core reactive path, now driving automatic row filtering. Granularity is range-level (a role change can re-run several guarded subscriptions) — accepted, consistent with current invalidation.

---

## 8. Error handling & default-ON

- **Default-ON:** any table with a registry entry is gated on every non-privileged op.
- **Deny-by-default:** a `read` returning `false` yields zero rows; a `write` returning `false`/throwing yields `Forbidden`.
- **Read denials are silent** (empty result / `null` from `get`) — never leak the existence or size of hidden data.
- **Write denials throw** `ForbiddenOperationError` with a table-named message.
- Tables **without** a policy are ungated in v1 (the uncovered-table advisor is deferred).

---

## 9. Testing

- **`policy.ts` units:** `compileWhere` for every operator incl. `in`/`notIn`/`isNull` lowering and empty-list edges; nested `AND/OR/NOT`; `true`/`false`/`undefined`; `mergeReadPolicy` ANDs with a pre-existing user filter (both survive).
- **Kernel integration** (SQLite, via `EmbeddedRuntime`):
  - ownership read-filter: a user sees only their `todos`; another user's rows are absent from `query`, `paginate`, and `get` (`get` → `null`).
  - write-gating: insert/replace/delete of a non-owned row → `Forbidden`; owned row → ok.
  - privileged bypass: `runSystem` sees the full, unfiltered table.
  - deny-by-default: policy table + anonymous caller → zero rows.
- **Reactive contract (headline):** a session subscribes to `ctx.db.query("documents")` under a role-gated `read`; after `assignRole` the subscription gains rows, after `revokeRole` it drops to zero — asserted through the sync handler, mirroring the RBAC-core reactive test.
- **Regression:** the full existing suite stays green (no-policy path unchanged).
- Postgres parity is deferred (only the SQLite adapter is built today).

---

## 10. File structure

**New**
- `packages/executor/src/policy.ts` — `WhereInput`/`FilterExpr` types re-export, `compileWhere`, `mergeReadPolicy`, `evalRead`, `checkWrite`, `PolicyRegistry`, `RuleContext`/`RuleAuth` types.
- `packages/executor/test/policy.test.ts` — `policy.ts` units.
- `components/authz/src/policies.ts` — `WhereInput` helper types, `RuleAuth` builder, `scopesWith`.
- Kernel + authz integration/reactive tests (in `packages/executor/test` and `components/authz/test`).

**Modify**
- `packages/executor/src/kernel.ts` — handlers consult the registry + rule-context.
- `packages/executor/src/executor.ts` — build per-call rule-context; thread registry + rule-context into `KernelContext`.
- `packages/component/src/compose.ts` (+ `defineComponent`) — `policies` + `policyContext` seam; aggregate into a `PolicyRegistry` + merged rule-context builder; collision guard.
- `packages/runtime-embedded/src/runtime.ts` — pass the composed registry / rule-context builder through to the executor.
- `components/authz/src/define-authz.ts` — accept `policies`; contribute them + the `ruleContext` (`{ auth }`) builder.
- `components/authz/src/context.ts` — add `scopesWith` to the facade.

---

## 11. Out of scope (later slices)

Relation predicates (`some/none/every/is/isNot`) and the query-engine traversal they need; `count`-through-predicate; join/`include` gating; the uncovered-table advisor; app-level `ctx.db.unsafe()`; Postgres adapter parity; full `Doc<T>`-typed `WhereInput` via codegen; gating a component's own namespaced tables; checking the post-write row on replace.
