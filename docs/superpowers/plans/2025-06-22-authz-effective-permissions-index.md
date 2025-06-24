# authz `effectivePermissions` Pre-Flattened Index Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Materialize role→permission grants into an `authz/effective_permissions` index so `can()` is an O(1) point-read with surgical per-permission invalidation, kept correct across config changes by a startup boot-hook rebuild.

**Architecture:** `assignRole`/`revokeRole` maintain the index (as wildcard *patterns*) transactionally; `can`/`require`/`scopesWith` read it via indexed point-reads; a new generic component **boot hook** rebuilds the index from `role_assignments` at runtime start when a stored config-hash changed. `role_assignments` stays the source of truth.

**Tech Stack:** TypeScript, Bun (package manager + runtime), Turborepo, vitest. Builds on the shipped RBAC-core (`role_assignments`, `roleGrants`/`expandRole`, gated `assignRole`/`revokeRole`, `ctx.authz` facade).

## Global Constraints

- **Bun toolchain:** `bun run build`, `bun run typecheck`, `bun run test`; single package `bun run --filter <pkg> test`. Never pnpm/npm.
- **Index is RBAC-only:** serves `can`/`require`/`scopesWith`. Relation predicates keep their semi-join (untouched).
- **Patterns, not enumerated permissions:** grants stored as-written (`documents:*`, `*:*`, `billing:manage`). `can(res:act)` point-reads the ≤4 candidate keys (`res:act`, `res:*`, `*:act`, `*:*`).
- **`role_assignments` is the source of truth;** `effective_permissions` is derived/rebuildable.
- **Config drift → startup rebuild:** the authz boot step compares a stored `configHash` to the current config and rebuilds if changed. `can()` is a pure point-read (no per-check freshness read).
- **Boot step runs namespaced (not raw-name privileged):** `namespace = component name`, `identity = null`, `privileged = false`; bare table names resolve under the component's namespace.
- **Bootstrap seeds BOTH tables:** any out-of-band `role_assignments` write (the first-admin bootstrap via `_system:insertDocument`) must also seed the matching `effective_permissions` row, or `can()` (index-backed) won't see it; the boot rebuild would delete an `effective_permissions` row that has no backing assignment.
- **Max-expansion guard:** a role expanding to > `MAX_PATTERNS_PER_ROLE` (=1000) patterns throws (fail-closed).
- **TDD, frequent commits.** Each task ends green (`build`/`typecheck`/`test`) with one commit.
- `noUncheckedIndexedAccess: true`.

---

## File Structure

- `components/authz/src/effective-permissions.ts` (**new**) — `expandRolePatterns`, `candidateKeys`, `configHash`, `upsertPatterns`, `reconcileScope`, `reconcileEffectivePermissions`, `MAX_PATTERNS_PER_ROLE`.
- `components/authz/src/schema.ts` (**modify**) — `effective_permissions` + `meta` tables.
- `components/authz/src/roles.ts` (**modify**) — export `expandRole`.
- `components/authz/src/functions.ts` (**modify**) — become a factory `authzModules(config)`; `assignRole`/`revokeRole` maintain the index; a gated `rebuild`.
- `components/authz/src/context.ts` (**modify**) — `can`/`require`/`scopesWith` read the index.
- `components/authz/src/define-authz.ts` (**modify**) — wire the factory + `boot`.
- `packages/component/src/define-component.ts` (**modify**) — `boot?` + `BootContext`.
- `packages/component/src/compose.ts` (**modify**) — collect `bootSteps`.
- `packages/runtime-embedded/src/runtime.ts` (**modify**) — run boot steps after `setupSchema`.
- Tests: authz (`effective-permissions.test.ts`, extend existing) + component (`boot-seam.test.ts`).

---

## Task 1: Core helpers + schema tables

**Files:**
- Create: `components/authz/src/effective-permissions.ts`
- Modify: `components/authz/src/schema.ts`, `components/authz/src/roles.ts`, `components/authz/src/index.ts`
- Test: `components/authz/test/effective-permissions.test.ts`

**Interfaces:**
- Consumes: `expandRole`/`AuthzConfig` from `./roles`.
- Produces: `MAX_PATTERNS_PER_ROLE = 1000`; `expandRolePatterns(config, role): string[]`; `candidateKeys(permission): string[]`; `configHash(config): string`. Schema adds `effective_permissions` (`byLookup [scopeType,scopeId,userId,permission]`, `byUser [userId]`) + `meta`.

- [ ] **Step 1: Write the failing test**

Create `components/authz/test/effective-permissions.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { expandRolePatterns, candidateKeys, configHash } from "../src/effective-permissions";
import type { AuthzConfig } from "../src/roles";

const config: AuthzConfig = {
  roles: {
    viewer: { documents: ["read"] },
    editor: { inherits: "viewer", documents: ["update"] },
    admin: { documents: ["*"], authz: ["manage"] },
  },
};

describe("expandRolePatterns", () => {
  it("expands a role to its permission patterns (with inheritance)", () => {
    expect(expandRolePatterns(config, "editor").sort()).toEqual(["documents:read", "documents:update"]);
  });
  it("keeps wildcards as patterns", () => {
    expect(expandRolePatterns(config, "admin").sort()).toEqual(["authz:manage", "documents:*"]);
  });
});

describe("candidateKeys", () => {
  it("returns the <=4 keys that could match a permission", () => {
    expect(candidateKeys("documents:read")).toEqual(["documents:read", "documents:*", "*:read", "*:*"]);
  });
});

describe("configHash", () => {
  it("is stable across key ordering and differs when a grant changes", () => {
    const a = configHash({ roles: { r: { a: ["x"], b: ["y"] } } });
    const b = configHash({ roles: { r: { b: ["y"], a: ["x"] } } });
    expect(a).toBe(b);
    expect(a).not.toBe(configHash({ roles: { r: { a: ["x", "z"], b: ["y"] } } }));
  });
});
```

