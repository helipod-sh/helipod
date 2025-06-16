# authz Layer 1 — Kernel-Enforced Row Policies Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Declare a `read`/`write` policy per app table; the kernel auto-filters every read and gates every write for that table — reactively and unbypassable from app code.

**Architecture:** Approach A (kernel-inline). Policy logic is a pure module `packages/executor/src/policy.ts` (`compileWhere`, `mergeReadPolicy`, `evalReadPolicy`, `evalWritePolicy`). The executor builds a per-call **rule-context** (`{ auth, db }`, txn-bound so policy reads join the read-set) and threads it + a **policy registry** through `KernelContext`; the kernel `db.*` handlers consult them. A generic `defineComponent({ policies, policyContext })` seam lets `composeComponents` aggregate the registry; only `authz` uses it in v1.

**Tech Stack:** TypeScript, Bun (package manager + runtime), Turborepo, vitest. Query engine's existing `FilterExpr` is the compile target (no engine changes).

## Global Constraints

- **Bun toolchain:** `bun install`, `bun run build`, `bun run typecheck`, `bun run test`; single package: `bun run --filter <pkg> test`. Never introduce pnpm/npm.
- **Field predicates only.** Read policies compile to the existing `FilterExpr` (`eq/neq/lt/lte/gt/gte/and/or/not`); `in`→OR-of-eq, `notIn`→AND-of-neq, `isNull`→eq/neq null. **No changes to `packages/query-engine`.** Relation predicates / count / joins are out of scope.
- **Fully reactive.** All rule-context readers are txn-bound (same `KernelContext.txn`), so `auth.can()`/`scopesWith()` reads of `role_assignments` join the querying function's read-set. No new reactivity machinery.
- **Privileged bypass only.** `ctx.privileged === true` skips ALL policy enforcement (exactly as it already skips the namespace boundary). App code has no opt-out. Facade readers and the rule-context's own `db` reader carry an **empty** registry / **null** rule-context builder (no re-entrant enforcement).
- **Default-ON, deny-by-default.** A table with a registry entry is gated on every non-privileged op. Read-deny is silent (empty / `null`); write-deny throws `ForbiddenOperationError`.
- **TDD, frequent commits.** Each task: failing test → verify red → minimal impl → green → commit. Whole workspace green (`build`/`typecheck`/`test`) before a task is done.
- **Reserved ctx keys:** `db`, `random`, `now` (a context provider named any of these throws).

---

## File Structure

- `packages/executor/src/policy.ts` (**new**) — policy types + pure `compileWhere`/`mergeReadPolicy`/`evalReadPolicy`/`evalWritePolicy`.
- `packages/executor/src/kernel.ts` (**modify**) — `KernelContext` gains `policyRegistry` + `getRuleContext`; `db.query`/`db.paginate`/`db.get`/`db.insert`/`db.replace`/`db.delete` consult policy.
- `packages/executor/src/executor.ts` (**modify**) — `RunOptions` gains `policyRegistry`/`policyProviders`; `run()` builds facades on a policy-free base ctx, then a memoized rule-context builder, then threads registry + builder into the main ctx.
- `packages/executor/src/index.ts` (**modify**) — export the policy surface.
- `packages/component/src/define-component.ts` (**modify**) — `ComponentDefinition` gains `policies?` + `policyContext?`.
- `packages/component/src/compose.ts` (**modify**) — aggregate `policyRegistry` + `policyProviders` into `ComposedProject`; typo/collision guards.
- `packages/runtime-embedded/src/runtime.ts` (**modify**) — thread `policyRegistry`/`policyProviders` from `create` through every non-privileged `executor.run` call-site.
- `components/authz/src/policies.ts` (**new**) — `buildRuleAuth(cctx)`; re-export `WhereInput`/`TablePolicy` for app authors.
- `components/authz/src/context.ts` (**modify**) — add `scopesWith` to the facade.
- `components/authz/src/roles.ts` (**modify**) — add `permission` arg support already exists (`roleGrants`); no change expected (used by `scopesWith`).
- `components/authz/src/define-authz.ts` (**modify**) — accept `policies`; contribute `policies` + `policyContext`.
- Tests: `packages/executor/test/policy.test.ts`, `packages/executor/test/row-policy.test.ts`, `packages/component/test/policy-compose.test.ts` (or extend an existing compose test), `components/authz/test/row-policy.test.ts`.

---

## Task 1: `policy.ts` — WhereInput→FilterExpr compilation (pure)

**Files:**
- Create: `packages/executor/src/policy.ts`
- Modify: `packages/executor/src/index.ts`
- Test: `packages/executor/test/policy.test.ts`

**Interfaces:**
- Consumes: `FilterExpr` from `@stackbase/query-engine`; `Value` from `@stackbase/values`; `GuestDatabaseReader` (type) from `./guest`; `ComponentContext` (type) from `./executor`.
- Produces:
  - types `Scope`, `RuleAuth`, `RuleContext`, `FieldOps`, `WhereInput`, `PolicyPredicate`, `TablePolicy`, `PolicyRegistry`, `PolicyContextProvider`.
  - `compileWhere(where: PolicyPredicate): FilterExpr | null` (null = "no clause" / unrestricted).
  - `mergeReadPolicy(existing: FilterExpr[] | undefined, policyExpr: FilterExpr | null): FilterExpr[]`.
  - `evalReadPolicy(policy: TablePolicy, rc: RuleContext): Promise<FilterExpr | null>`.
  - `evalWritePolicy(policy: TablePolicy, rc: RuleContext, row: Record<string, unknown>): Promise<boolean>`.

- [ ] **Step 1: Write the failing test**

