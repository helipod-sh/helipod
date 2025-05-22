---
title: Component System — Design Spec
status: draft (awaiting review)
date: 2025-05-22
audience: engineering (internal)
---

# Component System — Design Spec

The defining architectural bet for Stackbase: **everything is a component.** The core engine stays
minimal; capabilities (auth, authz, cron, file storage, …) are *components* with their own
namespaced tables, functions, and config. Stackbase ships official components; the community brings
their own (the "WordPress of backends"). The ecosystem — not the core — is the moat.

This reframes the build order: slice 3 is **not "auth"** — it is **the component system, proven with
auth.** Files/cron/authz then become components built on this model.

## 1. Problem this solves

In Convex, `convex-auth` dumps its tables (`authAccounts`, `authSessions`, `authRefreshTokens`, …)
into the **app** component, mixed with the developer's own tables. Auth is not a separable unit — it
pollutes the app's namespace. We want the opposite from day one: auth is its own clean, toggleable,
namespaced component; the app's data view shows only the app's tables.

## 2. Locked decisions (from brainstorming)

1. **Isolation = Hybrid.** Each component owns a separate, namespaced data space; it cannot touch
   app/other components' tables by default. Interop is explicit (declared dependencies + a
   contributed `ctx`; rare direct app-table access is an explicit grant).
2. **Trust = trusted now, sandbox-ready seams.** Self-host "install what you vet"; no enforced
   sandbox yet, but the capability/isolate boundary is designed so true sandboxing can be enforced
   later (the executor already reserves the V8-isolate seam).
3. **Config is authoritative; the dashboard writes back.** A version-controlled config declares
   installed/enabled components; the dashboard toggle edits that config and re-pushes. Secrets are
   env-referenced, never in the config file.
4. **Distribution = npm.** Components are npm packages; a discovery marketplace is a later thin layer
   (a curated index of `stackbase-component`-tagged packages).

## 3. The component model

### 3.1 What a component is

A component is an npm package whose entry exports a definition:

```ts
// @stackbase-community/auth
import { defineComponent } from "@stackbase/component";
import { defineSchema, defineTable, v } from "@stackbase/values";
import * as authFns from "./functions"; // queries/mutations defined with query()/mutation()

export default defineComponent({
  name: "auth",                       // the namespace id (must be unique per deployment)
  schema: defineSchema({              // this component's OWN tables (namespaced)
    accounts: defineTable({ userId: v.string(), provider: v.string(), secret: v.string(), salt: v.string() })
      .index("by_provider", ["provider", "userId"]),
    sessions: defineTable({ userId: v.string(), token: v.string(), expiresAt: v.number() })
      .index("by_token", ["token"]),
  }),
  modules: authFns,                   // path:name → RegisteredFunction (public + internal)
  config: v.object({ sessionTtlSeconds: v.number(), providers: v.array(v.string()) }),
  requires: [],                       // other components this depends on (by name)
  grants: [],                         // app tables this needs (read/write) — rare; auth needs none
  context: buildAuthContext,          // contributes `ctx.auth` to every function (§3.3)
  lifecycle: { onInstall, onEnable, onDisable, onUninstall }, // optional
});
```

Functions are marked **public** (callable by the app + clients, exposed as `api.auth.*`) or
**internal** (component-private). Reuse the existing `query`/`mutation`/`action` + a `visibility`
flag (we already model `visibility` in the manifest).

**v1 contents:** schema, modules, config, requires, grants, context, lifecycle. **Reserved seams
(not built in v1):** HTTP routes, scheduled jobs, custom dashboard panels, per-component client
packages.

### 3.2 Namespacing & the table registry

A table's full identity is **`(componentName, tableName)`**. The existing storage-table-id keyspace
(`MemoryTableRegistry`, user tables from 10001) is extended to allocate ids per `(component, table)`
pair. At load time the engine composes every **enabled** component's schema (plus the app's) into one
registry, namespaced — so two components can both have a `sessions` table without collision. The
on-disk MVCC log is unchanged (it already keys on storage-table-id).

### 3.3 The `ctx`-contribution model (composition direction: App → Component)

The key idea: **a component does not read the app's tables; it contributes a facade to `ctx`.**

- Every function runs with `ctx.db` **scoped to its own component's namespace** (and any granted
  tables). It physically cannot name another component's table — the table resolver only knows its
  own namespace.
- Each **enabled** component contributes a facade via its `context` builder, e.g. auth adds
  `ctx.auth`. The facade's methods execute against the **contributing** component's namespace and the
  current request (e.g. the session token), not the caller's.

So an app function does:

```ts
export const myPrescriptions = query(async (ctx) => {
  const userId = await ctx.auth.getUserId();           // runs in AUTH's namespace, reads its session
  if (!userId) return [];
  return ctx.db.query("prescriptions").withIndex("by_user", q => q.eq("userId", userId)).collect();
});
```

Auth never touches `prescriptions`; the app stores auth's **opaque `userId`** in its own tables and
filters by it. This is exactly the clean separation the screenshot lacks.

### 3.4 The boundary & enforcement (isolate-ready)

Enforcement happens at **two layers**, both built on machinery we already have:

1. **Resolution (primary):** `ctx.db`'s table resolver is scoped to `component.tables ∪ grantedTables`.
   A component literally cannot reference a foreign table through `db`. Cross-component access is only
   through contributed facades, which the providing component exposes and controls.
2. **Write-set audit (defense-in-depth):** the transactor already records each function's write-set by
   storage-table-id. The engine asserts every written table-id ∈ the running component's allowed set;
   a violation aborts the transaction. This same check is the **future isolate capability boundary** —
   in-process now, isolate-enforced later (the trusted-now-sandbox-ready decision).

