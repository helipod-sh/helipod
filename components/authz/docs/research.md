# Stackbase Authorization: Which Model Should We Build Natively?

Stackbase builds authorization natively — no external service, no middleware sidecar, no second process. The question is not which service to integrate or which ops topology to deploy; it is which **authorization model's logic and features** belong in `packages/authz`. Concretely: should the model's primitive be a role assigned to a user (RBAC), a boolean predicate evaluated over a row (ABAC / row-rules), or a relationship tuple traversed through a typed graph (ReBAC / Zanzibar)? Service integration and deployment topology were explicitly out of scope for this research. The answer turns entirely on which model's **check algorithm** fits Stackbase's reactive engine — where every query records a read-set, every write is measured against it, and the O(1) invalidation guarantee is the heart of the product.

---

## TL;DR Verdict

> **Winner: the convex-authz model (RBAC + ABAC + ReBAC hybrid).**
> Build authorization as typed application data in the MVCC store, with a permission vocabulary (`definePermissions`/`defineRoles`), scoped role assignment as a first-class multi-tenancy primitive, ABAC as plain TypeScript predicates (no CEL, no DSL), per-resource sharing via typed `grants`/relation rows, and an `effectivePermissions` pre-computed index that collapses every check to a single indexed point-read — the only model that is simultaneously read-set-precise, TypeScript-native, and broad enough to serve the full BaaS spectrum without a paradigm migration.

---

## The Authorization Models: A Primer

Four contenders map to three paradigms. **RBAC** (Role-Based Access Control) assigns users to named roles; a permission check asks "does this user hold a role that grants this action?" Convex-authz is the RBAC representative here, enriched with ABAC and ReBAC layers. **ABAC** (Attribute-Based Access Control / row-predicate) evaluates a boolean function over the row being accessed and the caller's identity: `(viewer, row) => boolean`. Supabase's Row-Level Security is the canonical example. **ReBAC** (Relationship-Based Access Control, after the Google Zanzibar paper) stores authorization facts as typed relationship tuples `(subject, relation, object)` and answers permission checks by traversing the resulting graph. OpenFGA and SpiceDB are both Zanzibar descendants — OpenFGA is the lighter variant; SpiceDB adds a richer permission algebra and first-class caveats (ABAC conditions grafted onto tuples). All four are evaluated specifically against Stackbase's reactive engine constraint: the check must be a **precise, bounded data read** that enters the read-set and drives subscription invalidation correctly.

---

## The Contenders

### convex-authz (RBAC + ABAC + ReBAC hybrid)

#### Model Logic

The convex-authz model does not force a single paradigm. RBAC handles the everyday layer: `definePermissions` produces a typed `resource:action` registry; `defineRoles` maps named roles to subsets of that registry with inheritance and composition. Role assignment is **scoped** — a user can be "admin of team:123" without being a global admin, making multi-tenancy correct-by-construction. ABAC sits on top as inline TypeScript predicate functions: a policy receives the subject's identity, stored attributes, and optionally the resource, and returns a boolean — no DSL, no policy language, full TypeScript. ReBAC provides the graph layer: `addRelation`/`hasRelation` on `(subject, relation, object)` triples with configurable traversal rules.

The critical structural decision is the **`effectivePermissions` pre-computed index**. When a role is assigned or a relationship is added (a mutation), a step expands all affected permissions and writes them as indexed rows keyed by `[tenantId, userId, permission, scopeKey]`. A permission check then reads **exactly one row** from that index — a single point-read — recording exactly one read-set entry. When the role is revoked, that one row changes, the read-set intersection fires, and the subscribed query re-runs. The check is O(1); the read-set footprint is minimal and precise.

The three paradigms share the same index structure, the same audit log, the same expiration machinery, and the same `can`/`require` call surface — they are not bolted together post-hoc.

#### Features

- **`definePermissions`**: typed `resource:action` registry; permission strings are first-class TypeScript literal types, making typos compile errors
- **`defineRoles`**: named roles as typed subsets of the permission registry, with inheritance (`inherits:`) and composition (`includes:`)
- **Scoped role assignment**: `assignRole(userId, role, { type, id })` — the same role means different things in different resource scopes; multi-tenancy isolation is structural (tenantId as leading index key)
- **`effectivePermissions` index**: traversal and role expansion happen at write time; checks are a single indexed point-read (O(1) read-set per check)
- **ABAC via `definePolicies`**: inline TypeScript predicate functions at check time, receiving subject attributes and resource data — no separate policy language, testable with standard test runners
- **ReBAC relation tuples**: `addRelation`/`hasRelation` on `(subject, relation, object)` with configurable traversal rules and bounded depth (`maxDepth`)
- **Permission overrides**: `grantPermission`/`denyPermission` bypass or block role-derived access for individual users (deny-wins semantics, no role proliferation)
- **Wildcard patterns**: `documents:*` or `*:read` grant/deny entire permission families in one operation
- **Expiring grants**: role assignments and overrides carry `expiresAt` with scheduled cleanup
- **Custom tenant-defined roles**: B2B tenants compose their own roles from a provider-approved permission whitelist
- **`canAny` / bulk checks**: up to 100 permissions in one call, avoiding N+1 check patterns
- **Full offboarding**: `deprovisionUser` removes all roles, overrides, attributes, and relationships transactionally
- **Audit log**: every authorization change recorded with actor, action, target, scope, and reason; cursor-based pagination
- **React integration**: `useCanUser`, `useUserRoles`, `useRequirePermission` hooks and `PermissionGate` component for reactive UI gating

#### Expressiveness Walkthrough

**Ownership** — ABAC policy covers this with zero schema changes: `ctx.resource?.ownerId === ctx.subject.userId`. The policy reads `ownerId`; Stackbase records that field in the read-set; ownership transfer automatically invalidates the subscription.

**Scoped roles** — `assignRole(ctx, userId, "admin", { type: "org", id: orgId })`. The scope is part of the index key, so an org admin cannot leak into another org through a permission bug — isolation is structural.

**Groups/teams** — `addRelation(ctx, {type:"user",id:alice}, "member", {type:"team",id:sales})`. Teams are assigned roles exactly like users via scoped role assignment. Membership changes update `effectivePermissions`, making reactive subscribers see the new access state immediately.

**Folder→document hierarchy** — ReBAC traversal rules: `"document:viewer": [{ through: "folder", via: "parent", inherit: "viewer" }]`. A user with viewer access to a folder automatically inherits viewer access to all documents in it. Pre-computation at relationship-write time — not at check time.

**Per-resource sharing** — `addRelation(ctx, {type:"user",id:bob}, "editor", {type:"document",id:docId})`. `relationPermissions` maps "document:editor" to the applicable actions. Revoke with `removeRelation`. The entire Google-Docs-style sharing UX is a single relation write.

**Conditional rules** — TypeScript functions: `ctx.resource?.status === "draft"`, `new Date().getUTCHours() >= 9`. No configuration language, composable with existing TS utilities, debuggable with `console.log`.

**Negation/exclusion** — `denyPermission` creates an explicit deny that overrides any role or relationship grant (deny-wins).

**Public/wildcard** — `grantPermission(ctx, "anonymous", "documents:read", undefined)` or a policy that always returns true; wildcard patterns (`documents:*`) grant families without enumerating actions.

#### How Stackbase Builds It