Create `packages/executor/test/policy.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { compileWhere, mergeReadPolicy, evalReadPolicy } from "../src/policy";
import type { FilterExpr } from "@stackbase/query-engine";

describe("compileWhere", () => {
  it("true/undefined → null (no clause); false → always-false", () => {
    expect(compileWhere(true)).toBeNull();
    expect(compileWhere(undefined)).toBeNull();
    expect(compileWhere(false)).toEqual({ op: "or", clauses: [] });
  });

  it("bare value → eq; explicit ops map to comparison ops", () => {
    expect(compileWhere({ userId: "u1" })).toEqual({ op: "eq", field: "userId", value: "u1" });
    expect(compileWhere({ age: { gte: 18 } })).toEqual({ op: "gte", field: "age", value: 18 });
    expect(compileWhere({ n: { ne: 5 } })).toEqual({ op: "neq", field: "n", value: 5 });
  });

  it("multiple fields AND together", () => {
    expect(compileWhere({ a: 1, b: 2 })).toEqual({
      op: "and",
      clauses: [{ op: "eq", field: "a", value: 1 }, { op: "eq", field: "b", value: 2 }],
    });
  });

  it("in → OR-of-eq (empty in → always-false); notIn → AND-of-neq (empty → always-true)", () => {
    expect(compileWhere({ id: { in: ["a", "b"] } })).toEqual({
      op: "or",
      clauses: [{ op: "eq", field: "id", value: "a" }, { op: "eq", field: "id", value: "b" }],
    });
    expect(compileWhere({ id: { in: [] } })).toEqual({ op: "or", clauses: [] });
    expect(compileWhere({ id: { notIn: [] } })).toEqual({ op: "and", clauses: [] });
  });

  it("isNull → eq/neq null", () => {
    expect(compileWhere({ x: { isNull: true } })).toEqual({ op: "eq", field: "x", value: null });
    expect(compileWhere({ x: { isNull: false } })).toEqual({ op: "neq", field: "x", value: null });
  });

  it("AND/OR/NOT compose recursively", () => {
    expect(compileWhere({ NOT: { a: 1 } })).toEqual({ op: "not", clause: { op: "eq", field: "a", value: 1 } });
    expect(compileWhere({ OR: [{ a: 1 }, { b: 2 }] })).toEqual({
      op: "or",
      clauses: [{ op: "eq", field: "a", value: 1 }, { op: "eq", field: "b", value: 2 }],
    });
  });
});

describe("mergeReadPolicy", () => {
  it("null policy leaves existing filters untouched", () => {
    const existing: FilterExpr[] = [{ op: "eq", field: "done", value: false }];
    expect(mergeReadPolicy(existing, null)).toEqual(existing);
    expect(mergeReadPolicy(undefined, null)).toEqual([]);
  });
  it("appends the policy expr (AND semantics: both survive)", () => {
    const existing: FilterExpr[] = [{ op: "eq", field: "done", value: false }];
    const pol: FilterExpr = { op: "eq", field: "userId", value: "u1" };
    expect(mergeReadPolicy(existing, pol)).toEqual([...existing, pol]);
  });
});

describe("evalReadPolicy", () => {
  it("calls the policy's read(rc) and compiles the result", async () => {
    const rc = { auth: { userId: "u1" }, db: {} } as never;
    const expr = await evalReadPolicy({ read: ({ auth }: any) => ({ userId: auth.userId }) }, rc);
    expect(expr).toEqual({ op: "eq", field: "userId", value: "u1" });
    expect(await evalReadPolicy({}, rc)).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test — verify it fails**

Run: `bun run --filter @stackbase/executor test policy`
Expected: FAIL — `Cannot find module "../src/policy"`.

- [ ] **Step 3: Implement `policy.ts`**

Create `packages/executor/src/policy.ts`:

```ts
import type { FilterExpr } from "@stackbase/query-engine";
import type { Value } from "@stackbase/values";
import type { GuestDatabaseReader } from "./guest";
import type { ComponentContext } from "./executor";

export interface Scope { type: string; id: string }

/** The authorization surface a policy sees. Backed by the composed auth+authz facades. */
export interface RuleAuth {
  userId: string | null;
  identity: string | null;
  can(permission: string, scope?: Scope): Promise<boolean>;
  roles(scope?: Scope): Promise<string[]>;
  scopesWith(permission: string, type?: string): Promise<string[]>;
}

/** Context a policy receives. `db` is a read-only, txn-bound reader for relation lookups. */
export interface RuleContext { auth: RuleAuth; db: GuestDatabaseReader }

export interface FieldOps {
  eq?: Value; ne?: Value; lt?: Value; lte?: Value; gt?: Value; gte?: Value;
  in?: Value[]; notIn?: Value[]; isNull?: boolean;
}

/**
 * A field-level predicate. Logical forms use the reserved keys AND/OR/NOT; otherwise every key is a
 * field mapped to a bare value (→ eq) or a `FieldOps` object. (A field literally named AND/OR/NOT is
 * not expressible — use nested logical forms.)
 */
export type WhereInput =
  | { AND: WhereInput[] }
  | { OR: WhereInput[] }
  | { NOT: WhereInput }
  | { [field: string]: Value | FieldOps };

export type PolicyPredicate = WhereInput | boolean | undefined;

export interface TablePolicy {
  read?: (ctx: RuleContext) => PolicyPredicate | Promise<PolicyPredicate>;
  write?: (ctx: RuleContext, row: Record<string, unknown>) => boolean | Promise<boolean>;
}

export type PolicyRegistry = ReadonlyMap<string, TablePolicy>;

/** A component's contribution to the rule-context (e.g. authz contributes `{ auth }`). */
export interface PolicyContextProvider {
  readonly namespace: string;
  readonly build: (cctx: ComponentContext) => object | Promise<object>;
}

const ALWAYS_TRUE: FilterExpr = { op: "and", clauses: [] };
const ALWAYS_FALSE: FilterExpr = { op: "or", clauses: [] };

/** Compile a policy predicate to a post-filter. Returns null when the policy adds no restriction. */
export function compileWhere(where: PolicyPredicate): FilterExpr | null {
  if (where === undefined || where === true) return null;
  if (where === false) return ALWAYS_FALSE;
  return compileNode(where);
}

function compileNode(node: WhereInput): FilterExpr {
  const n = node as Record<string, unknown>;
  if (Array.isArray(n.AND)) return { op: "and", clauses: (n.AND as WhereInput[]).map(compileNode) };
  if (Array.isArray(n.OR)) return { op: "or", clauses: (n.OR as WhereInput[]).map(compileNode) };
  if (n.NOT !== undefined) return { op: "not", clause: compileNode(n.NOT as WhereInput) };
  const clauses: FilterExpr[] = [];
  for (const [field, cond] of Object.entries(n)) clauses.push(compileField(field, cond));
  if (clauses.length === 0) return ALWAYS_TRUE;
  return clauses.length === 1 ? clauses[0] : { op: "and", clauses };
}