- [ ] **Step 2: Run — verify it fails**

Run: `bun run --filter @stackbase/authz test effective-permissions`
Expected: FAIL — module not found.

- [ ] **Step 3: Export `expandRole` + add schema tables**

In `components/authz/src/roles.ts`, change `function expandRole(` to `export function expandRole(`.

In `components/authz/src/schema.ts`, add the two tables:

```ts
import { defineSchema, defineTable, v } from "@stackbase/values";
export const authzSchema = defineSchema({
  role_assignments: defineTable({
    userId: v.string(), role: v.string(), scopeType: v.string(), scopeId: v.string(),
  }).index("byUserScope", ["userId", "scopeType", "scopeId"]).index("byUser", ["userId"]),
  effective_permissions: defineTable({
    userId: v.string(), scopeType: v.string(), scopeId: v.string(), permission: v.string(),
  }).index("byLookup", ["scopeType", "scopeId", "userId", "permission"]).index("byUser", ["userId"]),
  meta: defineTable({ configHash: v.string() }),
});
```

- [ ] **Step 4: Implement `effective-permissions.ts`**

Create `components/authz/src/effective-permissions.ts`:

```ts
import { expandRole, type AuthzConfig } from "./roles";

export const MAX_PATTERNS_PER_ROLE = 1000;

/** A role's granted permission patterns (with inheritance), stored verbatim (wildcards kept). */
export function expandRolePatterns(config: AuthzConfig, role: string): string[] {
  const set = expandRole(config, role, new Set());
  if (set.size > MAX_PATTERNS_PER_ROLE)
    throw new Error(`authz: role "${role}" expands to more than ${MAX_PATTERNS_PER_ROLE} permission patterns`);
  return [...set];
}

/** The <=4 stored patterns that would grant `permission = "res:act"`. */
export function candidateKeys(permission: string): string[] {
  const i = permission.indexOf(":");
  const res = i === -1 ? permission : permission.slice(0, i);
  const act = i === -1 ? "" : permission.slice(i + 1);
  return [...new Set([`${res}:${act}`, `${res}:*`, `*:${act}`, "*:*"])];
}

/** A stable, order-independent hash of the config's roles + permissions (the index version stamp). */
export function configHash(config: AuthzConfig): string {
  const canonical = stableStringify({ roles: config.roles ?? {}, permissions: config.permissions ?? {} });
  let h = 0x811c9dc5;
  for (let i = 0; i < canonical.length; i++) { h ^= canonical.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(16);
}

function stableStringify(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(",")}]`;
  const keys = Object.keys(v as object).sort();
  return `{${keys.map((k) => JSON.stringify(k) + ":" + stableStringify((v as Record<string, unknown>)[k])).join(",")}}`;
}
```

Append to `components/authz/src/index.ts`:

```ts
export * from "./effective-permissions";
```

- [ ] **Step 5: Run — verify it passes**

Run: `bun run --filter @stackbase/authz test effective-permissions`
Expected: PASS.

- [ ] **Step 6: Whole workspace green + commit**

Run: `bun run build && bun run typecheck && bun run test`
Expected: PASS (adding two tables + exporting `expandRole` is additive; existing tests unchanged).

```bash
git add components/authz/src/effective-permissions.ts components/authz/src/schema.ts components/authz/src/roles.ts components/authz/src/index.ts components/authz/test/effective-permissions.test.ts
git commit -m "feat(authz): effective-permissions helpers (patterns/candidateKeys/configHash) + index tables"
```

---

## Task 2: Component boot seam

**Files:**
- Modify: `packages/component/src/define-component.ts`, `packages/component/src/compose.ts`, `packages/runtime-embedded/src/runtime.ts`
- Test: `packages/component/test/boot-seam.test.ts`

**Interfaces:**
- Produces: `ComponentDefinition.boot?: (ctx: BootContext) => Promise<void>`; `BootContext = { db: GuestDatabaseWriter; now: number }`; `ComposedProject.bootSteps: { name: string; run: (ctx: BootContext) => Promise<void> }[]`; `EmbeddedRuntimeOptions.bootSteps?`; boot steps run once at `create`, namespaced + non-privileged.

- [ ] **Step 1: Write the failing test**

Create `packages/component/test/boot-seam.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { SqliteDocStore, NodeSqliteAdapter } from "@stackbase/docstore-sqlite";
import { composeComponents, defineComponent } from "../src/index";
import { EmbeddedRuntime } from "@stackbase/runtime-embedded";
import { defineSchema, defineTable, v, type SchemaDefinition } from "@stackbase/values";
import { query } from "@stackbase/executor";

const bootc = defineComponent({
  name: "bootc",
  schema: defineSchema({ marks: defineTable({ note: v.string() }) }) as unknown as SchemaDefinition,
  modules: { list: query(async (ctx) => ctx.db.query("marks", "by_creation").collect()) },
  boot: async (ctx) => { await ctx.db.insert("marks", { note: "booted" }); },
});