`packages/authz` implements this model's logic natively. `definePermissions` and `defineRoles` are pure TypeScript — no runtime, no I/O. The `Authz` client wraps Stackbase's `DatabaseAdapter` interface, not any external service. The critical implementation decision mirrors the `effectivePermissions` pattern on Stackbase's MVCC log: role/relation writes expand into an `authz_effective_permissions` table keyed by `[tenantId, userId, permission, scopeKey]`; a check reads exactly one row from that index.

```typescript
// packages/authz/src/index.ts
export const permissions = definePermissions({
  documents: { create: true, read: true, update: true, delete: true },
  comments:  { create: true, read: true, delete: true },
});

export const roles = defineRoles(permissions, {
  owner:  { documents: ["create","read","update","delete"], comments: ["create","read","delete"] },
  editor: { documents: ["read","update"], comments: ["create","read"] },
  viewer: { documents: ["read"], comments: ["read"] },
});

export const authz = new StackbaseAuthz({ permissions, roles });

// Inside a Stackbase query — the check is a single indexed read:
export const getDocument = query({
  args: { docId: v.id("documents") },
  handler: async (ctx, { docId }) => {
    const user = await ctx.auth.getUserIdentity();
    // Single point-read into authz_effective_permissions — one read-set entry:
    await authz.require(ctx, user.id, "documents:read", { type: "document", id: docId });
    return ctx.db.get(docId);
  },
});

// Inside a mutation — relation write triggers effectivePermissions update:
export const shareDocument = mutation({
  args: { docId: v.id("documents"), userId: v.string(), role: v.string() },
  handler: async (ctx, { docId, userId, role }) => {
    await authz.addRelation(ctx,
      { type: "user", id: userId },
      role,
      { type: "document", id: docId }
    );
    // effectivePermissions row written; subscribed queries auto-invalidate.
  },
});
```

ABAC policies that read resource data (`document.ownerId`) add that document row to the read-set — correct reactive behavior, composing with the engine's invalidation machinery with no extra plumbing.

#### Pros

- **O(1) check read-set** — the `effectivePermissions` index means every check is a single indexed point-read, so the engine invalidates only the queries whose specific `user+permission` combination changed
- **Unified three-paradigm surface** — one client interface from todo app to multi-tenant SaaS to Google-Docs-style sharing; no paradigm migration as the product grows
- **Full TypeScript type safety** — `definePermissions`/`defineRoles` produce types that make permission string typos compile errors
- **Scoped role assignment as a first-class primitive** — multi-tenancy isolation is structural (tenantId as leading index key), not an application-layer filter that can be accidentally omitted
- **ABAC as plain TypeScript** — no DSL, no CEL, no YAML; composable, testable with standard runners, full IDE support
- **Incremental adoption** — start with two lines (`definePermissions`/`defineRoles`), add ABAC policies for ownership, add ReBAC relations for sharing hierarchies; each layer is additive
- **Expiring grants, wildcards, overrides, bulk operations** — cover the real lifecycle of authorization (contractor onboarding, temporary access, org-wide changes) without custom code
- **Mental model maps to developer intuition** — "this user has the editor role on this document" is exactly what `addRelation`/`assignRole(scoped)` express

#### Cons (Model Limits)

- **Write amplification** — a role's permission-set change triggers re-expansion of `effectivePermissions` rows for every user holding that role; in large deployments with thousands of scoped role assignments, a single change may write many rows
- **ABAC policy read-set surprise** — a policy that reads `document.ownerId` adds that row to the read-set; correct behavior, but can produce unexpected subscription re-runs if developers do not think of policy evaluation as a data read
- **ReBAC traversal rules are code, not a declarable schema** — complex permission inheritance across many entity types can be hard to audit statically without additional tooling
- **Custom tenant-defined roles add a second expansion path** — the runtime role-expansion for tenant-composed roles must be kept consistent with the pre-computed path; a correctness invariant requiring careful implementation
- **Deep recursive group membership is not built-in** — for org-chart-deep hierarchies (groups containing groups to arbitrary depth), the model requires either bounding traversal depth or pre-computing transitive membership

#### Sharpest Rebuttal Point

The model's strongest critics claim the `effectivePermissions` pre-computation only trades graph-traversal cost at read time for write amplification at write time — and that a single `assignRole` on a large org triggers a transaction with hundreds of index writes, creating an OCC conflict surface and a window during which the index disagrees with the ground-truth tuples. The response: write-time expansion is bounded to the neighborhood of the changed tuple (not to all users globally), can be made incremental, and the synchronization window is within the same MVCC transaction — no stale results are pushed to clients. The ReBAC models (OpenFGA, SpiceDB) that avoid this by traversing at check time instead produce O(depth) read-set entries per check, directly breaking the O(1) invalidation guarantee. The write-amplification cost is the right trade for a reactive engine.

---

### OpenFGA / Zanzibar Relationship Model (ReBAC)

#### Model Logic

OpenFGA represents authorization as a **bipartite graph of typed relationship tuples**: each tuple is a triple `(object#relation, subject)` — e.g. `doc:1#viewer@user:anne` — stored as first-class data. An authorization model DSL declares type definitions and composition rules. A permission check is a graph walk: starting from a `(user, relation, object)` question, the engine follows union/intersection/exclusion/arrow rules until it finds a satisfying tuple or exhausts the search.

The separation between **schema** (the model — declared once per deployment) and **data** (the tuples — written at runtime) is the key insight: permissions are stored data, not code. Changing who can do what is a data mutation, not a code deploy. The model language provides: (1) direct assignment (`define viewer: [user]`), (2) union (`define can_view: viewer or editor`), (3) intersection (`define can_publish: editor and org_member`), (4) exclusion (`define can_view: viewer but not blocked`), (5) tuple-to-userset arrow traversal (`define viewer: viewer from parent` — hierarchy with no recursive joins), and (6) conditions via Google CEL expressions attached to individual tuples for ABAC expressiveness.

#### Features

- Relationship tuples as first-class stored data: `(object#relation, subject)` triples written by mutations
- Typed authorization model DSL (schema 1.1): version-controlled type definitions, permitted relations, and composition rules
- Direct assignment with type restrictions: `define viewer: [user, organization#member]` — only listed subject types can hold a relation
- Union, intersection, exclusion operators
- Tuple-to-userset arrow traversal (`from` keyword): delegates a relation on object A to a relation on object B that A relates to via another relation — hierarchy in O(depth) tuple reads
- Conditions (ABAC via Google CEL): CEL expression attached to a relation, evaluated against context at check time
- Contextual tuples: asserted only for a single check call (what-if reasoning without persistent writes)
- Type-bound public access: `user:*` as a subject grants a relation to all users of a type
- Userset subjects: `organization:acme#member` as a subject — a relation is granted to all members of a group without enumerating them
- `ListObjects` and `ListUsers` APIs: reverse queries — "all docs user:anne can view," "all users who can view doc:1"
- Modular model composition: split large authorization models into per-feature files

#### Expressiveness Walkthrough

**Ownership**: `define owner: [user]`. Write `doc:42#owner@user:anne`. One tuple, one read.

**Roles within an org**: `define admin: [user]` on `organization`; `define can_view_project: member or admin from organization` on `project`. Write `org:acme#admin@user:bob`. Bob can view all projects under acme with no per-project tuple.

**Groups/teams**: `define member: [user]` on `team`; `define viewer: [user, team#member]` on `document`. Write `team:eng#member@user:carol` and `doc:spec#viewer@team:eng`. Carol gets view because her group membership is resolved lazily at check time.

