# authz `effectivePermissions` Pre-Flattened Index — design

**Status:** approved (brainstorming) — 2025-06-22
**Slice:** `@stackbase/authz` — the RBAC read-path optimization. Successor to the merged relation-ops slice (`b34a435`).
**Predecessor context:** Today `ctx.authz.can(permission, scope)` reads the caller's whole `role_assignments` set (`byUser`), filters to global-or-scope, and for each assigned role runs `roleGrants(config, role, permission)` (expanding the role's config permissions, with inheritance + `*` wildcards). It is correct and reactive, but: (a) O(assignments) per check with live expansion, and (b) its read-set is the user's entire `role_assignments` range, so revoking **any** role re-runs **all** of that user's `can()` subscriptions — even ones checking unrelated permissions.

---

## 1. Goal

Materialize each user's effective permissions into an `authz/effective_permissions` index keyed `[scopeType, scopeId, userId, permission]`, maintained transactionally at `assignRole`/`revokeRole`. Then:
- `can(perm, scope)` becomes a small fixed number of **indexed point-reads** (O(1)), not a scan+expand.
- Its read-set is **exactly those keys**, so a role change invalidates **only** the subscriptions that checked an affected permission-family in that scope — surgical invalidation, the headline win.

The index is a derived cache of `role_assignments × config`. `role_assignments` remains the source of truth; the index is rebuildable.

---

## 2. Locked decisions (from brainstorming)

1. **RBAC scope only.** The index serves `can`/`require`/`scopesWith`. Relation/row-sharing predicates keep their semi-join (they are data-driven, per-row, not per-user-permission).
2. **Config drift → startup rebuild via a boot hook.** A new generic component **boot step** runs privileged at runtime start; authz compares a stored `configHash` to the current config and, if changed, rebuilds the index from all `role_assignments`. Because config lives in code, it changes only on redeploy (a restart), so boot is exactly when drift can occur. `can()` is therefore a pure point-read in steady state (no per-check freshness read).
3. **Patterns, not enumerated permissions.** Grants are stored as-written patterns (`documents:*`, `*:*`, `billing:manage`); `can(res:act)` point-reads the ≤4 candidate keys that could match. No declared permission vocabulary is required.

---

## 3. Data model

**`authz/effective_permissions`** — one row per granted permission pattern held by a user in a scope:

```ts
{ userId: string; scopeType: string; scopeId: string; permission: string }
```
- `permission` is a **pattern** exactly as it appears in the expanded role config: `"documents:read"`, `"documents:*"`, `"*:manage"`, `"*:*"`.
- `scopeType`/`scopeId` are `""`/`""` for a global grant, else the scope.
- Indexes:
  - `byLookup [scopeType, scopeId, userId, permission]` — point-reads for `can()`.
  - `byUser [userId]` — reconcile on revoke, and `scopesWith`.

**`authz/meta`** — a singleton row `{ configHash: string }` recording the config version the index was built under.

Both tables live under the `authz` namespace (component-owned), same as `role_assignments`.

---

## 4. Pattern materialization

`expandRolePatterns(config, role): string[]` returns the role's granted permission strings **with inheritance applied** (reusing the existing `expandRole` internals), *without* wildcard enumeration — a `documents: ["*"]` grant yields the pattern `"documents:*"`, `inherits` is followed, and results are deduped. These strings are stored verbatim as `effective_permissions.permission`.

`candidateKeys(permission): string[]` — for `permission = "res:act"`, the ≤4 patterns that would match it: `["res:act", "res:*", "*:act", "*:*"]`. (If `permission` has no `:` it is treated as `res` with empty action; the same construction applies.) `can()` checks these against the index.

This mirrors `roleGrants`'s wildcard rule (`(pr === res || pr === "*") && (pa === act || pa === "*")`) but inverted into a bounded set of exact keys to look up, so no scan is needed.

---

## 5. Maintenance (transactional, alongside the assignment)

