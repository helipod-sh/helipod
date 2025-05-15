---
title: Internals — UDF Execution (User Functions)
status: extracted (clean-room notes; concave studied as reference)
---
# UDF Execution (User Functions)

> Clean-room notes. We studied concave's published type declarations (`.d.ts`)
> to understand the *contracts* of its UDF runtime, then describe — in our own
> words — what **Stackbase** will build. No implementation source was read or
> copied; we reference concave only to name the surface area we must match for
> behavioral compatibility.

UDF = "user-defined function." These are the queries, mutations, and actions
that an app developer authors in TypeScript and we run on the server. The
subsystem covered here is the path from "a request names a function" to "that
function's code runs in a controlled environment, calls back into the engine
for data, and returns a serializable result with its read/write footprint."

---

## Purpose & the query/mutation/action distinction at runtime

There are three (really four) function flavors, and the runtime treats them as
distinct **execution environments**, not just as a tag. The reference encodes
this as an environment profile per type (`query`, `mutation`, `action`,
`httpAction`). For Stackbase we adopt the same per-type profile object, with
these runtime-relevant differences:

- **Query** — read-only, deterministic, snapshot-pinned. Runs against a fixed
  read snapshot; no writes, no network, no wall-clock, no real randomness. Its
  output includes the **read ranges** it touched so the subscription/OCC layer
  can invalidate it later.
- **Mutation** — read+write, deterministic, transactional with OCC retry. Runs
  inside an optimistic-concurrency transaction; on conflict it re-runs (bounded
  retry count). Emits both read and **written ranges** plus a commit timestamp.
- **Action** — non-deterministic, non-transactional. May use real randomness,
  real time, `fetch`, and timers, and may *call* queries/mutations (and other
  actions) but cannot touch the database directly. No snapshot pinning.
- **HTTP action** — like an action but entry/exit is a `Request`/`Response`
  rather than structured args/result.

The per-type contract we mirror (concave: `UdfEnvironmentProfile`) carries:
`id` (which type), `seedKind` (how the deterministic seed is derived),
`syscallApi` (which syscall ABI version), `deterministicExecution` (bool),
`capabilities` for `cryptoGetRandomValues` / `fetch` / `timers` each set to
`forbidden` or `native`, `snapshotPinning` (`pinned` | `none`), `transaction`
(`none` | `occ-retry`), and `maxRetries`. Stackbase keeps this as a small
table of four frozen profiles selected by function type — it is the single
place that says "queries cannot fetch, actions cannot read the db inline,"
etc.

The reference exposes the shared result shape (`UdfResult`) that every flavor
returns. Stackbase's equivalent carries: the JSON `result`; the serialized
`readRanges` and `writtenRanges` (key-range footprint for OCC/subscriptions);
captured `logLines`; an optional execution `trace`; an `authAccessed` flag
(did the function look at identity — affects cacheability); and the
`snapshotTimestamp` (queries) / `commitTimestamp` (mutations) used by
OCC-aware subscriptions.

---

## Module loading & analysis

User code is organized as **modules** addressed by a normalized specifier
(e.g. `messages`, or `someComponent/messages`). Before any function runs, the
runtime must discover modules, find the exported function by name, and know its
arg/return validators.

**Module registry & loaders.** The reference models a `ModuleRegistry` holding
ordered `ModuleLoader`s, scoped by component path (root loaders plus
per-component loaders), with register/unregister, clone, and reset. A loader is
just `(modulePath, context) => module | undefined`, where the context carries
the normalized `path`, optional `componentPath`, a `hint` (`udf` | `http` |
`schema` | `generated` | `manifest` | `unknown`), and the current `scope`.
Registry also supports **enumeration** (listing available modules) via loader
metadata, returning `ModuleListing`s (`path`, optional backing `source`,
`componentPath`, `hint`). For Stackbase:

- We build the same registry abstraction so module discovery is pluggable per
  deployment style: a glob-bundle loader for production (`createModuleLoaderFromGlob`
  equivalent — a record of `path -> () => import()`), a filesystem/dev loader,
  and component-scoped overlays.