**Hierarchy** (folder→document): `define viewer: [user, team#member] or viewer from parent` on `document`. Write `folder:design#viewer@team:design` and `doc:wireframes#parent@folder:design`. Design-team members view wireframes via arrow traversal — one tuple read per hierarchy level.

**Per-resource sharing**: Write `doc:budget#editor@user:bob`. That is the entire feature.

**Conditional/temporal access**: Attach a CEL condition to a tuple: `document:contract#viewer@user:dave` with `condition: {name: "non_expired_grant", context: {grant_time: ..., grant_duration: "72h"}}`. Pass `current_time` at check time.

**Multi-tenancy**: Model `organization` as the root. All resource types carry an `organization` relation; a user in org:acme cannot traverse to org:beta resources — isolation is structural.

**Public/wildcard**: Write `doc:public-readme#viewer@user:*`. One tuple.

#### How Stackbase Would Build It

Store relationship tuples in Stackbase's MVCC store (same store as all other data); interpret the authorization model schema at server startup. Tuples are rows — the existing transaction, reactive read-set, and codegen machinery applies with zero new infrastructure.

```typescript
// TypeScript builder API replaces the FGA DSL
export const authModel = defineAuthModel({
  document: type({
    relations: {
      owner:  direct("user"),
      editor: union(direct("user", "organization#member"), fromRelation("editor", "parent")),
      viewer: union(relation("editor"), relation("owner"), fromRelation("viewer", "parent")),
      parent: direct("folder").optional(),
      blocked: direct("user"),
      can_view: exclude(relation("viewer"), relation("blocked")),
    },
  }),
});

// Query — check reads tuples, enters read-set, reactive
export const getDocument = query(async (ctx, { docId }) => {
  const allowed = await ctx.auth.check({
    object: `document:${docId}`,
    relation: "can_view",
    subject: `user:${ctx.userId}`,
  });
  if (!allowed) throw new Error("Unauthorized");
  return ctx.db.get("documents", docId);
});
```

#### Pros

- Tuples are first-class stored data — fits the reactive model conceptually: tuple reads enter the read-set
- Single unified primitive covers all patterns: ownership, roles, groups (userset subjects), hierarchy (arrow traversal), sharing (tuple write), public access (`user:*`)
- Union/intersection/exclusion algebra is closed and composable
- Arrow traversal handles arbitrary hierarchies in a fixed number of tuple reads bounded by the declared model depth
- Conditions (CEL) add ABAC expressiveness without changing the tuple model
- Typed DSL + codegen: invalid `(object-type, relation, subject-type)` combinations can be compile-time errors
- Incremental adoption: tiny app uses `define owner: [user]`; large SaaS grows the same model to org/team/folder hierarchies
- Multi-tenancy isolation is structural — provable by model inspection, not by trusting WHERE clauses

#### Cons (Model Limits)

- **Arrow traversal grows the read-set with hierarchy depth** — a 10-level folder tree means up to 10 tuple reads per check, all entering the read-set; a single high-level tuple change (org membership) fans out into mass re-evaluation of every subscription that traversed it — the read-set fan-out problem
- **CEL evaluation adds a runtime expression interpreter** — a non-trivial embedded dependency
- **Conceptual shift** — "authorization as a graph" requires learning a new mental model; the DSL is a second source of truth alongside the TypeScript schema
- **`ListObjects` (reverse queries) fights Stackbase's reactive design** — "all docs user:anne can view" requires a full index scan or graph enumeration; expensive, non-reactive, unsuitable for the per-request reactive path

#### Sharpest Rebuttal Point

OpenFGA advocates claim that tuple reads "enter the read-set" and therefore the reactive loop is free. True but strategically misleading. For a three-level folder hierarchy with an org-role union arm, a single check traverses 6–12 tuple reads. All enter the read-set. When org membership for `org:acme` changes (one tuple write), every query that checked any permission on any resource inside that org re-evaluates — every subscription that traversed the org tuple, regardless of whether the effective permission changed. The `ListObjects` pattern (all docs I can see — the home screen of every document app) is explicitly conceded to be "non-reactive." For a reactive BaaS, "the most common pattern is non-reactive" is a serious model limitation.

---

### Supabase RLS / Row-Predicate Model (ABAC)

#### Model Logic

The row-predicate model represents authorization as a pure boolean function evaluated per table per operation: `(viewer: User, row: Row) => boolean`. The "policy" is a typed TypeScript predicate that can inspect any column of the row being accessed — `owner_id`, `tenant_id`, `status`, `is_public` — alongside any context about the calling user. Multiple policies compose by OR; separate `canRead` and `canWrite` predicates let you say "you can see draft rows you own but cannot see other people's drafts" without graph traversal.

The central insight is that authorization lives at the **data layer**, not the call layer. Declare once, per table, what "readable" means; every read automatically filters. Because each predicate is a data read — "does this membership row exist?" — it produces a precise read-set entry. When a user is added to a team, the membership row changes, the intersection fires, and every subscribed query that checked that membership re-runs automatically.

#### Features

- Per-table, per-operation boolean predicates (`canRead`, `canWrite`, `canDelete`) declared once, enforced everywhere
- Row attribute inspection: any column value is first-class predicate input
- Sub-lookups as plain typed data reads: membership, grant, and role tables queried inside the predicate
- Separate read and write predicates: `canRead` filters visibility; `canWrite` validates mutations independently
- Multi-policy OR composition: access granted if any policy passes
- Wildcard / public access: `row.is_public === true` requires no user context
- Conditional / attribute-based rules: arbitrary boolean expressions over row fields and user claims
- Multi-tenancy isolation: `tenant_id` column comparison is one indexed equality check
- TypeScript-native declaration: predicates are typed closures co-located with the schema
- Read-set composability: predicate sub-lookups extend the query's read-set automatically

#### Expressiveness Walkthrough

**Ownership**: `canRead: (viewer, row) => row.owner_id === viewer.id`. One comparison on a field already in scope.

**Roles within an org**: `canRead: (viewer, row) => row.org_id === viewer.org_id && ['admin','editor','viewer'].includes(viewer.role)`. Still one expression; role is a claim on the viewer.

**Groups/teams**: `canRead: (viewer, row) => db.query(memberships).filter(m => m.project_id === row.id && m.user_id === viewer.id).first() !== null`. One indexed sub-lookup, enters the read-set — reactive.

**Hierarchy** (folder→document): `canRead: (viewer, row) => row.owner_id === viewer.id || db.query(grants).filter(g => g.resource_id === row.folder_id && g.grantee_id === viewer.id).exists()`. One level of hierarchy via a grants table.

**Per-resource sharing**: `doc_grants` table with `(doc_id, grantee_id, role)`; `canRead` checks existence; `canWrite` additionally checks `role === 'editor'`. Share = insert a grant row; revoke = delete it.

**Conditional rules**: `canRead: (viewer, row) => row.is_public || row.owner_id === viewer.id || (row.status === 'review' && viewer.role === 'reviewer')`. Three branches, one expression.

**Negation**: `canRead: (viewer, row) => !blocks.exists({ blocker_id: row.author_id, blocked_id: viewer.id })`. Negation is `!` in TypeScript.

**Public wildcard**: `canRead: (_viewer, row) => row.is_public`. Viewer unused; unauthenticated access works naturally.