The component boundary and the reactivity boundary are the **same** boundary (both are table-id sets).

### 3.5 Cross-component reactivity (free)

Because read-sets are table-id-based, a query that calls `ctx.auth.getUserId()` has auth's `sessions`
table in its read-set and **re-runs when the session changes** — cross-component reactivity needs zero
new plumbing.

### 3.6 Dependencies & grants

- `requires: ["auth"]` — authz depends on auth and uses `ctx.auth` / `api.auth.*`. The loader
  topologically orders components and fails fast on a missing/disabled dependency.
- `grants` — the rare case a component needs direct app-table access (e.g. a webhook component reading
  an app table). The component *declares* the need; the **app grants it** in the config
  (`grants: { webhooks: { read: ["orders"] } }`), which widens that component's allowed table set.
  Default is no grants.

### 3.7 Lifecycle

`onInstall` (first add — seed/migrate), `onEnable`/`onDisable` (toggle — disabling keeps the
component's data but unmounts its tables/functions/ctx), `onUninstall` (remove — optionally drop data
after confirmation). Disable is reversible and non-destructive; uninstall is the destructive one.

## 4. Config & secrets

```ts
// stackbase.config.ts  (version-controlled, authoritative)
import { defineConfig } from "@stackbase/cli";
export default defineConfig({
  components: {
    auth: {
      from: "@stackbase-community/auth",
      enabled: true,
      config: { sessionTtlSeconds: 86400, providers: ["password"] },
    },
  },
});
```

Secrets (OAuth client secrets, signing keys) are referenced by env var, never inlined. The dashboard
Components page edits this file (and runs the install) rather than mutating hidden runtime state.

## 5. Distribution

Components are npm packages (`@stackbase-community/<name>`). Install = `pnpm add` + a config entry. A
discovery **marketplace** (ratings/docs over npm packages tagged `stackbase-component`) is a later,
thin layer — not a separate package system.

## 6. Codegen across components

Codegen extends to span components: per-component `Doc`/`Id` types under a component namespace, and a
typed API surface `api.auth.signIn(...)`, `api.<app>.*`. The app's generated `ctx` type includes the
enabled components' contributions (`ctx.auth: AuthContext`). This is additive to the existing codegen.

## 7. Auth — the first component

**v1 surface (fits the current query/mutation model, no Actions needed):**

- **Tables (namespaced under `auth`):** `accounts` (userId, provider, hashed secret, salt),
  `sessions` (userId, token, expiresAt).
- **`ctx.auth`:** `getUserId(): Promise<string | null>` (resolves the request's session token).
- **Public functions (`api.auth.*`):** `signUp(email, password) → token`, `signIn(...) → token`,
  `signOut()`, `getSession()`.
- **Session token:** returned to the client, stored client-side, sent on each request; the engine
  extracts it and `ctx.auth` resolves the session.
- **Password hashing:** `scrypt` via `node:crypto` (works on Node + Bun), salt random per signup. The
  random salt is non-deterministic, but on OCC replay only the committed attempt persists (the same
  pattern as document-id generation); verification uses the *stored* salt → deterministic. Caveat:
  hashing in a mutation blocks the event loop — acceptable for dev; moved to an Action at scale.

**Deferred to a fast-follow (needs Actions, slice 5):** OAuth providers, email verification, password
reset. The component model + `ctx.auth` + sessions land first; these slot in once Actions exist.

## 8. Dashboard "Components" page + component switcher

- **Components page:** lists installed components (from config) with enable/disable toggles and a
  per-component config form (rendered from the component's `config` validator). Toggling edits
  `stackbase.config.ts` and re-pushes.
- **Component switcher:** the data browser's table sidebar gains a component dropdown (the meaningful
  version of Convex's `app` dropdown) — selecting a component scopes the table list to that
  component's namespace. This directly resolves the screenshot's problem.

## 9. Migration

The existing app's tables/functions become the implicit **`app` component** (the default, ungated
namespace). Nothing in `examples/chat` or a user's `convex/` changes; the app is just "component
zero." Components are additive.

## 10. v1 scope & non-goals

**In:** the component model (manifest, namespacing, `ctx` contribution, the resolution + write-set
boundary, dependencies/grants, lifecycle); the config + loader; codegen across components; the **Auth**
component (password + sessions + `ctx.auth`); the dashboard **Components page** + **component
switcher**.

**Out (later slices):** OAuth/email auth (Actions); the marketplace/discovery site; custom dashboard
panels and per-component client SDK packages; runtime install-from-UI beyond config write-back;
authz/cron/files as components (built on the model afterward).

## 11. Build order (high-level — detailed in the implementation plan)

- **C0** — component manifest + namespaced table registry + schema composition.
- **C1** — `ctx` contribution + the resolution/write-set boundary + cross-component reactivity.
- **C2** — config (`stackbase.config.ts`) + the loader (topo-order, enable/disable) + codegen across components.
- **C3** — the **Auth** component (password + sessions + `ctx.auth`), with tests.
- **C4** — the dashboard **Components** page + the component switcher.

## 12. Open decisions & risks

1. **`ctx` token plumbing.** How the request's session token reaches `ctx.auth` (header on the WS/HTTP
   request → into the executor's run context). Needs a concrete `ctx`-building seam in the executor.
   *Lean: extend the executor's `KernelContext` with a per-request `identityToken`, set by the
   sync/HTTP layer.*
2. **Disable vs uninstall data semantics.** *Lean: disable keeps data + unmounts; uninstall prompts
   before dropping.*
3. **Codegen ergonomics** for `api.<component>.*` and the composed `ctx` type — additive but the
   biggest DX surface; worth prototyping early.
4. **One-way-door risk:** the namespacing + boundary are hard to change later. C0/C1 deserve extra
   review before C3/C4 build on them.