- Global fallback matters: the reference keeps a process-global default
  registry keyed by a well-known symbol so that bundled UDF code which runs
  *outside* the async-context scope can still resolve modules across bundle
  boundaries. We replicate this with a single shared registry singleton, plus
  an async-local "current registry" override (`withModuleRegistry`).
- Change listeners (`onModuleLoadersChanged`) let caches invalidate when the
  dev server hot-swaps modules.

**Analysis.** Once a module object is loaded, we statically/structurally analyze
its exports (concave: `analyzeUdfModule`). The output (`AnalyzedModule`) is:
- `functions`: for each exported UDF — `name`, `udfType`, `visibility`
  (`public` | `internal`), the `args` and `returns` validator JSON, and a
  source `pos`.
- `httpRoutes`: parsed from an exported HTTP router (`analyzeHttp`) — list of
  `{ path, method }` with positions; methods limited to GET/POST/PUT/DELETE/
  PATCH/OPTIONS.
- `cronSpecs`: parsed from an exported crons object (`analyzeCrons`).

Analysis is what populates the function manifest the platform uses for routing,
codegen, and visibility enforcement. Stackbase produces the same analyzed shape
so our deploy/push tooling and our router agree on what exists.

**Validation.** Argument and return values are checked against validator JSON
(concave: `validateValidator`, `SchemaValidator`, `ValidatorError` carrying a
`path` to the offending field). Document writes are validated against the table
schema (`SchemaValidator.validateDocument(tableName, doc)`), with a per-table
schema cache. Validators that reference `v.id("table")` need table-number
resolution (`resolveValidatorTableNumbers`, `collectValidatorReferencedTableNames`)
so id validators can be checked against the live table registry. Stackbase
mirrors: validate args on entry, validate documents on insert/replace, and
surface a structured path-bearing error.

---

## The kernel & syscall boundary (KEY)

This is the heart of the isolation model. User code never gets direct handles
to the docstore, scheduler, or other functions. Instead, the runtime installs a
narrow set of **globals/host functions** inside the user environment, and every
privileged operation goes out through a **syscall** to the kernel, which runs in
the trusted host with full access.

**The ABI.** The reference exposes three call shapes (concave: `ffi.d.ts`):

1. `performSyscall(op, arg) -> result` — **synchronous**, JSON in / JSON out.
   The contract is explicit: arguments and return are JSON-encodable only;
   Convex-value encoding/decoding (`convexToJson` / `jsonToConvex`) is the
   caller's responsibility, so this boundary only ever moves JSON. This is the
   serialization boundary that makes the host/guest split clean.
2. `performAsyncSyscall(op, arg) -> Promise<result>` — same JSON-only contract
   but asynchronous (db reads, queries, scheduling, sub-calls).
3. `performJsSyscall(op, arg) -> Promise<result>` — escape hatch where args and
   return need *not* be JSON-encodable (passing live JS objects). Used sparingly
   for things that genuinely need structured handles.
4. `performOp(op, ...args)` — host "ops" that don't need cross-version
   compatibility (internal to the runtime+host pairing).

**The kernel.** The trusted side is a per-invocation `UdfKernel` constructed
with the runtime services, an auth context, an execution profile (udfType +
syscall API id), the read snapshot (or inherited snapshot), an optional OCC
mutation transaction, a reference to the UDF executor (for nested calls), the
component path, an id generator, and the table registry. It exposes exactly the
four entry points the guest's FFI calls land on: `syscall(op, jsonArgs)`,
`asyncSyscall(op, jsonArgs)`, `jsSyscall(op, args)`, and `op(...)`. It also
exposes the accounting the result needs: tracked read ranges, tracked write
ranges, snapshot timestamp, and whether auth was accessed; plus
`clearAccessLogs()`.

Stackbase builds the same shape: **one kernel instance per function
invocation**, holding all per-invocation mutable state, with a string-in /
string-out syscall surface so the guest boundary is a pure data interface
(works identically whether the guest is in-process or in a separate V8 isolate
talking over a serialized channel).