#### How Stackbase Would Build It

A typed `policy()` call alongside the table schema definition, producing a `TablePolicy<T>` that the engine hooks into the query/mutation execution path:

```typescript
export const documents = defineTable({
  owner_id: v.id('users'),
  org_id: v.id('orgs'),
  is_public: v.boolean(),
  status: v.union(v.literal('draft'), v.literal('published')),
}).policy({
  canRead: (viewer, row, { db }) =>
    row.is_public ||
    row.owner_id === viewer.id ||
    db.query('memberships')
      .filter(m => m.org_id === row.org_id && m.user_id === viewer.id)
      .exists(),

  canWrite: (viewer, row, { db }) =>
    row.owner_id === viewer.id ||
    db.query('memberships')
      .filter(m => m.org_id === row.org_id && m.user_id === viewer.id && m.role === 'admin')
      .exists(),
});
```

The `db` passed to the predicate is the same MVCC-scoped handle used by the surrounding query. Every `.query()` inside the predicate enters the read-set automatically. Engine integration is three hooks: (1) filter rows through `canRead` before returning from `db.query(table)`; (2) assert `canWrite` on the new row before committing an insert/update; (3) assert `canWrite` on the existing row before committing a delete.

#### Pros

- **Perfectly reactive by construction** — predicate sub-lookups are plain data reads that extend the read-set; authorization changes propagate as automatic re-runs with zero extra plumbing
- **O(1) per-row check for the common cases** — ownership and tenancy are single indexed equality comparisons, never graph traversal
- **TypeScript-native, no DSL** — predicates are typed closures co-located with the schema; full inference, autocomplete, refactoring, compiler enforcement
- **Authorization at the data layer** — impossible to forget a check in one query function while covering it in another
- **Incremental adoption** — `owner_id` check on day 1 grows to team lookup on day 30 grows to per-resource grants on day 90; all additive, no model migration
- **Declarative read/write separation** — visibility and mutability constraints are independent predicates
- **Multi-tenancy is a single equality check** — scales to arbitrarily many tenants with one indexed column comparison

#### Cons (Model Limits)

- **Deep hierarchy requires data model surgery** — a genuinely deep folder tree requires either a materialized ancestors column (write amplification at the application level) or recursive sub-lookups that fan the read-set proportionally to depth; no structural answer
- **No permission vocabulary** — there is no canonical `editor` permission object to enumerate or audit externally; what "editor" means is implicit in predicate branches, making compliance and permission auditing harder
- **Predicate logic can drift** — without discipline, a `canRead` predicate grows into a multi-branch function that is harder to audit than a named-policy list; the model does not enforce structure
- **Join-through-memberships over-approximates the read-set** — a predicate that scans a membership table WHERE conditions may invalidate queries when unrelated membership rows change, because the index scan over the table enters the read-set more broadly than just the relevant row

#### Sharpest Rebuttal Point

The `canRead` predicate that joins through a memberships table — the "Day 30" growth path the model's own advocates describe — adds the entire membership-table index scan to the read-set, not just the relevant membership row. When any membership in the org changes (any user, any team), every subscribed query that performed that scan may be invalidated. This is coarse-grained invalidation dressed as precise read-set tracking. The model also has no answer to hierarchy without data model surgery, no built-in group propagation, and no enumerable permission vocabulary — real limitations that surface at scale.

---

### SpiceDB / Zanzibar Schema Model (ReBAC + Caveats)

#### Model Logic

SpiceDB's model is a **permission algebra layered on a typed relationship graph**. You declare object type definitions with named relations (typed edges from resource to subject) and computed permissions (named boolean expressions derived from those relations). The model never stores "who can do X" directly; it stores structural facts (Alice is a member of team Engineering; document readme has parent folder projects) and the schema's permission expressions compute the answer by traversing the graph.

The permission algebra has four operators: **union** (`+`), **intersection** (`&`), **exclusion** (`-`), and **arrow traversal** (`->`). Arrow traversal is crucial: `parent->view` means "follow the `parent` relation to the linked object and check its `view` permission there" — hierarchical inheritance without denormalization. These operators compose recursively; any permission is a closed algebraic expression over the relation graph. **Caveats** attach ABAC-style conditions to individual tuples: a caveat is a named, typed CEL expression stored in the schema; a relationship carries it with partial context baked in; at check time the caller provides the remaining context. Caveats are first-class schema citizens, not an afterthought.

#### Features

- Typed object definitions — `definition resource {}` namespaces all relations and permissions for a resource kind
- Relations with polymorphic subject types — `relation viewer: user | group#member | organization#admin`
- Subject-set subjects — `document:readme#editor@team:engineering#member` — one write grants every current and future team member the permission
- Union, intersection, and exclusion permission expressions
- Arrow traversal — `permission view = reader + parent_folder->view` — walk a relation to another object and inherit its permission
- Recursive / transitive closure — groups containing groups, folders containing folders
- Wildcards — `user:*` — grant access to all users of a type
- Caveats — named, typed CEL boolean expressions attached to tuples: `caveat within_hours(now timestamp, start int, end int) { ... }`
- Caveat context split — partial context baked into the relationship at write time; remaining context supplied at check time
- Rich caveat types — int, uint, bool, string, double, duration, timestamp, ipaddress, list, map
- Intersection arrow `.all()` — require membership in ALL related groups simultaneously
- Permission-level reuse — permissions reference other permissions within the same definition
- Multi-tenancy isolation via subject-type scoping — all relations scope through the tenant object; cross-tenant traversal is structurally impossible

#### Expressiveness Walkthrough

**Ownership**:
```
definition task {
  relation owner: user
  permission edit = owner
}
```
Write one tuple: `task:42#owner@user:alice`. One tuple, O(1) check. As terse as RLS but declared once in schema, not scattered across every query.

**Roles within org**:
```
definition project {
  relation org: organization
  relation editor: user
  permission edit = editor + org->admin
}
```
Org admins automatically become editors of every project under that org via arrow traversal. Adding a new project to the org automatically inherits the org's admin set — zero additional writes.

**Groups**:
```
definition document {
  relation viewer: user | group#member
  permission view = viewer
}
```
Write `document:spec#viewer@group:eng#member`. Every current and future member of the engineering group gets view access. Adding someone to the group is one tuple write; all downstream permissions update automatically.

**Hierarchy** (Notion/Google Docs style):
```
definition document {
  relation parent_folder: folder
  relation viewer: user
  permission view = viewer + parent_folder->view
}
```
Arrow traversal handles arbitrarily deep folder nesting. A user with view on the root gets view on every nested document recursively.

**Per-resource sharing**: Write `document:proposal#editor@user:bob`. Schema already declared the editor relation. Sharing is a single tuple write.

**Conditional rules**:
```
caveat business_hours(request_time timestamp) {
  request_time.getHours() >= 9 && request_time.getHours() < 17
}
definition document {
  relation editor: user with business_hours
  permission edit = editor
}
```
Alice's editor relationship carries the caveat. Outside 9-5, she loses edit access — no schema or data changes required.

**Negation**:
```
definition forum {
  relation member: user
  relation banned: user
  permission post = member - banned
}
```
Algebraic negation as a first-class operator — not a `NOT EXISTS` workaround.

**Multi-tenancy**: Every resource type carries an `organization` relation; no path exists in the graph connecting tenant A's data to tenant B's user without an explicit cross-org tuple.

#### How Stackbase Would Build It

