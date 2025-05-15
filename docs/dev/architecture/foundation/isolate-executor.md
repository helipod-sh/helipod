---
title: Foundation — V8-Isolate UDF Executor & Syscall ABI
slug: isolate-executor
status: design (implementation-ready)
audience: engineering (internal)
slice: Foundation (Tier 0)
depends_on: [sqlite-docstore, query-engine, occ-transactor, document-identity-registry]
seam_rows: [8]            # read-scaling: stateless poolable executor (scalability-spectrum §3)
locked_divergence: 3      # fully-serializable syscall ABI across a real V8 isolate (strategy.md)
---

# V8-Isolate UDF Executor & Syscall ABI

> Clean-room design. We studied the *contract shapes* of concave's UDF runtime
> (`@concavejs/*`, FSL-1.1; see [`.reference/README.md`](../../../../.reference/README.md))
> only to name the surface we must match for Convex behavioral compatibility. Every
> type, algorithm, and file below is our own. **No concave source is copied.** Where a
> concave name is cited it is an anchor for reviewers, not a reproduction.
>
> Grounding: [system-design](../system-design.md) §4 (execution model),
> [strategy](../strategy.md) (locked divergence #3), [scalability-spectrum](../scalability-spectrum.md)
> (seam row 8), [internals/05-udf-execution](../internals/05-udf-execution.md) (primary),
> and [internals/04](../internals/04-query-engine.md) / [02](../internals/02-transactions-consistency.md) /
> [01](../internals/01-storage.md) / [06](../internals/06-runtimes-topology.md) / [07](../internals/07-platform-services.md)
> (dependency contracts).

---

## 1. Purpose

This component is the **host/guest split** of Stackbase: it takes "a request names a
function" and turns it into "that function's user code runs in a controlled, sandboxed
environment, calls back into the engine only through a narrow serialized ABI, and returns
a fully-serializable result carrying its read/write footprint."

It is the single place that enforces the three runtime invariants the whole reactive core
depends on:

1. **Determinism** for queries & mutations (so OCC can replay them and the read-set is
   meaningful), enforced by the *host replacing* non-deterministic globals — never trusting
   the guest to avoid them.
2. **Isolation** — user code holds no live reference to the docstore, transactor, or other
   functions; every privileged operation crosses a **string-JSON-in / string-JSON-out**
   syscall boundary.
3. **A host-authoritative footprint ledger** — the kernel records every read/write range,
   auth access, and scheduled call *as it services each syscall*, so the guest cannot forge
   or omit its OCC/subscription footprint.

It owns module loading, analysis, and validation behind the `UdfExec` interface.

---

## 2. Boundaries — what it owns vs. does NOT

### Owns

- The `UdfExec` contract and its three implementations: **inline** (in-process, Tier 0
  dev/single-tenant), **isolated** (real V8 isolate, multi-tenant/untrusted), and the
  declared-but-trivial **remote** (Tier 2 pool client).
- The `UdfExecutionAdapter` ingress (raw transport request → typed, authed, context-tagged
  call) and the `CallContext` (client vs server).
- The **environment profiles** (4 frozen `UdfEnvironmentProfile`s) and the capability→global
  installer (the "ops table" that installs or withholds each ambient global).
- The **seeded PRNG**, the frozen-clock shim, and the determinism audit (which V8 surfaces
  are neutralized).
- The per-invocation **`UdfKernel`** + **`KernelContext`** (the footprint ledger, deterministic
  id/subrequest allocators, headroom tracker, log buffer).
- The **syscall ABI**: `SyscallChannel`, the versioned `KernelSyscallApiProfile`, the
  `SyscallRouter`, and the seven syscall families (database, query-stream, schedule, action,
  identity, storage, headroom).
- **Module loading/analysis/validation**: `ModuleRegistry` / `ModuleLoader`, `analyzeUdfModule`,
  arg/return/document validation, `parseUdfPath`.
- The `UdfResult` shape and its JSON (de)serialization.
- The **content-addressed query-cache seam** (`CacheStrategy` / `computeQueryHash`) and the
  `authAccessed` cacheability signal (seam row 8). It owns the *contract*; the cache impl is
  pluggable.
- The **isolate pool** (warm-start, reset, resource caps, hard-terminate).

### Does NOT own (consumes via sibling contracts)

- **Storage / MVCC reads & atomic writes** — `DocStore`, `TimestampOracle`, `LatestDocument`
  (← `sqlite-docstore`). The kernel calls these; it never speaks SQL.
- **The order-preserving index-key codec, query planning/execution, `RangeSet`/`KeyRange`,
  cursors** — (← `query-engine`). The kernel's data/query syscalls drive `QueryRuntime`; the
  ledger records the `KeyRange`s *the query engine produces*.
- **OCC validation, the 3-phase commit, `OccMutationTransaction`, `ConflictError`, the
  headroom limit definitions, `WriteInvalidation`** — (← `occ-transactor`). The executor owns
  the *retry loop*; the transactor owns *validate/commit*.
- **Document identity & the table registry** — `InternalDocumentId`, the base32+Fletcher16 id
  codec, `TableRegistry` (← `document-identity-registry`). The kernel overrides only *id
  generation* in deterministic envs (seeded, below); it imports the codec otherwise.
- **Sync tier / subscriptions / write-fanout** — the executor *produces* the footprint; the
  sync tier consumes it. The executor never pushes to clients.
- **Auth resolution** (token → `Principal`) — it consumes a resolved `Principal` (← platform
  auth); it does not verify JWTs.
- **Scheduler/cron execution** — it routes `ctx.scheduler.*` to a `SchedulerGateway` and
  records the scheduled call; the `ScheduledFunctionExecutor` runs jobs later.

---

## 3. Where it sits

```
   transport (HTTP / WS / cron / internal call)
        │  (path, jsonArgs, type, auth, callerKind, snapshotTs)
        ▼
   UdfExecutionAdapter ── installs ambient auth + CallContext, JSON→value validation
        │
        ▼
   UdfExec.execute(...)            ◄── three impls: Inline · Isolated · Remote(Tier 2)
        │  load module · pick env profile · acquire isolate · seed
        ▼
 ┌─────────────────────────────── isolate boundary ───────────────────────────────┐
 │  GUEST (sandbox, no ambient host globals)                                       │
 │    user UDF code  +  guest-runtime shim:                                        │
 │      • capability globals (seeded RNG / frozen clock / fetch? / timers?)        │
 │      • ctx facades (db / auth / scheduler / storage / runQuery…)                │
 │      • guest-local services (RNG, clock, id-codec normalizeId, console buffer)  │
 │           every host op ── SyscallChannel.callAsync(wireOp, argJson) ──┐        │
 └───────────────────────────────────────────────────────────────────────┼────────┘
                                                                          ▼
        HOST (trusted)  UdfKernel.asyncSyscall(wireOp, argJson) ──► SyscallRouter
                                                                      │ dispatch
                          ┌───────────────────────────────────────────┤
                          ▼            ▼            ▼          ▼        ▼
                      database     query-stream  schedule   action  identity/storage
                          │            │            │          │
                          ▼            ▼            ▼          ▼
                   DocStore    QueryRuntime   SchedulerGW   UdfExec (nested)
                    (←storage)  (←query-eng)   (←platform)   (re-enter)
                          │            │
                          └──► records KeyRanges / versions / authAccessed into ──► KernelContext (ledger)
                                                                                        │
                                                      finalize() ──► UdfResult (fully JSON-serializable)
```

---

## 4. The two serializable boundaries (the central idea)

Stackbase's locked divergence #3 ("fully serializable syscall ABI across a real V8 isolate
from day one") and seam row 8 ("stateless, horizontally-scaled executor pool") are the
**same property applied at two nested boundaries**. Getting both JSON-clean is what makes
the WhatsApp-scale read path a drop-in.

| | **Inner boundary** (guest ↔ host kernel) | **Outer boundary** (engine ↔ executor) |
|---|---|---|
| Crosses | the V8 isolate edge | a process / network edge |
| Carries | `(wireOp: string, argJson: string) → resultJson: string` | `UdfExec.execute(path, args, type, opts) → UdfResult` |
| Both sides JSON? | **Yes** — `SyscallChannel.callAsync` only | **Yes** — args are `JsonValue`, `UdfResult` is JSON (bigints as strings) |
| Enables | real V8 isolates (vs concave's non-JSON `performJsSyscall` that can't cross one) | `RemoteUdfExecutor` — ship the whole `execute()` to a pool node, get a `UdfResult` back |
| Tier 0 impl | inline channel = a direct async function call; isolated channel = isolate↔host message | local executor only |
| Tier 2 impl | isolated channel over a worker MessagePort (no `SharedArrayBuffer` needed) | pool node over a serialized socket; engine holds a `RemoteUdfExecutor` |

**Decision that makes both work: every host-crossing syscall is `async`.** We drop the
synchronous host-syscall shape entirely. The only "synchronous" things user code does are
pure JS (`Math.random`, `Date.now`, `normalizeId`) and we service those **guest-local** from
immutable data injected at setup. Because no host round-trip ever needs to block, the channel
works over a non-blocking MessagePort or a network socket **without `Atomics.wait` /
`SharedArrayBuffer`** — which is precisely the property that lets the executor be poolable at
Tier 2. (Convex's `ctx.db.*` / `ctx.runQuery` are already `await`ed, so "all host syscalls
async" costs the app author nothing.)

**`performJsSyscall` is eliminated.** Wherever concave passed a live JS object across the
boundary we serialize instead:
- streaming query cursors → a server-side **cursor table** keyed by a string `cursorId`
  (guest pulls pages by id);
- `Request`/`Response` for HTTP actions → JSON envelopes (`SerializedHttpRequest` /
  `SerializedHttpResponse`, body base64);
- blob bytes → base64 in the envelope, or a `storageId` string handle for large blobs.

If a genuinely structured handle is ever unavoidable, it goes through an explicit
**handle table** (host mints an opaque `handleId` string, keeps the object server-side) —
never a live object on the wire.

**Why this is also a security win:** the footprint ledger lives on the host and is written
*as the host services each data syscall*. A malicious or buggy guest cannot under-report its
read-set (to escape invalidation) or forge a write — the host records the truth regardless of
what the guest claims.

---

## 5. Core types & contracts

All types are TypeScript. Names are our own. Types imported from sibling components are listed
in §5.11 and referenced by name elsewhere.

### 5.1 Primitives & serialization conventions

```ts
export type UdfType = "query" | "mutation" | "action" | "httpAction";
export type FunctionVisibility = "public" | "internal";
export type CallerKind = "client" | "server";
export type HttpMethod = "GET" | "POST" | "PUT" | "DELETE" | "PATCH" | "OPTIONS";

/** The ONLY thing that crosses either serializable boundary. */
export type JsonValue =
  | null | boolean | number | string
  | JsonValue[] | { readonly [k: string]: JsonValue };

/**
 * Serialization conventions (load-bearing — both boundaries depend on them):
 *  - bigint timestamps  → decimal strings (canonical: no leading zeros; "-" for negatives).
 *  - byte buffers       → lowercase hex (KeyRange) or base64 (blob bodies); the field name fixes which.
 *  - Convex values      → encoded to JsonValue by the value codec BEFORE entering the ABI
 *                         (the ABI never sees a bigint/Int64/Bytes value, only its JSON image).
 */
```

### 5.2 `UdfEnvironmentProfile` — the per-type policy

The single table that says "queries cannot fetch, actions cannot read the db inline." Four
frozen instances, selected by function type.

```ts
export type CapabilityMode = "forbidden" | "seeded" | "native";

export interface UdfCapabilities {
  /** Math.random, crypto.getRandomValues, crypto.randomUUID */
  readonly random: CapabilityMode;
  /** Date.now(), new Date(), performance.now() */
  readonly clock: CapabilityMode;
  /** global fetch() */
  readonly fetch: CapabilityMode;
  /** setTimeout / setInterval / clearTimeout / clearInterval */
  readonly timers: CapabilityMode;
}

export type SyscallFamilyId =
  | "database" | "query" | "schedule" | "action" | "identity" | "storage" | "headroom";

export interface UdfEnvironmentProfile {
  readonly id: UdfType;
  /** Which versioned syscall ABI this profile binds to (see §5.5). */
  readonly syscallApi: string;            // e.g. "stackbase.syscall/1"
  readonly deterministicExecution: boolean;
  readonly seedKind: "request-derived" | "none";
  readonly capabilities: UdfCapabilities;
  readonly snapshotPinning: "pinned" | "none";
  readonly transaction: "none" | "occ-retry";
  readonly maxRetries: number;
  /** Which syscall families are mounted into the kernel for this env. */
  readonly syscallFamilies: readonly SyscallFamilyId[];
}
```

The four frozen profiles (Tier 0 defaults; `maxRetries` tunable):

```ts
export const QUERY_PROFILE: UdfEnvironmentProfile = Object.freeze({
  id: "query", syscallApi: "stackbase.syscall/1", deterministicExecution: true,
  seedKind: "request-derived",
  capabilities: { random: "seeded", clock: "seeded", fetch: "forbidden", timers: "forbidden" },
  snapshotPinning: "pinned", transaction: "none", maxRetries: 0,
  syscallFamilies: ["database", "query", "identity", "headroom"],
});

export const MUTATION_PROFILE: UdfEnvironmentProfile = Object.freeze({
  id: "mutation", syscallApi: "stackbase.syscall/1", deterministicExecution: true,
  seedKind: "request-derived",
  capabilities: { random: "seeded", clock: "seeded", fetch: "forbidden", timers: "forbidden" },
  snapshotPinning: "pinned", transaction: "occ-retry", maxRetries: 8,
  syscallFamilies: ["database", "query", "schedule", "identity", "storage", "headroom"],
});

export const ACTION_PROFILE: UdfEnvironmentProfile = Object.freeze({
  id: "action", syscallApi: "stackbase.syscall/1", deterministicExecution: false,
  seedKind: "none",
  capabilities: { random: "native", clock: "native", fetch: "native", timers: "native" },
  snapshotPinning: "none", transaction: "none", maxRetries: 0,
  syscallFamilies: ["schedule", "action", "identity", "storage", "headroom"],
});

export const HTTP_ACTION_PROFILE: UdfEnvironmentProfile = Object.freeze({
  ...ACTION_PROFILE, id: "httpAction",
});
```

Note: actions get **no** `database`/`query` families — an action touches the DB *only* via
`runQuery`/`runMutation` (the `action` family), preserving the hard boundary that side effects
never join the deterministic transaction.

### 5.3 `UdfResult` — the fully-serializable result (outer boundary payload)

```ts
export interface LogLine {
  readonly level: "debug" | "info" | "warn" | "error";
  readonly partsJson: string;   // console args, JSON array of JsonValue
  readonly timestampMs: number; // host wall clock at log time (NOT part of determinism)
}

export interface UdfResultFootprint {
  readonly readRanges: SerializedKeyRange[];     // ← query-engine
  readonly writtenRanges: SerializedKeyRange[];
  readonly writtenTables: string[];
}

export interface ScheduledFunctionRef {
  readonly jobId: string;
  readonly path: string;
  readonly scheduledTs: string;  // bigint decimal string
}

export interface SerializedUdfError {
  readonly code: string;         // machine code from the error hierarchy (platform errors)
  readonly message: string;
  readonly httpStatus: number;
  readonly retryable: boolean;
  readonly data?: JsonValue;     // e.g. validator path for ArgumentValidationError
}

export interface UdfResult {
  readonly status: "success" | "error";
  readonly result: JsonValue;                 // function return value (Convex-encoded → JSON)
  readonly error?: SerializedUdfError;         // present iff status === "error"
  readonly footprint: UdfResultFootprint;
  readonly logLines: LogLine[];
  readonly trace?: UdfTrace;                    // optional perf spans
  readonly authAccessed: boolean;              // cacheability signal (seam row 8)
  readonly snapshotTimestamp?: string;         // bigint string; set for queries / pinned reads
  readonly commitTimestamp?: string;           // bigint string; set for committed mutations
  readonly scheduled?: ScheduledFunctionRef[];
  readonly cacheStatus?: "miss" | "local-hit" | "edge-hit";
  readonly shardId: string;                    // "default" at Tier 0 — threads the shard seam (row 1)
}
```

Everything here is JSON-serializable, so a `RemoteUdfExecutor` can return it across a network
edge unchanged. `UdfTrace` is a tree of `{ name, startMs, durMs, children }` spans.

### 5.4 `UdfExec` & `UdfExecutionAdapter` — the executor contract

```ts
export interface SerializedPrincipal {     // JSON image of the platform Principal
  readonly kind: "user" | "admin" | "system" | "service" | "none";
  readonly tenantId?: string;
  readonly scopes: readonly string[];
  readonly userIdentity?: JsonValue;       // OIDC attributes, if any
  readonly label?: string;
}

export interface UdfExecuteOptions {
  readonly auth?: SerializedPrincipal;
  readonly componentPath?: string;
  readonly requestId?: string;             // stable per logical invocation; drives the seed
  readonly snapshotTimestamp?: string;     // bigint string; inherited snapshot (sub-calls / pinned)
  readonly callerKind?: CallerKind;        // visibility: internal fns only callable server-side
  readonly shardId?: string;               // default "default"
}

export interface SerializedHttpRequest {
  readonly method: HttpMethod;
  readonly url: string;
  readonly headers: ReadonlyArray<readonly [string, string]>;
  readonly bodyBase64?: string;
}
export interface SerializedHttpResponse {
  readonly status: number;
  readonly headers: ReadonlyArray<readonly [string, string]>;
  readonly bodyBase64?: string;
  readonly logLines: LogLine[];
}

/**
 * THE contract other components depend on. Stateless: every call carries everything it needs;
 * the instance holds only caches (modules/isolates/bootstrap), safe to share or rebuild.
 * Inline · Isolated · Remote(Tier 2) are interchangeable behind this interface.
 */
export interface UdfExec {
  execute(
    path: string,            // "module:export", e.g. "messages:list"
    args: JsonValue,         // already JSON (the adapter validated/encoded them)
    type: UdfType,
    options?: UdfExecuteOptions,
  ): Promise<UdfResult>;

  executeHttp(
    request: SerializedHttpRequest,
    options?: Pick<UdfExecuteOptions, "auth" | "requestId" | "componentPath" | "callerKind">,
  ): Promise<SerializedHttpResponse>;
}

/** Single ingress: raw transport → typed, authed, context-tagged execution. */
export interface UdfExecutionAdapter {
  /** Convert/validate JSON args, install ambient auth + CallContext, delegate to a UdfExec. */
  executeUdf(
    path: string, jsonArgs: JsonValue, type: UdfType, options?: UdfExecuteOptions,
  ): Promise<UdfResult>;
  executeHttp(req: SerializedHttpRequest, options?: UdfExecuteOptions): Promise<SerializedHttpResponse>;
}

/** Ambient client-vs-server record (shared-symbol singleton; survives bundle boundaries). */
export interface CallContext {
  readonly caller: CallerKind;
  readonly functionPath?: string;
}
export function runAsClientCall<T>(fp: string | undefined, fn: () => T): T;
export function runAsServerCall<T>(fp: string | undefined, fn: () => T): T;
export function isServerCall(): boolean;
export function isClientCall(): boolean;
```

### 5.5 The syscall ABI — channel, profile, router

```ts
/**
 * The inner serializable boundary. argJson and the resolved result are BOTH JSON strings.
 * Only one shape — async — so the channel works over any transport (in-process call,
 * isolate message port, or a remote socket) with no SharedArrayBuffer / Atomics.
 */
export interface SyscallChannel {
  callAsync(wireOp: string, argJson: string): Promise<string>;
}

/** Logical ops are stable across ABI versions; wire strings come from the profile. */
export type LogicalOp =
  | "db.get" | "db.insert" | "db.patch" | "db.replace" | "db.remove" | "db.count"
  | "q.stream" | "q.next" | "q.page" | "q.cleanup"
  | "sched.after" | "sched.at" | "sched.cancel"
  | "act.runQuery" | "act.runMutation" | "act.runAction"
  | "act.functionHandle" | "act.search" | "act.vectorSearch"
  | "id.getUserIdentity"
  | "store.store" | "store.get" | "store.getUrl" | "store.getMetadata" | "store.delete"
  | "limits.checkpoint";

export type WireOp = string;

/**
 * Versioned ABI. Client bundles are compiled against an `id`; the executor fleet can run
 * several profiles at once and pick the one matching the bundle's `syscallApi`, so op-name
 * evolution never breaks a deployed bundle. Evolution rule: ADDITIVE ONLY — never repurpose
 * or remove a wire string within a major id; introduce a new id for breaking change.
 */
export interface KernelSyscallApiProfile {
  readonly id: string;                                  // "stackbase.syscall/1"
  readonly developerIdFormat: "convex-base32";          // id codec the bundle expects
  readonly ops: Readonly<Record<LogicalOp, WireOp>>;    // logical → wire
  /** Reverse map is derived; both directions must be 1:1. */
}

export type SyscallHandler = (ctx: KernelContext, argJson: string) => Promise<string>;

export interface SyscallRouter {
  readonly profile: KernelSyscallApiProfile;
  /** Mount a family's handlers (keyed by logical op). Throws if a family is mounted twice. */
  register(family: SyscallFamilyId, handlers: Partial<Record<LogicalOp, SyscallHandler>>): void;
  /** Resolve a wire op → logical op via the profile, then dispatch. Unknown op → UserError. */
  dispatch(ctx: KernelContext, wireOp: string, argJson: string): Promise<string>;
}
```

### 5.6 `UdfKernel` & `KernelContext` — the host side & the ledger

```ts
/** One per invocation. The four-line surface the guest's channel lands on. */
export interface UdfKernel {
  /** The guest's SyscallChannel.callAsync routes here. JSON in / JSON out. */
  asyncSyscall(wireOp: string, argJson: string): Promise<string>;
  readonly context: KernelContext;
  /**
   * Finalize the invocation: drain open cursors, compute the footprint, and —
   * for a mutation — run the 3-phase commit (← occ-transactor). Throws ConflictError
   * (caught by the retry loop) or a resource error; otherwise returns the UdfResult.
   */
  finalize(returnValueJson: JsonValue): Promise<UdfResult>;
  dispose(): Promise<void>;
}

/**
 * Per-invocation mutable state, deliberately SEPARATE from the kernel class so it can be
 * constructed and asserted on in tests and (later) serialized for a fully out-of-process
 * kernel. This is the ledger that makes a query invalidatable and a mutation conflict-checkable.
 */
export interface KernelContext {
  // identity & scope
  readonly requestId: string;
  readonly componentPath: string;
  readonly callerKind: CallerKind;
  readonly principal: Principal;            // ← platform auth (host-trusted)
  readonly shardId: string;                 // threads the shard seam (row 1)

  // time / snapshot / policy
  readonly snapshotTimestamp: bigint;       // pinned read snapshot (queries/mutations)
  readonly requestTimestamp: number;        // frozen wall clock injected into deterministic guests
  readonly profile: UdfEnvironmentProfile;

  // transaction (mutations only; ← occ-transactor)
  readonly txn?: OccMutationTransaction;

  // deterministic allocators (seeded; stable across OCC retries)
  nextInternalId(tableNumber: number): InternalDocumentId;   // ← overrides codec CSPRNG in det envs
  nextSubrequestId(): number;

  // --- access ledger (host-authoritative; written as syscalls are serviced) ---
  recordDocumentRead(table: string, internalId: string, version: bigint | null): void;
  recordIndexRange(tableId: string, indexName: string, start: ArrayBuffer, end: ArrayBuffer | null): void;
  recordTableScan(tableId: string): void;
  recordDocumentWrite(table: string, internalId: string): void;
  recordIndexWrite(indexId: string, key: ArrayBuffer): void;
  recordScheduledFunction(ref: ScheduledFunctionRef): void;
  markAuthAccessed(): void;

  // readouts (become UdfResult / OCC input)
  getReadRanges(): KeyRange[];                        // ← query-engine RangeSet
  getWrittenRanges(): KeyRange[];
  getReadVersions(): ReadonlyArray<readonly [string, ReadVersion]>;  // ← occ-transactor
  readonly authAccessed: boolean;

  // limits & logs
  readonly headroom: TransactionHeadroomTracker;     // ← occ-transactor
  appendLog(line: LogLine): void;
  getLogLines(): LogLine[];
}
```

The kernel is constructed per invocation with: a `RuntimeServices` bundle (§5.10), the
resolved `Principal`, the `UdfEnvironmentProfile`, the snapshot timestamp (or live `txn`), the
`SyscallRouter`, the `TableRegistry`, the id codec, and the seeded id/subrequest generators.

### 5.7 Guest-local services (no host round-trip)

These run **inside the isolate** from data injected at setup. They are why we need no
synchronous host syscall.

```ts
/** Deterministic PRNG seeded per-invocation (§7.1). Wired into the random globals. */
export interface SeededRandom {
  nextFloat(): number;                 // → Math.random
  fillBytes(out: Uint8Array): void;    // → crypto.getRandomValues
  uuidV4(): string;                    // → crypto.randomUUID (RFC 4122, seeded bytes)
}

/** Setup data injected into the guest at the start of each invocation. */
export interface GuestSetup {
  readonly profile: UdfEnvironmentProfile;
  readonly argsJson: string;               // the function args
  readonly seedHex?: string;               // present iff deterministicExecution
  readonly requestTimestampMs: number;     // frozen Date.now for det envs; advisory for actions
  readonly tableNumbers: Readonly<Record<string, number>>;  // name→number, for guest-local normalizeId
  readonly developerIdFormat: "convex-base32";
  readonly syscallProfileId: string;
}
```

Guest-local services: `SeededRandom`; a frozen clock (`Date.now`/`new Date()`/`performance.now`
return `requestTimestampMs`/0 in det envs); the **id codec** `normalizeId(table, idStr)` (pure
base32+Fletcher16 decode, checked against the injected `tableNumbers` map); and a **console**
that buffers `LogLine`s returned in `UdfResult` (an optional `limits.checkpoint`/`log.flush`
async op streams them for long actions).

### 5.8 Module loading / analysis / validation

```ts
export type ModuleHint = "udf" | "http" | "schema" | "generated" | "manifest" | "unknown";

export interface ModuleLoadContext {
  readonly path: string;               // normalized, e.g. "messages" or "billing/invoices"
  readonly componentPath?: string;
  readonly hint: ModuleHint;
  readonly scope: "root" | "component";
}

export interface LoadedModule {
  readonly path: string;
  readonly exports: Record<string, unknown>;  // resolved exports (inline path)
  readonly source?: string;                    // bundled source string (isolate path)
  readonly analyzed: AnalyzedModule;
}

export type ModuleLoader =
  (modulePath: string, ctx: ModuleLoadContext) => Promise<LoadedModule | undefined>;

export interface ModuleListing {
  readonly path: string; readonly source?: string;
  readonly componentPath?: string; readonly hint: ModuleHint;
}

export interface ModuleRegistry {
  /** Ordered loaders, optionally component-scoped; returns an unregister fn. */
  register(loader: ModuleLoader, opts?: { componentPath?: string; priority?: number }): () => void;
  load(modulePath: string, componentPath?: string): Promise<LoadedModule | undefined>;
  enumerate(componentPath?: string): Promise<ModuleListing[]>;
  onChanged(listener: () => void): () => void;   // dev hot-reload invalidation
  clone(): ModuleRegistry;
  reset(): void;
}

export interface AnalyzedFunction {
  readonly name: string;
  readonly udfType: UdfType;
  readonly visibility: FunctionVisibility;
  readonly args: ValidatorJSON | null;     // ← query-engine validator JSON
  readonly returns: ValidatorJSON | null;
  readonly pos?: { readonly line: number; readonly column: number };
}
export interface AnalyzedHttpRoute { readonly path: string; readonly method: HttpMethod; readonly pos?: AnalyzedFunction["pos"]; }
export interface AnalyzedCronSpec { readonly name: string; readonly schedule: JsonValue; readonly functionPath: string; readonly args?: JsonValue; }
export interface AnalyzedModule {
  readonly functions: AnalyzedFunction[];
  readonly httpRoutes: AnalyzedHttpRoute[];
  readonly cronSpecs: AnalyzedCronSpec[];
}

export function analyzeUdfModule(mod: LoadedModule["exports"], path: string): AnalyzedModule;
export function parseUdfPath(path: string): { module: string; export: string };  // "a/b:c" → {module:"a/b", export:"c"}

/** Validation (delegates to the query-engine SchemaValidator; surfaces path-bearing errors). */
export function validateArgs(args: JsonValue, validator: ValidatorJSON | null): void; // throws ArgumentValidationError
export function validateDocument(table: string, doc: JsonValue): void;                // throws DocumentValidationError
```

A global default registry (well-known symbol) plus an async-local "current registry" override
(`withModuleRegistry`) lets bundled UDF code resolve modules even when it runs outside the
async-context scope — same shared-symbol discipline as `CallContext`.

### 5.9 Query-cache seam (scale seam row 8)

```ts
export interface QueryCacheEntry {
  readonly result: JsonValue;
  readonly footprint: UdfResultFootprint;
  readonly snapshotTimestamp: string;
  readonly authAccessed: boolean;
}

export interface CacheStrategy {
  get(hash: string): Promise<QueryCacheEntry | undefined>;
  set(hash: string, entry: QueryCacheEntry): Promise<void>;
  /** Drop every entry whose readRanges intersect these written ranges (reuses reactive overlap). */
  invalidate(written: SerializedKeyRange[], writtenTables: string[]): Promise<void>;
}

/**
 * Content-addressed key. `identitySubject` is included IFF the query accessed auth
 * (authAccessed): an auth-independent query is shared across all users (the dedup win);
 * an auth-dependent one is keyed per identity (correctness).
 */
export function computeQueryHash(input: {
  readonly path: string;
  readonly args: JsonValue;
  readonly componentPath?: string;
  readonly identitySubject?: string;
}): string;
```

Tier 0 ships an `InMemoryQueryCache implements CacheStrategy` (LRU, bounded). The executor
consults `get` before running a `query`, and `set`s on miss; the transactor's
`WriteInvalidation` feeds `invalidate`.

### 5.10 Runtime services bundles

```ts
/** Engine-facing bundle the executor/kernel operate against. */
export interface RuntimeServices {
  readonly docstore: DocStore;                 // ← sqlite-docstore (required)
  readonly queryRuntime: QueryRuntime;         // ← query-engine
  readonly transactor: Transactor;             // ← occ-transactor
  readonly tableRegistry: TableRegistry;       // ← document-identity-registry
  readonly schedulerGateway?: SchedulerGateway;// ← platform (mutations/actions)
  readonly blobstore?: BlobStore;              // ← platform
  readonly searchstore?: SearchStore;
  readonly vecstore?: VecStore;
  /** Back-reference so nested calls (actions → query/mutation) re-enter execution. */
  readonly udfExecutor: UdfExec;
}

/** Higher-level, provider-pluggable view (auth verify / scheduler) for swapping infra per host. */
export interface RuntimeContext {
  readonly docstore: DocStore;
  readonly auth: { verifyToken(t: string): Promise<Principal>; };
  readonly scheduler: { schedule(path: string, args: JsonValue, ts: bigint): Promise<string>; cancel(id: string): Promise<void>; };
  readonly blobstore?: BlobStore;
  readonly vecstore?: VecStore;
}
```

### 5.11 Dependencies imported from sibling components (not redefined here)

| From | Imported contracts the kernel/executor consume |
|---|---|
| `sqlite-docstore` | `DocStore` (`index_scan`, `get`, `count`, `write`, `previous_revisions*`, `load_documents`), `TimestampOracle`, `LatestDocument`, `DocumentLogEntry` |
| `query-engine` | `encodeIndexKey`/`compareIndexKeys`, `KeyRange`/`RangeSet`/`SerializedKeyRange`, `QueryRuntime` (`evaluate`/`evaluatePaginated`/`index_scan` driver), `QueryPlan`, `IndexCursor`/`decodeCursor`, `PaginatedResult`, `ValidatorJSON`, `SchemaValidator`, `SchemaService` |
| `occ-transactor` | `Transactor` (`begin`/`commit`/`rollback`), `OccMutationTransaction` (`stageWrite`/`commit`), `CommitResult`, `ConflictError`, `ReadVersion`, `TransactionHeadroomTracker`, `WriteInvalidation` |
| `document-identity-registry` | `InternalDocumentId`, `encodeDocumentId`/`decodeDocumentId`/`normalizeId`/`isValidDocumentId`, `generateInternalId` (non-det only), `TableRegistry`/`TableInfo`, `SYSTEM_TABLE_NUMBERS` |
| platform (later slices) | `Principal`, `SchedulerGateway`, `BlobStore`/`SearchStore`/`VecStore`, the `StackbaseError` hierarchy |

---

## 6. Syscall families (handler responsibilities)

Each family registers handlers keyed by `LogicalOp`. All take/return JSON strings. The
recurring pattern: **resolve target → enforce policy/validation → touch a sibling service →
record footprint into `KernelContext` → return JSON.**

- **database** (`db.get/insert/patch/replace/remove/count`): resolve the developer id (codec
  + registry), for writes `validateDocument` against the table schema, allocate a **seeded**
  `InternalDocumentId` on insert (det envs), stage into the `OccMutationTransaction` (or apply
  via a one-shot mutation path), and record `recordDocumentRead`/`recordDocumentWrite` +
  index writes. RYOW: reads consult the txn's staged writes first.
- **query** (`q.stream/next/page/cleanup`): open a plan via `QueryRuntime`, hold the live
  cursor **server-side** in the kernel's `cursorId → cursor` table, return `cursorId`; `q.next`
  pulls a page and records the exact `[start,end)` `KeyRange` actually scanned (the read set
  covers the scanned interval, not just surviving rows); `q.cleanup` disposes the cursor.
- **schedule** (`sched.after/at/cancel`): route to `SchedulerGateway`, write the job row inside
  the mutation's transaction, `recordScheduledFunction`. (Mounted for mutations & actions.)
- **action** (`act.runQuery/runMutation/runAction/functionHandle/search/vectorSearch`):
  re-enter the executor (`RuntimeServices.udfExecutor.execute`) with fresh per-invocation state;
  validates the call is legal for the calling env (a query may not call a mutation); search/
  vector go to the optional stores. (Action env only.)
- **identity** (`id.getUserIdentity`): read the host-trusted `Principal`, `markAuthAccessed`,
  return the OIDC attributes (or null).
- **storage** (`store.store/get/getUrl/getMetadata/delete`): blob bytes as base64 / `storageId`
  handles; writes a metadata row + bytes. (Mutations & actions.)
- **headroom** (`limits.checkpoint`): the guest periodically reports progress; the host checks
  the `TransactionHeadroomTracker` caps and aborts with a resource error if exceeded. Also the
  optional log-flush point for long actions.

---

## 7. Key data structures & algorithms

### 7.1 Seed derivation (deterministic, retry-stable, per-invocation unique)

```
seed = BLAKE3( requestId ‖ 0x1F ‖ path ‖ 0x1F ‖ canonicalJsonBytes(args) ‖ 0x1F ‖ (componentPath ?? "") )
SeededRandom = ChaCha8/“xoshiro256**” stream keyed by seed   // fast, well-distributed, reproducible
```

- **Retry-stable:** the seed does **not** include the OCC attempt number — an OCC retry of the
  same logical invocation reproduces identical random values *and identical insert ids*, so the
  retry is genuinely idempotent.
- **Per-invocation unique:** distinct `(requestId, path, args)` ⇒ distinct seed.
- `canonicalJsonBytes` is a fixed key-sorted JSON with the §5.1 bigint/bytes rules, so the
  hash is stable regardless of object key order.

### 7.2 Deterministic id allocation (replaces CSPRNG in det envs)

`KernelContext.nextInternalId(tableNumber)` pulls 16 bytes from the seeded stream (namespace
`"id"`, counter incremented per insert) → `InternalDocumentId`. The developer-facing id is then
`encodeDocumentId(tableNumber, internalId)` (← codec). Because the stream is seed-derived and
order-deterministic, inserts on an OCC retry regenerate the **same ids** in the **same order**
(idempotent commit). Actions (non-det) use the codec's real-CSPRNG `generateInternalId`.

### 7.3 Capability install (the "ops table")

```
buildGuestGlobals(profile):
  random:  seeded → bind Math.random/crypto.getRandomValues/crypto.randomUUID to SeededRandom
           native → leave host crypto in place
           forbidden → (n/a; random is never fully forbidden)
  clock:   seeded → Date.now/new Date()/performance.now return frozen requestTimestamp
           native → real clock
  fetch:   forbidden → install a throwing stub (ForbiddenOperationError) ; native → real fetch
  timers:  forbidden → throwing stubs for setTimeout/Interval ; native → real timers
```

Anything `forbidden` is a **throwing stub**, never merely absent — a query calling `fetch()`
fails loudly with a precise error rather than silently reading host state or getting `undefined`.

### 7.4 Determinism audit (V8 surfaces neutralized in det envs)

| Surface | Treatment in query/mutation |
|---|---|
| `Math.random`, `crypto.getRandomValues`, `crypto.randomUUID` | seeded |
| `Date.now`, `new Date()` (no-arg), `performance.now` | frozen to `requestTimestamp` / 0 |
| `fetch`, `setTimeout`, `setInterval`, `queueMicrotask`(timer-like) | throwing stub |
| `WeakRef`, `FinalizationRegistry` | removed (GC-observable nondeterminism) |
| `Error.stack` formatting | not exposed to control flow (sanitized in errors only) |
| `Intl` / locale-sensitive `toLocaleString` | pinned to a fixed locale (`en-US`, UTC) or disallowed |
| iteration order of `Map`/`Set` | already insertion-ordered (deterministic) — kept |
| `globalThis`, `process`, `require`, host modules | absent in the isolate (no ambient host) |

This table is the acceptance checklist for the determinism property test (§11).

### 7.5 OCC retry loop (mutations)

```
for attempt in 0..profile.maxRetries:
    txn = transactor.begin(requestId)                 // fresh snapshot
    kernel = newKernel(profile, txn, seed /*same every attempt*/, ...)
    runGuest(fn, args)                                  // stages writes, records footprint
    try:
        result = await kernel.finalize(returnValue)     // 3-phase commit (← occ-transactor)
        return result                                   // carries commitTimestamp + writtenRanges
    catch ConflictError:
        await sleep( occRetryDelay(attempt, seededRandom) )   // seeded backoff, reproducible
        continue
throw OccConflictError(409, retryable)                  // exhausted → surface to client
```

Replaying is safe precisely because the function is deterministic and the seed is retry-stable.
Resource-limit breaches throw a **resource error** (not a conflict) and do **not** retry.

### 7.6 Query streaming without live handles

`q.stream(plan)` → host builds a `QueryRuntime` cursor, stores it in `Map<cursorId, Cursor>`,
returns `cursorId` (string). `q.next(cursorId, n)` → pull one page (`PaginatedResult`), record
the scanned `KeyRange`, return `{ docs, nextCursor, hasMore }` (all JSON). `q.cleanup(cursorId)`
disposes. On `finalize`/`dispose`, all open cursors for the invocation are force-closed. This is
how `ctx.db.query(...).paginate()` / iteration work with **zero** non-JSON handle crossing the
boundary — the property that survives a real isolate and a remote pool.

### 7.7 Isolate pooling & warm start

- A **warm pool** of isolates, each created from a **startup snapshot** that pre-compiles the
  guest-runtime shim and the value codec (the per-call cost is then a cheap context + module
  instantiation, not a cold isolate).
- **Per-invocation context** (or fresh module instantiation): user module top-level runs once
  per context; we never reuse a context across **tenants** without a full reset, and we never
  let module-level mutable state leak between invocations (proven by the non-bleed test, §11).
- **Resource caps:** memory cap per isolate (Tier 0 default 128 MB), wall-clock timeout per
  type (query/mutation 1 s, action 10 min — tunable), enforced by hard isolate termination.
- A crashed/OOM/timed-out isolate is **discarded, not returned to the pool**.
- `InlineUdfExecutor` skips all of this (runs in the host isolate) — fastest for trusted
  single-tenant Tier 0 dev; `IsolatedUdfExecutor` is the multi-tenant/untrusted default.

### 7.8 Headroom (Tier 0 defaults; tunable, owned by occ-transactor)

`databaseQueries ≤ 4096`, `documentsRead ≤ 32000`, `documentsWritten ≤ 16000`,
`functionsScheduled ≤ 1000`, plus byte caps and the wall-clock/memory caps above. The kernel's
data syscalls feed `TransactionHeadroomTracker`; the tracker participates in savepoints.

---

## 8. Package / module / file layout

Lives in the engine package (`packages/server`), since it is engine-internal and must never be
imported by app code. (Per `CLAUDE.md`: the engine never imports a DB driver — this subsystem
only touches sibling *interfaces*.)

```
packages/server/src/udf/
  index.ts                       # public exports: UdfExec, profiles, adapter factories
  result.ts                      # UdfResult, LogLine, UdfTrace, (de)serialize + JSON conventions
  services.ts                    # RuntimeServices / RuntimeContext bundles
  call-context.ts                # CallContext (client/server), shared-symbol singleton

  exec/
    udf-exec.ts                  # UdfExec, UdfExecuteOptions, Serialized{Http,Principal} types
    inline-executor.ts           # InlineUdfExecutor (Tier 0 dev / single-tenant)
    isolated-executor.ts         # IsolatedUdfExecutor (real V8 isolate; prod / multi-tenant)
    remote-executor.ts           # RemoteUdfExecutor (Tier 2 pool client — declared, trivial now)
    execution-adapter.ts         # UdfExecutionAdapter (client + server factories)
    retry.ts                     # OCC retry loop + seeded backoff
    isolate-pool.ts              # warm snapshot, context lifecycle, reset, caps, terminate

  env/
    environment-profile.ts       # UdfEnvironmentProfile + the 4 frozen profiles
    capabilities.ts              # capability → global installer (the ops table)
    seeded-rng.ts                # SeededRandom (ChaCha8/xoshiro) + crypto shims + seed derivation
    guest-runtime.ts             # in-isolate shim: install globals, build ctx, wire SyscallChannel
    determinism-audit.ts         # neutralized-surface list + guards (the §7.4 table, enforced)

  kernel/
    kernel.ts                    # UdfKernel (asyncSyscall, finalize, dispose)
    kernel-context.ts            # KernelContext (ledger, allocators, headroom, logs)
    syscall-router.ts            # SyscallRouter (wire↔logical via profile, dispatch)
    syscall-api-profile.ts       # KernelSyscallApiProfile type + the "stackbase.syscall/1" profile
    channel.ts                   # SyscallChannel + inline/isolate/remote channel impls
    cursor-table.ts              # server-side query cursor registry (cursorId → cursor)
    families/
      database.ts                # db.get/insert/patch/replace/remove/count
      query.ts                   # q.stream/next/page/cleanup
      schedule.ts                # sched.after/at/cancel
      action.ts                  # act.runQuery/runMutation/runAction/functionHandle/search/vectorSearch
      identity.ts                # id.getUserIdentity
      storage.ts                 # store.store/get/getUrl/getMetadata/delete
      headroom.ts                # limits.checkpoint (+ optional log flush)

  modules/
    module-registry.ts           # ModuleRegistry + ModuleLoader + global/async-local registry
    loaders.ts                   # glob-bundle / filesystem-dev / in-memory-map loaders
    analyze.ts                   # analyzeUdfModule → AnalyzedModule
    validate.ts                  # validateArgs / validateDocument (→ SchemaValidator)
    udf-path.ts                  # parseUdfPath

  cache/
    cache-strategy.ts            # CacheStrategy interface
    query-hash.ts                # computeQueryHash (content-addressed; auth-independence)
    in-memory-cache.ts           # InMemoryQueryCache (Tier 0 LRU)

  __tests__/                     # see §11
    codec-boundary.property.test.ts
    determinism.property.test.ts
    occ-retry.test.ts
    capability-enforcement.test.ts
    cross-impl-equivalence.test.ts   # inline vs isolated produce identical UdfResult
    abi-version.test.ts
    isolate-nonbleed.test.ts
```

---

## 9. How it works at Tier 0 (single binary) NOW

The `EmbeddedRuntime` (Tier 0) composes one `UdfExec` with the docstore, transactor, sync
handler, and HTTP handler in one process; the client reaches it over a loopback WebSocket.
Concretely for a **query**:

1. A WS `Query`/HTTP `/api` request arrives → `UdfExecutionAdapter.executeUdf("messages:list",
   args, "query", { auth, snapshotTimestamp, callerKind:"client" })`. The adapter validates &
   JSON-encodes args, installs the ambient `Principal` + `CallContext`.
2. **Cache check:** `computeQueryHash({path, args, identitySubject?})` → `CacheStrategy.get`. On
   hit at a still-valid snapshot, return the cached `UdfResult` (`cacheStatus:"local-hit"`).
3. `UdfExec.execute` resolves the module via `ModuleRegistry`, asserts `list` is a `query`
   export, `validateArgs`. Picks `QUERY_PROFILE`. Derives the seed.
4. **Inline default** for single-tenant dev: runs the handler in-process with the capability
   globals installed and the `SyscallChannel` = a direct async call into the `UdfKernel`.
   **Isolated** for multi-tenant: acquires a warm isolate, injects `GuestSetup`, wires the
   channel across the isolate edge. Either way the user code is byte-identical.
5. As the handler runs `ctx.db.query(...).withIndex(...).collect()`, the guest issues
   `q.stream`/`q.next` async syscalls; the host drives `QueryRuntime`, recording each scanned
   `KeyRange` into `KernelContext`.
6. `kernel.finalize(returnValue)`: no commit for a query; assembles the `UdfResult` with
   `footprint.readRanges`, `authAccessed`, `snapshotTimestamp`, `shardId:"default"`.
7. The adapter `CacheStrategy.set`s the result and returns it. The sync tier records
   `readRanges` against the subscription so a later overlapping write recomputes it.

A **mutation** differs only at step 4–6: the profile is `MUTATION_PROFILE`, the kernel holds a
live `OccMutationTransaction`, `db.insert/patch` stage writes (with **seeded** ids), and
`finalize` runs the 3-phase commit through the transactor — on `ConflictError` the retry loop
(§7.5) replays the deterministic handler. `commitTimestamp` + `writtenRanges` flow out as
`WriteInvalidation` to the sync tier. An **action** uses `ACTION_PROFILE` (real clock/fetch/
timers, no db/query family) and reaches data only via `act.runQuery`/`runMutation`, each a fresh
nested `execute`.

Single binary, single shard `"default"`, in-memory cache, loopback transport — but every seam
below is already present.

---

## 10. The scale seam — reserved so the WhatsApp path attaches with no rewrite

This component carries **seam row 8** (read-scaling) and is the concrete realization of locked
divergence #3. Nothing below is built in Foundation beyond the trivial Tier 0 forms; the
*interfaces* are what make Tier 2 a drop-in.

**1. Stateless `UdfExec` + the outer serializable boundary → a horizontally-scaled executor
pool.** `execute(path, args, type, options)` takes everything as serializable inputs and returns
a fully-JSON `UdfResult` (bigints as strings, ranges as `SerializedKeyRange`). Therefore a
`RemoteUdfExecutor implements UdfExec` simply ships the call to a pool node and deserializes the
result — a drop-in behind the same interface. At Tier 2, the engine front-door holds a
`RemoteUdfExecutor`; reads fan out across a stateless pool (Convex's "Funrun") that reaches a
read replica at `snapshotTimestamp`. **App code and the engine are unchanged** — they only ever
call `UdfExec`.

**2. The inner serializable syscall ABI → real V8 isolates anywhere.** Because every host
syscall is async JSON-in/JSON-out (no `performJsSyscall`, no live handles — §4), the guest can be
a real isolate on a worker thread or another process **without `SharedArrayBuffer`/`Atomics`**.
The `SyscallChannel` is the one swappable seam: inline call → isolate message port → remote
socket, same handlers.

**3. Versioned `KernelSyscallApiProfile` → fleet evolution without breaking deployed bundles.**
A client bundle is compiled against `syscallApi: "stackbase.syscall/1"`. The executor fleet can
run several profiles at once and dispatch a bundle's wire ops against the profile matching its
declared id. Op-name evolution is additive-only within a major id; a breaking change mints a new
id. So a rolling fleet upgrade never breaks an old bundle in flight.

**4. Content-addressed query cache + `authAccessed` → query dedup at fan-out.** `computeQueryHash`
keys auth-independent queries identically across all users (massive dedup when 10k clients watch
the same conversation list); `authAccessed` gates per-identity keys for correctness. The
`CacheStrategy` is pluggable (Tier 0 in-memory → Tier 2 shared/edge cache) and invalidated by the
same `WriteInvalidation` ranges the reactive core already emits.

**5. Shard seam threaded (rows 1–2).** `UdfResult.shardId` and `UdfExecuteOptions.shardId` carry
the partition key (always `"default"` at Tier 0). When Tier 2 shards by conversation, the
executor already stamps every result with its shard — no engine change.

The conversion each reserve buys: at Tier 2, Endpoint B's read path is *adapters + config*
(`RemoteUdfExecutor`, a distributed `CacheStrategy`, an isolate-over-MessagePort channel), never
an app-code or core-engine rewrite. That conversion is this component's contribution to the
scalability mandate.

---

## 11. Failure & edge handling

| Condition | Detection | Surfaced as (code → HTTP) | Retry? |
|---|---|---|---|
| Module / export not found | `ModuleRegistry.load` / `analyzeUdfModule` | `FunctionNotFoundError` → 400 | no |
| Export is wrong type (called a mutation as a query) | type check pre-run | `FunctionTypeMismatchError` → 400 | no |
| Internal fn called from `callerKind:"client"` | `CallContext` + visibility | `InternalFunctionAccessError` → 403 | no |
| Arg / return / document validation fails | `validateArgs`/`validateDocument` | `ArgumentValidationError`/`DocumentValidationError` → 400 (carries `path`) | no |
| Forbidden capability (`fetch`/`Date.now`/`setTimeout` in q/m) | throwing stub fires | `ForbiddenOperationError` → 400 | no |
| OCC conflict | transactor `ConflictError` in `finalize` | retried (§7.5); if exhausted `OccConflictError` → 409 | yes (bounded, seeded) |
| Headroom exceeded (reads/writes/scheduled/bytes) | `TransactionHeadroomTracker` | resource error → 400 | **no** (distinct from conflict) |
| Isolate OOM / wall-clock timeout / hard crash | pool monitor / hard terminate | `UdfExecutionError` → 500; isolate discarded | no |
| Sandbox escape attempt (ambient global access) | `ReferenceError` in guest (no host globals) | `UdfExecutionError` → 500 | no |
| Non-JSON-serializable return value | value codec at `finalize` | `DocumentValidationError` → 400 (clear message) | no |
| Unknown wire op / ABI id mismatch | `SyscallRouter.dispatch` | `UserError` → 400 (names the op + expected ABI id) | no |
| Remote channel disconnect (Tier 2) | `RemoteUdfExecutor` | `ServiceUnavailableError` → 503 | yes (idempotent for queries; mutations gated on commit ack) |
| Dangling promise/timer after handler resolves | `finalize` awaits only the handler's promise; drains microtasks; closes cursors | dropped; logged in `trace` | n/a |
| Schema re-push invalidates injected `tableNumbers` | `ModuleRegistry.onChanged` → flush guest setup + isolate pool | next call rebuilds setup | n/a |

General rule (← platform error model): every thrown error carries `code`/`httpStatus`/`retryable`
and serializes via `toJSON()`, so the HTTP/WS layer maps any failure without a switch. We keep
the transactor's internal `ConflictError` **distinct** from the client-facing `OccConflictError`
so control-flow conflicts never leak to clients.

---

## 12. Test strategy

Runner: vitest. Property tests use `fast-check`. The acceptance gates:

### Property tests (the load-bearing invariants)

1. **Syscall-ABI round-trip** (`codec-boundary.property.test.ts`). For arbitrary syscall
   args/results (incl. bigint timestamps, nested Convex-value JSON, byte hex/base64), assert
   `deserialize(serialize(x)) ≡ x` with **no precision loss** — bigints survive as canonical
   decimal strings, no `number` coercion. This guards both serializable boundaries.
2. **`UdfResult` round-trip.** Arbitrary `UdfResult` (footprint ranges, scheduled refs, error
   payloads) survives `JSON.parse(JSON.stringify(r))` byte-stable — the precondition for
   `RemoteUdfExecutor` faithfulness.
3. **Order-preserving range agreement** (dependency cross-check with `query-engine`). For random
   value tuples, the `KeyRange`s the kernel records for a scan equal `encodeIndexKey`'s interval,
   and `compareIndexKeys` over recorded `[start,end)` reproduces logical sort order — so a
   committed write's key falls inside a subscriber's recorded interval iff it logically should.
   (The exhaustive codec ordering fuzz itself lives in `query-engine`; here we assert the
   executor *uses* it correctly, including the `_id` tiebreaker for stable cursors.)
4. **Determinism reproducibility.** For random `(path, args)`, running the same query/mutation N
   times yields **identical** `result` AND **identical** `footprint` AND identical seeded values;
   the §7.4 neutralized surfaces are each probed (a UDF reading `Math.random`/`Date.now`/
   `crypto.randomUUID` returns the same value across runs).
5. **Cross-impl equivalence** (`cross-impl-equivalence.test.ts`). The **same** UDF + args under
   `InlineUdfExecutor` and `IsolatedUdfExecutor` produce **byte-identical** `UdfResult` (modulo
   the non-deterministic `LogLine.timestampMs`). This proves the isolate boundary doesn't change
   semantics — the core promise of the serializable ABI.
6. **Seed stability vs uniqueness.** `seed(reqId,path,args)` is identical across OCC attempts
   (retry-stable) and distinct across distinct `(reqId,path,args)` (collision-resistant); insert
   ids regenerate identically on replay.

### Unit / scenario tests

7. **OCC conflict cases** (`occ-retry.test.ts`). (a) Inject a conflicting committed write between
   snapshot and `finalize` → exactly one `ConflictError` → retry → second attempt commits with
   **the same** insert ids (idempotent). (b) Persistent conflict → exhausts `maxRetries` →
   `OccConflictError` (409), not an infinite loop. (c) A read of an **absent** doc that later
   appears (phantom) triggers the conflict path. (d) A mutation that only reads commits with no
   `commitTimestamp`.
8. **Capability enforcement** (`capability-enforcement.test.ts`). `fetch`/`Date.now`/`setTimeout`/
   `crypto.randomUUID` inside a query/mutation throw `ForbiddenOperationError`; the same calls in
   an action succeed (real values). Asserts forbidden globals are **throwing stubs**, not
   `undefined`.
9. **Footprint authority (anti-forgery).** A guest that tries to under-report (e.g. reads via a
   syscall but the test inspects only host-recorded ranges) — assert the **host** ledger contains
   every read range regardless of guest behavior; a write is recorded even if the guest discards
   the return.
10. **Auth-independence / cache key.** A query that never calls `getUserIdentity` →
    `authAccessed:false` → `computeQueryHash` omits identity → two different users hit the same
    cache entry. One that calls it → per-identity keys; `CacheStrategy.invalidate` drops entries
    whose `readRanges` intersect a write.
11. **ABI versioning** (`abi-version.test.ts`). A bundle declaring `stackbase.syscall/1` keeps
    working when the router also mounts a (hypothetical) `/2` profile with renamed wire ops;
    an unknown wire op yields a precise `UserError` naming the op and expected ABI id.
12. **Isolate non-bleed** (`isolate-nonbleed.test.ts`). Module-level mutable state set during
    invocation A is **not** observable in invocation B (fresh context/instantiation); a
    crashed/timed-out isolate is not returned to the pool.
13. **Streaming cursors.** `paginate()` over a large table pulls pages via the server-side cursor
    table; the recorded read interval for a page ends **at the cursor**, not the index end (no
    over-invalidation); `q.cleanup`/`dispose` closes all cursors; a forgotten cursor is reaped at
    `finalize`.
14. **HTTP action serialization.** `executeHttp` round-trips `SerializedHttpRequest` →
    `SerializedHttpResponse` (base64 bodies, header pairs) with no live `Request`/`Response`
    crossing the boundary.
15. **Module loading.** glob-bundle, filesystem-dev, and in-memory-map loaders each resolve a
    module + export; `analyzeUdfModule` extracts `functions`/`httpRoutes`/`cronSpecs`;
    `onChanged` invalidates caches on dev hot-swap.

---

## 13. Open issues / decisions to finalize before/within implementation

1. **Isolate engine choice.** `isolated-vm` (mature, snapshot+memory caps, sync *and* async
   host calls) vs `worker_threads`+`MessagePort` (truly separate thread, async-only — aligns with
   the "all syscalls async" decision) vs `node:vm` (weak isolation, dev only). Leaning:
   `worker_threads` for the production isolate (matches the no-`SharedArrayBuffer` async channel
   and the Cloudflare/edge model), `node:vm`/inline for dev. Must validate startup cost.
2. **Isolate startup cost / warm-start.** Confirm the snapshot warm-pool gets per-call overhead
   under the query-latency budget; define the reset protocol that provably clears tenant state
   (the non-bleed gate). The biggest perf risk.
3. **Determinism completeness.** Finalize the §7.4 audit — especially `Intl`/locale,
   `performance.now`, async **microtask ordering**, and `WeakRef`/`FinalizationRegistry` removal.
   Decide pin-vs-disallow per surface and encode each as a guard + a property in test #4.
4. **Seed derivation finalization.** Lock the hash (BLAKE3 vs SHA-256), the PRNG (ChaCha8 vs
   xoshiro256\*\*), and the **args canonicalization** rules for bigint/bytes/`undefined`/`-0`/NaN
   so the seed is stable cross-platform.
5. **ABI versioning policy.** Confirm additive-only within a major id, a deprecation window, and
   whether `developerIdFormat` can ever change without a new major. Pin the initial op→wire map.
6. **Headroom numbers & enforcement points.** Adopt the §7.8 caps as defaults; decide per-type
   wall-clock/memory caps and where `limits.checkpoint` must fire (every N reads? per page?).
7. **Action sandbox depth.** Actions are long-running + network-egressing; running them in the
   same isolate model as queries may be wrong. Likely a **separate, heavier executor** behind the
   same `UdfExec` (network egress allow-list, longer timeout, its own pool). Decide now so the
   interface doesn't leak the distinction.
8. **Component scoping across the syscall boundary.** Whether a component may call across into
   another component and with whose auth; how `componentPath` + the table registry's
   per-component namespacing interact with the kernel's resolution. (Components are "Not
   supported" in v1 compatibility, but the seam must not foreclose it.)
9. **Query-cache placement & coherence at Tier 2.** Whether the cache sits in the executor or
   above it; correctness of auth-independent dedup; snapshot-vs-replica-lag when a pool node reads
   a replica at `snapshotTimestamp` (stale replica must not serve a snapshot it hasn't reached).
10. **Log delivery.** Batch-return (default) vs live streaming for long actions via
    `limits.checkpoint`/a dedicated flush op; bound the buffered log size.
11. **`finalize` async-drain semantics.** Exact rule for pending syscalls/promises after the
    handler resolves (we await only the handler's promise + drain microtasks); confirm no
    correctness gap for legitimately-concurrent `Promise.all` of reads.