**Per-invocation state lives in a KernelContext** (concave: `KernelContext`),
deliberately separated from the kernel class so it can be tested and run
outside Node's async-local storage. It holds: auth context, component path,
snapshot timestamp, mutation transaction, table registry, execution profile,
and — critically — the **access logs**: read log, write log, local (uncommitted)
writes, resolved-document-target caches, a headroom/limits tracker, the
`authAccessed` flag, and a subrequest counter. Its methods are the recording
hooks the syscalls call into: `recordTableRead`, `recordDocumentRead`,
`recordIndexRange`, `recordIndexWrite`, `recordDocumentWrite`,
`recordLocalWrite`, `recordDatabaseQuery`, `recordReadValue(s)`,
`recordScheduledFunction`, `markAuthAccessed`, plus deterministic subrequest id
allocation (`nextSubrequestId`) and table-number allocation. The read/write
ranges accumulated here become the OCC footprint in `UdfResult`. We adopt this
context object verbatim in spirit: it is the ledger that makes a query's result
invalidatable and a mutation's transaction conflict-checkable.

**Syscall routing.** A `SyscallRouter` maps `op` string -> handler, split into
sync and async tables, dispatching string-JSON in/out (async handlers can opt
into `json` vs `convex` arg formats). Families of syscalls register their ops
onto the router. The op *names* are not hard-coded in the handlers; they come
from a versioned **syscall API profile** (`KernelSyscallApiProfile`, id
`convex-1.0`), which maps each logical operation to its wire op string and also
declares the developer-id format. This indirection is how the host stays
backward-compatible across client SDK versions. Stackbase keeps a versioned ABI
profile object likewise, so we can evolve op names without breaking deployed
client bundles.

The syscall families we implement (mirroring the reference):

- **Database syscalls** (`mutation`/`query` data access): `normalizeId`,
  `count`, `insert`, `get`, `remove`, `shallowMerge` (patch), `replace`. These
  resolve a document target, enforce schema validation on writes, record
  read/write footprint into the context, and route through the docstore gateway.
- **Query syscalls** (streaming index/table reads): `queryStream`,
  `queryStreamNext`, `queryPage`, `queryCleanup`. The handler holds open query
  cursors keyed by an id, pulling pages from the query runtime — this is how
  `ctx.db.query(...).paginate()`/iteration works under the hood without loading
  everything at once.