Relationship tuples are stored in Stackbase's MVCC store (same tables as app data). The schema's permission algebra is compiled to a traversal plan at server startup. A check is a graph walk over indexed tuple rows; every read enters the Stackbase read-set.

```typescript
export const authzSchema = defineAuthzSchema({
  document: {
    relations: {
      owner: subject("user"),
      editor: subject("user").or(subjectSet("organization", "admin")),
      viewer: subject("user").or(subjectSet("organization", "member")).or(wildcard("user")),
      parent: subject("folder"),
    },
    permissions: {
      view: union("viewer", "editor", "owner", arrow("parent", "view")),
      edit: union("editor", "owner", arrow("parent", "edit")),
      delete: only("owner"),
    },
  },
});

export const getDocument = query({
  args: { id: v.id("documents") },
  handler: async (ctx, { id }) => {
    await ctx.authz.check("document", id, "view", ctx.userId);
    return ctx.db.get(id);
  },
});
```

Schema compiler generates typed permission names — `"veiw"` (typo) is a TypeScript error. The traversal plan is pre-compiled; check executes a bounded, known set of indexed tuple lookups. Caveats evaluate as pure functions over supplied context with no additional I/O reads.

#### Pros

- **Richest abstract expressiveness** — union, intersection, exclusion, arrow traversal, and caveats compose to express every access pattern in the same schema language
- **Caveats are first-class and typed** — conditions are named, reusable, schema-declared CEL expressions, not ad-hoc predicates scattered across function handlers
- **Subject-sets make group-based access fully dynamic** — adding a user to a group automatically propagates permissions to all resources referencing that group, with zero additional writes
- **Arrow traversal enables hierarchical inheritance with no denormalization** — folder permissions cascade to documents structurally
- **Wildcard subjects** cleanly express public/anonymous access
- **Exclusion operator** handles negation as a first-class algebraic operation
- **Permission expressions are named** — a self-documenting vocabulary mapping directly to product language
- **Multi-tenancy is structural** — isolation enforced by the graph's shape, not by remembered WHERE clauses
- **Incremental adoption** — start with `define owner: [user]`, grow to org-roles + groups + hierarchy + caveats as the product matures

#### Cons (Model Limits)

- **Schema compilation step required** — the permission algebra must be compiled to a traversal plan before checks run; adds a build-time artifact and a foreign DSL
- **Arrow traversal grows the read-set with depth** — deeply nested trees produce longer traversal chains, all entering the read-set; same fan-out problem as OpenFGA at high-level tuple changes
- **CEL evaluation at check time** — requires embedding a CEL interpreter; a non-trivial dependency
- **Intersection arrows (`.all()`)** — requiring a user to be in ALL related groups is non-obvious; semantics easy to misread
- **CEL is a foreign type system** — caveat parameters must be bridged manually from TypeScript to CEL context at every call site; a typo in a context key name is a runtime error, not a build error, breaking the TypeScript-native principle

#### Sharpest Rebuttal Point

The schema compilation step and CEL dependency directly violate Stackbase's locked "TypeScript end-to-end" principle. The permission algebra must be compiled in a foreign DSL; caveat conditions are CEL, not TypeScript — two foreign type systems that sit outside the TypeScript compiler and break the "rename a table and the compiler tells you exactly what broke" story. Additionally, the check algorithm is still a runtime graph traversal whose read-set is determined by traversal depth, not the query's declared data dependencies. A high-level tuple change fans out into mass re-evaluation proportional to the number of resources under that node — the same fatal reactive fit problem as OpenFGA.

---

## The Cross-Fire

### Do Relationship Tuples Subsume Everything vs. Simpler Models Are Enough?

The ReBAC advocates argue that all authorization patterns — ownership, roles, groups, hierarchy, sharing, conditions — can be expressed as relationship tuples, making them a universal primitive. The counter-argument is that expressiveness and fit are different. A ReBAC check for ownership is a tuple read; a predicate check is a field comparison on a row the query was already reading. The simpler model is genuinely simpler for the common case, and "simpler models are enough for 80% of BaaS apps" is the correct observation. The resolution: the ReBAC tuple primitive is the right graduation path for apps that need hierarchy and group delegation, not the mandatory starting point for every app.

### Per-Row Predicates vs. Relationship Graph

Predicates are maximally local: the authorization rule for a document lives next to the document's business logic, in the same file, readable without a separate mental model. The relationship graph is maximally expressive: once you learn the mental model, every authorization pattern is a consistent graph operation. The tension is DX vs. expressiveness. The resolution: per-row predicates belong at the engine's data layer as `canRead`/`canWrite` hooks (the "can't forget a check" guarantee), complemented by an explicit `require()` call at hot paths — the two styles are compatible and serve different ergonomic needs.

### Graph-Traversal Checks vs. O(1) Reactive Reads

This is the decisive head-to-head for Stackbase. Graph-traversal checks (OpenFGA, SpiceDB) produce read-set entries proportional to hierarchy depth; a high-level tuple change fans out into mass subscription re-evaluation. Pre-computed `effectivePermissions` (convex-authz) collapses the check to a single indexed read — exactly one read-set entry — at the cost of write-time expansion. The reactive engine's correctness guarantee demands bounded, precise read-sets. Write amplification is bounded and manageable; read-set fan-out is unbounded and directly undermines the reactive guarantee. The O(1) read-path wins.

### One Unified Model vs. A Layered Ladder

Should Stackbase ship one model (the most expressive one) or a layered ladder (start simple, graduate to complex)? The ReBAC advocates prefer one unified model — "incremental adoption" within the same graph schema. The predicate model advocates prefer a flat, TS-native starting point. The synthesis: the layered ladder is correct, but the layers should share a unified declaration surface. Apps start with ownership predicates and scoped RBAC; they add the ReBAC graph layer as an opt-in for hierarchy and group delegation without migrating existing checks. The engine exposes both layers under one `packages/authz` API.

---

## Comparison Table

| Model | Expressiveness | Ownership | Roles | Groups | Hierarchy / Inheritance | Per-Resource Sharing | Conditional / ABAC | Reactive O(1) Fit | Mental Model | Typed DX |
|---|---|---|---|---|---|---|---|---|---|---|
| convex-authz (RBAC+ABAC+ReBAC hybrid) | ★★★★☆ | ★★★★★ | ★★★★★ | ★★★★☆ | ★★★☆☆ | ★★★★★ | ★★★★★ | ★★★★★ | ★★★★★ | ★★★★★ |
| Supabase RLS / row-predicate (ABAC) | ★★★☆☆ | ★★★★★ | ★★★☆☆ | ★★★☆☆ | ★★☆☆☆ | ★★★★☆ | ★★★★★ | ★★★★★ | ★★★★★ | ★★★★☆ |
| SpiceDB / Zanzibar schema (ReBAC + caveats) | ★★★★★ | ★★★★☆ | ★★★★☆ | ★★★★★ | ★★★★★ | ★★★★★ | ★★★★☆ | ★★☆☆☆ | ★★★☆☆ | ★★★☆☆ |
| OpenFGA / Zanzibar relationship (ReBAC) | ★★★★☆ | ★★★★☆ | ★★★★☆ | ★★★★★ | ★★★★★ | ★★★★★ | ★★★☆☆ | ★★☆☆☆ | ★★★☆☆ | ★★★☆☆ |