/** A plain scalar/array/null/ArrayBuffer is a bare `eq`; a plain object is a `FieldOps` bag. */
function isFieldOps(cond: unknown): cond is FieldOps {
  return cond !== null && typeof cond === "object" && !Array.isArray(cond) && !(cond instanceof ArrayBuffer);
}

function compileField(field: string, cond: unknown): FilterExpr {
  if (!isFieldOps(cond)) return { op: "eq", field, value: cond as Value };
  const ops = cond;
  const clauses: FilterExpr[] = [];
  if ("eq" in ops) clauses.push({ op: "eq", field, value: ops.eq as Value });
  if ("ne" in ops) clauses.push({ op: "neq", field, value: ops.ne as Value });
  if ("lt" in ops) clauses.push({ op: "lt", field, value: ops.lt as Value });
  if ("lte" in ops) clauses.push({ op: "lte", field, value: ops.lte as Value });
  if ("gt" in ops) clauses.push({ op: "gt", field, value: ops.gt as Value });
  if ("gte" in ops) clauses.push({ op: "gte", field, value: ops.gte as Value });
  if (ops.in !== undefined) clauses.push({ op: "or", clauses: ops.in.map((v) => ({ op: "eq", field, value: v })) });
  if (ops.notIn !== undefined) clauses.push({ op: "and", clauses: ops.notIn.map((v) => ({ op: "neq", field, value: v })) });
  if ("isNull" in ops) clauses.push({ op: ops.isNull ? "eq" : "neq", field, value: null });
  if (clauses.length === 0) return ALWAYS_TRUE;
  return clauses.length === 1 ? clauses[0] : { op: "and", clauses };
}

/** AND-merge a compiled read policy into a query's existing post-filters. */
export function mergeReadPolicy(existing: FilterExpr[] | undefined, policyExpr: FilterExpr | null): FilterExpr[] {
  if (!policyExpr) return existing ?? [];
  return [...(existing ?? []), policyExpr];
}

export async function evalReadPolicy(policy: TablePolicy, rc: RuleContext): Promise<FilterExpr | null> {
  if (!policy.read) return null;
  return compileWhere(await policy.read(rc));
}

export async function evalWritePolicy(
  policy: TablePolicy, rc: RuleContext, row: Record<string, unknown>,
): Promise<boolean> {
  if (!policy.write) return true;
  return await policy.write(rc, row);
}
```

Append to `packages/executor/src/index.ts`:

```ts
export * from "./policy";
```

- [ ] **Step 4: Run the test — verify it passes**

Run: `bun run --filter @stackbase/executor test policy`
Expected: PASS (all `compileWhere`/`mergeReadPolicy`/`evalReadPolicy` cases green).

- [ ] **Step 5: Typecheck + commit**

Run: `bun run typecheck` → Expected: PASS.

```bash
git add packages/executor/src/policy.ts packages/executor/src/index.ts packages/executor/test/policy.test.ts
git commit -m "feat(executor): policy.ts — WhereInput→FilterExpr compilation + merge (pure)"
```

---

## Task 2: Read enforcement in the kernel (query / paginate / get)

**Files:**
- Modify: `packages/executor/src/kernel.ts`, `packages/executor/src/executor.ts`
- Test: `packages/executor/test/row-policy.test.ts`

**Interfaces:**
- Consumes (Task 1): `PolicyRegistry`, `RuleContext`, `PolicyContextProvider`, `evalReadPolicy`, `mergeReadPolicy` from `./policy`; existing `ComponentContext` from `./executor`.
- Produces:
  - `KernelContext` gains `readonly policyRegistry: PolicyRegistry` and `readonly getRuleContext: (() => Promise<RuleContext>) | null`.
  - `RunOptions` gains `policyRegistry?: PolicyRegistry` and `policyProviders?: ReadonlyArray<PolicyContextProvider>`.
  - Behaviour: non-privileged `db.query`/`db.paginate` AND-merge the table's read policy; `db.get` returns `null` for a row failing the read policy. Privileged calls and tables with no policy are unchanged.

- [ ] **Step 1: Write the failing test**

Create `packages/executor/test/row-policy.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { SqliteDocStore, NodeSqliteAdapter } from "@stackbase/docstore-sqlite";
import { MonotonicTimestampOracle } from "@stackbase/docstore";
import { SingleWriterTransactor } from "@stackbase/transactor";
import { QueryRuntime } from "@stackbase/query-engine";
import { encodeStorageIndexId } from "@stackbase/id-codec";
import { InlineUdfExecutor, SimpleIndexCatalog, mutation, query } from "../src/index";
import type { PolicyRegistry, PolicyContextProvider } from "../src/policy";

async function harness() {
  const store = new SqliteDocStore(new NodeSqliteAdapter());
  await store.setupSchema();
  const transactor = new SingleWriterTransactor(store, new MonotonicTimestampOracle());
  const queryRuntime = new QueryRuntime(store);
  const catalog = new SimpleIndexCatalog();
  catalog.addTable("todos", 5001);
  catalog.addIndex({ table: "todos", tableNumber: 5001, index: "by_creation", fields: [], indexId: encodeStorageIndexId(5001, "by_creation") });
  return new InlineUdfExecutor({ transactor, queryRuntime, catalog });
}

// Registry: todos are readable only when ownerId === the caller's userId.
const registry: PolicyRegistry = new Map([
  ["todos", { read: ({ auth }) => ({ ownerId: auth.userId }) }],
]);
// A synthetic provider that reports the caller as "u1".
const asUser = (userId: string | null): PolicyContextProvider[] => [{
  namespace: "authz",
  build: () => ({ auth: { userId, identity: null, can: async () => false, roles: async () => [], scopesWith: async () => [] } }),
}];

