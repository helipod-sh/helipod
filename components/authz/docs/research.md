# Stackbase Authorization: Roundtable Research

## Framing the Question

Stackbase is a Convex-like reactive Backend-as-a-Service: clients call TypeScript query and mutation functions, never tables. The reactive engine records each query's read-set, and when a committed mutation's write-set intersects that read-set, live subscriptions are re-run and pushed to clients over WebSocket. This architecture means the function is the trust boundary — not the database, not a middleware layer. "Which authorization approach fits?" is therefore non-obvious: models designed for direct-database access (Postgres RLS) enforce at the wrong layer, models that introduce out-of-process checks (OpenFGA, SpiceDB) leave no fingerprint in the read-set and break the reactive guarantee, and simple convention-based helpers (convex-authz) offer no structural "can't-forget" guarantee. The question demands an approach that is simultaneously at the function-execution layer, tracked by the reactive engine, adapter-agnostic across SQLite and Postgres, and shippable without adding a second service to a self-hosted deployment.

---

## TL;DR Verdict

> **Winner: Stackbase-native reactive authz component.**
> Build a first-party authz component that slots rule evaluation into the kernel's existing `requireOwnTable` seam so enforcement is structurally impossible to forget and revocation is reactive by construction — then layer RBAC tables and an optional tuple store on top.

---

## The Contenders

### 1. convex-authz (dbjpanda)

#### How It Works

convex-authz is a community library that stores authorization state (roles, attributes, relationships) in component-namespaced tables inside the Convex/Stackbase deployment. Checks happen as explicit TypeScript calls — `await authz.require(ctx, userId, "documents:update")` — inside function handlers. Three complementary models compose under one `Authz` class: RBAC (roles with inheritance), ABAC (async policy functions over user attributes and resource context), and ReBAC (Zanzibar-style subject/relation/object tuples). At assignment time, the library recomputes and writes pre-flattened `effectivePermissions`, `effectiveRoles`, and `effectiveRelationships` index tables, so permission checks at read-time are O(1) single-indexed lookups rather than graph traversals. Multi-tenancy uses `tenantId` as the leading index column. React hooks (`useCanUser`, `PermissionGate`) drive UI gating from the same live subscription machinery.

#### How It Maps to Stackbase

The authz state lives in `authz/*` namespaced tables, accessible through `ctx.db`. A `ctx.authz` facade is injected via the component `context` builder. `authz.require(ctx, userId, perm)` is called at the top of each handler before any `ctx.db` write. Because `effectivePermissions` rows are read via `ctx.db`, they enter the query read-set automatically; revoking a role rewrites those rows, triggering read-set/write-set intersection and immediate subscription re-push. The pattern maps cleanly to Stackbase's component model.

```typescript
// Typical usage inside a mutation handler
export const updateDocument = mutation({
  args: { docId: v.id("documents"), content: v.string() },
  handler: async (ctx, { docId, content }) => {
    const userId = await getAuthUserId(ctx);
    await authz.require(ctx, userId, "documents:update", {
      type: "document",
      id: docId,
    });
    await ctx.db.patch(docId, { content });
  },
});
```

#### Pros

- The function-layer check is the correct trust boundary for Stackbase's architecture.
- Reactive revocation is automatic: `effectivePermissions` rows enter the read-set, so revocation immediately invalidates live subscriptions.
- Storage-adapter-agnostic: all state is in ordinary indexed tables, identical on SQLite and Postgres.
- No extra service: everything is component-namespaced tables inside the single binary.
- O(1) checks at runtime via pre-flattened effective-permission tables.
- TypeScript end-to-end: `definePermissions`/`defineRoles` return inferred types with autocomplete.
- Ships expiring grants and audit log out of the box.
- React hooks complete the full-stack loop.

#### Cons

- No "can't-forget" structural guarantee: if a developer adds a mutation and omits `authz.require`, data leaks silently. The engine does nothing to stop it.
- Write amplification on `assignRole`: recomputing `effectivePermissions` for every permission × scope holds the single-writer lock for potentially thousands of row writes per role change — a meaningful latency risk at mid-scale.
- The package is Convex-specific. Adopting it for Stackbase means forking it, not just wrapping it — the component ABI, table conventions, and deployment model differ. Stackbase would own a security-load-bearing fork of a one-developer's community project, echoing the concave.dev disappearance risk that this project exists to avoid.
- ABAC policies that need external data (billing status, feature flags) cannot call the network (queries must be pure), so that data must be cached in Stackbase tables first — the cache-invalidation problem becomes the developer's.
- No first-class answer for multi-hop relationship traversal without the ReBAC layer.

