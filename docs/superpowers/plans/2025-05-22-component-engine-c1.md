# Component Engine C1 — Namespace-Scoped ctx.db + Boundary Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `ctx.db` namespace-scoped so a component's function resolves its own bare table names (`sessions` → `auth/sessions`) and **cannot** touch another component's or the app's tables — the isolation boundary, enforced for both name-based and id-based operations.

**Architecture:** Add a `namespace` to the executor's `KernelContext` (and `RunOptions`). Name-based ops (`insert`/`query`/`paginate`) resolve `getFullTableName(name, namespace)` before the catalog lookup. Id-based ops (`get`/`replace`/`delete`) verify the document's table belongs to the running namespace via `parseFullTableName`. A `namespaceForPath` helper (in `@stackbase/component`) maps a function path to its namespace — the bridge C2's loader will use. This plan does NOT build `ctx`-contribution facades (`ctx.auth.*`), config, or the loader — those are the next plans.

**Tech Stack:** TypeScript, pnpm/turbo, vitest. Touches `@stackbase/executor` (kernel + executor) and `@stackbase/component` (the path helper). Reuses `getFullTableName`/`parseFullTableName` from `@stackbase/id-codec`.

## Global Constraints

- **The boundary is the same set the engine already tracks:** a component's allowed tables are those whose full name is in its namespace; the app (namespace `""`) owns bare-named tables.
- `getFullTableName(name, "")` returns the bare name; `getFullTableName(name, "auth")` returns `auth/name`. `parseFullTableName("auth/sessions")` → `{ componentPath: "auth", name: "sessions" }`; `parseFullTableName("messages")` → `{ componentPath: "", name: "messages" }`. (Verified in `id-codec/src/table-registry.ts`.)
- Component code uses **bare** table names (`ctx.db.query("sessions")`); the kernel namespaces them. The app is unaffected (namespace `""` → bare names resolve unchanged).
- Strict TS (`strict`, `noUncheckedIndexedAccess`, `verbatimModuleSyntax`); ESM only.
- Existing executor tests (queries/mutations with no namespace) must keep passing — `namespace` defaults to `""`.

---

### Task 1: Namespace plumbing + scoped name-based resolution

**Files:**
- Modify: `packages/executor/src/kernel.ts` (`KernelContext.namespace`; scope `requireTable` + `db.query`/`db.paginate`)
- Modify: `packages/executor/src/executor.ts` (`RunOptions.namespace` → `kctx.namespace`)
- Test: `packages/executor/test/component-scope.test.ts`

**Interfaces:**
- Consumes: `getFullTableName` (`@stackbase/id-codec`), `SimpleIndexCatalog` (`./catalog`).
- Produces: `KernelContext` gains `readonly namespace: string`; `RunOptions` gains `namespace?: string` (default `""`); `requireTable(ctx, name)` returns `{ tableNumber: number; fullName: string }` resolved under `ctx.namespace`; `db.query`/`db.paginate` resolve their table under `ctx.namespace`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/executor/test/component-scope.test.ts
import { describe, it, expect } from "vitest";
import { SqliteDocStore, NodeSqliteAdapter } from "@stackbase/docstore-sqlite";
import { MonotonicTimestampOracle } from "@stackbase/docstore";
import { SingleWriterTransactor } from "@stackbase/transactor";
import { QueryRuntime } from "@stackbase/query-engine";
import { encodeStorageIndexId } from "@stackbase/id-codec";
import { InlineUdfExecutor, SimpleIndexCatalog, mutation, query } from "../src/index";

async function harness() {
  const store = new SqliteDocStore(new NodeSqliteAdapter());
  await store.setupSchema();
  const transactor = new SingleWriterTransactor(store, new MonotonicTimestampOracle());
  const queryRuntime = new QueryRuntime(store);
  const catalog = new SimpleIndexCatalog();
  // app table "messages" (10001) + component table "auth/sessions" (10002), each with by_creation
  for (const [name, n] of [["messages", 10001], ["auth/sessions", 10002]] as const) {
    catalog.addTable(name, n);
    catalog.addIndex({ table: name, tableNumber: n, index: "by_creation", fields: [], indexId: encodeStorageIndexId(n, "by_creation") });
  }
  return new InlineUdfExecutor({ transactor, queryRuntime, catalog });
}