describe("component boot seam", () => {
  it("runs a component's boot step once at runtime create (namespaced write)", async () => {
    const c = composeComponents({ schemaJson: defineSchema({}).export(), moduleMap: {} }, [bootc]);
    expect(c.bootSteps).toHaveLength(1);
    const r = await EmbeddedRuntime.create({
      store: new SqliteDocStore(new NodeSqliteAdapter()),
      catalog: c.catalog, modules: c.moduleMap, componentNames: c.componentNames, bootSteps: c.bootSteps,
    });
    const rows = (await r.run<any[]>("bootc:list", {})).value;
    expect(rows.map((m) => m.note)).toEqual(["booted"]);
  });
});
```

- [ ] **Step 2: Run — verify it fails**

Run: `bun run --filter @stackbase/component test boot-seam`
Expected: FAIL — `boot` not accepted / `bootSteps` not on `ComposedProject` / not run.

- [ ] **Step 3: Add `boot` to `ComponentDefinition`**

In `packages/component/src/define-component.ts`, add the import and field:

```ts
import type { GuestDatabaseWriter } from "@stackbase/executor";
```
```ts
  /** A once-per-process startup step (migrations/index rebuilds). Runs namespaced + non-user. */
  boot?: (ctx: BootContext) => Promise<void>;
```
And export the type (top-level, after the interface):

```ts
export interface BootContext { db: GuestDatabaseWriter; now: number }
```

- [ ] **Step 4: Collect `bootSteps` in `compose.ts`**

Add `BootContext` to the executor import; add to `ComposedProject`:

```ts
  bootSteps: { name: string; run: (ctx: BootContext) => Promise<void> }[];
```

In `composeComponents`, before the return:

```ts
  const bootSteps = components.filter((c) => c.boot).map((c) => ({ name: c.name, run: c.boot! }));
```

Add `bootSteps` to the returned object.

- [ ] **Step 5: Run boot steps in `runtime.ts`**

Add imports: `import { mutation, type RegisteredFunction, type GuestDatabaseWriter } from "@stackbase/executor";` (merge with existing executor import). Add to `EmbeddedRuntimeOptions`:

```ts
  bootSteps?: { name: string; run: (ctx: { db: GuestDatabaseWriter; now: number }) => Promise<void> }[];
```

In `create`, AFTER the `executor` is constructed and BEFORE building the `handler`, add:

```ts
    // Run component boot steps once, before serving: a namespaced, non-user mutation per step.
    for (const step of options.bootSteps ?? []) {
      const bootFn = mutation(async (ctx) => {
        await step.run({ db: ctx.db as unknown as GuestDatabaseWriter, now: ctx.now() });
        return null;
      });
      await executor.run(bootFn, {}, { path: `_boot:${step.name}`, namespace: step.name, identity: null });
    }
```

- [ ] **Step 6: Run — verify it passes**

Run: `bun run --filter @stackbase/component test boot-seam`
Expected: PASS — the boot step's row is visible after create.

- [ ] **Step 7: Whole workspace green + commit**

Run: `bun run build && bun run typecheck && bun run test` → PASS (additive; runtimes without `bootSteps` are unchanged).

```bash
git add packages/component/src/define-component.ts packages/component/src/compose.ts packages/runtime-embedded/src/runtime.ts packages/component/test/boot-seam.test.ts
git commit -m "feat(component): component boot-step seam (once-per-start namespaced migration hook)"
```

---

## Task 3: `assignRole`/`revokeRole` maintain the index

**Files:**
- Modify: `components/authz/src/functions.ts`, `components/authz/src/define-authz.ts`, `components/authz/src/effective-permissions.ts`
- Test: extend `components/authz/test/effective-permissions.test.ts`

**Interfaces:**
- Consumes: Task 1 helpers.
- Produces: `authzModules(config): { assignRole, revokeRole }` (factory replacing the standalone exports); `upsertPatterns(db, config, userId, role, st, si)` and `reconcileScope(db, config, userId, st, si)` in `effective-permissions.ts`.

- [ ] **Step 1: Write the failing test**

Append to `components/authz/test/effective-permissions.test.ts` an integration case that assigns and revokes through the runtime and inspects `effective_permissions`:

```ts
import { SqliteDocStore, NodeSqliteAdapter } from "@stackbase/docstore-sqlite";
import { composeComponents } from "@stackbase/component";
import { EmbeddedRuntime } from "@stackbase/runtime-embedded";
import { defineSchema } from "@stackbase/values";
import { query, mutation, type RegisteredFunction } from "@stackbase/executor";
import { auth } from "@stackbase/auth";
import { defineAuthz } from "../src/define-authz";

function systemModules(): Record<string, RegisteredFunction> {
  return { "_system:insertDocument": mutation(async (ctx, a: { table: string; fields: Record<string, unknown> }) =>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await ctx.db.insert(a.table, a.fields as any)) };
}
const cfg = { roles: { editor: { documents: ["read", "update"] }, viewer: { documents: ["read"] }, admin: { authz: ["manage"] } } };
const authz = defineAuthz(cfg);