describe("row read policy", () => {
  it("filters query/get to visible rows; privileged bypasses", async () => {
    const ex = await harness();
    // seed two owners (privileged → full table, no policy)
    const idU1 = (await ex.run<{ _id: string }>(mutation(async (ctx) => ({ _id: await ctx.db.insert("todos", { ownerId: "u1", text: "a" }) })), {}, { privileged: true })).value._id;
    const idU2 = (await ex.run<{ _id: string }>(mutation(async (ctx) => ({ _id: await ctx.db.insert("todos", { ownerId: "u2", text: "b" }) })), {}, { privileged: true })).value._id;

    const opts = { policyRegistry: registry, policyProviders: asUser("u1") };

    const visible = await ex.run<any[]>(query(async (ctx) => ctx.db.query("todos", "by_creation").collect()), {}, opts);
    expect(visible.value.map((d) => d.ownerId)).toEqual(["u1"]);            // only u1's row

    const mine = await ex.run<any>(query(async (ctx) => ctx.db.get(idU1)), {}, opts);
    expect(mine.value?.text).toBe("a");
    const theirs = await ex.run<any>(query(async (ctx) => ctx.db.get(idU2)), {}, opts);
    expect(theirs.value).toBeNull();                                        // hidden → null, no existence leak

    const all = await ex.run<any[]>(query(async (ctx) => ctx.db.query("todos", "by_creation").collect()), {}, { privileged: true });
    expect(all.value.length).toBe(2);                                       // privileged sees everything
  });

  it("anonymous (userId null) sees zero rows (deny-by-default via predicate)", async () => {
    const ex = await harness();
    await ex.run(mutation(async (ctx) => ctx.db.insert("todos", { ownerId: "u1", text: "a" })), {}, { privileged: true });
    const none = await ex.run<any[]>(query(async (ctx) => ctx.db.query("todos", "by_creation").collect()), {}, { policyRegistry: registry, policyProviders: asUser(null) });
    expect(none.value).toEqual([]);                                         // ownerId === null matches nothing
  });
});
```

- [ ] **Step 2: Run the test — verify it fails**

Run: `bun run --filter @stackbase/executor test row-policy`
Expected: FAIL — `policyRegistry`/`policyProviders` are not accepted / no filtering happens (both users' rows returned).

- [ ] **Step 3: Extend `KernelContext` + read handlers (`kernel.ts`)**

In `packages/executor/src/kernel.ts`, add imports at the top:

```ts
import type { PolicyRegistry, RuleContext } from "./policy";
import { evalReadPolicy, mergeReadPolicy } from "./policy";
import { evaluateFilter } from "@stackbase/query-engine";
```

Add two fields to `KernelContext` (after `identity`):

```ts
  /** Table → policy; empty for facade / rule-context readers so enforcement never re-enters. */
  readonly policyRegistry: PolicyRegistry;
  /** Lazily builds (and memoizes) the rule-context; null when no policy provider is composed. */
  readonly getRuleContext: (() => Promise<RuleContext>) | null;
```

Replace `handleDbGet` with the policy-aware version:

```ts
const handleDbGet: SyscallHandler = async (ctx, argJson) => {
  const { id } = JSON.parse(argJson) as { id: string };
  const internalId = decodeDocumentId(id);
  const meta = ctx.catalog.getTableByNumber(internalId.tableNumber);
  if (!meta) throw new FunctionNotFoundError(`unknown table for id ${id}`);
  requireOwnTable(ctx, meta.name);
  const value = await ctx.txn.get(internalId);
  if (value !== null && !ctx.privileged && ctx.getRuleContext) {
    const policy = ctx.policyRegistry.get(meta.name);
    if (policy?.read) {
      const expr = await evalReadPolicy(policy, await ctx.getRuleContext());
      if (expr && !evaluateFilter(value as DocumentValue, expr)) return JSON.stringify(null);
    }
  }
  return JSON.stringify(value === null ? null : convexToJson(value as Value));
};
```

In `handleDbQuery`, immediately AFTER the `const query: Query = { … };` block and BEFORE `const { documents, readSet } = …`, insert:

```ts
  if (!ctx.privileged && ctx.getRuleContext) {
    const policy = ctx.policyRegistry.get(tableName);
    if (policy?.read) query.filters = mergeReadPolicy(query.filters, await evalReadPolicy(policy, await ctx.getRuleContext()));
  }
```

In `handleDbPaginate`, apply the identical block after its `const query: Query = { … };` (using its `tableName`).

- [ ] **Step 4: Build the rule-context + thread it (`executor.ts`)**

In `packages/executor/src/executor.ts`, add to the imports:

```ts
import type { PolicyRegistry, PolicyContextProvider, RuleContext } from "./policy";
```

Add to `RunOptions` (after `contextProviders`):

```ts
  /** Table → policy, consulted by the kernel on non-privileged db ops. */
  policyRegistry?: PolicyRegistry;
  /** Components contributing rule-context fields (e.g. authz → `{ auth }`). */
  policyProviders?: ReadonlyArray<PolicyContextProvider>;