**Scoring notes:**
- *Reactive O(1) Fit*: convex-authz and RLS score highest because checks are single indexed reads or field comparisons on already-read rows. SpiceDB and OpenFGA score lowest because their check algorithm is a runtime graph traversal whose read-set grows with hierarchy depth, producing fan-out on high-level tuple changes.
- *Typed DX*: convex-authz scores highest because `definePermissions`/`defineRoles` produce TypeScript literal types enforced by the compiler with no foreign DSL. SpiceDB and OpenFGA score lower because the schema DSL and CEL condition language sit outside the TypeScript type system.
- *Hierarchy*: SpiceDB and OpenFGA score highest because arrow traversal is a first-class schema primitive. convex-authz scores lower because deep hierarchy requires explicit data modeling (materialized ancestors or O(depth) subqueries).
- *Groups*: SpiceDB and OpenFGA score highest because userset subjects (`group#member`) are a native primitive — adding a user to a group propagates permissions with zero additional writes. convex-authz requires a two-hop subquery or write-time expansion.

---

## The Judge's Verdict

### Winning Model

**convex-authz (RBAC + ABAC + ReBAC hybrid)** — its logic wins as the basis for `packages/authz`.

### Scorecard

| Model | Score | Rationale |
|---|---|---|
| convex-authz (RBAC+ABAC+ReBAC hybrid) | **9/10** | Covers the full BaaS spectrum with a typed permission vocabulary, scoped roles, ABAC as plain TS, per-resource sharing via relation rows, and an `effectivePermissions` index that makes every check a single indexed point-read — exactly one precise read-set entry, the ideal reactive footprint. TypeScript-native, no DSL, no CEL. Incremental from two lines to multi-tenant SaaS without paradigm migration. Genuine gaps: deep hierarchy and recursive group membership require manual data modeling (addressable by grafting an opt-in ReBAC layer). |
| Supabase RLS / row-predicate (ABAC) | **7/10** | Best read-set precision for the 80% case: ownership/tenancy checks read a field already in the query's read-set, adding zero fan-out. Authorization declared at the data layer, cannot forget a check, TS-native. Ceiling is real: no permission vocabulary, no compositional algebra, no first-class hierarchy or group propagation. Excellent as the engine-level `canRead`/`canWrite` hooks; insufficient alone as the primary model. |
| SpiceDB / Zanzibar schema (ReBAC + caveats) | **6/10** | Highest abstract expressiveness; structural multi-tenant isolation; first-class hierarchy, groups, and caveats. But weakest reactive fit: check is a runtime graph traversal with read-set proportional to depth, not the query's declared reads — high-level tuple changes fan out into mass re-evaluation. Requires schema compilation and CEL (foreign DSL/runtime), violating the TS-end-to-end principle. Its algebra and arrow-traversal are the right things to borrow as an opt-in hierarchy layer. |
| OpenFGA / Zanzibar relationship (ReBAC) | **6/10** | Single unified tuple primitive elegantly covers all patterns; tuples-as-data superficially fits the read-set model. Same fatal reactive fit problem as SpiceDB: depth-proportional read-set fan-out; `ListObjects` (all docs I can see — the home screen) is non-reactive. Separate authorization model DSL is two sources of truth. Type-restricted relations and userset subjects are worth borrowing; the model as a whole is not the right primary. |

### The Concrete Model to Build

**Logic:** Authorization is typed application data stored in Stackbase's MVCC store. Every permission check is a typed, indexed data read. The reactive loop is not special-cased for authorization — it is free because authorization IS data.

**Features** (`packages/authz`):

1. **Typed permission registry** — `definePermissions({ documents: { read, update, ... } })` producing `resource:action` string-literal TypeScript types; a typo is a compile error; a missing permission is a type error. This is the "permission vocabulary" that RLS lacks.

2. **Named roles with inheritance and composition** — `defineRoles(permissions, { editor: {...}, viewer: {...}, admin: { inherits: "editor", ... } })`. Roles are typed subsets of the permission registry; inheritance is declared, not re-implemented per role.

3. **Scoped role assignment as a first-class primitive** — `assignRole(ctx, userId, "admin", { type: "org", id })`. The scope is part of the index key; multi-tenant isolation is structural (tenantId as the leading key), not a remembered WHERE clause.

4. **ABAC as plain TypeScript predicates** — `(ctx, resource) => resource.ownerId === ctx.userId`, `resource.status === "draft"`, `Date.now() < grant.expiresAt`. No DSL, no CEL. Conditions are TypeScript: type-checked, testable with vitest, and they read row data that lands precisely in the read-set.

5. **Per-resource sharing via typed relation rows** — a typed `grants` table `{ resourceId, resourceType, userId, role }`; `addRelation`/`hasRelation`/`removeRelation` over `(subject, relation, object)` for the Notion/Google-Docs case. Share = insert one row; revoke = delete one row.

6. **Overrides and deny-wins semantics** — `grantPermission`/`denyPermission` for exceptions without role proliferation; `expiresAt` on grants for temporal access; wildcard patterns (`documents:*`) for family-wide grants.

7. **`effectivePermissions` pre-computed index** — keyed `[tenantId, userId, permission, scopeKey]`. Role/relation writes expand into this index at write time; a check is a single indexed point-read — exactly one read-set entry, surgical invalidation. This is the decisive performance contract.

8. **Opt-in arrow-traversal layer** — for hierarchy-first apps: `viewer from parent` declares that the `viewer` relation on an object is inherited from a related object via the `parent` relation. Type-restricted relation declarations ensure invalid `(type, relation, subject-type)` combinations are compile-time errors. Apps adopt graph traversal only where they need it.

**Declaration surface:** Pure TypeScript, co-located with the schema, consumed by codegen so that (a) every permission/role/relation name is a typed literal, (b) `authz.require(ctx, userId, "documents:read", { type, id })` and `authz.can(...)` are fully typed, and (c) codegen can enforce that tenant-scoped tables carry the tenant key. Checks live inside server-side query/mutation functions, entering the read-set automatically.

### Features to Borrow from Each Model

**From RLS (ABAC):**
- Engine-level per-table `canRead`/`canWrite` predicate hooks enforced in the query/mutation execution path — authorization declared once at the data layer, impossible to forget at a call site. Predicates are plain typed TypeScript closures co-located with the schema.
- Keep ABAC conditions as TypeScript (not CEL) — same type system, same compiler, reads row data that lands precisely in the read-set.

**From SpiceDB / OpenFGA (ReBAC):**
- Type-restricted relation declarations — invalid `(type, relation, subject-type)` combinations are compile-time errors; codegen enforces that every registered resource type has its authorization relations declared.
- Userset subjects (`team#member` as a grantee) — dynamic group propagation with zero additional writes per group member.
- `user:*` wildcard subjects for public/anonymous resources.
- Opt-in arrow-traversal layer (`viewer from parent`) for hierarchy-first and recursive-group apps — composable in the same query as flat predicates.
- Exclusion/deny-wins operator concept backing `grantPermission`/`denyPermission`.