- **Schedule syscalls**: `schedule` / `cancelJob` (and action-context variants),
  routing to a scheduler gateway and recording scheduled functions into the
  context (so a mutation's scheduling is part of its transaction).
- **Action syscalls** (only available in the action environment): `actionQuery`,
  `actionCall`/`actionMutation`, `runUdf`, `createFunctionHandle`,
  `vectorSearch`, `search`. These let an action invoke other functions — routed
  through a `UdfInvocationManager`, which re-enters the executor for the named
  function with fresh per-invocation state.
- **Identity syscalls**: `getUserIdentity`, which reads the ambient auth context
  and sets `authAccessed` (so we know the function's result depends on identity).
- (Reference also has blobstore and a "headroom"/limits syscall family; we
  include the same.)

**Nested invocation.** `UdfInvocationManager.execute(path, args, type,
componentPath)` is the bridge for function-to-function calls: an action calling
a mutation, etc. It validates the call is legal for the calling environment and
spins up a fresh kernel/context for the callee. Stackbase routes all
cross-function calls through this single manager so call semantics (auth
propagation, snapshot inheritance, depth/headroom accounting) are uniform.

**Why this is the isolation boundary:** the guest only ever sees installed
globals (db/query/scheduler/auth facades) implemented purely as FFI calls that
serialize to JSON and cross into the kernel. The guest holds no live references
to engine internals. Whether the guest runs in the same process (inline) or a
separate V8 isolate, the contract is identical — which is exactly what lets us
swap the isolation mechanism without touching user code.

---

## Determinism enforcement

Queries and mutations must be **deterministic** so they can be retried (OCC) and
cached/invalidated by read footprint. The environment profile drives this; the
runtime *replaces* the non-deterministic globals rather than trusting user code
to avoid them.

**Seeded randomness.** The reference derives a deterministic RNG from a string
seed (concave: `udfRng(seed)` returning `mathRandom`, `cryptoRandomUUID`, and
`cryptoGetRandomValues`). In deterministic environments, `Math.random`,
`crypto.randomUUID`, and `crypto.getRandomValues` are all rebound to this seeded
generator, so two runs (e.g. an OCC retry) produce identical values. The seed's
provenance is the `seedKind` in the profile (per query/mutation/action/http).
Stackbase mirrors: one seeded PRNG per invocation, deterministically derived,
wired into all three randomness surfaces.

**No clock / no network / no timers in queries & mutations.** The runtime ops
table (concave: `UdfRuntimeOps`) lists every ambient capability as a nullable
slot: `mathRandom`, `dateNow`, `cryptoRandomUUID`, `cryptoGetRandomValues`,
`fetch`, `setInterval`, `setTimeout`, `console`, plus the `convex` host
interface. In a deterministic environment, `dateNow`/`fetch`/`setTimeout`/
`setInterval` are `null` (or stubbed to throw), and randomness slots point at
the seeded generator. The per-type `capabilities` map (`forbidden` | `native`)
is the policy; the ops table is the mechanism that installs or withholds each
global. Actions get `native` for fetch/timers/real-randomness; queries and
mutations get `forbidden`. Stackbase implements environment setup as: take the
profile, build the ops table, install exactly those globals into the
guest. Anything `forbidden` is either absent or a throwing stub, so a query that
calls `Date.now()` or `fetch()` fails loudly rather than reading host state.

**OCC retry uses determinism.** The reference includes
`computeOccRetryDelayMs(attempt, base, max, random)` — even retry backoff is fed
the (seeded-or-real) random fn, keeping the loop reproducible where it must be.
Stackbase keeps the retry loop in the runtime, re-running the same seeded
function on conflict up to `maxRetries`.

The deterministic execution entry points the reference exposes
(`executeUdf`, `runUdfQuery`, `runUdfMutation`, `runUdfAction`,
`runUdfHttpAction`) all take the environment profile, the docstore, the user
`fn`, and optional auth/stores/requestId/component/snapshot, and return a
`UdfResult`. These are the "run the user function under this policy and collect
its footprint" primitives. Stackbase exposes the same five.

---

## Execution adapter & executors

There are two layers above the kernel:

**Executor (`UdfExec`).** The thing that, given a function *path* and *args*,
loads the module, finds the export, sets up the environment + kernel, runs it,
and returns a `UdfResult`. Its interface (concave) is two methods:
`execute(path, args, type, auth?, componentPath?, requestId?, snapshotTimestamp?)`
and `executeHttp(request, auth?, requestId?)`. Stackbase keeps this exact
interface as our executor contract so multiple executor implementations are
interchangeable.

**Inline executor** (concave: `InlineUdfExecutor implements UdfExec`) — runs
user code in the *same process* as the engine. Constructed with `RuntimeServices`
(docstore + optional blob/search/vec stores + a reference to the executor for
nested calls), an optional logger, a request-id factory, a module registry, a
log sink, the table registry, and a shared **bootstrap state**. Notable
responsibilities visible in its shape:
- caches loaded modules and HTTP routers per process;
- `parseUdfPath` splits `"file:export"` into `[module, export]`;
- `assertFunctionExport` + `validateArgs` enforce the function exists and args
  type-check before running;
- `withAmbientAuth` installs the auth context ambiently (no manual threading
  through every call);
- `loadModule` / `resolveHttpRoute` / `loadHttpRouter` resolve code via the
  registry;
- **Bootstrap** (`InlineExecutorBootstrapState`): ensures system tables exist
  and runtime metadata is synced before the first UDF runs, memoized via a
  promise and reusable across invocations; `reset()` re-bootstraps after a
  docstore wipe (test resets). `primeBootstrap` / `primeTableRegistry` warm
  these ahead of first request. The bootstrap timing (`totalMs`,
  `ensureSystemTablesMs`, `syncRuntimeMetadataMs`, `warmTableRegistryMs`,
  `reused`) is reported for observability.

The reference name implies a counterpart "serialized"/isolated executor sharing
the same `UdfExec` interface — i.e. the inline executor is the in-process
variant, and the interface is what lets a sandboxed/isolate executor drop in.
**This is the seam Stackbase uses for V8 isolates** (see below).

**Execution adapter** (concave: `UdfExecutionAdapter`) — the single entry point
all transports (HTTP, WebSocket, internal calls) funnel through, wrapping a
`UdfExec` plus a default call type (`client` | `server`). Its
`executeUdf(path, jsonArgs, type, auth?, componentPath?, requestId?,
snapshotTimestamp?)`:
1. converts JSON args -> engine values (with validation),
2. installs the auth context ambiently,
3. installs the **call context** (client vs server),
4. delegates to the executor.

Two factories produce the two flavors: a client adapter (external requests) and
a server adapter (internal/function-to-function). Stackbase adopts this adapter
as the one place where "raw transport request" becomes "typed, authed,
context-tagged execution," so we never duplicate that glue per transport.

**Call context** (concave: `call-context.d.ts`) — an async-local record of
`{ caller: 'client' | 'server', functionPath? }`, with `runAsServerCall` /
`runAsClientCall` wrappers and `isServerCall()` / `isClientCall()` predicates.
This lets code distinguish "invoked by an end-user client" from "invoked by
another function," e.g. for visibility checks (internal functions only callable
server-side). Like the module registry, it uses a shared-symbol singleton so the
context survives bundle boundaries. Stackbase reuses this pattern.

---

## Runtime context & services

What gets injected into an invocation comes in two granularities:

**RuntimeServices** (concave) — the engine-facing bundle the executor needs:
`docstore` (required), optional `blobstore`, `searchstore`, `vecstore`, and a
back-reference `udfExecutor` (so nested calls re-enter execution). There's a
`resolveRuntimeServices` normalizer. Stackbase passes this same bundle into the
executor; it is the set of stores the kernel's syscalls operate against.

**RuntimeContext** (concave) — a higher-level, platform-pluggable view:
`docstore` (required), optional `blobstore`/`vecstore`, plus provider interfaces
for `auth` (`verifyToken` / `generateToken`) and `scheduler`
(`schedule(path, args, time)` / `cancel(jobId)`). This is the abstraction that
lets different host platforms supply their own concrete auth/scheduler/storage.
Stackbase keeps the provider-interface seam so the same UDF runtime can run on
different backing infrastructure (local dev, hosted, edge) by swapping providers.

The relationship: the **adapter** establishes ambient auth + call context, the
**executor** owns module loading + bootstrap + per-invocation setup, the
**kernel/context** holds the privileged services and the access ledger, and the
**syscalls** are the only way user code reaches any of it.

---

## Schema service

At runtime the kernel needs schema/validator info to validate writes and to
resolve index reads. The reference centralizes this in a `SchemaService`
(per component path, backed by the table registry) with a cached schema
definition and per-table cache. Its surface:
- `validate(tableName, doc)` — schema-check a document before write (delegates
  to the `SchemaValidator`);
- `getTableSchema(tableName)`;
- `getIndexFieldsForTable(table, indexDescriptor)` and
  `getAllIndexesForTable(table)` — so the query syscalls know how to build index
  range keys;
- `getSearchIndexConfig` / `getVectorIndexConfig` and the cross-table
  `getAllSearchIndexes` / `getAllVectorIndexes` — config for search/vector reads;
- `getTableNames()`.

The database syscalls receive a `SchemaService` and a `QueryRuntime`; the
service is the bridge from "table name + index name in user code" to "concrete
fields/validators the engine enforces." Stackbase builds the same service,
schema-validating on insert/replace/patch and feeding index metadata to the
query/streaming syscalls. It is cache-backed and component-scoped, and must be
invalidated when schema is re-pushed.

---

## How Stackbase reimplements this

**Same contracts, V8-isolate guest by default.** The whole design above is
built so the guest (user code) and host (kernel) communicate only through a
serialized syscall ABI. Concave's shipped variant runs user code inline (same
process). Stackbase implements the **same `UdfExec` interface** with a
**V8-isolate executor**: each invocation gets a fresh, resource-limited isolate
(or a pooled, reset one) with no ambient Node/host globals. We install exactly
the capability globals the environment profile permits, and route every db /
query / schedule / action / identity call out through `performSyscall` /
`performAsyncSyscall`. Because the kernel already speaks string-JSON in/out, the
isolate boundary is just "the channel the FFI calls cross" — inline and isolate
executors are drop-in interchangeable behind the adapter.