#### Sharpest Rebuttal Point (Against It)

The can't-forget failure is structural. A junior developer writes `export const getDocument = query({ handler: async (ctx, { id }) => ctx.db.get(id) })` and omits the authz call. The engine is silent. For a reactive product where a live subscription may stream that result to many clients indefinitely, this is a silent ongoing data leak, not a one-time error. Building load-bearing security on a convention-over-enforcement model is the precise risk this architecture should eliminate.

---

### 2. OpenFGA

#### How It Works

OpenFGA is a CNCF-incubating, Apache-2.0-licensed authorization engine implementing Zanzibar-style Relationship-Based Access Control. You write an authorization model in a declarative DSL defining object types, named relations, and composition operators (union, intersection, difference, inheritance via `->` arrow). Relationship tuples — live data like "user:anne is viewer of doc:1" — are stored in OpenFGA's own datastore (Postgres, MySQL, SQLite-beta, or in-memory). The **Check API** traverses the tuple graph against the model to answer binary permit/deny questions. **ListObjects** returns all objects of a given type a user can access. **Contextual tuples** inject transient relationships per-request without persisting them.

#### How It Maps to Stackbase

An `authz` component would wrap OpenFGA's Check/Write/ListObjects calls behind a typed facade with two modes: embedded (OpenFGA process spawned as a sidecar during `stackbase dev`) and external (production, point at a deployed OpenFGA service). A synthetic read-set bridge is required: `ctx.authz.check(...)` records a synthetic read-set entry (`authz/<userId>/<object>/<relation>`), and tuple-write events write a matching synthetic entry so the sync tier's intersection logic can re-run affected subscriptions on revocation.

```typescript
// Authorization model (authz/model.fga) — version-controlled with the app
model schema 1.1

type document
  relations
    define owner: [user]
    define viewer: [user, organization#member]
    define can_read: viewer or owner
    define can_write: owner
```

```typescript
// Guard inside a query function
export const getDocument = query({
  args: { docId: v.id("documents") },
  handler: async (ctx, { docId }) => {
    const userId = await ctx.auth.getUserId();
    await ctx.authz.check({ user: `user:${userId}`, relation: "can_read", object: `document:${docId}` });
    return await ctx.db.get(docId);
  },
});
```

#### Pros

- Single version-controlled `.fga` model file is the authoritative source of truth — no permission logic scattered across mutation bodies.
- Handles the full complexity spectrum in one system: simple ownership, multi-tenant org hierarchies, nested folder inheritance, cross-org sharing.
- Apache-2.0, CNCF-governed; backed by Auth0/Okta with production use at Airbnb, Twilio, and GitHub.
- Contextual tuples enable transient, request-scoped grants (draft previews, share links) without polluting the persistent store.
- SQLite backend support (beta): theoretically zero-config for local dev.
- Typed TypeScript SDK with codegen for relation/type inference.

#### Cons

- Separate Go service: cannot be linked into a `bun build --compile` TypeScript binary. "Embedded mode" still requires shelling out to `openfga run` or bundling a Go native binary — neither is zero-config, neither preserves single-binary packaging.
- Out-of-process checks leave no read-set fingerprint: an OpenFGA call does not call `ctx.txn.recordRead`. Revocation requires the synthetic mirror-table bridge, which is two systems pretending to be one with a divergence window on every write and no two-phase commit across stores.
- Tuple/business writes are not atomic across two stores: if the business mutation commits but `ctx.authz.writeTuple()` fails (network blip), authorization state diverges from business state with no automatic recovery.
- SQLite backend is beta-quality, underdocumented, and not what the OpenFGA team tests against; reliability for production self-host is unproven.
- `ListObjects` reverse-traversal can be expensive for large graphs and returns IDs that require a second round-trip to the Stackbase database.

#### Sharpest Rebuttal Point (Against It)

