# Authz RBAC Core — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Ship the foundational slice of `@stackbase/authz` per `components/authz/README.md`: a typed RBAC facade `ctx.authz.can/require/roles`, role assignment (`authz:assignRole`/`revokeRole`), composing on `auth` — and **reactive**: revoking a role empties a live subscription that called `ctx.authz.can(...)`.

**Architecture:** One engine prerequisite (**Component→Component facades**: a component's context builder receives the facades of components it `requires`, so `authz` can call `ctx.auth.getUserId()`), then the `@stackbase/authz` component: a `defineAuthz({ permissions, roles })` factory (static role→permission config), an `authz/role_assignments` table, `assignRole`/`revokeRole` mutation modules, and a read-only `ctx.authz` facade computing `can()` from assignments + the config.

**Tech Stack:** TypeScript, Bun/turbo/vitest. Touches `@stackbase/executor` (ComponentContext), `@stackbase/component` (requires validation), and the new `@stackbase/authz` component (`components/authz`).

## Global Constraints

- Reuses the existing component seams: `defineComponent`, namespaced tables (`authz/role_assignments`), `ctx`-contribution (`contextType`/codegen), `requires`. The engine already resolves identity (`ctx.auth`, C3.5a) and is reactive (read-set).
- `ctx.authz` is **read-only** (the facade gets a read-only reader): `can`/`require`/`roles`. **Writes** (`assignRole`/`revokeRole`) are **mutation modules** (`authz:*`), like `auth`'s `signUp`/`signIn` — not facade methods (write-contributing facades are a later slice).
- Roles + permissions are **static config** (`defineAuthz({...})`); role assignments are dynamic data. `can()` computes directly from assignments + config (the `effectivePermissions` pre-flattened index is a later performance slice).
- Scope is `{ type: string; id: string }` (stored as `scopeType`/`scopeId`, `""`/`""` = global). A scoped check also matches global assignments.
- `authz` `requires: ["auth"]`, declared AFTER `auth` in the config (build order = declaration order). The engine validates `requires ⊆ earlier-declared components`.
- **Deferred (per README, later slices):** kernel row-policy enforcement (`read`/`write` policies, WhereInput-merge, count/join gating), relations/sharing, hierarchy, the `effectivePermissions` index, write-contributing facades, typed `ctx.authz` codegen beyond the `contextType` hook.
- Strict TS; ESM.

---

### Task 1: Component→Component facades (engine)

**Files:**
- Modify: `packages/executor/src/executor.ts` (`ComponentContext.components`; thread accumulated facades)
- Test: `packages/executor/test/component-facades.test.ts`

**Interfaces:**
- Produces: `ComponentContext` gains `readonly components: Record<string, unknown>` — the facades of components built *before* this one (i.e. the ones it can compose on). In `run()`'s provider loop, each `build` receives the accumulated prior facades.

- [ ] **Step 1: Write the failing test**
```ts
// packages/executor/test/component-facades.test.ts
import { describe, it, expect } from "vitest";
import { SqliteDocStore, NodeSqliteAdapter } from "@stackbase/docstore-sqlite";
import { MonotonicTimestampOracle } from "@stackbase/docstore";
import { SingleWriterTransactor } from "@stackbase/transactor";
import { QueryRuntime } from "@stackbase/query-engine";
import { InlineUdfExecutor, SimpleIndexCatalog, query, type ContextProvider } from "../src/index";

async function harness() {
  const store = new SqliteDocStore(new NodeSqliteAdapter());
  await store.setupSchema();
  return new InlineUdfExecutor({ transactor: new SingleWriterTransactor(store, new MonotonicTimestampOracle()), queryRuntime: new QueryRuntime(store), catalog: new SimpleIndexCatalog() });
}

describe("Component→Component facades", () => {
  it("a later provider's build receives the facades of earlier providers", async () => {
    const a: ContextProvider = { name: "a", namespace: "a", build: () => ({ hello: () => "world" }) };
    const b: ContextProvider = { name: "b", namespace: "b", build: (cctx) => ({
      viaA: () => (cctx.components.a as { hello(): string }).hello(),
    }) };
    const fn = query(async (ctx) => (ctx as unknown as { b: { viaA(): string } }).b.viaA());
    const r = await (await harness()).run<string>(fn, {}, { contextProviders: [a, b] });
    expect(r.value).toBe("world");
  });
});
```

- [ ] **Step 2: Run test to verify it fails** — `bun run --filter @stackbase/executor test component-facades` → FAIL (`cctx.components` undefined).

- [ ] **Step 3: Write minimal implementation**

In `packages/executor/src/executor.ts`, add to `ComponentContext`:
```ts
  /** Facades of components built before this one (the ones it `requires` / can compose on). */
  readonly components: Record<string, unknown>;
```
In `run()`'s provider loop, accumulate the built facades and pass them into each `build`:
```ts
        const builtFacades: Record<string, unknown> = {};
        for (const p of options.contextProviders ?? []) {
          if (p.name in guestCtx) throw new Error(`context provider "${p.name}" collides with a reserved ctx key`);
          const pctx: KernelContext = { ...kctx, namespace: p.namespace, privileged: false, profile: profileFor("query") };
          const preader = new GuestDatabaseReader(new InlineSyscallChannel(this.router, pctx));
          const facade = Object.freeze(p.build({ db: preader, identity: kctx.identity, now: kctx.now, components: builtFacades }));
          guestCtx[p.name] = facade;
          builtFacades[p.name] = facade;
        }
```
(Providers are consumed in order, so a provider sees only earlier facades — matching `requires` = declared-earlier.)

- [ ] **Step 4: Run test, typecheck, commit** — `bun run --filter @stackbase/executor test` → all pass · `bun run --filter @stackbase/executor exec tsc --noEmit` → clean.
```bash
git add packages/executor/src/executor.ts packages/executor/test/component-facades.test.ts
git commit -m "feat(executor): Component→Component facades — a builder receives earlier components' facades"
```

---

### Task 2: `@stackbase/authz` scaffold + `defineAuthz` + role logic

**Files:**
- Create: `components/authz/package.json`, `tsconfig.json`, `tsup.config.ts`, `src/index.ts`
- Create: `components/authz/src/roles.ts` (pure role→permission logic), `src/schema.ts`, `src/define-authz.ts`
- Modify: `packages/component/src/define-component.ts` (validate `requires`) — actually validate in `composeComponents` (`compose.ts`) where the component set is known
- Test: `components/authz/test/roles.test.ts`

**Interfaces:**
- Produces: `AuthzConfig = { permissions?: Record<string,string[]>; roles?: Record<string, RoleDef> }` where `RoleDef = { inherits?: string | string[] } & Record<string, string[]>`; `roleGrants(config, role, permission): boolean` (expands inheritance + wildcard); `authSchema` (`authz/role_assignments`); `defineAuthz(config): ComponentDefinition` (`name:"authz"`, `requires:["auth"]`, schema, modules [Task 3], context [Task 3], `contextType`).

- [ ] **Step 1: Scaffold** — copy `tsconfig.json`/`tsup.config.ts` from `components/auth/`. `package.json`:
```json
{
  "name": "@stackbase/authz", "version": "0.0.0", "private": true, "type": "module",
  "exports": { ".": { "types": "./dist/index.d.ts", "import": "./dist/index.js" } },
  "main": "./dist/index.js", "types": "./dist/index.d.ts",
  "scripts": { "build": "tsup", "typecheck": "tsc --noEmit", "test": "vitest run" },
  "dependencies": { "@stackbase/auth": "workspace:*", "@stackbase/component": "workspace:*", "@stackbase/errors": "workspace:*", "@stackbase/executor": "workspace:*", "@stackbase/values": "workspace:*" },
  "devDependencies": { "@stackbase/docstore-sqlite": "workspace:*", "@stackbase/runtime-embedded": "workspace:*", "@types/node": "catalog:", "tsup": "catalog:", "typescript": "catalog:", "vitest": "catalog:" }
}
```
Run `bun install`. `src/index.ts`: `export * from "./roles"; export * from "./schema"; export { defineAuthz } from "./define-authz";`

- [ ] **Step 2: Write the failing test** (`components/authz/test/roles.test.ts`):
```ts
import { describe, it, expect } from "vitest";
import { roleGrants, type AuthzConfig } from "../src/roles";

const config: AuthzConfig = {
  permissions: { documents: ["read", "update", "delete"] },
  roles: {
    viewer: { documents: ["read"] },
    editor: { inherits: "viewer", documents: ["update"] },
    admin: { inherits: "editor", documents: ["delete"] },
  },
};

describe("roleGrants", () => {
  it("expands inherited permissions", () => {
    expect(roleGrants(config, "editor", "documents:read")).toBe(true);   // inherited from viewer
    expect(roleGrants(config, "editor", "documents:update")).toBe(true);
    expect(roleGrants(config, "editor", "documents:delete")).toBe(false);
    expect(roleGrants(config, "admin", "documents:read")).toBe(true);    // transitively inherited
  });
  it("honors wildcards", () => {
    expect(roleGrants({ roles: { god: { documents: ["*"] } } }, "god", "documents:delete")).toBe(true);
    expect(roleGrants({ roles: { god: { "*": ["*"] } } }, "god", "billing:manage")).toBe(true);
  });
  it("unknown role or permission grants nothing", () => {
    expect(roleGrants(config, "nope", "documents:read")).toBe(false);
    expect(roleGrants(config, "viewer", "documents:update")).toBe(false);
  });
});
```

- [ ] **Step 3: Run test to verify it fails** — `bun run --filter @stackbase/authz test roles` → FAIL.

- [ ] **Step 4: Implement**

`src/roles.ts`:
```ts
export interface RoleDef { inherits?: string | string[]; [resource: string]: string[] | string | string[] | undefined }
export interface AuthzConfig {
  permissions?: Record<string, string[]>;
  roles?: Record<string, RoleDef>;
}

/** Does `role` (via inheritance) grant `permission` (a "resource:action" string)? Supports `*`. */
export function roleGrants(config: AuthzConfig, role: string, permission: string): boolean {
  const perms = expandRole(config, role, new Set());
  const [res, act] = permission.split(":");
  for (const p of perms) {
    const [pr, pa] = p.split(":");
    if ((pr === res || pr === "*") && (pa === act || pa === "*")) return true;
  }
  return false;
}

function expandRole(config: AuthzConfig, role: string, seen: Set<string>): Set<string> {
  const out = new Set<string>();
  const def = config.roles?.[role];
  if (!def || seen.has(role)) return out;
  seen.add(role);
  const inherits = def.inherits ? (Array.isArray(def.inherits) ? def.inherits : [def.inherits]) : [];
  for (const parent of inherits) for (const p of expandRole(config, parent, seen)) out.add(p);
  for (const [resource, actions] of Object.entries(def)) {
    if (resource === "inherits" || !Array.isArray(actions)) continue;
    for (const action of actions) out.add(`${resource}:${action}`);
  }
  return out;
}
```
`src/schema.ts`:
```ts
import { defineSchema, defineTable, v } from "@stackbase/values";
export const authzSchema = defineSchema({
  role_assignments: defineTable({
    userId: v.string(), role: v.string(), scopeType: v.string(), scopeId: v.string(),
  }).index("byUserScope", ["userId", "scopeType", "scopeId"]).index("byUser", ["userId"]),
});
```
`src/define-authz.ts` (context/modules filled in Task 3 — for now a stub that compiles):
```ts
import { defineComponent, type ComponentDefinition } from "@stackbase/component";
import { authzSchema } from "./schema";
import type { AuthzConfig } from "./roles";
// authzContext + modules imported in Task 3
export function defineAuthz(config: AuthzConfig): ComponentDefinition {
  return defineComponent({
    name: "authz",
    requires: ["auth"],
    schema: authzSchema,
    modules: {},                 // Task 3: assignRole, revokeRole
    // context: (cctx) => authzContext(cctx, config),   // Task 3
    // contextType: { import: "@stackbase/authz", type: "AuthzContext" },  // Task 3
  });
}
```
In `packages/component/src/compose.ts` `composeComponents` (or a helper it calls), after building the component-name set, validate requires:
```ts
const names = new Set(components.map((c) => c.name));
for (const c of components) for (const req of c.requires ?? []) {
  if (!names.has(req)) throw new Error(`component "${c.name}" requires "${req}", which is not enabled`);
}
```

- [ ] **Step 5: Run test, typecheck, commit** — `bun run --filter @stackbase/authz test` + `bun run --filter @stackbase/component test` pass · both tsc clean.
```bash
git add components/authz packages/component/src/compose.ts
git commit -m "feat(authz): scaffold @stackbase/authz + roleGrants + schema + defineAuthz; validate requires"
```

---

### Task 3: `ctx.authz` facade + `assignRole`/`revokeRole`

**Files:**
- Create: `components/authz/src/context.ts` (`AuthzContext` + `authzContext`), `src/functions.ts` (`assignRole`, `revokeRole`)
- Modify: `components/authz/src/define-authz.ts` (wire `context`, `modules`, `contextType`), `src/index.ts` (export `AuthzContext`)
- Test: `components/authz/test/rbac.test.ts`

**Interfaces:**
- Produces: `interface AuthzContext { can(permission: string, scope?: { type: string; id: string }): Promise<boolean>; require(permission: string, scope?): Promise<void>; roles(scope?): Promise<string[]> }`; `authz:assignRole({ userId, role, scope? })` + `authz:revokeRole({ userId, role, scope? })` mutations.

- [ ] **Step 1: Write the failing test** (`components/authz/test/rbac.test.ts`):
```ts
import { describe, it, expect } from "vitest";
import { SqliteDocStore, NodeSqliteAdapter } from "@stackbase/docstore-sqlite";
import { composeComponents } from "@stackbase/component";
import { EmbeddedRuntime } from "@stackbase/runtime-embedded";
import { defineSchema } from "@stackbase/values";
import { query } from "@stackbase/executor";
import { auth } from "@stackbase/auth";
import { defineAuthz } from "../src/define-authz";

const authz = defineAuthz({ roles: { editor: { documents: ["read", "update"] } } });

async function makeRuntime() {
  const app = { "me:canEdit": query(async (ctx) => (ctx as unknown as { authz: { can(p: string): Promise<boolean> } }).authz.can("documents:update")) };
  const { catalog, moduleMap, componentNames, contextProviders } = composeComponents(
    { schemaJson: defineSchema({}).export(), moduleMap: app }, [auth, authz]);
  return EmbeddedRuntime.create({ store: new SqliteDocStore(new NodeSqliteAdapter()), catalog, modules: moduleMap, componentNames, contextProviders });
}

describe("authz RBAC", () => {
  it("assignRole grants a permission; revokeRole removes it; anonymous is denied", async () => {
    const r = await makeRuntime();
    const { token, userId } = (await r.run<{ token: string; userId: string }>("auth:signUp", { email: "a@b.co", password: "pw" })).value;
    expect((await r.run<boolean>("me:canEdit", {}, { identity: token })).value).toBe(false); // no role
    await r.run("authz:assignRole", { userId, role: "editor" });
    expect((await r.run<boolean>("me:canEdit", {}, { identity: token })).value).toBe(true);
    await r.run("authz:revokeRole", { userId, role: "editor" });
    expect((await r.run<boolean>("me:canEdit", {}, { identity: token })).value).toBe(false);
    expect((await r.run<boolean>("me:canEdit", {}).valueOf ? await r.run<boolean>("me:canEdit", {}) : { value: false }).value).toBe(false); // anonymous
  });
});
```
(If the anonymous line is awkward, assert `(await r.run("me:canEdit", {})).value === false` on its own.)

- [ ] **Step 2: Run test to verify it fails** — `bun run --filter @stackbase/authz test rbac` → FAIL.

- [ ] **Step 3: Implement**

`src/context.ts`:
```ts
import type { ComponentContext } from "@stackbase/executor";
import { roleGrants, type AuthzConfig } from "./roles";

export interface AuthzContext {
  can(permission: string, scope?: { type: string; id: string }): Promise<boolean>;
  require(permission: string, scope?: { type: string; id: string }): Promise<void>;
  roles(scope?: { type: string; id: string }): Promise<string[]>;
}

interface AuthFacade { getUserId(): Promise<string | null> }

export function authzContext(cctx: ComponentContext, config: AuthzConfig): AuthzContext {
  const auth = cctx.components.auth as AuthFacade | undefined;
  async function assignedRoles(scope?: { type: string; id: string }): Promise<string[]> {
    const uid = auth ? await auth.getUserId() : null;
    if (!uid) return [];
    const rows = await cctx.db.query("role_assignments", "byUser").eq("userId", uid).collect();
    const st = scope?.type ?? "", si = scope?.id ?? "";
    return rows
      .filter((r) => (r.scopeType === "" && r.scopeId === "") || (r.scopeType === st && r.scopeId === si)) // global OR the scope
      .map((r) => r.role as string);
  }
  return {
    async can(permission, scope) {
      for (const role of await assignedRoles(scope)) if (roleGrants(config, role, permission)) return true;
      return false;
    },
    async require(permission, scope) {
      if (!(await this.can(permission, scope))) throw new Error(`Forbidden: ${permission}`);
    },
    async roles(scope) { return assignedRoles(scope); },
  };
}
```
`src/functions.ts`:
```ts
import { mutation } from "@stackbase/executor";

interface Assign { userId: string; role: string; scope?: { type: string; id: string } }
export const assignRole = mutation(async (ctx, { userId, role, scope }: Assign) => {
  const st = scope?.type ?? "", si = scope?.id ?? "";
  const existing = await ctx.db.query("role_assignments", "byUserScope").eq("userId", userId).eq("scopeType", st).eq("scopeId", si).collect();
  if (existing.some((r) => r.role === role)) return null; // idempotent
  await ctx.db.insert("role_assignments", { userId, role, scopeType: st, scopeId: si });
  return null;
});
export const revokeRole = mutation(async (ctx, { userId, role, scope }: Assign) => {
  const st = scope?.type ?? "", si = scope?.id ?? "";
  const rows = await ctx.db.query("role_assignments", "byUserScope").eq("userId", userId).eq("scopeType", st).eq("scopeId", si).collect();
  for (const r of rows) if (r.role === role) await ctx.db.delete(r._id as string);
  return null;
});
```
Wire `define-authz.ts`:
```ts
import { authzContext } from "./context";
import { assignRole, revokeRole } from "./functions";
// ... in defineComponent:
    modules: { assignRole, revokeRole },
    context: (cctx) => authzContext(cctx, config),
    contextType: { import: "@stackbase/authz", type: "AuthzContext" },
```
`src/index.ts`: add `export type { AuthzContext } from "./context";`

- [ ] **Step 4: Run test, typecheck, commit** — `bun run --filter @stackbase/authz test` pass · tsc clean.
```bash
git add components/authz/src components/authz/test/rbac.test.ts
git commit -m "feat(authz): ctx.authz.can/require/roles facade + assignRole/revokeRole (composes on ctx.auth)"
```

---

### Task 4: Reactive contract test

**Files:**
- Test: `components/authz/test/reactive.test.ts`

**Interfaces:** consumes the runtime + sync handler (mirror `components/auth/test/auth-reactive.test.ts`).

- [ ] **Step 1: Write the failing test** — a subscribed `me:canEdit` query re-runs and flips when a role is assigned/revoked:
```ts
// components/authz/test/reactive.test.ts
import { describe, it, expect } from "vitest";
import { SqliteDocStore, NodeSqliteAdapter } from "@stackbase/docstore-sqlite";
import { composeComponents } from "@stackbase/component";
import { EmbeddedRuntime } from "@stackbase/runtime-embedded";
import { defineSchema } from "@stackbase/values";
import { query } from "@stackbase/executor";
import { auth } from "@stackbase/auth";
import { defineAuthz } from "../src/define-authz";

function mockSocket() { const sent: any[] = []; return { sent, send: (d: string) => sent.push(JSON.parse(d)), bufferedAmount: 0, close: () => {} }; }
const lastQueryValue = (sock: { sent: any[] }, queryId: number): unknown => {
  for (let i = sock.sent.length - 1; i >= 0; i--) { const m = [...(sock.sent[i]?.modifications ?? [])].reverse().find((x: any) => x.type === "QueryUpdated" && x.queryId === queryId); if (m) return m.value; }
  return undefined;
};
const authz = defineAuthz({ roles: { editor: { documents: ["update"] } } });

describe("authz reactivity", () => {
  it("a subscribed can()-query re-runs when a role is assigned and revoked", async () => {
    const app = { "me:canEdit": query(async (ctx) => (ctx as unknown as { authz: { can(p: string): Promise<boolean> } }).authz.can("documents:update")) };
    const { catalog, moduleMap, componentNames, contextProviders } = composeComponents({ schemaJson: defineSchema({}).export(), moduleMap: app }, [auth, authz]);
    const r = await EmbeddedRuntime.create({ store: new SqliteDocStore(new NodeSqliteAdapter()), catalog, modules: moduleMap, componentNames, contextProviders });
    const { token, userId } = (await r.run<{ token: string; userId: string }>("auth:signUp", { email: "a@b.co", password: "pw" })).value;

    const sock = mockSocket();
    r.handler.connect("s1", sock, token);   // authenticated at connect (C3.5c-2 connect identity)
    await r.handler.handleMessage("s1", JSON.stringify({ type: "ModifyQuerySet", add: [{ queryId: 1, udfPath: "me:canEdit", args: {} }], remove: [] }));
    expect(lastQueryValue(sock, 1)).toBe(false);

    await r.run("authz:assignRole", { userId, role: "editor" });      // grant → subscription re-runs
    await new Promise((res) => setTimeout(res, 10));
    expect(lastQueryValue(sock, 1)).toBe(true);

    await r.run("authz:revokeRole", { userId, role: "editor" });      // revoke → subscription re-runs (the headline)
    await new Promise((res) => setTimeout(res, 10));
    expect(lastQueryValue(sock, 1)).toBe(false);
  });
});
```
(If `handler.connect(sessionId, socket, identity)` — the connect-time identity — is not present in this build, use `SetAuth` instead: `handleMessage("s1", JSON.stringify({ type: "SetAuth", token }))` before the ModifyQuerySet. Check `packages/sync/src/handler.ts`.)

- [ ] **Step 2: Run test to verify it fails** — before Tasks 1–3 land it fails; after, confirm it PASSES (the reactive contract).

- [ ] **Step 3: Run full slice + workspace**
- `bun run --filter @stackbase/authz test` → all authz tests pass (roles, rbac, reactive).
- `bun run --filter @stackbase/authz exec tsc --noEmit` → clean.
- `bun run build && bun run typecheck && bun run test` from repo root → whole workspace green.

- [ ] **Step 4: Commit**
```bash
git add components/authz/test/reactive.test.ts
git commit -m "test(authz): reactive contract — a subscribed can()-query flips on assignRole/revokeRole"
```

---

## Self-Review

**Spec coverage (against `components/authz/README.md` Layer 1–2 core):**
- Typed permission/role config (`defineAuthz`, `roleGrants` with inheritance + wildcard) — Task 2. ✅
- `ctx.authz.can/require/roles` composing on `ctx.auth` (Component→Component facades) — Tasks 1, 3. ✅
- Role assignment (`authz:assignRole`/`revokeRole`), scoped (global + scope match) — Task 3. ✅
- **Reactive revocation** (a subscribed `can()` query empties when the role is revoked) — Task 4 (the README's headline guarantee). ✅
- **Out of scope (later README slices):** kernel row-policy enforcement (`read`/`write` policies, WhereInput-merge, count/join gating); relations/sharing; hierarchy; the `effectivePermissions` pre-flattened index (can() computes live); write-contributing facades (`ctx.authz.assignRole` — assignment is a module mutation for now); typed `ctx.authz` codegen beyond the `contextType` hook.

**Placeholder scan:** none — runnable code/commands. The Task 4 note ("if `connect(…, identity)` absent, use `SetAuth`") directs the implementer to check the real handler signature.

**Type consistency:** `AuthzConfig`/`roleGrants` (Task 2) consumed by `authzContext` (Task 3); `ComponentContext.components` (Task 1) read by `authzContext` as `cctx.components.auth`; `defineAuthz` (Task 2) wires `authzContext` + `assignRole`/`revokeRole` (Task 3); the reactive test (Task 4) exercises all of it through the runtime + sync handler.