**Our syscall ABI.** We freeze a versioned syscall API profile (our analog of
`convex-1.0`) mapping logical ops -> wire op strings, so client bundles compiled
against an older ABI keep working. The op families are: database (get/insert/
remove/patch/replace/count/normalizeId), query streaming (open/next/page/
cleanup), schedule (schedule/cancel, + action variants), action (run another
function, create handle, vector/text search), identity (getUserIdentity), blob
storage, and a limits/headroom op. Sync ops are JSON-fast-path; async ops return
promises; a rarely-used JS-syscall path exists for non-JSON handles.

**Multi-runtime via the adapter.** The execution adapter is our single ingress:
HTTP, WebSocket, cron, and internal function-to-function calls all build a
`(path, jsonArgs, type, auth, callType)` and hand it to the adapter, which
converts args, installs ambient auth + call context, and dispatches to whichever
executor is configured. This is how we support multiple guest runtimes (inline
for dev/tests, isolate for production, potentially a remote/serialized executor
for actions that need a heavier sandbox) without the rest of the engine knowing
which is in play.

**Determinism is enforced by the host, not trusted to the guest.** We pick the
environment profile from the function type, build the ops table from its
`capabilities`, and install only those globals into the isolate. Queries and
mutations get a seeded PRNG wired into `Math.random` / `crypto.*`, no
`Date.now`, no `fetch`, no timers. Actions get the real ones. The read/write
range ledger in the kernel context produces the OCC footprint that drives both
mutation conflict detection and query subscription invalidation.