- **`assignRole(user, role, scope)`** (still gated by `authz:manage`, unchanged): insert/keep the `role_assignments` row as today, then `for (p of expandRolePatterns(config, role))` **upsert** `effective_permissions {user, scopeType, scopeId, permission: p}` (skip if the exact row already exists — idempotent).
- **`revokeRole(user, role, scope)`** (gated, unchanged): delete the `role_assignments` row, then **reconcile** `(user, scope)`: recompute the granted pattern set from the user's *remaining* `role_assignments` in that scope (`⋃ expandRolePatterns`), read the stored `effective_permissions` rows for `(user, scope)`, and delete any whose `permission` is not in the recomputed set. (A pattern granted by another still-assigned role survives — hence recompute, never blind-delete.)

Both run inside the mutation's transaction, so the index can never diverge from `role_assignments` within a running server.

---

## 6. Read path

- **`can(perm, scope)` / `require(perm, scope)`:** compute `candidateKeys(perm)`; for each key, point-read `effective_permissions` via `byLookup` at both the **requested** scope (`scope.type/scope.id`) and the **global** scope (`""`/`""`). Any hit → `true`; none → `false`. Anonymous (`userId === null`) → `false`. Up to `4 patterns × 2 scopes = 8` point-reads, O(1). The read-set is those keys (including empty gaps — so a later grant re-runs a `can()===false` subscription).
- **`scopesWith(perm, type)`:** scan the caller's `effective_permissions` `byUser`; keep rows where `scopeType === type` (when `type` given) and `permission ∈ candidateKeys(perm)`; collect deduped `scopeId`. Bounded by the user's grants; no per-row config expansion. Global grants (`scopeType === ""`) are handled as before (a `can(perm)` check catches a global grant; `scopesWith` returns scoped ids).
- **`roles(scope)`:** unchanged — reads `role_assignments`.

---

## 7. Config drift → boot reconcile

`configHash(config): string` — a deterministic serialization of `config.roles` + `config.permissions` (stable key ordering) hashed to a short string; equal configs → equal hash.

The authz **boot step** runs as a system boot transaction (§8) at `EmbeddedRuntime.create` (after `setupSchema`):
1. Read `authz/meta`. If present and `configHash` equals the current config's → return (steady state, cheap).
2. Otherwise **rebuild**: scan all `role_assignments`; for each, upsert its expanded patterns into `effective_permissions`; delete `effective_permissions` rows not produced by any current assignment (orphans from a removed/renamed role or a shrunk grant). Then write `authz/meta = { configHash }`.
3. Log one line: `authz: rebuilt effective_permissions (<N> assignments → <M> rows)`.

On a fresh database (no `meta`, no assignments) this is a no-op that stamps the initial hash. An `authz:rebuild` mutation (gated by `authz:manage`) exposes the same reconcile for ops recovery — it reuses `reconcileEffectivePermissions`, so no duplicate logic.

---

## 8. The component boot seam (generic)

`ComponentDefinition` gains:

```ts
boot?: (ctx: BootContext) => Promise<void>;
interface BootContext { db: GuestDatabaseWriter; now: number } // read+write, scoped to this component's namespace
```