The tuple-sync consistency hazard cannot be fully mitigated without a distributed transaction coordinator that OpenFGA does not provide. A mutation that inserts a document row and calls `ctx.authz.writeTuple()` are two separate operations with two separate failure modes. Getting them right requires application-level retry queues and reconciliation logic — complexity that belongs in the authz system's design, not in every application developer's operations runbook.

---

### 3. Supabase Row-Level Security (Postgres RLS)

#### How It Works

Postgres RLS attaches POLICY objects directly to tables. Each policy is a SQL predicate evaluated by the query planner on every row access. SELECT policies use a `USING` clause (non-matching rows are silently filtered); INSERT/UPDATE/DELETE policies use `WITH CHECK`. Policies reference session-local GUC variables (typically `current_setting('request.jwt.claim.sub')`) for identity context. Supabase injects identity via `SET LOCAL request.jwt.claims = '...'` inside each transaction via PostgREST, enabling safe direct-browser-to-Postgres queries. Policy expressions can reference any column, call stable SQL functions, or join other tables via subqueries.

#### How It Maps to Stackbase

Honest answer: it doesn't map well. Implementation would require injecting `ctx.userId` into every Postgres connection via `SET LOCAL` inside the `DatabaseAdapter` transaction, defining policies in SQL migrations alongside DDL, and accepting that those policies duplicate checks already written in TypeScript function bodies.

```sql
-- A policy that duplicates what the query function already does
CREATE POLICY select_own_messages ON messages
  FOR SELECT USING (
    sender_id = current_setting('request.jwt.claim.sub')::uuid
    OR EXISTS (
      SELECT 1 FROM channel_members
      WHERE channel_id = messages.channel_id
        AND user_id = current_setting('request.jwt.claim.sub')::uuid
    )
  );
```

The function is still the trust boundary and still filters rows — RLS adds a second, redundant filter below it, in a different language, on only one of Stackbase's two supported adapters.

#### Pros

- Database-enforced: structurally impossible for application code to bypass once enabled (on Postgres).
- Declarative and colocated with schema in SQL migrations.
- Mature and battle-hardened since Postgres 9.5; proven at Supabase's scale for the direct-browser-to-DB pattern.
- Zero extra service: policies live inside Postgres itself.
- Efficient for simple ownership predicates — compiles into the query plan, uses existing indexes.

#### Cons

- **Postgres-only, no SQLite RLS**: Stackbase's primary zero-config dev tier uses the SQLite adapter. RLS cannot exist there at all. The result is two completely different security models depending on which adapter is configured — a correctness and auditing disaster that directly violates the locked "engine must NOT hard-depend on one database" constraint.
- Architecturally inverted: Stackbase clients never touch the database. The function is the trust boundary. RLS fires below it, defending a surface no client can reach. At best it is redundant defense-in-depth; at worst it gives false confidence.
- No reactive invalidation: when an RLS policy changes, Postgres has no mechanism to notify Stackbase's sync tier. Live subscriptions see stale data until they reconnect.
- Identity injection via `SET LOCAL` session variables is fragile under connection pooling and couples the adapter to a specific Supabase-derived convention.
- DX is alien: authz logic in SQL `CREATE POLICY` migrations requires context-switching away from TypeScript, breaks codegen, and makes authz invisible to the type system.

#### Sharpest Rebuttal Point (Against It)

RLS is disqualified by a single locked architectural decision: "The engine must NOT hard-depend on one database." SQLite has no RLS. The default deployment target for every self-hosted Stackbase instance would have zero database-layer enforcement while the Postgres adapter has full enforcement — two completely different security models per adapter, with the most common one providing none. This is not a tradeoff; it is a categorical incompatibility.

---

### 4. SpiceDB (Authzed)

#### How It Works

SpiceDB is an Apache-2.0-licensed, open-source implementation of Google Zanzibar — the authorization system powering Google Docs, Drive, and YouTube. Permissions are declared in the Zed schema language: object types, named relations, and computed permission expressions using union, intersection, difference, and the `->` arrow for inheritance traversal. Live data is a graph of relationship tuples. Three primary APIs: `CheckPermission` (binary permit/deny), `LookupResources` (all resources of type T a user can access), and `LookupSubjects` (all subjects that can access resource R). Every response returns a `ZedToken` — a causally consistent cursor that solves the new-enemy and old-friend distributed consistency problems. Datastores: Postgres, CockroachDB, MySQL, Cloud Spanner. No SQLite backend.

