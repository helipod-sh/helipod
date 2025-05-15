---
title: Internals — Platform Services (Auth, Scheduler, System, HTTP, Storage Abstractions)
status: extracted (clean-room notes; concave studied as reference)
---

# Platform Services

These are clean-room design notes for Stackbase, written after studying the
concave reference distribution (FSL-1.1-Apache-2.0) at the `.d.ts` contract
level. Nothing here is copied verbatim; the goal is to capture the *shape* of
each platform service so we can build our own implementation. Where useful we
cite concave type/method names so future readers can cross-reference, but the
contracts below are framed as **what Stackbase will build**.

The unifying theme across all of these subsystems is the same one that drives
our DocStore design: **narrow interfaces with swappable implementations**. Auth
is an injected resolver, not a global. Storage/search/vector are adapter
interfaces. The scheduler and crons are just rows in system tables that an
executor scans. At Tier 0 every implementation is thin and in-process; the
seams exist so we can later swap in distributed backends without touching
callers.

---

## Auth

The reference splits authentication ("who are you?") from authorization ("are
you allowed?") cleanly, and we will keep that split. The central design move —
which we adopt wholesale — is **no global mutable auth state**. The reference
explicitly calls out replacing earlier `setAdminAuthConfig` /
`setSystemAuthConfig` / `setJwtValidationConfig` global setters with an injected,
request-scoped resolver. Stackbase does the same: every request handler is
constructed with the config it needs.

### Principal — the unified identity

A request, regardless of transport (HTTP, WebSocket, internal call), resolves to
a single immutable `Principal` before any policy check. Our `Principal` carries:

- `kind`: one of `user | admin | system | service | none`. This is the
  coarse-grained category that drives most policy.
  - `user` — end user authenticated via JWT/OIDC.
  - `admin` — dashboard / deploy-key / admin-token caller.
  - `system` — internal callers (scheduler, cron, sync infrastructure).
  - `service` — machine-to-machine API keys / service tokens.
  - `none` — anonymous/unauthenticated.
- `tenantId?`: which project/tenant the principal is scoped to (absent for
  single-tenant/local dev).
- `scopes`: a readonly array of fine-grained `ManagementCapability` values.
  These only matter for admin/service principals hitting management APIs.
- `userIdentity?`: OIDC-style identity attributes, present for `user` (and when
  an admin impersonates a user).
- `token?`: the raw token used (opaque to consumers, kept for audit).
- `label?`: human-readable label for audit logs (email, service name).

Design rules we keep: a Principal is **immutable after construction** and
**self-describing** — no code anywhere does "am I admin? check the global"; the
Principal already carries the answer. We'll provide constructor helpers
(`anonymousPrincipal`, `userPrincipal`, `adminPrincipal`, `systemPrincipal`,
`servicePrincipal`) and predicate helpers (`hasCapability`, `canCallInternal`,
`canAccessComponents`). Wildcard scope `"*"` grants everything; admin/system in
insecure dev mode get an implicit `"*"`.

`ManagementCapability` is a closed string-union of fine-grained grants:
`tables:read/write`, `documents:read/write`, `functions:list/execute`,
`storage:read/write`, `scheduler:read/write`, `logs:read/write`,
`analytics:read`, `schema:read`, `components:read`, `deploy:write`, and `*`.

There is a `LegacyAuthContext` bridge in the reference (`{ tokenType, token,
userIdentity }`) with `principalToLegacyAuthContext` /
`legacyAuthContextToPrincipal` converters. That exists purely for a migration
seam between the new Principal model and an older WebSocket/HTTP auth-context
shape. Stackbase should design the Principal in from day one and **not** carry
this legacy shape — we note it only so we don't accidentally reproduce a
migration artifact as if it were essential.

### AuthResolver — token → Principal

The resolver is the single seam through which identity reaches functions. The
contract is one async method:

- `resolve(request: AuthResolveRequest): Promise<AuthResolveResult>`

`AuthResolveRequest` is everything the transport knows: the raw bearer `token?`,
a `tokenTypeHint?` (`"auto" | "Admin" | "System" | "User" | "None"` — HTTP uses
`"auto"` and the resolver sniffs; WebSocket passes the explicit kind from its
Authenticate message), an optional `impersonating` identity (for admin/system
impersonation), and a `tenantId?`. `AuthResolveResult` returns the resolved
`principal` plus a convenience `userIdentity?` copy.

Key contract rule we adopt: **resolvers MUST NOT throw on invalid tokens**. They
either return an anonymous principal or a well-typed error the caller can map to
401/403. This keeps the unauthenticated path cheap and predictable.

Concrete implementations we plan to mirror:

- `DefaultAuthResolver` — constructed with explicit injected config
  (`DefaultAuthResolverConfig`): optional `adminAuth`, `systemAuth`,
  single `jwtConfig`, an ordered list of `jwtProviders` (tried in order,
  first verification wins, checked before the single fallback), `tenantId`,
  `allowInsecure` (dev mode where admin/system tokens aren't required), and an
  optional `managementJwt` config (below). It exposes `updateJwtProviders()` so
  providers loaded later (after module loading at listen-time) can be injected
  post-construction.
- `TenantAuthResolver` — resolves per-tenant config at runtime via a
  `TenantAuthConfigProvider.getTenantAuthConfig(tenantId)`, caches per-tenant
  resolver instances with a TTL (reference default ~30s), and falls back to a
  `fallbackResolver` when a tenant has no config. Requires `request.tenantId`.
- `StaticTenantAuthConfigProvider` — a trivial map-backed provider for
  tests/static deployments.

There are also env-bootstrap helpers (`createDefaultAuthResolverFromEnv`,
`createTenantAuthResolverFromEnv`, `createInsecureAuthResolver`,
`resolveManagementJwtConfigFromEnv`, `resolveTenantAuthConfigFromEnv`) that build
resolvers from a plain env object — importantly **without** reading any global
mutable config. Stackbase keeps the same "env → config object → resolver"
discipline.

#### Scoped management JWTs

For admin/system access the reference supports signed JWTs carrying tenant
binding + fine-grained scopes, via `ScopedManagementJwtConfig`. This is a nice
upgrade over a single shared admin token, and we'll adopt the model: a
`validation` (JWT verification settings), configurable claim names
(`scopesClaim` default `"scopes"`, `tenantClaim` default `"tenantId"` with
`tenantClaimFallbacks`, `tokenTypeClaim` default `"tokenType"`, `labelClaim`),
toggles (`requireTokenTypeClaim`, `requireTenantBinding` default true,
`requireScopes` default true, `defaultScopes` default `["*"]`), static
`revokedJtis`, and a dynamic `isRevoked(...)` hook returning boolean/promise for
revocation checks keyed on `jti`/tenant/tokenType/claims.

### JWT verification

The JWT module gives us the user-token path. The pieces we replicate:

- `JWTClaims` — standard OIDC claim bag (`sub`, `iss`, profile fields, `email`,
  `aud`, `exp`/`iat`/`nbf`, `jti`, plus arbitrary extras).
- `JWTValidationConfig` — `issuer`, `audience`, `jwksUrl`, `secret`,
  `algorithms`, `skipVerification`, `clockTolerance`, and `jwksCacheTtlMs`
  (cached remote JWKS resolver TTL, reference default 5 min).
- Conversions both directions between OIDC claims and identity attributes
  (`identity2claims` / `claims2identity`), plus an unsafe decoder
  (`decodeJwtClaimsToken` / `decodeJwtUnsafe`) for inspection without
  verification.
- Verification entrypoints: `verifyJwt`, `verifyJwtAndGetIdentity`,
  `identityFromToken`. Trusted-token shortcut: `identityFromTrustedToken` for
  internally-minted tokens.
- A typed `JWTValidationError` with a closed `JWTValidationErrorCode` union
  (`MISSING_CONFIG`, `INVALID_SIGNATURE`, `TOKEN_EXPIRED`, `TOKEN_NOT_ACTIVE`,
  `CLAIM_VALIDATION_FAILED`, `MISSING_SUBJECT`, `MISSING_ISSUER`,
  `INVALID_TOKEN`).
- Admin/system token configs (`AdminAuthConfig`, `SystemAuthConfig`, each just
  `{ token?, allowInsecure? }`) with matching `AdminAuthError`/`SystemAuthError`
  and `isAdminToken`/`assertAdminToken` (and system equivalents). Env resolvers
  (`resolveAdminAuthConfigFromEnv`, etc.) build these.
- `WELL_KNOWN_JWKS_URLS` convenience builders for Auth0, Clerk, Supabase,
  Firebase. We'll keep a small registry like this so common providers are
  one-liners.

### Auth providers / config (auth.config.ts)

Projects can declare auth providers in an `auth.config.ts` (Convex convention).
`AuthConfigService` lazy-loads and caches them (same lazy-load+cache pattern as
our schema service), and gracefully returns `[]` when no file exists. Two
provider shapes:

- OIDC provider: `{ domain, applicationID? }` — JWKS discovered via OIDC from
  the domain.
- Custom JWT provider: `{ type: "customJwt", issuer, jwks, applicationID?,
  algorithm? }` — explicit issuer + JWKS endpoint/data-URI.

`providerToJwtConfig(provider, jwksUrl?)` maps an entry to a
`JWTValidationConfig`. The service's `getProviders()` returns the list that gets
fed into `DefaultAuthResolver.jwtProviders` / `updateJwtProviders`.

### Authorization policy

Separate from authentication. The policy is a pure function
`authorize(principal, action): AuthorizationDecision`. An `AuthorizationAction`
is a discriminated union over what the caller wants to do:

- `call_function` (with `functionPath`, `isInternal`, optional `componentPath`)
- `call_system_function` (`functionName`)
- `access_component` (`componentPath`)
- `management_operation` (`capability`, optional `resource`)
- `custom` (`name`, `metadata`)

`AuthorizationDecision` is `{ allowed: true }` or `{ allowed: false, reason,
code? }`. The `DefaultAuthorizationPolicy` encodes the baseline rules we want:
internal functions require admin/system/service; component-scoped calls require
admin/system; `_system:*` functions require admin/system/service; management ops
check the fine-grained capability; ordinary public functions are open to all.
Design goals we keep: **composable** (chain policies first-allow-wins or
all-must-allow), **auditable** (every decision is structured/loggable), and
**testable** (pure of `(Principal, Action)`). A `requireAuthorization(principal,
action, policy?)` helper throws at enforcement points (HTTP handler, UDF
dispatch).

### How identity reaches functions (ambient context)

Once resolved, the Principal/identity is made ambient via an
AsyncLocalStorage-backed context (with a correct serialized-execution fallback
where ALS isn't available). The API: `getAuthContext()` returns the current
`UserIdentityAttributes | undefined`, `getPrincipal()` returns the current
`Principal | undefined`, and `runWithAuth(auth, fn, principal?)` /
`runWithAuthSync(...)` execute `fn` with that context propagated through all
nested async calls. This is how a UDF reads `ctx.auth` without threading
identity through every call. Stackbase uses the same ambient pattern at Tier 0.

---

## Scheduler & crons

Both the one-shot scheduler and the cron system are **durable via system
tables** — there is no in-memory job queue that loses state on restart. Jobs are
rows; an executor periodically scans for due rows, runs them, and writes back
state. This is the design we want for Tier 0: simple, restart-safe, and uses the
same DocStore we already have.

### Scheduled (one-shot) functions

`ScheduledFunctionExecutor` is constructed with a `docstore`, a `udfExecutor`
(`UdfExec`), and tuning options: `notifyWrites` (invalidation callback so
subscriptions update when the job writes), `allocateTimestamp`/`now` (injected
clocks for testing/determinism), `logger`, `runMutationInTransaction` (wrap the
state mutation transactionally), `tableName` (which system table holds jobs),
`maxConcurrentJobs`, and `scanPageSize`.

The runtime surface is tiny:
- `runDueJobs(): Promise<ScheduledExecutionResult>` — scans for jobs whose time
  has passed, executes up to the concurrency limit, returns
  `{ executed, nextScheduledTime }`.
- `getNextScheduledTime(): Promise<number | null>` — for the host loop to decide
  when to wake next.

Internally (private) it paginates the job table, executes each job through the
UDF executor, and updates job state. The host process drives this by calling
`runDueJobs` on a timer (or sleeping until `nextScheduledTime`).

The **kernel-facing** side is `SchedulerGateway`, the API a running function
calls to schedule/cancel work: `schedule(name, fnArgs, ts, componentPath) =>
Promise<string>` (returns the scheduled job id) and `cancel(id, state?)`. It's
built with a `KernelContext`, a `DocAccess` handle, and an `idGenerator`. So:
user code calls `ctx.scheduler.runAfter(...)` → `SchedulerGateway.schedule`
writes a row → `ScheduledFunctionExecutor.runDueJobs` later picks it up.

### Cron jobs

`CronExecutor` mirrors the scheduled executor (same `docstore`/`udfExecutor`/
clocks/concurrency options) but is backed by the `_crons` system table and adds
spec syncing. A `CronSpec` has `name`, a `schedule`, `functionPath`, optional
`args`, and optional `componentPath`. A `CronSchedule` is either
`{ type: "cron", cronspec }` (cron expression like `"0 * * * *"`) or
`{ type: "interval", seconds }`.

The persisted `CronJobState` row adds bookkeeping: `_id`, `_creationTime`, the
schedule, function path, an optional resolved `functionType` (`mutation` |
`action`, cached so the executor doesn't have to guess at run time), `args`,
`componentPath`, `lastRun?`, `nextRun`, and `lastRunState?`
(`{ kind: "success" }` or `{ kind: "failed", error }`).

Methods:
- `syncCronSpecs(cronSpecs)` — reconcile definitions from the user's
  `convex/crons.ts` into the `_crons` table (add/update/remove rows).
- `runDueJobs()` — run any cron whose `nextRun` has passed, recompute and store
  the next `nextRun`, record success/failure.
- `getNextScheduledTime()` — earliest next run across all crons.

Cron specs are **discovered by introspection** (see below):
`discoverCronSpecs()` analyzes the registered modules, finds the crons module
(the one with a default-exported Crons object), and also resolves each target
function's type so it can annotate the spec's `functionType`. Stackbase keeps
this "specs live in code, get synced into a durable table, executor scans the
table" model.

**Durability note:** because both executors read/write through the DocStore and
write back `lastRun`/`nextRun`/`lastRunState`, a crash mid-run is recoverable —
on restart the executor simply re-scans for due rows. We must make job execution
idempotent or at-least-once aware; the reference's success/failure state lets us
detect and avoid double-running where it matters.

---

## System tables & functions

The `_`-prefixed internal tables and the introspection/admin functions that the
dashboard reads.

### System tables & bootstrap

System tables are reserved by name with fixed table numbers
(`SYSTEM_TABLE_NUMBERS`) and a visibility flag (`public` | `private`) via
`SystemTableDefinition` / `SYSTEM_TABLE_DEFINITIONS`. Helpers:
`getSystemTableDefinition`, `isPublicSystemTable`, `getReservedSystemTables`.

`SystemMetadata` is a singleton metadata document (global key
`concave:system_metadata:v1`) recording bootstrap state: `version`,
`bootstrapped`, the `tableIdStrategy` (`registry_u32`), `developerIdCodec`
(`convex_base32`), `nextUserTableNumber`, `registryVersion`, an optional
`runtimeMetadataVersion`, and timestamps. User table numbers are allocated
sequentially above the reserved system range, and individual reservations use a
`concave:table_number:<n>` key prefix.

Two bootstrap operations, each returning timing stats so we can observe startup
cost:
- `ensureSystemTablesBootstrapped(docstore)` → `EnsureSystemTablesStats` —
  idempotently creates the reserved system tables and the metadata doc (skips if
  already bootstrapped).
- `syncRuntimeMetadata(docstore, tableRegistry, loadedRuntimeMetadata?,
  existingMetadata?)` → `SyncRuntimeMetadataStats` — writes schema docs, schema
  progress, and index metadata derived from the loaded modules, and bumps the
  metadata version. `computeRuntimeMetadataVersion(modules)` produces a content
  hash so this only runs when modules actually change.

There's a family of helpers for table metadata documents
(`createTableInfo`, `createTableMetadataEntryForUserTable`,
`createTableMetadataDocumentId`, `tableInfoFromStoredDocument`,
`parseStoredTableFullName`, `fullTableNameMatches`, `tableInfoMatchesName`,
`nextUserTableNumber`) — i.e. the read/write codecs for the table catalog stored
in the DocStore. Stackbase needs the same: a durable catalog of tables + an
idempotent bootstrap + a content-hashed metadata sync.

### System functions (dashboard introspection)

These power the dashboard's data browser and admin views. They are plain
functions over the DocStore, not magic:

- `listTables(docstore)` → `SystemTableInfo[]` (name, documentCount, indexes,
  searchIndexes?, vectorIndexes?).
- `getTableSchema(tableName)` → `SystemTableSchema | null` (fields with type/
  optional/description, plus index/searchIndex/vectorIndex definitions).
- `listFunctions(componentPath?)` → `SystemFunctionInfo[]` (name, type
  query/mutation/action/http, path, isInternal?, httpMethod?, httpPath?).
- `getTableData(docstore, tableName, { page, pageSize, orderBy, order })` →
  paginated `{ data, total, page, pageSize, hasMore }`.

The reference also exposes `system-functions-module` and `internal` re-exports
(wiring these as actual callable `_system:*` functions) — we'll expose ours the
same way so the dashboard calls them like any other internal function, gated by
the authorization policy.

### Function introspection

`SystemAnalyzedFunction` is the richer static-analysis record: `name`, `module`,
`path`, `type`, `visibility` (`public`/`internal`/null), optional `args`/
`returns` validators, `source`, `componentPath`, and HTTP method/path. This comes
from analyzing the registered modules (not runtime registration), with a cache
that `clearSystemFunctionIntrospectionCache()` resets.
`listSystemFunctions({componentPath?})` returns them; `discoverCronSpecs(...)`
(described under crons) is the same analysis machinery used to find the crons
module. Stackbase's introspection should likewise be **static module analysis
with a clearable cache**, since the dashboard and the cron sync both depend on
it.

### Execution log

A fixed-size in-memory ring buffer feeds the dashboard's logs tab.
`ExecutionLogEntry` records `id`, `timestamp`, `functionName`, `functionType`,
`status` (success/error), `duration`, `logLines[]`, optional `error`,
`requestId`, and an optional `trace` (UDF trace). It implements the `LogSink`
abstraction (below). `InMemoryLogSink(maxEntries)` keeps the newest N entries and
evicts oldest; `query(filter)` supports `limit`/`functionType`/`status`/`search`
and returns newest-first; `NoopLogSink` discards everything for production where
log storage isn't wanted. There are also module-level convenience functions
(`pushExecutionLog`, `queryExecutionLog`, `clearExecutionLog`,
`executionLogSize`) over a default singleton buffer. We keep this exact shape: a
ring buffer in dev, a no-op (or external sink) in prod, behind one interface.

---

## HTTP routing

This covers both the framework's own HTTP API (the `/api/...` endpoints the
client SDK and dashboard call) and user-defined `httpAction` endpoints.

### Core HTTP API (api-router)

`handleCoreHttpApiRequest(request, options)` is the shared router for the
built-in API surface. It returns `{ handled, response }` (or `undefined` when the
route isn't one it owns, so a host can fall through to user routes). Its
`CoreHttpApiOptions` are the injection seams:

- `executeFunction(params)` — the bridge to the UDF executor.
  `FunctionExecutionParams` = `{ type, path, args, auth?, componentPath?,
  snapshotTimestamp?, request }`; `FunctionExecutionResult` = `{ result,
  logLines, trace?, readRanges?, writtenRanges?, writtenTables?,
  commitTimestamp?, cacheStatus? }` (the read/write ranges drive subscription
  invalidation; `cacheStatus` reports miss/local-hit/edge-hit).
- `validateFunctionCall?` — pre-flight hook (e.g. authorization).
- `notifyWrites?` — invalidation broadcast after writes.
- `storage?` — a `StorageAdapter` with `store(blob, request) =>
  { storageId, writtenRanges?, writtenTables? }` and `get(storageId, request) =>
  { blob, headers? }`. This is the HTTP-facing storage seam (distinct from the
  lower-level `BlobStore`).
- `corsHeaders?`, `getSnapshotTimestamp?`, and `authResolver?` (the AuthResolver
  above).

Helper functions we'll mirror: `parseAuthorizationTokenHeader(authHeader)`
(extract bearer token), `computeCorsHeaders(request)` / `applyCors(response,
headers)`, and `resolveAuthContext(bodyAuth, headerToken?, headerIdentity?,
authResolver?)` which centralizes "given what the request presented, what's the
auth context" using the resolver.

### HttpHandler (host wiring)

`HttpHandler` is the concrete object a runtime host (Bun/Node/Workers) constructs
to serve requests. It takes a `UdfExec`, a `runtimeName`, an optional
`UdfExecutionAdapter`, and `HttpHandlerOptions`: `services` (a `Pick` of
`RuntimeServices` — just `docstore` + `blobstore`), `notifyWrites`, `isDev`, and
an optional `authResolver`. Its single public method is `handleRequest(request)
=> Promise<Response>`. Internally it owns a query cache, the execution adapter,
and the auth resolver, and delegates the core API routes to the api-router. The
docstring notes the `authResolver` is the migration path away from inline
global-config auth logic — Stackbase starts there: **always inject the
resolver**.

### User httpAction endpoints

`SystemFunctionInfo` / `SystemAnalyzedFunction` carry `type: "http"` plus
`httpMethod` and `httpPath`, so user-registered HTTP endpoints are discovered by
the same introspection and routed by path/method. Our router dispatches: built-in
`/api/*` → core handler; otherwise match against registered httpActions; else
404.

---

## Blob / search / vector store abstractions

These are the same **swappable-seam pattern as DocStore**: a narrow interface,
multiple adapters, chosen at host-construction time. The reference groups them
under `abstractions/` and a `RuntimeServices` bundle.

### BlobStore

Platform-agnostic blob storage. Interface methods:
- `store(blob | ArrayBuffer, options?) => StorageMetadata` where
  `StorageMetadata` = `{ _id, sha256, size, contentType?, uploadedAt }` and
  `StorageOptions` = `{ contentType?, storageId? }`.
- `get(storageId) => Blob | ArrayBuffer | null`
- `delete(storageId)`
- `getUrl(storageId) => string | null` (public URL if the backend supports it,
  else null).

Reference adapters named in the doc comment: `R2BlobStore` (Cloudflare R2),
`S3BlobStore` (S3-compatible), `FsBlobStore` (local Node/Bun filesystem).
Stackbase Tier 0 ships the filesystem adapter and leaves the cloud ones as
later drop-ins.

The kernel-facing wrapper is `BlobStoreGateway` (built with `KernelContext`,
`DocAccess`, a `QueryRuntime`, an optional `BlobStore`, and an `idGenerator`).
It's what user code's `ctx.storage` talks to: `isConfigured()`, `store(blob) =>
storageId`, `get(storageId)`, `getPublicUrl(storageId, fallbackUrl?)`,
`getMetadata(storageId) => { storageId, sha256, size, contentType }`,
`delete(storageId)`. Note it couples blob bytes (in the `BlobStore`) with blob
*metadata rows* (in the DocStore via `DocAccess`) — storing a blob writes both.
`requireStorage()` (private) throws a clear error when no backend is configured,
which maps to the `StorageNotConfiguredError` below.

### SearchStore

Full-text search seam. Optional lifecycle methods plus one required query:
- `setupSchema?({ searchIndexes? })` — provision indexes.
- `syncWrites?(documents)` — keep the index in sync with document log entries.
- `search(indexId, searchQuery, filters: Map, { limit? }) =>
  { doc, score }[]` — ranked results.

`isSearchStore(value)` is a runtime guard. `createDocStoreSearchStore(docstore)`
returns a SearchStore backed by the DocStore itself (i.e. the Tier 0 default —
search without a separate engine), or `undefined` if unsupported. Stackbase
follows this: a built-in DocStore-backed search for Tier 0, with the interface
ready for an external engine later.

### VecStore

Vector search seam, same shape:
- `setupSchema?({ vectorIndexes? })`
- `syncWrites?(documents)`
- `vectorSearch(indexId, vector: number[], limit, filters: Map) =>
  { doc, score }[]`

`isVecStore(value)` guards it. No DocStore-backed default is provided in the
reference (vector search generally needs a real index), so at Tier 0 we either
ship a brute-force in-memory cosine implementation or leave it unconfigured.

### LogSink

Already covered under the execution log — it's the abstraction the system log
implements: `record(entry)` + `query(filter)`, with in-memory and no-op
adapters. Same pattern: dev gets the ring buffer, prod gets no-op or an external
sink.

All of these (DocStore, BlobStore, SearchStore, VecStore, LogSink) compose into
a `RuntimeServices` bundle that the host assembles once and threads through. The
HTTP handler only needs a `Pick` of it (`docstore` + `blobstore`), illustrating
that callers depend on the **narrowest slice** they need.

---

## Error model

A single structured hierarchy maps cleanly to HTTP status codes and to
client/dashboard/monitoring handling. Base class `ConcaveError` (Stackbase:
`StackbaseError`) carries `code` (machine-readable), `httpStatus`, `retryable`,
optional `data`, and a `cause`. It serializes via `toJSON()` to
`{ error, code, message, retryable, data? }` for API responses.

Five families, by HTTP semantics:

- **UserError → 400** — developer mistakes. Subclasses:
  `ArgumentValidationError`, `DocumentNotFoundError`, `DocumentValidationError`,
  `FunctionNotFoundError`, `FunctionTypeMismatchError`, `QueryError`,
  `IndexNotFoundError`, `SystemFieldModificationError`, `SchedulingError`,
  `ForbiddenOperationError` (e.g. calling `fetch`/`setTimeout` inside a
  query/mutation).
- **AuthenticationError → 401** and **AuthorizationError → 403** (the latter
  with an optional `requiredRole`); plus `InternalFunctionAccessError` (403,
  carries the `functionPath` a client illegally tried to call).
- **ConflictError → 409** — `OccConflictError` for optimistic-concurrency
  conflicts (retryable; named distinctly from the transactor's internal simpler
  conflict error — worth keeping that naming discipline so the public API error
  and the internal control-flow error don't collide).
- **SystemError → 500** — internal failures: `DatabaseError`, `StorageError`,
  `StorageNotConfiguredError`, `UdfExecutionError`, `ModuleLoadError`.
- **TransientError → 503** — retryable with optional `retryAfterMs`:
  `TimeoutError`, `RateLimitError`, `ServiceUnavailableError`.

Helpers: `isConcaveError`, `isRetryableError`, `getHttpStatus(error)`, and
`toConcaveError(error)` (normalize any thrown value). Stackbase adopts this
structure verbatim in spirit: every error knows its own HTTP status and
retryability, so the HTTP layer can serialize any thrown error correctly without
a giant switch.

---

## How Stackbase reimplements this

- **Keep it thin and in-process at Tier 0.** Scheduler and crons are rows in
  system tables scanned by an in-process executor on a timer; no external queue.
  System functions are plain functions over the DocStore. The execution log is
  an in-memory ring buffer. This matches the reference's own defaults
  (`InMemoryLogSink`, DocStore-backed `SearchStore`, `FsBlobStore`).
- **Adapters for files / search / vector.** Define `BlobStore`, `SearchStore`,
  `VecStore`, `LogSink` as narrow interfaces up front; ship filesystem +
  DocStore-backed implementations for Tier 0; leave R2/S3 and external
  search/vector engines as drop-in adapters chosen at host construction. Bundle
  them in a `RuntimeServices` object and let each caller take the narrowest
  `Pick`.
- **Auth is pluggable and global-free from day one.** Inject an `AuthResolver`
  into every handler; never reach for global mutable auth config. Model identity
  as an immutable `Principal` (kind + scopes + tenant + identity), separate
  authentication (resolver) from authorization (pure policy of
  `(Principal, Action)`), and propagate identity ambiently via
  AsyncLocalStorage. Support env-bootstrapped resolvers, ordered JWT providers
  from `auth.config.ts`, scoped management JWTs, and a tenant-aware resolver
  with TTL caching for future multi-tenancy — but none of that needs to be wired
  on for single-tenant local dev.
- **One error hierarchy that owns its HTTP mapping.** Every error carries `code`
  / `httpStatus` / `retryable` and a `toJSON()`, so the HTTP layer serializes
  uniformly.

---

## Open questions / risks

- **Convex compatibility surface.** The reference leans on `convex/server`
  types (`UserIdentityAttributes`), the `auth.config.ts` provider convention,
  `_system:*` function naming, and `_crons`/cron-spec parsing from
  `convex/crons.ts`. We must decide how much Convex wire/convention compat
  Stackbase commits to vs. defining our own; the more we match, the more we
  inherit their semantics (and constraints).
- **Scheduler durability semantics.** "Scan due rows, run, write back state"
  gives at-least-once. We need to define idempotency expectations for scheduled
  mutations/actions, behavior on crash mid-action (actions aren't
  transactional), and whether `runMutationInTransaction` is mandatory for the
  state write-back. Also: leader election / single-runner guarantee if more than
  one host process exists (the in-process executor assumes one runner).
- **Cron spec drift.** Specs come from static module analysis (`discoverCronSpecs`)
  then sync into `_crons`. We must define reconciliation on deploy (removed
  crons, changed schedules, in-flight runs) and how `functionType` caching
  invalidates when a function's kind changes.
- **Management JWT revocation.** The `isRevoked` hook is per-request and can be
  async — that's a latency/availability dependency on the hot auth path. Need a
  caching/timeout story so a slow revocation backend can't stall every request.
- **Tenant resolver cache coherence.** Per-tenant config cached with a ~30s TTL
  means config changes take up to the TTL to propagate, and a missing tenant
  silently falls back to the fallback resolver. We need explicit invalidation
  and clear behavior (fail-closed vs fall-back) when tenant config is absent.
- **Ambient auth without ALS.** The reference notes a serialized-execution
  fallback when AsyncLocalStorage is unavailable. We must confirm our target
  runtimes (Workers in particular) all support ALS or that the fallback is truly
  safe under concurrency.
- **Storage metadata/bytes consistency.** `BlobStoreGateway` writes a metadata
  row (DocStore) and bytes (BlobStore) separately. A crash between the two
  orphans bytes or dangles metadata; we need a reconciliation/GC story.
- **Search/Vector at Tier 0.** DocStore-backed search may not scale or rank
  well; there is no built-in vector default at all. We must decide the Tier 0
  quality bar (brute-force vectors? no vectors until an adapter is configured?).
- **Error taxonomy fidelity.** Keeping `OccConflictError` distinct from the
  transactor's internal conflict error is a deliberate naming discipline; we
  need to enforce it so internal control-flow errors never leak to clients.
