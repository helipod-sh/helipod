# @stackbase/authz

**Reactive, typed authorization for Stackbase.** One model that scales from a two-line ownership rule to multi-tenant SaaS with sharing and hierarchies — enforced *inside the engine* so you can't forget a check, and reactive *by construction* so revoking access empties live subscriptions instantly.

> **Status: design target (this README is the spec).** This document describes the complete intended API and behavior. The component is built to match it, layer by layer (see [Build order](#build-order)). The design rationale — why this model beats RBAC-only, Postgres RLS, OpenFGA/Zanzibar, and SpiceDB for a *reactive* backend — is in [`docs/research.md`](./docs/research.md).

---

## Why authz is different here

Most authorization is bolted on: a library you call (and forget to call), a database feature that only your DB enforces, or a separate service you sync to. Stackbase authz is **none of those**. It is:

- **Reactive by construction.** A permission check *reads* authorization data, and Stackbase tracks every query's read-set. So when you revoke a role or unshare a document, every affected live query **re-runs and updates in the same instant** — no cache invalidation, no polling, no refetch. No other authorization model gives you this, because none of them runs *inside* a reactive engine.
- **O(1) on the hot path.** Roles, relationships, and hierarchies are *flattened into an indexed table at write time*, so a permission check is a single indexed point-read — not a graph traversal. The thing that runs on every request is the cheapest thing in the system.
- **Engine-enforced, can't-forget.** Row policies run at the `ctx.db` kernel seam, so *every* read — including joins and counts — is filtered, and *every* write is checked. A function that forgets to authorize still cannot leak data.
- **One TypeScript model, no DSL.** Permissions, roles, conditions, and relationships are all plain typed TypeScript. A typo'd permission is a *compile error*. No `.fga`/`.zed` schema, no CEL, no SQL `CREATE POLICY`. It's fully typed end-to-end through codegen.
- **A complexity ladder.** The simple case is two lines. Roles, tenancy, sharing, and hierarchy are each opt-in and appear only when an app needs them — the same model the whole way up, with no paradigm migration.

See the full, unbiased comparison and the con-by-con engineering analysis in [`docs/research.md`](./docs/research.md).

---

## Install & enable

`@stackbase/authz` is a Stackbase component. Add it to your project's `stackbase.config.ts`:

```ts
// stackbase.config.ts
import { defineConfig } from "@stackbase/component";
import { auth } from "@stackbase/auth";
import { authz } from "./authz.config";

export default defineConfig({ components: [auth, authz] });
```

`authz` requires `auth` (it uses `ctx.auth.getUserId()` as the identity anchor). The engine wires `ctx.authz` into every function and auto-enforces your row policies; the dashboard gains an Authorization page for roles, assignments, and grants.

---

## Quickstart

The smallest useful authz is one rule — "a user sees only their own rows":

```ts
// authz.config.ts
import { defineAuthz } from "@stackbase/authz";

export const authz = defineAuthz({
  policies: {
    documents: {
      // READ rules return a query predicate, AND-merged into every read of `documents`.
      read: ({ auth }) => ({ ownerId: auth.userId }),
      // WRITE rules check the row being written and return true/false.
      write: ({ auth }, doc) => doc.ownerId === auth.userId,
    },
  },
});
```

That's it. Now **every** query on `documents` — including ones that forgot to filter, and including `documents` hydrated through a join — returns only rows the caller owns, and any write to a `documents` row the caller doesn't own throws `Forbidden`. And it's reactive: if you later change `ownerId`, every subscriber's view updates live.

```ts
// convex/documents.ts — no manual authz call needed; the policy is enforced by the engine
export const list = query(async (ctx) => ctx.db.query("documents").collect()); // already filtered
```

Need an explicit check (e.g. to gate a mutation by capability)? Use the typed `ctx.authz` facade:

```ts
export const remove = mutation(async (ctx, { id }) => {
  const doc = await ctx.db.get(id);
  await ctx.authz.require("documents:delete", { org: doc.orgId }); // throws Forbidden if denied
  await ctx.db.delete(id);
});
```

---

## Mental model (three ideas)

1. **Authorization is application data.** Roles, grants, and relationships are rows in namespaced `authz/*` tables. There is no separate policy engine — authz *is* data in the same MVCC store as everything else.
2. **A permission check is a data read.** `ctx.authz.can(...)` is a single indexed point-read against a pre-computed `authz/effective_permissions` index; a row policy is a predicate merged into a query. Because checks read data, they enter the read-set, so they are reactive for free.
3. **Enforcement lives at the engine, not the call site.** Row policies are applied in the kernel's `ctx.db` path (the same seam that enforces component namespacing). You declare rules once at the data layer; you cannot forget them at a call site, and joins/counts can't slip past them.

---

## The complexity ladder

The same model covers every project type. Adopt only the layer you need.

### Level 0 — Ownership (row policies)

```ts
defineAuthz({
  policies: {
    todos: {
      read:  ({ auth }) => ({ userId: auth.userId }),
      write: ({ auth }, row) => row.userId === auth.userId,
    },
  },
});
```

### Level 1 — Roles & permissions

Declare a typed permission vocabulary and roles as named permission sets (with inheritance):

```ts
defineAuthz({
  permissions: {
    documents: ["read", "update", "delete", "share"],
    billing:   ["view", "manage"],
  },
  roles: {
    viewer: { documents: ["read"] },
    editor: { inherits: "viewer", documents: ["update"] },
    admin:  { inherits: "editor", documents: ["delete", "share"], billing: ["view", "manage"] },
  },
  policies: {
    documents: {
      read:  ({ auth }) => auth.can("documents:read"),          // a role grants the permission
      write: ({ auth }, doc) => auth.can("documents:update"),
    },
  },
});
```

Assign roles at runtime (in a mutation, or from the dashboard):

```ts
export const promote = mutation(async (ctx, { userId }) => {
  await ctx.authz.require("billing:manage");
  await ctx.authz.assignRole(userId, "editor");
});
```

`permissions` produce string-literal types: `auth.can("documents:reed")` is a **compile error**.

### Level 2 — Multi-tenant scopes

A role is granted *within a scope*. The scope becomes part of the index key, so tenant isolation is **structural**, not a remembered `WHERE`:

```ts
await ctx.authz.assignRole(userId, "admin", { type: "org", id: orgId });

// check is scoped:
await ctx.authz.require("documents:delete", { org: doc.orgId });
```

In a read policy, "documents in any org where I can read" is expressed with `auth.scopesWith(...)`, which resolves (from the effective-permissions index) the set of scope ids where the caller holds a permission:

```ts
policies: {
  documents: {
    read: ({ auth }) => ({ orgId: { in: auth.scopesWith("documents:read", "org") } }),
  },
}
```

### Level 3 — Per-resource sharing (relations)

Share a single resource with a single user/team via relationship rows, and express visibility with a **relation predicate** (reactive: a write to the related table re-runs the subscription):

```ts
// share
await ctx.authz.addRelation(userId, "viewer", { type: "document", id: docId });

// policy: I can read a doc I own OR a doc shared with me OR my team
policies: {
  documents: {
    read: ({ auth }) => ({
      OR: [
        { ownerId: auth.userId },
        { sharedWith: { some: { userId: auth.userId } } },        // direct share
        { sharedWith: { some: { team: { is: { members: { some: { userId: auth.userId } } } } } } }, // team share
      ],
    }),
  },
}
```

### Level 4 — Hierarchy (opt-in arrow traversal)

For folder→doc / recursive structures, declare inherited relations. The engine compiles these to **write-time closure expansion**, so checks stay O(1) (no read-time graph walk):

```ts
defineAuthz({
  relations: {
    folder: { viewer: ["user", "folder#viewer"] },          // a folder's viewer can be inherited from its parent folder
    document: { viewer: ["user", "folder#viewer from parent"] }, // a doc inherits its folder's viewers
  },
});
```

Apps that declare no arrow relations pay zero overhead — the traversal compiler is a no-op.

---

## Feature reference

### Permissions

`permissions: { resource: [action, ...] }` defines the authorization vocabulary. Codegen emits `"resource:action"` string-literal types consumed by `auth.can`, `ctx.authz.can/require`, role declarations, and grants — so every permission reference is type-checked and a typo is a compile error. Supports **wildcards**: `"documents:*"` (all actions on documents).

### Roles

`roles: { name: { inherits?, ...permissionSets } }`. A role is a typed subset of the permission registry. `inherits` composes roles (single or array). Roles are resolved/unioned at assignment time and flattened into the effective-permissions index. Unknown/undeclared roles grant nothing (**fails closed**).

### Row policies

`policies: { table: { read?, write? } }` — declared per app table.

- **`read(ctx)` → `WhereInput | true | false`** — returns a query predicate that is **AND-merged into every read** of the table (`get`, `query`, `collect`, paginate, and hydrated joins). `true` = unrestricted; `false` = deny (zero rows); returning nothing = no restriction added by this policy.
- **`write(ctx, row)` → `boolean | Promise<boolean>`** — receives the candidate row (on insert) or pre-write row (on update/delete) and returns allow/deny; `false`/throw → `Forbidden`. **Write rules may call `ctx.db`** to resolve relationships (e.g. "is the caller a member of the row's org?"), and those reads join the transaction.

**Policy-author notes:**

1. **Write policies gate both images on replace.** Insert checks the new row; replace checks **both** the existing row (you may modify it) **and** the resulting row (so you can't reassign it out of your own visibility); delete checks the existing row. This means a write rule like `row.ownerId === auth.userId` blocks an ownership reassignment even if the caller currently owns the document.
2. **`scopesWith` returns scoped grants only, not global ones.** Pair it with a preceding `auth.can(permission)` check — a global grant makes `can` true and means unrestricted access — e.g. `auth.can("documents:read") ? true : { orgId: { in: await auth.scopesWith("documents:read") } }`.
3. **`isNull: true` matches an explicit `null`, not a missing field.** A missing field is `undefined` in the document value, which is distinct from `null` — only explicit `null` values stored on a field match `{ field: { isNull: true } }`.

**Rule context** (`ctx`): `auth.userId` (the resolved caller, `null` if anonymous), `auth.roles`, `auth.can(permission, scope?)`, `auth.scopesWith(permission, type?)`, `auth.identity` (raw claims), and `db` (a read-only `ctx.db` for relation lookups).

**Predicate operators** (in `WhereInput`): field operators `eq` (bare value), `ne`, `in`, `notIn`, `lt`, `lte`, `gt`, `gte`, `isNull`; logical `AND` / `OR` / `NOT`; **relation predicates** `is` / `isNot` (to-one), `some` / `none` / `every` (to-many). All fully typed against `Doc<T>`.

**Relation predicates (`some` / `is`).** A read policy can filter by related rows:
- `{ sharedWith: { some: { userId: auth.userId } } }` — to-many: a row in the related
  child table names the caller. Declare the relation on the table:
  `defineTable({...}).relation("sharedWith", { table: "document_shares", field: "documentId" })`.
- `{ orgId: { is: { ownerId: auth.userId } } }` — to-one: follow a `v.id` field to its row
  and test it (no declaration needed).

Both are **reactive** — a write to the related table live-updates the subscription — and the leaf
of a relation clause may itself contain relation clauses (multi-level chains, see below). Performance
note: v1 scans the related table per clause; declaring an index on the child's filtered field is
recommended and will be used once index push-down lands.

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

Two things to know when authoring relation predicates:

- **The relation lookup ignores the related table's own read policy — by intent.** The semi-join
  reads *all* rows of the child/target table to decide the parent's visibility, so a `read` policy on
  `document_shares` does **not** hide share rows from the resolver. The authorization decision is made
  from the true data, not the caller's filtered view (otherwise a user could be denied a resource they
  were actually granted). Only the id-set is used — child rows are never returned to the caller.
- **`NOT` over a relation clause is an anti-join.** `{ NOT: { sharedWith: { some: { userId: auth.userId } } } }`
  reads as "rows *not* shared with me" — a valid but easy-to-misread negation. Prefer expressing
  visibility positively (an `OR` of the ways a row *is* visible) and reach for `NOT` deliberately.

### Scoped role assignment

`ctx.authz.assignRole(userId, role, scope?)` / `revokeRole(userId, role, scope?)`. `scope` is `{ type: string, id: string }` (e.g. `{ type: "org", id }`); omitted = global. The scope is the leading component of the effective-permissions index key, making cross-tenant isolation structural. `auth.scopesWith(permission, type?)` returns the scope ids where the caller holds a permission (for read predicates).

**Managing roles is itself a permission.** `assignRole`/`revokeRole` require the caller to hold `authz:manage` **in the target scope** (grant it through a role, e.g. `admin: { authz: ["manage"] }`) — so role management can't be used to escalate privilege, and a scope admin can only grant within their own scope. An explicit `scope` must have a non-empty `type` and `id`; `""` is reserved for the global scope (omit `scope` for global).

**Bootstrapping the first admin.** There is deliberately no ungated path to the first role. Seed it out-of-band through the privileged admin surface (the `stackbase` CLI / admin API / dashboard), which writes the first `admin` assignment directly — e.g. `runSystem("_system:insertDocument", { table: "authz/role_assignments", fields: { userId, role: "admin", scopeType: "", scopeId: "" } })`. From then on, that admin manages everyone else through the gated mutations.

### Relations & sharing

`ctx.authz.addRelation(subject, relation, object)` / `removeRelation(...)` / `hasRelation(subject, relation, object)`. `subject` is a user (`userId`) or a **userset** (`"team:eng#member"` — group membership, propagates with zero per-member writes). Per-resource sharing is one relation row; revoke is one delete. Relation predicates in read policies make sharing reactive via child-table read-dependencies.

### Overrides & negation

`ctx.authz.grantPermission(userId, permission, scope?)` / `denyPermission(...)` for exceptions without proliferating roles. **Deny wins** over any grant. Grants accept an optional `expiresAt` for temporal access; expired grants are ignored (and a sweep prunes them).

### Wildcards & anonymous

`"documents:*"` (family-wide permission), `"user:*"` / a `public: true` flag on a relation (anonymous/public access). Anonymous callers (`auth.userId === null`) are handled explicitly by policies — there is no implicit allow.

### The `ctx.authz` facade

Available in every query/mutation (typed via codegen):

| Method | Purpose |
|---|---|
| `can(permission, scope?)` → `Promise<boolean>` | capability check (O(1) indexed read) |
| `require(permission, scope?)` → `Promise<void>` | throws `Forbidden` if denied |
| `canAny(permissions[], scope?)` / `canAll(...)` | combinator checks |
| `roles(scope?)` → `Promise<string[]>` | the caller's roles in a scope |
| `assignRole` / `revokeRole` | mutate role assignments |
| `addRelation` / `removeRelation` / `hasRelation` | mutate/inspect relationships |
| `grantPermission` / `denyPermission` | overrides |
| `deprovisionUser(userId)` | remove all of a user's assignments/relations/grants in one call |

### The `effectivePermissions` index (how O(1) works)

`assignRole` / `addRelation` / `grant` calls **expand at write time** into an `authz/effective_permissions` index keyed `[scopeKey, userId, permission]`. A `can(...)` check is then a single indexed point-read → exactly one read-set entry → surgical invalidation when that exact row changes. Expansion runs inside the *same* mutation transaction (so it can't drift), is bounded by the declared relation graph, and is observable (logged, with a max-expansion guard).

### Engine enforcement

- **Default-ON.** Any table with a declared policy is auto-gated on every `ctx.db` op. You opt *out* explicitly (`ctx.db.unsafe(...)` for intentional admin bypass), and an **uncovered-table advisor** warns about tables that hold data but declare no policy.
- **Deny-by-default** for declared-but-unmatched policies.
- **Joins are gated.** Hydrated/included relations are filtered by the child table's own read policy — an `include` cannot over-expose.
- **`count` is correct, not leaky.** Counts run *through* the read predicate (count of *visible* rows), so they never reveal the size of hidden data.

---

## Reactivity

Authorization participates in the reactive loop with no special-casing:

- A subscribed query whose policy reads `authz/*` data (a role, a grant, a relation) has those rows in its read-set. **Revoke the role / remove the share → the exact effective-permissions row changes → the subscription re-runs and the now-forbidden rows disappear, live.**
- Identity is taken from the connection's authenticated session (`ctx.auth`), so signing out also re-evaluates every authorization-dependent subscription.
- Because checks are indexed point-reads (not table scans or graph walks), invalidation is **surgical** — only the queries that depended on the *specific* changed permission re-run.

**Non-reactive escape hatch:** "list every resource a user can access" (a reverse query / admin home-screen) is an explicit, paginated, **non-reactive administrative API** (`ctx.authz.listAccessible(...)`) — never placed on the per-request reactive path, to avoid unbounded read-set fan-out.

---

## Multi-tenancy

Scopes are the tenancy primitive. Assign roles within `{ type: "org", id }`; the scope is the leading index key, so a tenant A assignment can *never* satisfy a tenant B check. Codegen can enforce that tenant-scoped tables carry a tenant key. A typical pattern:

```ts
policies: {
  invoices: {
    read:  ({ auth }) => ({ orgId: { in: auth.scopesWith("invoices:read", "org") } }),
    write: ({ auth }, inv) => auth.can("invoices:write", { org: inv.orgId }),
  },
}
```

---

## Testing

Policies and permission logic are **pure functions**, testable in isolation with vitest — mirroring production evaluation:

```ts
import { expectPolicy } from "@stackbase/authz/testing";

test("owners read their docs; others don't", () => {
  expectPolicy(authz).as({ userId: "alice" }).read("documents")
    .matches({ ownerId: "alice", title: "x" })
    .rejects({ ownerId: "bob", title: "y" });
});

test("revoking a role removes the permission", async () => {
  // integration: assert a live subscription empties when the role is revoked (reactive contract)
});
```

The contract test suite asserts: (a) `can` is true after `assignRole`; (b) a subscribed query re-runs and empties when the role is revoked; (c) invalidation is exactly the affected `[scope, user, permission]` row; (d) policies behave identically on the SQLite and Postgres adapters.

---

## Performance & the write-time contract

The model is **read-optimized**: it pre-materializes effective permissions so the *check* (which runs constantly and re-runs on every invalidation) is O(1). The cost moves to *writes* (granting/revoking/re-parenting), which are rare. That cost is contained:

- **Bounded** by the declared relation graph (no unbounded expansion).
- **Transactional** with the originating mutation for the common case (so no drift).
- **Async-with-a-pending-marker** above a configurable threshold for pathological bulk changes (e.g. re-parenting a folder with 10k descendants), so expansion never blocks the single writer.

This is the deliberate, correct trade for a reactive backend — and it is stated plainly because there are no hidden costs.

---

## Security model

- **Deny-by-default**: no policy match → no access.
- **Can't-forget**: engine enforcement at the `ctx.db` seam; missing a manual check cannot leak data.
- **No size leaks**: count-through-predicate; gated joins; no hidden-row enumeration.
- **Drift-proof**: effective-permissions expansion is transactional with its source write.
- **Fails closed**: unknown roles/permissions grant nothing; anonymous is explicit.
- **Auditable**: an `authz/audit_log` records assignments, grants, revocations, and denials.

---

## Architecture

- **Namespaced tables** (owned by the component, isolated by the engine boundary): `authz/roles`, `authz/role_assignments`, `authz/relations`, `authz/grants`, `authz/effective_permissions` (the index), `authz/audit_log`.
- **Composition**: `requires: ["auth"]`; uses `ctx.auth.getUserId()` for identity. Contributes a typed `ctx.authz` facade via the component `contextType`/codegen path.
- **Enforcement seam**: row policies hook the executor kernel's `ctx.db` read/write path (the same seam that enforces component namespacing and ownership), so enforcement is adapter-agnostic and reactive by default.
- **Adapter-neutral**: all logic is TypeScript over the `DatabaseAdapter` interface; identical on SQLite and Postgres. No DB-specific authorization.

---

## Comparison (at a glance)

| | Stackbase authz | OpenFGA / SpiceDB (ReBAC) | Supabase RLS | Plain function checks |
|---|---|---|---|---|
| Reactive (live revocation) | ✅ by construction | ❌ out-of-process check | ❌ DB can't notify | ⚠️ only if you read authz data |
| Check cost | O(1) indexed read | graph traversal | row predicate | varies |
| Can't-forget | ✅ engine-enforced | ⚠️ guard call | ✅ DB-enforced (but Postgres-only) | ❌ |
| Language | TypeScript (typed) | DSL + CEL | SQL | TypeScript |
| Works on SQLite + Postgres | ✅ | n/a (separate service) | ❌ Postgres-only | ✅ |
| Expressiveness | ownership→roles→sharing→hierarchy | maximal (relationships) | predicates only | arbitrary |

Full analysis, scorecard, and the con-by-con engineering teardown: [`docs/research.md`](./docs/research.md).

---

## Build order

The component ships as a complexity ladder; each layer is a working slice with its own tests.

1. **Layer 1 — row policies + engine enforcement** (the foundation): `read` (WhereInput-merged) / `write` (candidate-row) policies, the kernel `ctx.db` enforcement seam (default-ON, deny-by-default, gated joins, count-through-predicate), and the reactive contract test (revocation empties a live subscription on both adapters).
2. **Layer 2 — RBAC**: `definePermissions`/`defineRoles`, `authz/roles` + `role_assignments`, scoped `assignRole`, the `effective_permissions` write-time index, and `ctx.authz.can/require` (typed via codegen).
3. **Layer 3 — relations & sharing**: `authz/relations`, `addRelation`/`hasRelation`, relation predicates, userset subjects, overrides/deny-wins, expiry.
4. **Layer 4 — hierarchy**: opt-in `viewer from parent` arrow-traversal compiled to write-time closure expansion; `listAccessible` (non-reactive admin API).

Each layer has a spec in `docs/superpowers/specs/` before code, per the project's process.