#### How It Maps to Stackbase

SpiceDB fits as an optional advanced adapter, not the default. The authz component would expose an identical `ctx.authz` API surface whether backed by SpiceDB or the native implementation. A mirror-tuple bridge (`authz/permission_cache` keyed on `(userId, object, relation) → bool`) is required for reactive integration: SpiceDB Watch API events trigger mutations that update the mirror, and query functions read from the mirror (entering the read-set), so invalidation fires correctly.

```zed
// authz/schema.zed
definition document {
  relation owner:  user
  relation viewer: user | org#member
  relation parent: org
  permission view   = owner + viewer
  permission edit   = owner
  permission delete = owner + parent->manage
}
```

```typescript
// Usage inside a Stackbase function
export const listMyDocuments = query(async (ctx) => {
  const userId = await ctx.auth.getUserId();
  const allowedIds = await ctx.authz.lookupResources("document", "view");
  return ctx.db.query("documents")
    .filter(q => q.in(q.field("_id"), allowedIds))
    .collect();
});
```

#### Pros

- Highest expressiveness ceiling: union, intersection, exclusion, and arrow-traversal operators cover every known permission pattern — ownership, org hierarchies, inherited folder permissions, wildcard public access, cross-resource role bindings.
- `LookupResources` returns exactly the IDs a caller can see, enabling correct and efficient list pages.
- ZedTokens provide causal consistency across replicated systems — the new-enemy and old-friend problems are solved by design.
- Single version-controlled schema is the authoritative source of truth, auditable by non-engineers.
- Apache-2.0, battle-proven at Zanzibar scale, active CNCF community.
- Caveats enable ABAC on top of the graph model without polluting mutation logic.

#### Cons

- **No SQLite backend**: SpiceDB requires Postgres, CockroachDB, MySQL, or Cloud Spanner. `stackbase dev` with SQLite cannot use SpiceDB without a full Postgres install, which destroys the zero-config local development experience and kills adoption.
- Separate gRPC service: cannot be embedded in a `bun build --compile` TypeScript binary. Adds a second service, second availability budget, and second ops burden to every deployment.
- Reactivity bridge is synthetic and introduces a divergence window between the SpiceDB write and the mirror-table update — neither is part of the same Stackbase OCC transaction.
- Zed schema is a third language to learn alongside TypeScript and SQL, taxing the "DX is the feature" principle.
- `LookupResources` returns IDs that require a second round-trip to Stackbase's DB; large allowed sets produce large `IN` clauses that stress the SQLite query planner.
- ZedToken machinery solves a distributed-replication consistency problem that Stackbase's single-writer OCC transactor already eliminates — the complexity tax has no payoff at Tier 0/1.

#### Sharpest Rebuttal Point (Against It)

SpiceDB is disqualified for the default path by the absence of a SQLite backend. `stackbase dev` is the zero-config first-run experience that either earns or loses the developer. Requiring a full Postgres install before authz works at all puts a hard prerequisite on the most common onboarding path. SpiceDB's value proposition — correctness at Google-scale graph complexity — solves a problem the 99th-percentile Stackbase developer will never have, at an ops cost every Stackbase developer will pay.

---

### 5. Stackbase-native (Reactive Component)

#### How It Works

A first-party authz component that models authorization as a reactive citizen of the engine itself — enforcing at the kernel seam all `ctx.db` operations already pass through, rather than relying on function authors to call a check helper. Three interlocking layers compose the full model.

**Layer 1 — Declarative row rules.** Each table definition carries optional `read` and `write` predicates — pure TypeScript functions `(ctx, doc) => boolean` evaluated by the kernel before any document is returned or staged. The kernel already calls `requireOwnTable` on every `db.get`, `db.query`, `db.insert`, `db.replace`, and `db.delete` (verified in `packages/executor/src/kernel.ts`). Authz row rules slot into that seam: the kernel evaluates the predicate against `ctx.identity` and the fetched document, throwing `ForbiddenOperationError` on write-deny and returning `null` on read-deny. Because rule predicates touch `ctx.db`, their reads are recorded via `ctx.txn.recordRead(range)` (verified at kernel.ts:204/225), automatically entering the query's read-set. Revocation is reactive by construction with zero additional plumbing.