```

Replace the body of the `runInTransaction` callback (from `const kctx: KernelContext = {` through `return { value: … };`) with:

```ts
        // Base context: NO policy enforcement. Used for the facade readers and the rule-context's own
        // db reader, so a policy's internal reads are never themselves re-gated (no re-entrancy).
        const baseKctx: KernelContext = {
          profile,
          txn,
          queryRuntime: this.deps.queryRuntime,
          catalog: this.deps.catalog,
          snapshotTs: txn.snapshotTs,
          random: createSeededRandom(seed),
          logs: [],
          namespace: options.namespace ?? "",
          privileged: options.privileged ?? false,
          identity: options.identity ?? null,
          now: startedAt,
          policyRegistry: new Map(),
          getRuleContext: null,
        };

        const reserved = new Set(["db", "random", "now"]);
        const guestCtx: Record<string, unknown> = { random: () => baseKctx.random.next(), now: () => baseKctx.now };
        const builtFacades: Record<string, unknown> = {};
        for (const p of options.contextProviders ?? []) {
          if (reserved.has(p.name) || p.name in guestCtx) throw new Error(`context provider "${p.name}" collides with a reserved ctx key`);
          const pctx: KernelContext = { ...baseKctx, namespace: p.namespace, privileged: false, profile: profileFor("query") };
          const preader = new GuestDatabaseReader(new InlineSyscallChannel(this.router, pctx));
          const facade = Object.freeze(p.build({ db: preader, identity: baseKctx.identity, now: baseKctx.now, components: builtFacades }));
          guestCtx[p.name] = facade;
          builtFacades[p.name] = facade;
        }

        // Memoized rule-context: built lazily on the first policy hit, once per call.
        const policyProviders = options.policyProviders ?? [];
        let rcCache: Promise<RuleContext> | undefined;
        const getRuleContext: (() => Promise<RuleContext>) | null = policyProviders.length === 0 ? null : () =>
          (rcCache ??= (async () => {
            const merged: Record<string, unknown> = {};
            for (const p of policyProviders) {
              const pctx: KernelContext = { ...baseKctx, namespace: p.namespace, privileged: false, profile: profileFor("query") };
              const preader = new GuestDatabaseReader(new InlineSyscallChannel(this.router, pctx));
              Object.assign(merged, await p.build({ db: preader, identity: baseKctx.identity, now: baseKctx.now, components: builtFacades }));
            }
            const db = new GuestDatabaseReader(new InlineSyscallChannel(this.router, { ...baseKctx, profile: profileFor("query") }));
            return { ...merged, db } as RuleContext;
          })());

        // Main context: carries the registry + rule-context builder → policy enforcement is ON.
        const kctx: KernelContext = { ...baseKctx, policyRegistry: options.policyRegistry ?? new Map(), getRuleContext };
        const channel = new InlineSyscallChannel(this.router, kctx);
        const db = fn.type === "query" ? new GuestDatabaseReader(channel) : new GuestDatabaseWriter(channel);
        guestCtx.db = db;

        const value = await fn.handler(guestCtx, args);
        return { value: value as T, logs: kctx.logs, readRanges: txn.reads.toArray() };
```

> Note: `guestCtx.logs`/`kctx.logs` share the same array reference via the `{ ...baseKctx }` spread, so `console.log` still records into the returned `logs`.

- [ ] **Step 5: Run the test — verify it passes**

Run: `bun run --filter @stackbase/executor test row-policy`
Expected: PASS — u1 sees only their row, `get` of u2's row is `null`, privileged sees both, anonymous sees none.

- [ ] **Step 6: Whole workspace green + commit**

Run: `bun run build && bun run typecheck && bun run test`
Expected: PASS (existing executor/auth/authz tests unchanged — the no-policy path is inert).

```bash
git add packages/executor/src/kernel.ts packages/executor/src/executor.ts packages/executor/test/row-policy.test.ts
git commit -m "feat(executor): kernel read-policy enforcement (query/paginate/get) + rule-context threading"
```

---

## Task 3: Write enforcement (insert / replace / delete)

**Files:**
- Modify: `packages/executor/src/kernel.ts`
- Test: `packages/executor/test/row-policy.test.ts` (add a `describe`)

**Interfaces:**
- Consumes: `evalWritePolicy` from `./policy`; `KernelContext.policyRegistry`/`getRuleContext` (Task 2).
- Produces: non-privileged `db.insert` gates on the candidate row; `db.replace`/`db.delete` gate on the pre-write row; deny throws `ForbiddenOperationError("write policy on <table>")`.

- [ ] **Step 1: Write the failing test**

Append to `packages/executor/test/row-policy.test.ts`:

```ts
import { evalWritePolicy } from "../src/policy"; // ensure import present (or rely on registry below)

describe("row write policy", () => {
  const writeRegistry = new Map([
    ["todos", { write: ({ auth }, row) => row.ownerId === auth.userId }],
  ]);

  it("blocks writing a row you don't own; allows your own; privileged bypasses", async () => {
    const ex = await harness();
    const opts = { policyRegistry: writeRegistry, policyProviders: asUser("u1") };

    // insert as u1: own row ok, other's row Forbidden
    await expect(ex.run(mutation(async (ctx) => ctx.db.insert("todos", { ownerId: "u1", text: "ok" })), {}, opts)).resolves.toBeDefined();
    await expect(ex.run(mutation(async (ctx) => ctx.db.insert("todos", { ownerId: "u2", text: "no" })), {}, opts)).rejects.toThrow(/write policy on todos/);

    // seed a u2 row privileged, then u1's replace/delete of it is Forbidden (pre-write row is u2's)
    const u2 = (await ex.run<{ _id: string }>(mutation(async (ctx) => ({ _id: await ctx.db.insert("todos", { ownerId: "u2", text: "x" })) })), {}, { privileged: true })).value._id;
    await expect(ex.run(mutation(async (ctx) => ctx.db.replace(u2, { ownerId: "u2", text: "y" })), {}, opts)).rejects.toThrow(/write policy on todos/);
    await expect(ex.run(mutation(async (ctx) => ctx.db.delete(u2)), {}, opts)).rejects.toThrow(/write policy on todos/);

    // privileged can delete it
    await expect(ex.run(mutation(async (ctx) => ctx.db.delete(u2)), {}, { privileged: true })).resolves.toBeDefined();
  });
});
```

> If the inline `_id` object literal above trips the linter, the implementer may simplify to `async (ctx) => ({ _id: await ctx.db.insert("todos", { ownerId: "u2", text: "x" }) })`.

- [ ] **Step 2: Run the test — verify it fails**

Run: `bun run --filter @stackbase/executor test row-policy`
Expected: FAIL — writes are not gated (all inserts/replaces/deletes succeed).

- [ ] **Step 3: Add write gating to `kernel.ts`**

Add the import (extend Task 2's policy import line):

```ts
import { evalReadPolicy, evalWritePolicy, mergeReadPolicy } from "./policy";
```

Add a helper above the handlers:

```ts
async function enforceWrite(ctx: KernelContext, table: string, row: DocumentValue): Promise<void> {
  if (ctx.privileged || !ctx.getRuleContext) return;
  const policy = ctx.policyRegistry.get(table);
  if (!policy?.write) return;
  const ok = await evalWritePolicy(policy, await ctx.getRuleContext(), row as Record<string, unknown>);
  if (!ok) throw new ForbiddenOperationError(`write policy on ${table}`);
}
```

In `handleDbInsert`, after `const doc: DocumentValue = { … };` and BEFORE `ctx.txn.put(id, doc);`:

```ts
  await enforceWrite(ctx, fullName, doc);