async function runtimeWithAdmin() {
  const c = composeComponents({ schemaJson: defineSchema({}).export(), moduleMap: {
    "eff:list": query(async (ctx) => ctx.db.query("authz/effective_permissions", "by_creation").collect()),
  } }, [auth, authz]);
  const r = await EmbeddedRuntime.create({
    store: new SqliteDocStore(new NodeSqliteAdapter()), catalog: c.catalog, modules: c.moduleMap,
    systemModules: systemModules(), componentNames: c.componentNames, contextProviders: c.contextProviders,
    policyRegistry: c.policyRegistry, policyProviders: c.policyProviders, relationRegistry: c.relationRegistry,
  });
  const admin = (await r.run<{ token: string; userId: string }>("auth:signUp", { email: "a@b.co", password: "pw" })).value;
  // bootstrap: seed BOTH role_assignments AND effective_permissions for the admin's manage grant
  await r.runSystem("_system:insertDocument", { table: "authz/role_assignments", fields: { userId: admin.userId, role: "admin", scopeType: "", scopeId: "" } });
  await r.runSystem("_system:insertDocument", { table: "authz/effective_permissions", fields: { userId: admin.userId, scopeType: "", scopeId: "", permission: "authz:manage" } });
  return { r, admin };
}
const effFor = async (r: EmbeddedRuntime, userId: string) =>
  (await r.run<any[]>("eff:list", {})).value.filter((e) => e.userId === userId).map((e) => e.permission).sort();

describe("assign/revoke maintain effective_permissions", () => {
  it("assign materializes patterns; revoke reconciles; a shared pattern survives", async () => {
    const { r, admin } = await runtimeWithAdmin();
    const bob = (await r.run<{ userId: string }>("auth:signUp", { email: "bob@b.co", password: "pw" })).value;
    await r.run("authz:assignRole", { userId: bob.userId, role: "editor" }, { identity: admin.token });
    expect(await effFor(r, bob.userId)).toEqual(["documents:read", "documents:update"]);
    await r.run("authz:assignRole", { userId: bob.userId, role: "viewer" }, { identity: admin.token });
    await r.run("authz:revokeRole", { userId: bob.userId, role: "editor" }, { identity: admin.token });
    // viewer still grants documents:read → it survives; documents:update is gone
    expect(await effFor(r, bob.userId)).toEqual(["documents:read"]);
  });
});
```

- [ ] **Step 2: Run — verify it fails**

Run: `bun run --filter @stackbase/authz test effective-permissions`
Expected: FAIL — `assignRole` doesn't write `effective_permissions` yet.

- [ ] **Step 3: Add `upsertPatterns` + `reconcileScope`**

Append to `components/authz/src/effective-permissions.ts`:

```ts
import type { GuestDatabaseWriter } from "@stackbase/executor";

/** Insert the role's patterns for (user, scope) that aren't already present (idempotent). */
export async function upsertPatterns(
  db: GuestDatabaseWriter, config: AuthzConfig, userId: string, role: string, scopeType: string, scopeId: string,
): Promise<void> {
  const existing = await db.query("effective_permissions", "byLookup").eq("scopeType", scopeType).eq("scopeId", scopeId).eq("userId", userId).collect();
  const have = new Set(existing.map((r) => r.permission as string));
  for (const p of expandRolePatterns(config, role)) if (!have.has(p)) await db.insert("effective_permissions", { userId, scopeType, scopeId, permission: p });
}

/** Recompute (user, scope) effective patterns from remaining role_assignments; insert missing, delete orphans. */
export async function reconcileScope(
  db: GuestDatabaseWriter, config: AuthzConfig, userId: string, scopeType: string, scopeId: string,
): Promise<void> {
  const assigns = await db.query("role_assignments", "byUserScope").eq("userId", userId).eq("scopeType", scopeType).eq("scopeId", scopeId).collect();
  const desired = new Set<string>();
  for (const a of assigns) for (const p of expandRolePatterns(config, a.role as string)) desired.add(p);
  const rows = await db.query("effective_permissions", "byLookup").eq("scopeType", scopeType).eq("scopeId", scopeId).eq("userId", userId).collect();
  const have = new Set<string>();
  for (const r of rows) {
    if (desired.has(r.permission as string)) have.add(r.permission as string);
    else await db.delete(r._id as string);
  }
  for (const p of desired) if (!have.has(p)) await db.insert("effective_permissions", { userId, scopeType, scopeId, permission: p });
}
```

> `GuestDatabaseWriter` is the mutation `ctx.db` type; the authz mutations already use it. The `.query(...).eq(...)` builder is the same one `assignRole` already uses.

- [ ] **Step 4: Make `functions.ts` a config-aware factory**

Replace the standalone `assignRole`/`revokeRole` exports in `components/authz/src/functions.ts` with a factory that captures `config` (keep `assertScope`, `MANAGE_PERMISSION`, `WithAuthz` as-is):

```ts
import { mutation, type RegisteredFunction, type GuestDatabaseWriter } from "@stackbase/executor";
import type { AuthzConfig } from "./roles";
import { upsertPatterns, reconcileScope } from "./effective-permissions";
```
```ts
export function authzModules(config: AuthzConfig): Record<string, RegisteredFunction> {
  const assignRole = mutation(async (ctx, { userId, role, scope }: Assign) => {
    assertScope(scope);
    await (ctx as unknown as WithAuthz).authz.require(MANAGE_PERMISSION, scope);
    const st = scope?.type ?? "", si = scope?.id ?? "";
    const existing = await ctx.db.query("role_assignments", "byUserScope").eq("userId", userId).eq("scopeType", st).eq("scopeId", si).collect();
    if (!existing.some((r) => r.role === role)) await ctx.db.insert("role_assignments", { userId, role, scopeType: st, scopeId: si });
    await upsertPatterns(ctx.db as unknown as GuestDatabaseWriter, config, userId, role, st, si); // idempotent even if the assignment already existed
    return null;
  });

  const revokeRole = mutation(async (ctx, { userId, role, scope }: Assign) => {
    assertScope(scope);
    await (ctx as unknown as WithAuthz).authz.require(MANAGE_PERMISSION, scope);
    const st = scope?.type ?? "", si = scope?.id ?? "";
    const rows = await ctx.db.query("role_assignments", "byUserScope").eq("userId", userId).eq("scopeType", st).eq("scopeId", si).collect();
    for (const r of rows) if (r.role === role) await ctx.db.delete(r._id as string);
    await reconcileScope(ctx.db as unknown as GuestDatabaseWriter, config, userId, st, si);
    return null;
  });

  return { assignRole, revokeRole };
}
```

Keep the existing `interface Assign`, `MANAGE_PERMISSION`, `WithAuthz`, `assertScope`. Remove the old top-level `export const assignRole`/`revokeRole`.

- [ ] **Step 5: Wire the factory in `define-authz.ts`**

Replace the `import { assignRole, revokeRole } from "./functions";` with `import { authzModules } from "./functions";` and change `modules`:

```ts
    modules: authzModules(config),