**Layer 2 — RBAC via namespaced tables.** `authz/roles` and `authz/role_assignments` tables store role definitions and assignments. A typed `ctx.authz.can(permission, scope?)` facade is contributed through the component `contextType`/codegen path. Because `can()` reads from these tables via `ctx.db`, the role tables join the read-set automatically — revoking a role assignment invalidates every subscription that called `ctx.authz.can()` for that user.

**Layer 3 — Optional tuple store.** An `authz/tuples` table stores `(subject, relation, object)` triples for complex sharing hierarchies. `ctx.authz.related(subject, relation, object)` does bounded-depth graph traversal over these tuples inside the current transaction, again through `ctx.db`, automatically extending the read-set.

#### How It Maps to Stackbase

This is a direct extension of existing, tested machinery. The kernel seam is already there. The component model (namespaced tables, `context` builder, `requires` dependency chain, codegen integration) is already there. The reactive engine (read-set recording, write-set intersection, subscription re-push) is already there. The authz component adds a rule-evaluation hook and three tables.

```typescript
// Schema definition with inline row rules (app's schema.ts)
export default defineSchema({
  messages: defineTable({
    channelId: v.id("channels"),
    authorId: v.string(),
    body: v.string(),
  })
    .index("by_channel", ["channelId"])
    .rowRules({
      // This fires in the kernel on every db.get/db.query result row
      // — structurally impossible to forget
      read:  (ctx, doc) => ctx.authz.isMember(doc.channelId),
      write: (ctx, doc) => doc.authorId === ctx.auth.getUserId(),
    }),
});
```

```typescript
// ctx.authz facade (authz/context.ts)
export function buildAuthzContext(cctx: ComponentContext) {
  return {
    async can(permission: string, scope?: string): Promise<boolean> {
      const userId = cctx.identity;
      if (!userId) return false;
      const assignments = await cctx.db.query("role_assignments")
        .withIndex("by_user_scope", q => q.eq("userId", userId).eq("scope", scope ?? null))
        .collect();
      for (const a of assignments) {
        const role = await cctx.db.get(a.roleId);
        if (role?.permissions.includes(permission)) return true;
      }
      return false;
    },
    async isMember(channelId: string): Promise<boolean> {
      return this.can("channel:read", channelId);
    },
    async related(subject: string, relation: string, object: string): Promise<boolean> {
      const direct = await cctx.db.query("tuples")
        .withIndex("by_subject_rel", q => q.eq("subject", subject).eq("relation", relation))
        .collect();
      return direct.some(t => t.object === object);
    },
  };
}
```

```typescript
// Reactive revocation — zero extra plumbing
// When admin calls mutation removeFromChannel:
await ctx.db.delete(membershipId); // writes to authz/role_assignments
// Transactor emits write-set covering authz/role_assignments.by_user_scope[userId, channelId].
// Sync tier intersects against read-sets of live subscriptions that called ctx.authz.can().
// Those subscriptions are immediately re-run and re-pushed.
// The revoked user's client receives an empty result — no polling, no manual cache bust.
```

#### Pros

- **Can't-forget enforcement**: rules fire at the kernel seam that all `ctx.db` calls already pass through — structural guarantee, not developer discipline.
- **Fully reactive by construction**: predicate reads enter the read-set via existing `ctx.txn.recordRead` machinery; revocation triggers automatic write-set/read-set intersection and immediate subscription re-push; zero bridge plumbing.
- **Adapter-agnostic**: pure TypeScript through the DocStore seam; identical behavior on SQLite (Tier 0) and Postgres (Tier 2).
- **Zero extra services**: compiles into the single binary, preserves the zero-config self-host story.
- **Composable complexity ladder**: ownership row rule → RBAC `ctx.authz.can()` → tuple ReBAC — projects grow into expressiveness without switching systems.
- **Typed end-to-end**: `contextType` declaration drives codegen; `ctx.authz` is fully typed in every function; row-rule predicates infer the correct `Doc<'tableName'>` type.
- **Low marginal cost**: the reactive engine, component model, and kernel seam are already built and tested; the authz component adds a rule-evaluation hook and three namespaced tables.