describe("namespace-scoped ctx.db — name-based ops", () => {
  it("resolves a component's bare table name to its namespaced table", async () => {
    const executor = await harness();
    const insert = mutation(async (ctx) => ctx.db.insert("sessions", { token: "t" })); // bare name
    const id = (await executor.run<string>(insert, {}, { namespace: "auth" })).value;
    expect(typeof id).toBe("string");

    const list = query(async (ctx) => ctx.db.query("sessions", "by_creation").collect());
    const docs = (await executor.run<Array<{ token: string }>>(list, {}, { namespace: "auth" })).value;
    expect(docs.map((d) => d.token)).toEqual(["t"]);
  });

  it("denies a component reading a table outside its namespace (the boundary)", async () => {
    const executor = await harness();
    const readApp = query(async (ctx) => ctx.db.query("messages", "by_creation").collect());
    await expect(executor.run(readApp, {}, { namespace: "auth" })).rejects.toThrow(/unknown table|unknown index/);
  });

  it("the app (namespace '') resolves bare names unchanged", async () => {
    const executor = await harness();
    const insert = mutation(async (ctx) => ctx.db.insert("messages", { body: "hi" }));
    const id = (await executor.run<string>(insert, {}, {})).value; // no namespace → ""
    expect(typeof id).toBe("string");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @stackbase/executor test component-scope`
Expected: FAIL — `namespace` not accepted / bare `sessions` resolves to nothing or the wrong table.

- [ ] **Step 3: Write minimal implementation**

In `packages/executor/src/kernel.ts`:

```ts
// 1. import getFullTableName
import { decodeDocumentId, encodeInternalDocumentId, encodeStorageTableId, newDocumentId, getFullTableName } from "@stackbase/id-codec";

// 2. add namespace to KernelContext
export interface KernelContext {
  readonly profile: UdfEnvironmentProfile;
  readonly txn: TransactionContext;
  readonly queryRuntime: QueryRuntime;
  readonly catalog: IndexCatalog;
  readonly snapshotTs: bigint;
  readonly random: SeededRandom;
  readonly logs: string[];
  readonly namespace: string;
}

// 3. scope requireTable, returning the resolved full name (for index maintenance)
function requireTable(ctx: KernelContext, name: string): { tableNumber: number; fullName: string } {
  const fullName = getFullTableName(name, ctx.namespace);
  const meta = ctx.catalog.getTable(fullName);
  if (!meta) throw new FunctionNotFoundError(`unknown table: ${name}`);
  return { tableNumber: meta.tableNumber, fullName };
}
```

In `handleDbInsert`, use the resolved full name for index maintenance:
```ts
  const { tableNumber, fullName } = requireTable(ctx, table);
  const id = newDocumentId(tableNumber);
  const docId = encodeInternalDocumentId(id);
  const doc: DocumentValue = { ...(jsonToConvex(value) as DocumentValue), _id: docId, _creationTime: Number(ctx.snapshotTs) };
  ctx.txn.put(id, doc);
  maintainIndexes(ctx, fullName, null, doc, id);
  return JSON.stringify({ id: docId });
```

In `handleDbQuery` and `handleDbPaginate`, scope the index lookup's table name:
```ts
  const indexSpec = ctx.catalog.getIndex(getFullTableName(spec.table, ctx.namespace), spec.index);
```
(apply this same one-line change in BOTH handlers.)

In `packages/executor/src/executor.ts`:
```ts
// RunOptions gains namespace
export interface RunOptions {
  seed?: number;
  path?: string;
  namespace?: string;
}
// inside run(), when building kctx, add:
const kctx: KernelContext = {
  profile,
  txn,
  queryRuntime: this.deps.queryRuntime,
  catalog: this.deps.catalog,
  snapshotTs: txn.snapshotTs,
  random: createSeededRandom(seed),
  logs: [],
  namespace: options.namespace ?? "",
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @stackbase/executor test component-scope` → first + third tests PASS, second (boundary) PASS.
Run: `pnpm --filter @stackbase/executor test` → existing executor tests still pass (they pass no namespace → `""`).
Run: `pnpm --filter @stackbase/executor exec tsc --noEmit` → clean.

- [ ] **Step 5: Commit**

```bash
git add packages/executor/src/kernel.ts packages/executor/src/executor.ts packages/executor/test/component-scope.test.ts
git commit -m "feat(executor): namespace-scoped ctx.db name resolution (component boundary)"
```

---

### Task 2: Scope id-based ops (get / replace / delete)

**Files:**
- Modify: `packages/executor/src/kernel.ts` (`db.get`/`db.replace`/`db.delete` verify the doc's table is in the namespace)
- Test: `packages/executor/test/component-scope-ids.test.ts`

**Interfaces:**
- Consumes: `parseFullTableName` (`@stackbase/id-codec`), Task 1's `KernelContext.namespace`.
- Produces: a `requireOwnTable(ctx, fullName)` guard; `get`/`replace`/`delete` throw `ForbiddenOperationError` when the document's table's `componentPath !== ctx.namespace`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/executor/test/component-scope-ids.test.ts
import { describe, it, expect } from "vitest";
import { SqliteDocStore, NodeSqliteAdapter } from "@stackbase/docstore-sqlite";
import { MonotonicTimestampOracle } from "@stackbase/docstore";
import { SingleWriterTransactor } from "@stackbase/transactor";
import { QueryRuntime } from "@stackbase/query-engine";
import { encodeStorageIndexId } from "@stackbase/id-codec";
import { InlineUdfExecutor, SimpleIndexCatalog, mutation, query } from "../src/index";

async function harness() {
  const store = new SqliteDocStore(new NodeSqliteAdapter());
  await store.setupSchema();
  const transactor = new SingleWriterTransactor(store, new MonotonicTimestampOracle());
  const queryRuntime = new QueryRuntime(store);
  const catalog = new SimpleIndexCatalog();
  for (const [name, n] of [["messages", 10001], ["auth/sessions", 10002]] as const) {
    catalog.addTable(name, n);
    catalog.addIndex({ table: name, tableNumber: n, index: "by_creation", fields: [], indexId: encodeStorageIndexId(n, "by_creation") });
  }
  return new InlineUdfExecutor({ transactor, queryRuntime, catalog });
}

describe("namespace-scoped ctx.db — id-based ops", () => {
  it("denies get/delete of a document whose table is outside the namespace", async () => {
    const executor = await harness();
    // app inserts into messages, capturing the id
    const appId = (await executor.run<string>(mutation(async (ctx) => ctx.db.insert("messages", { body: "secret" })), {}, {})).value;
    // a component (namespace "auth") must NOT be able to get that app document by id
    const steal = query(async (ctx) => ctx.db.get(appId));
    await expect(executor.run(steal, {}, { namespace: "auth" })).rejects.toThrow(/namespace|forbidden/i);
    const del = mutation(async (ctx) => ctx.db.delete(appId));
    await expect(executor.run(del, {}, { namespace: "auth" })).rejects.toThrow(/namespace|forbidden/i);
  });

  it("allows get of a document in the component's own namespace", async () => {
    const executor = await harness();
    const id = (await executor.run<string>(mutation(async (ctx) => ctx.db.insert("sessions", { token: "t" })), {}, { namespace: "auth" })).value;
    const got = await executor.run<{ token: string } | null>(query(async (ctx) => ctx.db.get(id)), {}, { namespace: "auth" });
    expect(got.value?.token).toBe("t");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @stackbase/executor test component-scope-ids`
Expected: FAIL — the steal/delete succeed (no namespace check on id-based ops yet).

- [ ] **Step 3: Write minimal implementation**

In `packages/executor/src/kernel.ts`, import `parseFullTableName` and add the guard:

```ts
import { decodeDocumentId, encodeInternalDocumentId, encodeStorageTableId, newDocumentId, getFullTableName, parseFullTableName } from "@stackbase/id-codec";

/** Reject access to a document whose table is outside the running component's namespace. */
function requireOwnTable(ctx: KernelContext, fullName: string): void {
  if (parseFullTableName(fullName).componentPath !== ctx.namespace) {
    throw new ForbiddenOperationError(`document is not in this component's namespace`);
  }
}
```

`handleDbGet` — resolve the id's table and guard before reading:
```ts
const handleDbGet: SyscallHandler = async (ctx, argJson) => {
  const { id } = JSON.parse(argJson) as { id: string };
  const internalId = decodeDocumentId(id);
  const meta = ctx.catalog.getTableByNumber(internalId.tableNumber);
  if (!meta) throw new FunctionNotFoundError(`unknown table for id ${id}`);
  requireOwnTable(ctx, meta.name);
  const value = await ctx.txn.get(internalId);
  return JSON.stringify(value === null ? null : convexToJson(value as Value));
};
```

In `handleDbReplace` and `handleDbDelete`, add `requireOwnTable(ctx, meta.name);` immediately after the existing `const meta = ctx.catalog.getTableByNumber(...)` + null check (before the `ctx.txn.get`/mutation).

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @stackbase/executor test component-scope-ids` → PASS.
Run: `pnpm --filter @stackbase/executor test` → all executor tests pass (existing get/replace/delete run with namespace `""` on bare-named tables → `componentPath === ""` matches).
Run: `pnpm --filter @stackbase/executor exec tsc --noEmit` → clean.

- [ ] **Step 5: Commit**

```bash
git add packages/executor/src/kernel.ts packages/executor/test/component-scope-ids.test.ts
git commit -m "feat(executor): namespace-scope id-based ops (no cross-component get/replace/delete)"
```

---

### Task 3: `namespaceForPath` — the path→namespace bridge

**Files:**
- Modify: `packages/component/src/compose.ts` (add `namespaceForPath`)
- Modify: `packages/component/src/index.ts` (already `export * from "./compose"`)
- Test: `packages/component/test/namespace-for-path.test.ts`

**Interfaces:**
- Produces: `namespaceForPath(path: string, componentNames: ReadonlySet<string>): string` — the prefix before the first `:` if it's a registered component name, else `""` (an app module). C2's loader uses this to choose the `namespace` it passes to `executor.run`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/component/test/namespace-for-path.test.ts
import { describe, it, expect } from "vitest";
import { namespaceForPath } from "../src/compose";

describe("namespaceForPath", () => {
  const names = new Set(["auth", "cron"]);
  it("returns the component name for a component function path", () => {
    expect(namespaceForPath("auth:signIn", names)).toBe("auth");
    expect(namespaceForPath("cron:tick", names)).toBe("cron");
  });
  it("returns '' for an app module path (prefix is not a component)", () => {
    expect(namespaceForPath("messages:list", names)).toBe("");
    expect(namespaceForPath("auth", names)).toBe(""); // colon-free → not a component fn key
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @stackbase/component test namespace-for-path`
Expected: FAIL — `namespaceForPath` not exported.

- [ ] **Step 3: Write minimal implementation**

Add to `packages/component/src/compose.ts`:
```ts
/** The namespace a function path runs in: its component name, or "" for an app module. */
export function namespaceForPath(path: string, componentNames: ReadonlySet<string>): string {
  const i = path.indexOf(":");
  if (i === -1) return "";
  const prefix = path.slice(0, i);
  return componentNames.has(prefix) ? prefix : "";
}
```

- [ ] **Step 4: Run test, typecheck, full build, commit**

Run: `pnpm --filter @stackbase/component test namespace-for-path` → PASS.
Run: `pnpm --filter @stackbase/component test` → all component tests pass.
Run: `pnpm build && pnpm typecheck && pnpm test` → whole workspace green.

```bash
git add packages/component/src/compose.ts packages/component/test/namespace-for-path.test.ts
git commit -m "feat(component): namespaceForPath — path→namespace bridge for the loader"
```

---

## Self-Review

**Spec coverage (against `2025-05-22-component-system-design.md` §3.3–§3.4):**
- §3.4 boundary via resolution — Task 1 (name-based: `requireTable`/query scope by `getFullTableName`) + Task 2 (id-based: `requireOwnTable` via `parseFullTableName`). Both surfaces closed. ✅
- §3.3 the App→Component direction's *plumbing prerequisite* — the namespace seam (`KernelContext.namespace` + `RunOptions.namespace`) that `ctx`-contribution facades and the loader build on; `namespaceForPath` (Task 3) is the bridge C2 uses. ✅
- **Out of scope for this plan (next plans):** the `ctx`-contribution facade (`ctx.auth.getUserId()`) + request-token plumbing; §3.5 cross-component reactivity (falls out once facades read across namespaces — read-sets are already table-id based, so no new plumbing, but it's exercised in the facade plan); the write-set *audit* (defense-in-depth / isolate enforcement — deferred to the sandboxing slice, since in-process resolution already enforces the boundary); §4 config + loader; §6 codegen.

**Placeholder scan:** none — every step has runnable code/commands. The "apply this same one-line change in BOTH handlers" (Task 1, query + paginate) names both call sites explicitly.

**Type consistency:** `KernelContext.namespace` (Task 1) is read by `requireTable`/`requireOwnTable` and the query handlers; `RunOptions.namespace` (Task 1) sets it; `requireTable` returns `{ tableNumber, fullName }` consumed by `handleDbInsert`'s `maintainIndexes(ctx, fullName, …)`; `requireOwnTable` (Task 2) consumes `meta.name` (the full catalog name). `namespaceForPath` (Task 3) returns the same `namespace` string `RunOptions.namespace` expects.