```

- [ ] **Step 6: Run — verify it passes**

Run: `bun run --filter @stackbase/authz test effective-permissions`
Expected: PASS — assign materializes both patterns; after adding viewer and revoking editor, `documents:read` survives, `documents:update` is gone.

- [ ] **Step 7: Whole workspace green + commit**

Run: `bun run build && bun run typecheck && bun run test`
Expected: PASS — `can()` still reads live (unchanged in this task), so existing RBAC/row-policy/relation tests are unaffected; `assignRole` now dual-writes `effective_permissions` (harmless).

```bash
git add components/authz/src/functions.ts components/authz/src/define-authz.ts components/authz/src/effective-permissions.ts components/authz/test/effective-permissions.test.ts
git commit -m "feat(authz): assignRole/revokeRole maintain the effective_permissions index"
```

---

## Task 4: `can`/`require`/`scopesWith` read the index

**Files:**
- Modify: `components/authz/src/context.ts`
- Modify (test helpers): `components/authz/test/rbac.test.ts`, `components/authz/test/row-policy.test.ts`, `components/authz/test/relation-policy.test.ts`, `components/authz/test/reactive.test.ts`
- Test: extend `components/authz/test/effective-permissions.test.ts`

**Interfaces:**
- Consumes: `candidateKeys` (Task 1); the `effective_permissions` rows written by Task 3.
- Produces: `can`/`require`/`scopesWith` read `effective_permissions` (point-reads); `roles` unchanged.

- [ ] **Step 1: Write the failing test**

First, extend the shared fixture from Task 3: add a wildcard role to `cfg` and two facade queries to `runtimeWithAdmin`'s `moduleMap`:
- `cfg.roles.superadmin = { "*": ["*"] }` (expands to the single pattern `"*:*"`).
- in `runtimeWithAdmin`'s `moduleMap`, add:
  `"me:can": query(async (ctx, { p }: { p: string }) => (ctx as unknown as { authz: { can(p: string): Promise<boolean> } }).authz.can(p)),`
  `"me:scopes": query(async (ctx, { p, t }: { p: string; t?: string }) => (ctx as unknown as { authz: { scopesWith(p: string, t?: string): Promise<string[]> } }).authz.scopesWith(p, t)),`

Then append:

```ts
describe("can()/scopesWith read the index", () => {
  it("exact + wildcard grants answer via the index; anonymous denied", async () => {
    const { r, admin } = await runtimeWithAdmin();
    const carol = (await r.run<{ token: string; userId: string }>("auth:signUp", { email: "carol@b.co", password: "pw" })).value;
    await r.run("authz:assignRole", { userId: carol.userId, role: "editor" }, { identity: admin.token });
    expect((await r.run<boolean>("me:can", { p: "documents:read" }, { identity: carol.token })).value).toBe(true);
    expect((await r.run<boolean>("me:can", { p: "billing:view" }, { identity: carol.token })).value).toBe(false);
    expect((await r.run<boolean>("me:can", { p: "documents:read" })).value).toBe(false); // anonymous
    await r.run("authz:assignRole", { userId: carol.userId, role: "superadmin" }, { identity: admin.token });
    expect((await r.run<boolean>("me:can", { p: "anything:goes" }, { identity: carol.token })).value).toBe(true); // *:*
  });

  it("scopesWith returns the scope ids where a permission is held", async () => {
    const { r, admin } = await runtimeWithAdmin();
    const dave = (await r.run<{ token: string; userId: string }>("auth:signUp", { email: "dave@b.co", password: "pw" })).value;
    await r.run("authz:assignRole", { userId: dave.userId, role: "editor", scope: { type: "org", id: "o1" } }, { identity: admin.token });
    await r.run("authz:assignRole", { userId: dave.userId, role: "editor", scope: { type: "org", id: "o2" } }, { identity: admin.token });
    expect((await r.run<string[]>("me:scopes", { p: "documents:read", t: "org" }, { identity: dave.token })).value.sort()).toEqual(["o1", "o2"]);
  });
});
```

- [ ] **Step 2: Run — verify it fails**

Run: `bun run --filter @stackbase/authz test effective-permissions`
Expected: FAIL — `can()` still computes live (reads `role_assignments`), and would still pass for the assigned cases but the wildcard-via-index path and the surgical read-set aren't exercised; more importantly, Step 3 switches the read path and the EXISTING bootstrap tests (below) must be fixed.

- [ ] **Step 3: Rewrite `can`/`require`/`scopesWith` to read the index**

In `components/authz/src/context.ts`, replace the facade body. Keep `authzContext(cctx, config)`; `assignedRoles`/`roles` stay (used by `roles()`), but `can`/`require`/`scopesWith` now read `effective_permissions`. The facade no longer calls `roleGrants` — **remove the now-unused `import { roleGrants } from "./roles"`** (keep the `AuthzConfig` type import; `config` stays a parameter but is now only structurally present — that's fine, `noUnusedParameters` is not enabled). Add:

```ts
import { candidateKeys } from "./effective-permissions";
```
```ts
  async function uid(): Promise<string | null> { return auth ? await auth.getUserId() : null; }
  async function held(scopeType: string, scopeId: string, userId: string, keys: string[]): Promise<boolean> {
    for (const key of keys) {
      const hit = await cctx.db.query("effective_permissions", "byLookup")
        .eq("scopeType", scopeType).eq("scopeId", scopeId).eq("userId", userId).eq("permission", key).collect();
      if (hit.length > 0) return true;
    }
    return false;
  }
  return {
    async can(permission, scope) {
      const u = await uid(); if (!u) return false;
      const keys = candidateKeys(permission);
      const st = scope?.type ?? "", si = scope?.id ?? "";
      if (await held(st, si, u, keys)) return true;
      if (st !== "" || si !== "") return held("", "", u, keys); // fall back to a global grant
      return false;
    },
    async require(permission, scope) {
      if (!(await this.can(permission, scope))) throw new Error(`Forbidden: ${permission}`);
    },
    async roles(scope) { return assignedRoles(scope); },
    async scopesWith(permission, type) {
      const u = await uid(); if (!u) return [];
      const keys = new Set(candidateKeys(permission));
      const rows = await cctx.db.query("effective_permissions", "byUser").eq("userId", u).collect();
      const out = new Set<string>();
      for (const r of rows) {
        if (type !== undefined && r.scopeType !== type) continue;
        if (keys.has(r.permission as string)) out.add(r.scopeId as string);
      }
      return [...out];
    },
  };