```

In `handleDbReplace`, after the `if (oldDoc === null) …` guard and BEFORE building `newDoc`:

```ts
  await enforceWrite(ctx, meta.name, oldDoc);
```

In `handleDbDelete`, after `const oldDoc = await ctx.txn.get(internalId);` and BEFORE `ctx.txn.delete(internalId);`:

```ts
  if (oldDoc !== null) await enforceWrite(ctx, meta.name, oldDoc);
```

- [ ] **Step 4: Run the test — verify it passes**

Run: `bun run --filter @stackbase/executor test row-policy`
Expected: PASS — own writes ok, others' writes throw `write policy on todos`, privileged bypasses.

- [ ] **Step 5: Whole workspace green + commit**

Run: `bun run build && bun run typecheck && bun run test` → PASS.

```bash
git add packages/executor/src/kernel.ts packages/executor/test/row-policy.test.ts
git commit -m "feat(executor): kernel write-policy enforcement (insert/replace/delete)"
```

---

## Task 4: Component-system `policies` seam + runtime wiring

**Files:**
- Modify: `packages/component/src/define-component.ts`, `packages/component/src/compose.ts`, `packages/runtime-embedded/src/runtime.ts`
- Test: `packages/component/test/policy-compose.test.ts`

**Interfaces:**
- Consumes: `TablePolicy`, `PolicyRegistry`, `PolicyContextProvider`, `ComponentContext` from `@stackbase/executor`; `getFullTableName` from `@stackbase/id-codec`.
- Produces:
  - `ComponentDefinition` gains `policies?: Record<string, TablePolicy>` and `policyContext?: (cctx: ComponentContext) => object | Promise<object>`.
  - `ComposedProject` gains `policyRegistry: PolicyRegistry` and `policyProviders: PolicyContextProvider[]`.
  - `EmbeddedRuntimeOptions` gains `policyRegistry?`/`policyProviders?`; the runtime passes them to every non-privileged `executor.run` (`runQuery`/`runMutation`/`run`), never to `runSystem`.

- [ ] **Step 1: Write the failing test**

Create `packages/component/test/policy-compose.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { defineComponent, composeComponents } from "../src/index";
import { defineSchema, defineTable, v } from "@stackbase/values";
import { mutation } from "@stackbase/executor";

const appSchema = defineSchema({ todos: defineTable({ ownerId: v.string(), text: v.string() }) });

const guard = defineComponent({
  name: "guard",
  schema: defineSchema({}),
  modules: {},
  policies: { todos: { read: ({ auth }) => ({ ownerId: auth.userId }) } },
  policyContext: () => ({ auth: { userId: "u1", identity: null, can: async () => false, roles: async () => [], scopesWith: async () => [] } }),
});

describe("policy composition", () => {
  it("aggregates policies into a registry keyed by resolved table name + a provider", () => {
    const composed = composeComponents({ schemaJson: appSchema.export(), moduleMap: {} }, [guard]);
    expect(composed.policyRegistry.has("todos")).toBe(true);
    expect(composed.policyProviders).toHaveLength(1);
    expect(composed.policyProviders[0].namespace).toBe("guard");
  });

  it("rejects a policy on an unknown table (typo guard)", () => {
    const bad = defineComponent({ name: "bad", schema: defineSchema({}), modules: {}, policies: { nope: { read: () => true } } });
    expect(() => composeComponents({ schemaJson: appSchema.export(), moduleMap: {} }, [bad])).toThrow(/unknown table "nope"/);
  });

  it("rejects two components claiming the same table", () => {
    const g2 = defineComponent({ name: "g2", schema: defineSchema({}), modules: {}, policies: { todos: { read: () => true } } });
    expect(() => composeComponents({ schemaJson: appSchema.export(), moduleMap: {} }, [guard, g2])).toThrow(/duplicate policy for table "todos"/);
  });
});
```

- [ ] **Step 2: Run the test — verify it fails**

Run: `bun run --filter @stackbase/component test policy-compose`
Expected: FAIL — `policyRegistry`/`policyProviders` not on `ComposedProject`; `policies`/`policyContext` not accepted.

- [ ] **Step 3: Extend `ComponentDefinition` (`define-component.ts`)**

Add imports:

```ts
import type { TablePolicy, PolicyContextProvider } from "@stackbase/executor";
```

Add fields to `ComponentDefinition` (after `contextType`):

```ts
  /** Row policies this component declares for app tables: table → { read?, write? }. */
  policies?: Record<string, TablePolicy>;
  /** Contributes fields to every row policy's rule-context (e.g. authz → `{ auth }`). */
  policyContext?: PolicyContextProvider["build"];
```

- [ ] **Step 4: Aggregate in `compose.ts`**

Add imports:

```ts
import type { RegisteredFunction, ContextProvider, TablePolicy, PolicyContextProvider } from "@stackbase/executor";
```

Add to `ComposedProject`:

```ts
  policyRegistry: ReadonlyMap<string, TablePolicy>;
  policyProviders: PolicyContextProvider[];
```

In `composeComponents`, after `const { tableNumbers, catalog } = composeTables(...)`, add:

```ts
  const policyRegistry = new Map<string, TablePolicy>();
  const policyProviders: PolicyContextProvider[] = [];
  for (const c of components) {
    for (const [table, policy] of Object.entries(c.policies ?? {})) {
      const key = getFullTableName(table, ""); // policies gate app (root) tables in v1
      if (tableNumbers[key] === undefined) throw new Error(`component "${c.name}" declares a policy for unknown table "${table}"`);
      if (policyRegistry.has(key)) throw new Error(`duplicate policy for table "${table}"`);
      policyRegistry.set(key, policy);
    }
    if (c.policyContext) policyProviders.push({ namespace: c.name, build: c.policyContext });
  }