#### Cons

- **Rule predicate N+1 reads**: a `ctx.db.query` returning N rows triggers the rule predicate N times, each of which may do its own `ctx.db` read (e.g., a membership check). Without per-invocation memoization keyed on `(identity, scope, table)`, this multiplies DB reads. The memoization layer must be built carefully — getting it wrong produces stale permission decisions (security bug) or over-invalidation (performance bug).
- **Pre-flattened effective-permission tables are needed**: if rule predicates traverse a role graph at check-time, every subscription re-run on invalidation pays that traversal cost. Permissions should be pre-flattened at write-time (as convex-authz does) so check-time is O(1). This is more design work than "just read the tables."
- **Deep graph traversal fan-out**: multi-hop tuple traversal without explicit depth limits can produce very wide read-sets, causing over-invalidation (every write to any touched table re-runs every subscription with a deep traversal in its read-set).
- **No external enforcement**: authz rules protect the function API. If a Postgres-adapter database is also exposed directly to a BI tool or `psql` session, those clients bypass the kernel. Lightweight Postgres ownership constraints or CHECK constraints would be needed as defense-in-depth for that scenario.
- **Must be built**: unlike the external approaches, there is no existing implementation to wrap. However, the expensive part — the reactive engine — is already done.

#### Sharpest Rebuttal Point (Against It)

The concession the native component owes: it has not been built yet, and the pre-flattened permission table model (needed for O(1) reactive re-execution), per-invocation memoization, and depth-bounded tuple traversal are all real engineering work — not boilerplate. The estimated scope is "a week of work for ownership + RBAC" but that estimate does not include the memoization layer or the edge cases (cycles in the tuple graph, wildcard grants, cross-tenant leakage) that a production authz component must handle. That said, the hard part — the reactive engine — is done. The authz component is implementation work, not research work.

---

## The Cross-Fire

### ReBAC-as-service vs. in-engine

OpenFGA and SpiceDB both argue that externalizing the relationship graph gives you a version-controlled, auditable, language-independent policy model that non-engineers can review. This is genuinely valuable. But for Stackbase, externalizing the graph breaks the reactive contract: an out-of-process Check call leaves no fingerprint in `ctx.txn`'s read-set. When the tuple changes, the sync tier has no write-set intersection to fire on. Both service advocates were forced to propose a synthetic mirror-table bridge — which concedes the entire reactive argument. If you must mirror authz state into Stackbase tables to get reactivity, you should keep it there natively and skip the external service. The "single authoritative model" discipline OpenFGA rightly values can be expressed as a typed TypeScript permission declaration (declare-once, no magic strings) without a separate DSL or service.

### RLS database-enforcement vs. function-model enforcement

Supabase RLS's structural insight — that enforcement should fire at one authoritative layer impossible to bypass — is exactly right. But RLS chooses the database as that layer, which is correct for Supabase (clients query Postgres directly) and wrong for Stackbase (clients call functions, functions own all database access exclusively). The right layer to enforce "structurally impossible to bypass" in Stackbase is the function-execution kernel — the one path all `ctx.db` calls already flow through. The native component relocates RLS's structural guarantee from the database to the kernel and makes it adapter-agnostic. RLS's other valuable idea — lightweight Postgres ownership constraints as defense-in-depth when operators expose the DB port — remains valid as an optional hardening step, not the primary model.

### Library-convention vs. first-class-reactive

convex-authz and the native component both use `ctx.db` tables, so both get reactive revocation "for free" via the read-set mechanism. The decisive difference is structural enforcement. convex-authz is a convention: `await authz.require(ctx, userId, perm)` at the top of each handler. The native component slots into the kernel seam: rules fire on every `ctx.db` call regardless of what the function body does. For a reactive product where a forgotten check streams stale or unauthorized data to live subscribers indefinitely, the gap between convention and structure is a security property gap, not just a code-quality preference. Additionally, convex-authz's write-amplification on role assignment (rewriting O(permissions × scopes) effective-permission rows per mutation) holds Stackbase's single-writer lock — the native component's pre-flattened model achieves the same O(1) check-time while keeping the write scope bounded.