- `composeComponents` collects `bootSteps: { name: string; run: (ctx: BootContext) => Promise<void> }[]` (namespace = component name).
- `EmbeddedRuntime.create`, after `setupSchema`, runs each boot step **once**, in composition order, before serving traffic. Each runs as a **system-initiated, non-user transaction** in the component's own namespace: a mutation-profile `GuestDatabaseWriter` on a kernel context with `namespace = component name`, `identity = null`, and **`privileged = false`** — so bare table names resolve under the component's namespace as usual (`ctx.db.query("effective_permissions", …)` → `authz/effective_permissions`) and the write goes through the normal namespaced path. (This is deliberately *not* the executor's raw-name `privileged` mode, which skips namespace prefixing.) It writes only its own namespace's tables; there is no acting user, and the step is trusted server code, so it is not subject to the row policies or the `authz:manage` gate that guard user-facing mutations.
- Only authz contributes a boot step in v1. `defineAuthz` wires `boot: (ctx) => reconcileEffectivePermissions(ctx, config)`.

The boot step scans all `role_assignments` via the default `by_creation` index (a full-table read, no `eq`), so it sees every user's assignments during a rebuild.

---

## 9. Surgical invalidation (the payoff)

`can()` no longer reads `role_assignments`; its read-set is the ≤8 `effective_permissions` point-read keys. Consequences:
- Revoking a role deletes specific `[scope, user, pattern]` rows → invalidates **only** subscriptions that point-read those exact keys, i.e. only those checking an affected permission-family in that scope. A subscription checking an unrelated permission the same user still holds does **not** re-run (today it does).
- Gaining a permission (assign) inserts a key that was previously an empty-gap read of a `can()===false` subscription → that subscription re-runs and flips to `true`. Negative reads stay reactive.
- Granularity is per-`(scope, permission-pattern)` — the finest the system offers.

---

## 10. Guards & observability

- **Max-expansion guard:** if `expandRolePatterns` yields more than a fixed cap (`MAX_PATTERNS_PER_ROLE = 1000`) for a single role, throw `authz: role "<role>" expands to more than 1000 permission patterns` (fail-closed; bounds pathological/cyclic config). Applied on assign and rebuild.
- **Observability:** the boot rebuild logs its one-line summary; `assignRole`/`revokeRole` remain silent (hot path).

---

## 11. Testing

- **Surgical-invalidation contract (headline):** a user holds `a:read` (via role `ra`) and `b:read` (via role `rb`); two subscriptions `can("a:read")` and `can("b:read")` are open; revoking `ra` re-runs **only** the `a:read` subscription (it flips to `false`), while the `b:read` subscription does **not** re-run. Asserted through the sync handler (compare push counts / values per query id).
- **Reactivity preserved:** assign flips a `can()===false` subscription to `true`; revoke flips it back (the shipped RBAC-core contract, now via the index).
- **Config-drift rebuild:** build the index under one config, then boot a runtime whose config grants a role an extra permission with a changed hash → after boot, `can()` reflects the new permission for existing assignments; a removed permission is gone (orphan deleted).
- **Wildcard:** a role granting `documents:*` answers `can("documents:read")` and `can("documents:delete")` true via the pattern point-reads; `can("billing:view")` false.
- **Multi-role reconcile:** a user assigned `ra` and `rb` both granting `x:read`; revoking `ra` leaves `can("x:read") === true` (reconcile keeps the pattern granted by `rb`).
- **scopesWith** returns the right scope ids from the index.
- **Regression:** RBAC-core, Layer 1 row-policy, and relation tests stay green (they exercise `can()`/`require()` through the new index path unchanged in behavior).

---

## 12. File structure

**New**
- `components/authz/src/effective-permissions.ts` — `expandRolePatterns`, `candidateKeys`, `configHash`, `upsertPatterns`, `reconcileScope`, `reconcileEffectivePermissions` (boot/rebuild), `MAX_PATTERNS_PER_ROLE`.
- `authz/effective_permissions` + `authz/meta` tables in `components/authz/src/schema.ts`.
- Tests: authz (surgical, config-drift, wildcard, reconcile, scopesWith); component (boot seam).

**Modify**
- `components/authz/src/context.ts` — `can`/`require`/`scopesWith` read the index.
- `components/authz/src/functions.ts` — `assignRole`/`revokeRole` maintenance; a privileged `rebuild`.
- `components/authz/src/define-authz.ts` — wire `boot` + expose `rebuild`.
- `packages/component/src/define-component.ts` — `boot?` field + `BootContext`.
- `packages/component/src/compose.ts` — collect `bootSteps` into `ComposedProject`.
- `packages/runtime-embedded/src/runtime.ts` — run boot steps privileged after `setupSchema`.

---

## 13. Out of scope (later)

Config-as-data (roles/permissions in DB tables); incremental/lazy rebuild (v1 rebuilds fully at boot on config change); a background/cron rebuild; the index for relation/sharing permissions; `addRelation`/`removeRelation` sugar; index push-down for the relation semi-joins; typed codegen for permission strings.