```

- [ ] **Step 4: Fix the bootstrap test helpers (seed the index too)**

Every existing test that bootstraps an admin by inserting a `role_assignments` row via `_system:insertDocument` must ALSO insert the matching `effective_permissions` row, or the now-index-backed `can("authz:manage")` returns false and the admin can't call `assignRole`. In each of `components/authz/test/rbac.test.ts`, `row-policy.test.ts`, `relation-policy.test.ts`, and the inline admin seed in `reactive.test.ts`, immediately after the `_system:insertDocument` into `authz/role_assignments` for the admin, add:

```ts
await r.runSystem("_system:insertDocument", { table: "authz/effective_permissions", fields: { userId: <adminUserId>, scopeType: "", scopeId: "", permission: "authz:manage" } });
```

(use that file's admin userId variable). If a file's `systemModules()` lacks `_system:insertDocument` it already has it for the role_assignments seed — reuse it.

- [ ] **Step 5: Run — verify it passes**

Run: `bun run --filter @stackbase/authz test`
Expected: PASS — the new index-read assertions pass, and the bootstrap-fixed existing authz tests (rbac, row-policy, relation-policy, reactive) pass with `can()` reading the index.

- [ ] **Step 6: Whole workspace green + commit**

Run: `bun run build && bun run typecheck && bun run test`
Expected: PASS.

```bash
git add components/authz/src/context.ts components/authz/test/rbac.test.ts components/authz/test/row-policy.test.ts components/authz/test/relation-policy.test.ts components/authz/test/reactive.test.ts components/authz/test/effective-permissions.test.ts
git commit -m "feat(authz): can/require/scopesWith read the effective_permissions index"
```

---

## Task 5: Boot reconcile (config drift) + surgical invalidation + rebuild

**Files:**
- Modify: `components/authz/src/effective-permissions.ts`, `components/authz/src/define-authz.ts`, `components/authz/src/functions.ts`, `components/authz/README.md`
- Test: extend `components/authz/test/effective-permissions.test.ts`

**Interfaces:**
- Consumes: `reconcileScope`, `configHash` (Tasks 1/3); the boot seam (Task 2).
- Produces: `reconcileEffectivePermissions(ctx, config)` (boot/rebuild); `authz` `boot` wired; a gated `authz:rebuild` module.

- [ ] **Step 1: Write the failing tests**

Append to `components/authz/test/effective-permissions.test.ts` (these reuse `systemModules`, `auth`, `defineAuthz`, `composeComponents`, `EmbeddedRuntime`, `defineSchema`, `query` already imported in this file):

```ts
// Seed a bootstrap admin (both tables) into a runtime `r`, returning the admin's token/userId.
async function seedAdmin(r: EmbeddedRuntime, email: string) {
  const a = (await r.run<{ token: string; userId: string }>("auth:signUp", { email, password: "pw" })).value;
  await r.runSystem("_system:insertDocument", { table: "authz/role_assignments", fields: { userId: a.userId, role: "admin", scopeType: "", scopeId: "" } });
  await r.runSystem("_system:insertDocument", { table: "authz/effective_permissions", fields: { userId: a.userId, scopeType: "", scopeId: "", permission: "authz:manage" } });
  return a;
}