```

Add `policyRegistry` and `policyProviders` to the returned object.

- [ ] **Step 5: Thread through the runtime (`runtime.ts`)**

Add imports:

```ts
import type { PolicyContextProvider } from "@stackbase/executor";
import type { TablePolicy } from "@stackbase/executor";
```

Add to `EmbeddedRuntimeOptions`:

```ts
  policyRegistry?: ReadonlyMap<string, TablePolicy>;
  policyProviders?: ReadonlyArray<PolicyContextProvider>;
```

In `create`, after `const contextProviders = options.contextProviders ?? [];`, add:

```ts
    const policyRegistry = options.policyRegistry ?? new Map();
    const policyProviders = options.policyProviders ?? [];
```

Extend every non-privileged `executor.run(...)` options object in `runQuery`, `runMutation`, and the public `run` with `policyRegistry, policyProviders` (do **not** touch `runSystem`). Add the two to the constructor params + `new EmbeddedRuntime(...)` call, and store them as private fields the `run` method reads (mirror how `contextProviders` is stored/used). Example for `runQuery`:

```ts
      async runQuery(path, args, identity) {
        const r = await executor.run(resolve(path), jsonToConvex(args), { path, namespace: namespaceForPath(path, componentNames), contextProviders, policyRegistry, policyProviders, identity: identity ?? null });
```

- [ ] **Step 6: Run the test — verify it passes**

Run: `bun run --filter @stackbase/component test policy-compose`
Expected: PASS — registry keyed `todos`, one provider, typo + duplicate guards throw.

- [ ] **Step 7: Whole workspace green + commit**

Run: `bun run build && bun run typecheck && bun run test` → PASS.

```bash
git add packages/component/src/define-component.ts packages/component/src/compose.ts packages/runtime-embedded/src/runtime.ts packages/component/test/policy-compose.test.ts
git commit -m "feat(component): policies/policyContext seam + runtime wiring for row policies"
```

---

## Task 5: authz Layer 1 — `defineAuthz({ policies })` + `scopesWith` + reactive contract

**Files:**
- Create: `components/authz/src/policies.ts`
- Modify: `components/authz/src/context.ts`, `components/authz/src/define-authz.ts`, `components/authz/src/roles.ts` (add `policies` to `AuthzConfig`), `components/authz/src/index.ts`
- Test: `components/authz/test/row-policy.test.ts`

**Interfaces:**
- Consumes: `ComponentContext`, `RuleAuth`, `TablePolicy` from `@stackbase/executor`; `roleGrants`, `AuthzConfig` from `./roles`; the `auth`/`authz` facades from `cctx.components`.
- Produces:
  - `AuthzContext` gains `scopesWith(permission: string, type?: string): Promise<string[]>`.
  - `AuthzConfig` gains `policies?: Record<string, TablePolicy>`.
  - `buildRuleAuth(cctx: ComponentContext): Promise<RuleAuth>`.
  - `defineAuthz` contributes `policies` + `policyContext: (cctx) => ({ auth: await buildRuleAuth(cctx) })`.

- [ ] **Step 1: Write the failing test**

Create `components/authz/test/row-policy.test.ts`:

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

// documents are readable/writable only by a caller holding documents:read / documents:update.
const authz = defineAuthz({
  roles: { editor: { documents: ["read", "update"] }, admin: { authz: ["manage"] } },
  policies: {
    documents: {
      read: ({ auth }) => auth.can("documents:read"),         // true when the role grants it, else deny
      write: ({ auth }) => auth.can("documents:update"),
    },
  },
});

const appSchema = defineSchema({ documents: defineTable({ title: v.string() }) });

async function makeRuntime() {
  const { catalog, moduleMap, componentNames, contextProviders, policyRegistry, policyProviders } =
    composeComponents({ schemaJson: appSchema.export(), moduleMap: {
      "docs:list": query(async (ctx) => ctx.db.query("documents", "by_creation").collect()),
    } }, [auth, authz]);
  return EmbeddedRuntime.create({
    store: new SqliteDocStore(new NodeSqliteAdapter()),
    catalog, modules: moduleMap, systemModules: systemModules(), componentNames, contextProviders, policyRegistry, policyProviders,
  });
}

async function makeAdmin(r: EmbeddedRuntime, email: string) {
  const who = (await r.run<{ token: string; userId: string }>("auth:signUp", { email, password: "pw" })).value;
  await r.runSystem("_system:insertDocument", { table: "authz/role_assignments", fields: { userId: who.userId, role: "admin", scopeType: "", scopeId: "" } });
  return who;
}

describe("authz row policies", () => {
  it("read policy filters by permission; write policy gates inserts", async () => {
    const r = await makeRuntime();
    const admin = await makeAdmin(r, "admin@b.co");
    await r.runSystem("_system:insertDocument", { table: "documents", fields: { title: "seeded" } });
    const { token, userId } = (await r.run<{ token: string; userId: string }>("auth:signUp", { email: "e@b.co", password: "pw" })).value;

    // No role → read policy denies → zero rows; write denied.
    expect((await r.run<any[]>("docs:list", {}, { identity: token })).value).toEqual([]);

    await r.run("authz:assignRole", { userId, role: "editor" }, { identity: admin.token });

    // Now editor → documents:read → sees the seeded doc.
    expect((await r.run<any[]>("docs:list", {}, { identity: token })).value.length).toBe(1);
  });

  it("REACTIVE: a subscribed docs:list re-runs and empties when the role is revoked", async () => {
    const r = await makeRuntime();
    const admin = await makeAdmin(r, "admin2@b.co");
    await r.runSystem("_system:insertDocument", { table: "documents", fields: { title: "d1" } });
    const { token, userId } = (await r.run<{ token: string; userId: string }>("auth:signUp", { email: "bob@b.co", password: "pw" })).value;
    await r.run("authz:assignRole", { userId, role: "editor" }, { identity: admin.token });

    const sent: any[] = [];
    const sock = { sent, send: (d: string) => sent.push(JSON.parse(d)), bufferedAmount: 0, close: () => {} };
    const last = (): unknown => {
      for (let i = sent.length - 1; i >= 0; i--)
        for (const m of [...(sent[i]?.modifications ?? [])].reverse())
          if (m.type === "QueryUpdated" && m.queryId === 1) return m.value;
      return undefined;
    };
    r.handler.connect("s1", sock);
    await r.handler.handleMessage("s1", JSON.stringify({ type: "SetAuth", token }));
    await r.handler.handleMessage("s1", JSON.stringify({ type: "ModifyQuerySet", add: [{ queryId: 1, udfPath: "docs:list", args: {} }], remove: [] }));
    expect((last() as any[]).length).toBe(1);                 // editor sees the doc

    await r.run("authz:revokeRole", { userId, role: "editor" }, { identity: admin.token });
    await new Promise((res) => setTimeout(res, 50));
    expect(last()).toEqual([]);                               // revoke → read policy denies → live empties
  });
});
```

- [ ] **Step 2: Run the test — verify it fails**

Run: `bun run --filter @stackbase/authz test row-policy`
Expected: FAIL — `defineAuthz` does not accept `policies` / no filtering (or `scopesWith`/rule-context missing).

- [ ] **Step 3: Add `scopesWith` to the facade (`context.ts`)**

Add to the `AuthzContext` interface:

```ts
  scopesWith(permission: string, type?: string): Promise<string[]>;
```

Add to the returned facade object in `authzContext` (alongside `can`/`require`/`roles`):

```ts
    async scopesWith(permission, type) {
      const uid = auth ? await auth.getUserId() : null;
      if (!uid) return [];
      const rows = await cctx.db.query("role_assignments", "byUser").eq("userId", uid).collect();
      const out = new Set<string>();
      for (const row of rows) {
        if (type !== undefined && row.scopeType !== type) continue;
        if (roleGrants(config, row.role as string, permission)) out.add(row.scopeId as string);
      }
      return [...out];
    },
```

- [ ] **Step 4: Add `buildRuleAuth` (`policies.ts`)**

Create `components/authz/src/policies.ts`:

```ts
import type { ComponentContext, RuleAuth } from "@stackbase/executor";

/** Re-exported so app authors can type their policies. */
export type { WhereInput, FieldOps, TablePolicy, PolicyPredicate } from "@stackbase/executor";

interface AuthFacade { getUserId(): Promise<string | null> }
interface AuthzFacade {
  can(p: string, s?: { type: string; id: string }): Promise<boolean>;
  roles(s?: { type: string; id: string }): Promise<string[]>;
  scopesWith(p: string, t?: string): Promise<string[]>;
}

/** Build the `auth` field of a row policy's rule-context from the composed auth+authz facades. */
export async function buildRuleAuth(cctx: ComponentContext): Promise<RuleAuth> {
  const authFacade = cctx.components.auth as AuthFacade | undefined;
  const authzFacade = cctx.components.authz as AuthzFacade;
  const userId = authFacade ? await authFacade.getUserId() : null;
  return {
    userId,
    identity: cctx.identity,
    can: (p, s) => authzFacade.can(p, s),
    roles: (s) => authzFacade.roles(s),
    scopesWith: (p, t) => authzFacade.scopesWith(p, t),
  };
}
```

- [ ] **Step 5: Accept + contribute `policies` (`roles.ts` + `define-authz.ts`)**

In `components/authz/src/roles.ts`, extend `AuthzConfig`:

```ts
import type { TablePolicy } from "@stackbase/executor";

export interface AuthzConfig {
  permissions?: Record<string, string[]>;
  roles?: Record<string, RoleDef>;
  policies?: Record<string, TablePolicy>;
}
```

In `components/authz/src/define-authz.ts`, add the import and two `defineComponent` fields:

```ts
import { buildRuleAuth } from "./policies";
```
```ts
    policies: config.policies,
    policyContext: async (cctx) => ({ auth: await buildRuleAuth(cctx) }),
```

Append to `components/authz/src/index.ts`:

```ts
export * from "./policies";
```

- [ ] **Step 6: Run the test — verify it passes**

Run: `bun run --filter @stackbase/authz test row-policy`
Expected: PASS — no-role caller sees zero docs, editor sees the doc, and the subscribed `docs:list` empties on `revokeRole` (the headline reactive contract).

- [ ] **Step 7: Whole workspace green + commit**

Run: `bun run build && bun run typecheck && bun run test`
Expected: PASS (all prior authz/auth/executor/component tests still green).

```bash
git add components/authz/src/policies.ts components/authz/src/context.ts components/authz/src/roles.ts components/authz/src/define-authz.ts components/authz/src/index.ts components/authz/test/row-policy.test.ts
git commit -m "feat(authz): Layer 1 row policies — defineAuthz({policies}) + scopesWith + reactive contract"
```

---

## Self-Review (completed by plan author)

**Spec coverage:**
- §3.1 `defineAuthz({policies})` → Task 5. §3.2 `RuleContext`/`RuleAuth` → Task 1 (types) + Task 5 (`buildRuleAuth`). §3.3 `scopesWith` → Task 5. §3.4/§4 `WhereInput`→`FilterExpr` → Task 1. §5 component seam → Task 4. §6 kernel enforcement → Tasks 2–3. §6.1 threading → Task 2. §7 reactivity → exercised in Task 5's reactive test. §8 default-ON/deny-by-default → Tasks 2–3 tests. §9 testing → each task's tests. §10 file structure → matches. §11 out-of-scope → not built. ✅ No gaps.

**Placeholder scan:** No TBD/TODO; every code step shows complete code; commands have expected output. ✅

**Type consistency:** `PolicyRegistry`/`RuleContext`/`RuleAuth`/`TablePolicy`/`PolicyContextProvider`/`WhereInput`/`FieldOps` defined once in Task 1 and consumed unchanged in Tasks 2–5. `getRuleContext: (() => Promise<RuleContext>) | null` identical in `KernelContext` (Task 2) and its uses (Tasks 2–3). `policyContext` build signature `(cctx) => object | Promise<object>` consistent across `define-component.ts` (Task 4) and `defineAuthz` (Task 5). Registry key = `getFullTableName(table, "")` in compose (Task 4), matched by the handlers' resolved `tableName`/`meta.name` (Tasks 2–3). ✅
```