**Per-invocation kernel + context.** We construct one kernel and one
`KernelContext` per invocation, carrying snapshot timestamp, auth, component
path, mutation transaction, execution profile, and the access logs. We keep the
context as a standalone object (not fused into the kernel) precisely so it can be
created and asserted on in tests, and so a future fully-out-of-process kernel
can serialize its state.

---

## Open questions / risks

- **Isolate startup cost.** The reference runs inline, so it never pays
  isolate-creation latency. Stackbase's per-invocation isolate must be pooled
  and reset cheaply, or query latency suffers. Need a story for snapshot-based
  isolate warm-start and for resetting global state safely between invocations
  (the reference's `resetBootstrapState` / module-cache reset hints at the
  state we must clear).
- **JS-syscall path across an isolate boundary.** `performJsSyscall` explicitly
  carries non-JSON values. In an inline executor that's free; across a real
  isolate boundary it's impossible without copying/proxying. We must enumerate
  every JS-syscall use in the reference and either eliminate it (serialize) or
  build an explicit proxy/handle table. This is the biggest compatibility risk.
- **Determinism completeness.** Beyond `Math.random` / `Date.now` / `fetch` /
  timers, V8 has other non-deterministic surfaces (`crypto.subtle`,
  `Intl`/locale, `Error.stack` formatting, iteration order of weak collections,
  `performance.now`). We need an audit of which the reference neutralizes vs.
  leaves, and a policy for ours.
- **Seed provenance.** `seedKind` says *how* the seed is derived but the
  declarations don't show the exact inputs (request id? function path? attempt
  number?). We must define a seed derivation that is stable across OCC retries
  yet unique per logical invocation, and document it.
- **Syscall ABI versioning.** Only `convex-1.0` is visible. We must decide our
  own initial ABI id and the compatibility guarantees (additive ops only?
  per-op deprecation?) before any client bundles ship against it.
- **Headroom / limits semantics.** The context tracks a "headroom" limits budget
  and there is a headroom syscall, but the declarations don't reveal the limits
  (max reads, max scheduled functions, transaction size). We need concrete
  numbers and enforcement points.
- **Component scoping.** Module registry, call context, and schema service are
  all component-path aware. We must pin down how component boundaries interact
  with the syscall boundary (can a component call across into another component,
  and with whose auth?).
- **Action sandbox depth.** Actions allow `fetch`/timers and call other
  functions; running them in the same isolate model as queries may be wrong
  (long-running, network). We may need a separate, heavier executor for actions
  behind the same `UdfExec` interface.