---

## Comparison Table

| Approach | Fit Score | Function-model fit | Reactive | Works on SQLite + Postgres | No extra service | DX / typing | Expressiveness |
|---|---|---|---|---|---|---|---|
| Stackbase-native | 9/10 | Enforces at kernel seam — structurally impossible to forget | Yes — predicate reads enter read-set via existing `recordRead`; revocation auto-invalidates | Yes — pure TypeScript through DocStore seam, identical on both | Yes — single binary, zero config | Typed end-to-end via codegen; row-rule predicates infer `Doc<T>` | RBAC + ownership now; ReBAC tuples additive |
| convex-authz (dbjpanda) | 7/10 | Correct layer but convention-only — forget one call and leak | Yes — effectivePermissions rows in read-set; revocation re-pushes | Yes — `ctx.db` tables, adapter-agnostic | Yes — component tables in same binary | TypeScript with `definePermissions`/`defineRoles` inference | RBAC + ABAC + ReBAC under one class |
| OpenFGA | 3/10 | Guard call inside function is correct but check is out-of-process | No — out-of-process call leaves no read-set entry; synthetic bridge required | Partial — SQLite backend is beta and still a separate process | No — Go service cannot link into Bun binary; still requires shelling out | TypeScript SDK with type inference | Full Zanzibar: union, intersection, arrow-traversal |
| SpiceDB | 2/10 | Guard call inside function is correct but check is out-of-process | No — same synthetic bridge problem as OpenFGA | No — no SQLite backend; Postgres required even for `stackbase dev` | No — separate gRPC service, own datastore | Zed DSL adds a third language to learn | Highest ceiling: all Zanzibar operators + caveats |
| Supabase RLS | 1/10 | Wrong layer — fires below the function, which clients never bypass anyway | No — Postgres has no mechanism to notify the reactive sync tier | No — SQLite has no RLS; Postgres-only enforcement means two security models per adapter | Yes — lives inside Postgres | SQL `CREATE POLICY` breaks TypeScript DX; invisible to codegen | Limited to SQL predicates over row data |

---

## The Judge's Verdict

### Winner: Stackbase-native (reactive component)

**Score: 9/10**

### Scorecard

| Criterion | Result |
|---|---|
| Reactive by construction | Pass — predicate reads enter `ctx.txn.recordRead` automatically |
| Adapter-agnostic (SQLite + Postgres) | Pass — pure TypeScript through DocStore seam |
| No extra service / single-binary | Pass — namespaced tables compile into the binary |
| Can't-forget structural guarantee | Pass — kernel seam fires on every `ctx.db` call |
| Typed end-to-end | Pass — `contextType` drives codegen |
| Composable complexity | Pass — ownership → RBAC → tuples as layers |
| Implementation cost | Acceptable — hard part (reactive engine) already exists |

### Concrete Recommendation

Build a first-party native authz component shipping as a complexity ladder in three layers:

**Layer 1 (ship first — ownership + row rules):** Add a `rowRules` declaration surface to table definitions. Inside the kernel's existing `requireOwnTable`/db-op handlers (verified present in `packages/executor/src/kernel.ts`), evaluate the rule predicate after fetching each document. Return `ForbiddenOperationError` on write-deny and `null` on read-deny. Rule predicates that touch `ctx.db` automatically extend the read-set via the existing `ctx.txn.recordRead` path — revocation is reactive with zero additional wiring. This seam is structurally impossible for a function author to bypass.

**Layer 2 (RBAC — ships after Layer 1 is stable):** Add `authz/roles` and `authz/role_assignments` namespaced tables. Expose `ctx.authz.can(permission, scope?)` via the component `contextType`/codegen path. The `auth` component is a declared dependency (`requires: ["auth"]`), using `ctx.auth.getUserId()` as the identity anchor. Pre-flatten effective permissions at assignment write-time (not at check read-time) so check cost is O(1) indexed read — critical because checks re-execute on every subscription invalidation.

**Layer 3 (ReBAC tuples — seam-reserved, implementation deferred):** Add `authz/tuples` table with `ctx.authz.related(subject, relation, object)` for bounded-depth graph traversal. This covers Google Docs-style sharing hierarchies without a separate service.