describe("boot reconcile — config drift", () => {
  it("rebuilds the index at boot when the roles config changed", async () => {
    const store = new SqliteDocStore(new NodeSqliteAdapter());
    const build = async (config: Parameters<typeof defineAuthz>[0]) => {
      const c = composeComponents({ schemaJson: defineSchema({}).export(), moduleMap: {
        "me:can": query(async (ctx, { p }: { p: string }) => (ctx as unknown as { authz: { can(p: string): Promise<boolean> } }).authz.can(p)),
      } }, [auth, defineAuthz(config)]);
      return { c, r: await EmbeddedRuntime.create({ store, catalog: c.catalog, modules: c.moduleMap, systemModules: systemModules(),
        componentNames: c.componentNames, contextProviders: c.contextProviders, policyRegistry: c.policyRegistry,
        policyProviders: c.policyProviders, relationRegistry: c.relationRegistry, bootSteps: c.bootSteps }) };
    };
    const cfgOld = { roles: { editor: { documents: ["read"] }, admin: { authz: ["manage"] } } };
    const one = await build(cfgOld);
    const admin = await seedAdmin(one.r, "a@b.co");
    const bob = (await one.r.run<{ token: string; userId: string }>("auth:signUp", { email: "bob@b.co", password: "pw" })).value;
    await one.r.run("authz:assignRole", { userId: bob.userId, role: "editor" }, { identity: admin.token });
    expect((await one.r.run<boolean>("me:can", { p: "documents:delete" }, { identity: bob.token })).value).toBe(false);

    // redeploy: editor now also grants documents:delete → new config hash → boot rebuild over the SAME store
    const cfgNew = { roles: { editor: { documents: ["read", "delete"] }, admin: { authz: ["manage"] } } };
    const two = await build(cfgNew);
    expect((await two.r.run<boolean>("me:can", { p: "documents:delete" }, { identity: bob.token })).value).toBe(true);
  });
});

describe("surgical invalidation", () => {
  it("revoking a role re-runs only subscriptions checking an affected permission", async () => {
    const cfg2 = { roles: { ra: { a: ["read"] }, rb: { b: ["read"] }, admin: { authz: ["manage"] } } };
    const c = composeComponents({ schemaJson: defineSchema({}).export(), moduleMap: {
      "me:canA": query(async (ctx) => (ctx as unknown as { authz: { can(p: string): Promise<boolean> } }).authz.can("a:read")),
      "me:canB": query(async (ctx) => (ctx as unknown as { authz: { can(p: string): Promise<boolean> } }).authz.can("b:read")),
    } }, [auth, defineAuthz(cfg2)]);
    const r = await EmbeddedRuntime.create({ store: new SqliteDocStore(new NodeSqliteAdapter()), catalog: c.catalog, modules: c.moduleMap,
      systemModules: systemModules(), componentNames: c.componentNames, contextProviders: c.contextProviders,
      policyRegistry: c.policyRegistry, policyProviders: c.policyProviders, relationRegistry: c.relationRegistry, bootSteps: c.bootSteps });
    const admin = await seedAdmin(r, "a@b.co");
    const bob = (await r.run<{ token: string; userId: string }>("auth:signUp", { email: "bob@b.co", password: "pw" })).value;
    await r.run("authz:assignRole", { userId: bob.userId, role: "ra" }, { identity: admin.token });
    await r.run("authz:assignRole", { userId: bob.userId, role: "rb" }, { identity: admin.token });

    const sent: any[] = [];
    const sock = { sent, send: (x: string) => sent.push(JSON.parse(x)), bufferedAmount: 0, close: () => {} };
    r.handler.connect("s1", sock);
    await r.handler.handleMessage("s1", JSON.stringify({ type: "SetAuth", token: bob.token }));
    await r.handler.handleMessage("s1", JSON.stringify({ type: "ModifyQuerySet", add: [
      { queryId: 1, udfPath: "me:canA", args: {} }, { queryId: 2, udfPath: "me:canB", args: {} },
    ], remove: [] }));
    const updates = (qid: number) => sent.flatMap((m) => m.modifications ?? []).filter((x: any) => x.type === "QueryUpdated" && x.queryId === qid);
    expect(updates(1).at(-1)?.value).toBe(true);
    expect(updates(2).at(-1)?.value).toBe(true);
    const before2 = updates(2).length;

    await r.run("authz:revokeRole", { userId: bob.userId, role: "ra" }, { identity: admin.token });
    await new Promise((res) => setTimeout(res, 50));
    expect(updates(1).at(-1)?.value).toBe(false);   // a:read revoked → its subscription re-runs, now false
    expect(updates(2).length).toBe(before2);        // b:read subscription did NOT re-run (its read keys don't intersect the deleted a:read row)
  });
});
```

- [ ] **Step 2: Run — verify it fails**

Run: `bun run --filter @stackbase/authz test effective-permissions`
Expected: FAIL — no boot reconcile; config drift not reflected.

- [ ] **Step 3: Implement `reconcileEffectivePermissions`**

Append to `components/authz/src/effective-permissions.ts`:

```ts
/** Boot/rebuild: if the stored config hash differs from the current config, rebuild the whole index
 *  from role_assignments (reconcile every present (user,scope), drop orphans) and stamp the new hash. */