**From Lunora (shipped reactive RLS — the closest prior art):**
- **Read rules return a `WhereInput` predicate AND-merged into the query**, not a per-row boolean — index-pushdown, no scan-then-filter, and the predicate's columns/relations become *precise* read-dependencies (no over-invalidation). *(This supersedes the per-row-boolean form in "ABAC as plain TypeScript predicates" above; the per-row form is kept only for writes.)*
- **Relation predicates** (`some`/`is`/`none`/`every`) as the reactive way to express one-hop sharing/membership (`{ members: { some: { userId } } }`) — index-friendly and reactive via a child-table read-dep, with no graph walk.
- **Pure-function policy testing** (`expectPolicy(policies).as({ userId })`) — policies are testable in isolation with vitest, mirroring production evaluation.
- **`count` / nested-hydration leak awareness** and a **`rls_uncovered_table`-style advisor** for tables that have data but no policy.

**Non-functional contract (both ReBAC camps' concessions, codified):**
- Reverse "ListObjects" queries (all resources a user can access) are an **explicitly non-reactive, paginated administrative API**, never on the per-request reactive path.
- The `effectivePermissions` write-time expansion is **bounded and observable** — expansion depth is limited by the declared relation graph, and expansion progress is logged for debugging.

---

## Prior Art: Lunora — a Shipped Reactive-Backend RLS

After the roundtable we examined **[Lunora](https://lunora.sh/docs/concepts/rls)**, a *production* reactive backend in Stackbase's exact category (Convex-like server functions + real-time subscriptions + local-first sync). It is the closest existing prior art to what we are designing, and it independently arrived at almost exactly the model the roundtable recommended — which is strong validation — while also **refining two decisions we got slightly wrong.**

### Lunora's model (verbatim shape)

Policies are plain TypeScript via `definePolicy`, attached to procedures with an `rls(...)` middleware:

```ts
const ownDocuments = definePolicy({
  table: "documents",
  on: "read",
  when: ({ auth }) => ({ ownerId: auth.userId }),   // returns a WHERE predicate, not a boolean
});
export const listDocuments = query.use(rls(definePolicies([ownDocuments])))
  .query(async ({ ctx }) => ctx.db.findMany("documents"));
```

- **Reads:** the policy's `when()` returns a **`WhereInput` predicate** that is **AND-merged into the query** (`baseWhere`) — non-matching rows are simply invisible. It can return `true` (unrestricted), `false` (deny → zero rows), or `undefined` (opt out).
- **Writes** (`insert`/`update`/`delete`): `when()` receives the candidate/pre-write `row` and returns a boolean; a mismatch throws `FORBIDDEN`.
- **Roles:** `definePermission("posts:delete")` + `defineRole("admin", { permissions })` + `auth.can(permission)`; roles are unioned at request time and **fail closed for unknown roles**.
- **Sharing / relationships:** Prisma-style **relation predicates** (`is`/`some`/`none`/`every`) inside the `WhereInput`, e.g. `{ members: { some: { userId: auth.userId } } }` — and these are **reactive**: a relation predicate stamps a read-dependency on the *child* table, so a write there re-runs the subscription.
- **Reactive identity** is stamped at the **WebSocket upgrade** (connection-level), and subscriptions re-run under that verified identity.
- **Posture:** **deny-by-default but opt-in per procedure** (only `.use(rls(...))` procedures are guarded), with an **`rls_uncovered_table` advisor** that warns about unguarded tables. Pure-function policy testing via `expectPolicy(policies).as({ userId })`.

### What it confirms (our verdict holds)

TypeScript predicates (no DSL/CEL), enforcement at the **function layer** (the actual trust boundary, not the DB), roles + per-row conditions + relation-based sharing as a **hybrid**, and **reactivity for free** because checks read data. Lunora is essentially our recommended model, shipped — which is about the strongest validation a design can get.

### What it *refines* (two upgrades we should adopt)

1. **Reads should return a query *predicate*, not a per-row boolean.** Our recommendation said "ABAC as `(ctx, doc) => boolean`." Lunora returns a `WhereInput` that is **AND-merged into the query** — which is strictly better and *fixes the exact cons the roundtable flagged*: the predicate **pushes into the index** (no scan-then-filter, no N+1) and its columns/relations become **precise read-dependencies** (no fan-out). So the model becomes: **read rules return a `WhereInput` merged into the query; write rules evaluate the candidate row → boolean/throw** (the per-row form is correct *only* for writes, where there's a single in-memory row and no fetcher — note Lunora explicitly disallows relation predicates on writes for this reason).

2. **Relation predicates (`some`/`is`/...) are the reactive sweet-spot for sharing — often better than arrow-traversal.** A "share with Bob" or "members of this org" check is just a relation predicate in the read's `WhereInput`; it's index-friendly, composes with the rest of the filter, and is reactive via the child-table read-dep — **no graph-walk, no fan-out**. This means our "opt-in arrow-traversal compiler" should be reserved for genuinely *recursive* hierarchy (folder→subfolder→doc); the common one-hop sharing/membership case is a relation predicate.

### Subtleties Lunora surfaced (bake these in)

- **`count` on a row-filtered table leaks the count of rows you can't see** — Lunora throws `COUNT_RLS_UNSUPPORTED`. Our pagination/aggregation must special-case this.
- **Nested hydration (`with`/joins) must re-filter children by the child table's own read policy** — or an `include` becomes a visibility leak.
- **Deny-by-default**, plus an advisor/lint for unguarded tables.

### The one real fork: opt-in vs. engine-default

Lunora is **opt-in per procedure** (`.use(rls(...))`) + an advisor; our roundtable leaned **engine-global "can't-forget."** The synthesis I'd take: **default-ON at the engine for any table that declares a policy** (so you can't forget), with an **explicit per-query opt-out** for the rare intentional-bypass (admin tooling), and Lunora's **`rls_uncovered_table`-style advisor** to flag tables that have data but no policy. That's strictly stronger than opt-in while keeping the escape hatch.

---

## Why This Model Dominates — and Where Every Con Went

The honest test of "best of the best" is not a feature list — it is whether **every con raised anywhere in this document has a concrete engineering answer that removes it**, leaving the model dominant on the axes that matter (speed, DX, ease, error-resistance). Below, each con is mapped to the mechanism that eliminates it. This is the synthesis of all five models *plus* the engine-level enforcement only Stackbase can do — and it is why none of the borrowed models, on its own, reaches here.

### Every con, and the mechanism that removes it

| Con (and who raised it) | Why it normally hurts | The mechanism that removes it | Net result |
|---|---|---|---|
| **Per-row boolean read filter scans then filters** (our v1) | full table scan + N+1 predicate eval + read-set fan-out | **Read rules return a `WhereInput` AND-merged into the query** (from Lunora) — pushed into the index; columns become precise read-deps | Index-pushed, O(matched-rows), surgical invalidation |
| **ReBAC check is a runtime graph traversal** (convex-authz vs SpiceDB/OpenFGA) | read-set grows with hierarchy depth → mass re-invalidation on high-level changes | **`effectivePermissions` materialized at *write* time**; a check is a single indexed point-read | O(1) check, exactly one read-set entry, zero traversal at read time |
| **A materialized index can drift from source** (classic CQRS risk) | stale permissions = security bug | **Expansion runs inside the *same OCC mutation* that changes the role/relation** — atomic, deterministic | Drift is structurally impossible |
| **Bulk hierarchy re-parent amplifies writes** (the cost of materialization) | re-parenting 10k descendants holds the single-writer lock | **Bounded, observable expansion** + **async background expansion above a threshold** (a "pending" marker), so the common case is transactional and the pathological case is non-blocking | O(1) reads always; bulk writes never block the writer |
| **Deep/recursive hierarchy needs manual data modeling** (convex-authz gap) | hand-rolled ancestor tables, easy to get wrong | **Opt-in `viewer from parent` arrow-traversal** compiled to write-time closure expansion; **one-hop sharing via relation predicates** (from Lunora) | Recursion is declared, not hand-rolled; the common one-hop case needs no traversal at all |
| **Group membership requires extra writes to propagate** (convex-authz vs ReBAC userset) | adding a user to a team should not require re-granting | **Userset subjects** (`team#member` as grantee, from ReBAC) expanded at write-time / joined via relation predicate | Add-to-group propagates with O(1) reads, no per-member writes |
| **`count` on a filtered table leaks the hidden-row count** (Lunora throws) | size of invisible data is itself a leak | **The engine counts *through* the read predicate** (count of *visible* rows) — the predicate is already merged into the query | `count` works *and* leaks nothing — strictly better than Lunora's "throw" |
| **Nested `include`/join can over-expose children** (Lunora warns) | a hydrated relation skips the child's policy | **Enforcement lives at the `ctx.db` kernel seam**, so *every* read — including hydrated/joined reads — is predicate-gated by construction | Joins cannot leak; no per-query discipline required |
| **"Forgot to add the check"** (every function-level/opt-in model: convex-authz, Lunora, raw guards) | one missing guard = data breach | **Engine-default-ON for any table with a policy** + explicit per-query opt-out for intentional admin bypass + an `uncovered-table` advisor | Can't-forget by default; bypass is loud and intentional |
| **Write rules can't do relationship checks** (Lunora: writes see one in-memory row, no fetcher) | "can edit only if member of the row's org" is unexpressible on writes | **Our write rule runs in a full mutation `ctx`** — it can `ctx.db` query to resolve relationships, and those reads join the transaction | Write rules are *more* capable than Lunora's |
| **DSL/CEL is a second source of truth outside the type system** (SpiceDB/OpenFGA) | schema + condition language drift from app types; typos at runtime | **Pure TypeScript registry** (`definePermissions`/`defineRoles`) → string-literal types via codegen | A typo'd permission/role/relation is a *compile* error |
| **DB-enforced RLS is Postgres-only and can't notify the reactive tier** (Supabase) | two security models per adapter; no live revocation | **Engine-level enforcement through the `DatabaseAdapter` seam** | Identical on SQLite + Postgres; revocation is reactive |
| **"Too many concepts to learn"** (a hybrid has more surface than pure RBAC) | cognitive cost | **It's a ladder** — the simple case is one predicate object; roles, relations, arrows, overrides are each opt-in and only appear when needed | Two lines for a todo app; the same model scales to multi-tenant SaaS with no migration |

There is no con in this table that survives as a *logical* defect on the common path or the reactive path — each is either eliminated outright or relocated to a bounded, observable, non-blocking write-time cost.

### Best on each axis — earned, not asserted

- **Fastest (the reactive check, the thing that runs constantly):** every check is either a single indexed point-read against `effectivePermissions` or an index-pushed `WhereInput` — **zero read-time graph traversal, zero scan**, and invalidation is exactly the affected `[tenantId, userId, permission, scopeKey]` row. ReBAC traverses on every check; Postgres-RLS can't drive the reactive tier at all; a per-row boolean scans. We pre-pay at write time so the hot path is O(1). *No alternative is faster on the reactive read path.*
- **Best DX:** one language end-to-end (TypeScript), one type system, co-located with the schema, codegen-typed call sites — **no `.fga`/`.zed` schema, no CEL, no SQL `CREATE POLICY`**. SpiceDB/OpenFGA make you learn a modeling language *and* a condition language; Supabase makes you write SQL invisible to your types. Ours is the only model with no foreign surface.
- **Easiest to write:** the floor is a single predicate object (`when: ({ auth }) => ({ ownerId: auth.userId })`); you reach for roles/relations/arrows only when an app needs them; and **policies are pure functions testable with `vitest`** in isolation. ReBAC demands an upfront model even for a todo app.
- **Least error-prone:** **engine-default-ON** (can't forget) + **typed literals** (typos are compile errors) + **auto-gated joins and counts** (no hydration/count leak) + **deny-by-default** + **drift-proof transactional expansion** + an **uncovered-table advisor**. Safety here is *structural*, not a matter of developer discipline — which is the opposite of every opt-in/RLS-policy/guard-call model.

### The one honest residual (stated, not hidden)

The model is **read-optimized**: it pre-materializes effective permissions, so **role/relation/hierarchy *writes* do more work** than a system that traverses at read time. That is the deliberate, correct trade for a reactive backend — you optimize the operation that runs on *every* request and re-runs on *every* invalidation (the check), at the cost of the operation that runs rarely (granting/revoking/re-parenting). And even that cost is contained: expansion is bounded, observable, transactional for the common case, and **async-with-a-pending-marker** for pathological bulk changes so it never blocks the single writer. This is not a silent con — it is a conscious, bounded write-time cost that buys an O(1) reactive read path. No alternative avoids *some* version of this tradeoff; ours is the only one that puts the cost where it does the least harm.

---

## Implications for `components/authz`

The model-level next steps for the `components/authz` layer are:

1. **Define the storage schema** — the `authz_effective_permissions` table keyed by `[tenantId, userId, permission, scopeKey]`; the `authz_relations` table for `(subject, relation, object)` tuples; the `authz_grants` table for per-resource sharing; the `authz_overrides` table for explicit grant/deny; and the `authz_audit_log` table. All tables live in the MVCC store behind the `DatabaseAdapter` interface — no database specifics leak out of `packages/adapters/*`.

2. **Implement write-time expansion** — the mutation path that converts a `assignRole` or `addRelation` call into indexed `effectivePermissions` rows. Expansion must be transactional with the caller's mutation, bounded by the declared relation graph, and observable (logged, with a maximum expansion count per call that raises an explicit error rather than silently hanging).

3. **Implement the `Authz` client** — `definePermissions`, `defineRoles`, `assignRole`, `addRelation`, `can`, `require`, `canAny`, `grantPermission`, `denyPermission`, `deprovisionUser`. TypeScript generics are constrained by the permission registry so that every call site is fully typed.

4. **Codegen integration** — the typed permission/role/relation names produced by `definePermissions`/`defineRoles`/`defineAuthzSchema` feed into the existing codegen pipeline alongside the data schema, so the generated `api` object includes typed authz helpers.

5. **Engine-level data-layer hooks** — integrate `canRead`/`canWrite` predicate hooks into the query/mutation execution path so that tables with a `.policy()` declaration are automatically predicate-gated; this is the "can't forget a check" guarantee borrowed from RLS.

6. **Opt-in arrow-traversal compiler** — a schema declaration of `viewer from parent` compiles to a traversal plan that the engine executes against the `authz_relations` table. For apps that do not declare any arrow relations, the traversal compiler is a no-op and adds zero overhead.

7. **Reactive contract test** — a vitest suite that asserts: (a) a `can` check after `assignRole` returns true; (b) a subscribed query that calls `can` is invalidated and re-run when the role is revoked; (c) invalidation scope is exactly the affected `[tenantId, userId, permission, scopeKey]` row, not any broader table scan.

8. **Design spec** — per the project's process rule, a full spec in `docs/superpowers/specs/` is required before code lands. The spec should document the storage schema, the expansion algorithm (with bounded-depth proof), the codegen contract, and the reactive performance guarantee — all at the model level, before any implementation begins.