**Required engineering details surfaced by the cons:**
- Per-invocation memoization keyed on `(identity, scope, table)` to bound predicate N+1 cost — getting this wrong produces stale permissions (security) or over-invalidation (performance).
- Explicit traversal depth limits on tuple-graph walks to prevent read-set fan-out.
- Atomic effective-permission recomputation within the same mutation transaction that changes a role assignment — must not hold the single-writer lock for O(permissions × scopes) writes.

**Optional escape hatch:** Publish `@stackbase-community/authz-openfga` (or SpiceDB variant) behind the identical `ctx.authz` interface for teams running centralized cross-service authz outside Stackbase. The interface contract must be stable before either adapter is written.

### What to Borrow from the Losers

**From convex-authz:** Take the pre-flattened `effectivePermissions` write-time-cost model — correct for a reactive system where checks re-run on every invalidation. Take the `definePermissions`/`defineRoles` typed-declaration ergonomics — declare permissions once as a TypeScript object, never scatter magic strings across mutation bodies. Consider the expiring grants and audit log patterns as Layer 2 additions.

**From OpenFGA:** Take the principle that there should be ONE version-controlled authoritative declaration of every permission shape in the deployment — not logic spread across individual function bodies. Express this as a single TypeScript permission schema (not a separate `.fga` DSL), preserving the single-language DX.

**From SpiceDB:** Take the relationship-tuple shape and the arrow/inheritance idea for Layer 3. Note that Stackbase's single-writer OCC transactor already provides the causal consistency that ZedTokens exist to recover in a distributed system — adopt the tuple model, skip the token machinery.

**From RLS:** Take the load-bearing insight that enforcement must be structurally impossible to bypass — and relocate that guarantee from the database to the function-execution kernel (the actual trust boundary). Optionally document lightweight Postgres `CHECK` constraints or ownership policies as defense-in-depth for operators who expose the DB port directly, without requiring them as the primary model.

---

## What This Means for `components/authz`

The roundtable verdict implies the following concrete build steps for the `components/authz` directory:

1. **Kernel seam hook** — Add `rowRules` to the table definition surface in the schema package. Wire rule evaluation into `kernel.ts`'s existing `requireOwnTable` / db-op handlers. Write tests proving: (a) a query without any authz call is still blocked by a row rule, (b) revoking a role membership immediately invalidates a live subscription (reactive revocation), (c) rules are adapter-agnostic (run the same test against both SQLite and Postgres adapters).

2. **Component schema** — Create `packages/components/authz/src/schema.ts` with `authz/roles`, `authz/role_assignments`, and a seam-reserved `authz/tuples` table (defined but not yet queried by default). Use Stackbase's existing `defineTable`/`defineSchema` surface.

3. **Context facade** — Create `packages/components/authz/src/context.ts` exporting `buildAuthzContext`. Add `contextType` declaration pointing at the exported TypeScript types for codegen integration. Declare `requires: ["auth"]` to wire `ctx.auth.getUserId()` as the identity anchor.

4. **Per-invocation memoization** — Implement a lightweight request-scoped cache inside `buildAuthzContext` keyed on `(identity, scope, table)`. This is a prerequisite for Layer 1 correctness, not a Layer 2 optimization.

5. **Pre-flattened effective permissions** — Design the `authz/role_assignments` write path to recompute and cache a flat `authz/effective_permissions` index inside the same mutation transaction. All `ctx.authz.can()` checks read from this index (O(1)) rather than traversing the role graph at check-time.

6. **Layer 3 seam** — Define the `authz/tuples` table and `ctx.authz.related()` stub that returns `false` with a clear TODO comment. This reserves the interface so app code that starts using it compiles today and gets real behavior when the traversal is implemented.

7. **Community adapter interface** — Define and export a stable `AuthzAdapter` interface that both the native implementation and a future `@stackbase-community/authz-openfga` package would satisfy. Stability of this interface is a prerequisite for any external adapter work.

8. **Security test suite** — Write tests covering: inherited permissions (role grant propagates to child scope), wildcard grants, cross-tenant isolation (tenant A's role assignment cannot satisfy tenant B's authz check), and revocation latency (revocation must invalidate within the same OCC transaction boundary, not eventually).