export async function reconcileEffectivePermissions(ctx: { db: GuestDatabaseWriter }, config: AuthzConfig): Promise<void> {
  const db = ctx.db;
  const metaRows = await db.query("meta", "by_creation").collect();
  const meta = metaRows[0];
  const current = configHash(config);
  if (meta && meta.configHash === current) return; // steady state — nothing changed

  const assigns = await db.query("role_assignments", "by_creation").collect();
  const scopes = new Map<string, { userId: string; scopeType: string; scopeId: string }>();
  for (const a of assigns) {
    const key = `${a.userId as string} ${a.scopeType as string} ${a.scopeId as string}`;
    scopes.set(key, { userId: a.userId as string, scopeType: a.scopeType as string, scopeId: a.scopeId as string });
  }
  // drop effective_permissions for any (user,scope) that no longer has an assignment
  const allEff = await db.query("effective_permissions", "by_creation").collect();
  for (const e of allEff) {
    const key = `${e.userId as string} ${e.scopeType as string} ${e.scopeId as string}`;
    if (!scopes.has(key)) await db.delete(e._id as string);
  }
  for (const s of scopes.values()) await reconcileScope(db, config, s.userId, s.scopeType, s.scopeId);
  if (meta) await db.replace(meta._id as string, { configHash: current });
  else await db.insert("meta", { configHash: current });
}
```

- [ ] **Step 4: Wire `boot` + a gated `rebuild` module**

In `components/authz/src/functions.ts`, add a `rebuild` mutation to the factory (gated by manage — an admin can force a rebuild):

```ts
import { reconcileEffectivePermissions } from "./effective-permissions";
```
Inside `authzModules(config)`, before `return`:

```ts
  const rebuild = mutation(async (ctx) => {
    await (ctx as unknown as WithAuthz).authz.require(MANAGE_PERMISSION);
    await reconcileEffectivePermissions({ db: ctx.db as unknown as GuestDatabaseWriter }, config);
    return null;
  });
```
Return `{ assignRole, revokeRole, rebuild }`.

In `components/authz/src/define-authz.ts`, wire the boot step:

```ts
import { reconcileEffectivePermissions } from "./effective-permissions";
```
Add to the `defineComponent({...})`:

```ts
    boot: (ctx) => reconcileEffectivePermissions(ctx, config),
```

- [ ] **Step 5: Document in `components/authz/README.md`**

Add a short "Effective-permissions index" note near the RBAC section: `can()` is an O(1) indexed point-read backed by a materialized `authz/effective_permissions`; the index is maintained at `assignRole`/`revokeRole`, rebuilt at startup when the roles/permissions config changes (via the component boot hook), and an out-of-band admin bootstrap must seed both `role_assignments` and `effective_permissions` (or run `authz:rebuild`).

- [ ] **Step 6: Run — verify it passes**

Run: `bun run --filter @stackbase/authz test effective-permissions`
Expected: PASS — config-drift rebuild reflects the new permission; the surgical test shows only the affected subscription re-runs.

- [ ] **Step 7: Whole workspace green + commit**

Run: `bun run build && bun run typecheck && bun run test`
Expected: PASS (all prior slices green).

```bash
git add components/authz/src/effective-permissions.ts components/authz/src/functions.ts components/authz/src/define-authz.ts components/authz/README.md components/authz/test/effective-permissions.test.ts
git commit -m "feat(authz): boot reconcile for config drift + authz:rebuild + surgical-invalidation contract"
```

---

## Self-Review (completed by plan author)

**Spec coverage:** §2 decisions → Tasks 1–5. §3 tables → Task 1. §4 patterns/candidateKeys → Task 1. §5 maintenance → Task 3. §6 read path → Task 4. §7 boot reconcile/configHash/rebuild → Task 5. §8 boot seam → Task 2. §9 surgical invalidation → Task 5 test. §10 guards (MAX_PATTERNS) → Task 1; observability note deferred (log line optional). §11 testing → Tasks 1/3/4/5. §12 file structure → matches. §13 out-of-scope → not built. ✅ (One deliberate simplification: the boot rebuild's one-line log in §7/§10 is optional and omitted from the code to avoid a logging dependency — noted, not a gap.)

**Placeholder scan:** No TBD/TODO; every product-code and test step is complete code. Tasks 4/5 spell out the read-path, config-drift, and surgical-invalidation tests verbatim (the surgical test asserts `updates(2).length === before2` — a genuine "did-not-re-run" check, not a value check). Task 4 Step 4's bootstrap-helper edit is a described mechanical change across four named test files (add one `_system:insertDocument` per admin seed), with the exact fields given. ✅

**Type consistency:** `expandRolePatterns`/`candidateKeys`/`configHash` (Task 1) consumed by `upsertPatterns`/`reconcileScope` (Task 3), `can`/`scopesWith` (Task 4), `reconcileEffectivePermissions` (Task 5). `BootContext`/`bootSteps` shape identical across define-component, compose, runtime (Task 2). `authzModules(config)` (Task 3) wired in define-authz; `boot` (Task 5) added to the same `defineComponent`. `effective_permissions` index names (`byLookup`, `byUser`) consistent between schema (Task 1) and all readers/writers. ✅
```
