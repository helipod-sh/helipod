---
title: Foundation — Embedded Tier 0 Runtime & Loopback Transport
status: design (implementation-ready)
audience: engineering (internal)
slice: Foundation
component: embedded-runtime
depends_on: [sqlite-docstore, occ-transactor, query-engine, isolate-executor, reactive-sync-tier]
---

# Embedded Tier 0 Runtime & Loopback Transport

> Clean-room design for **Stackbase**. We studied the concave packages
> (`@concavejs/runtime-base`, `@concavejs/runtime-embedded`, `@concavejs/transport-bridge`,
> `@concavejs/transport-capnweb`; FSL-1.1-Apache-2.0) only to learn the **shape** of the
> contracts. Every interface below is our own restatement in our own vocabulary. No source
> is copied; concave names are cited only as parity anchors. See
> [`.reference/README.md`](../../../../.reference/README.md).
>
> Grounding: [system-design](../system-design.md) · [strategy](../strategy.md) ·
> [scalability-spectrum](../scalability-spectrum.md) · internals
> [06-runtimes-topology](../internals/06-runtimes-topology.md) (primary),
> [03-reactivity-sync](../internals/03-reactivity-sync.md),
> [05-udf-execution](../internals/05-udf-execution.md),
> [02-transactions-consistency](../internals/02-transactions-consistency.md),
> [01-storage](../internals/01-storage.md), [07-platform-services](../internals/07-platform-services.md).

---

## 1. Purpose & boundaries

### 1.1 What this component is

The **Embedded Runtime** is the **composition root** of Stackbase Tier 0: it instantiates the
five engine slices it depends on and wires them into **one in-process binary** with no sidecar,
no TCP, and no port. It is the object a developer gets from `createEmbeddedRuntime(options)`,
and it is the object that `stackbase dev` and the standalone binary run.

It hands the **unmodified** Convex client a `ClientTransport` — a `{ clientUrl,
webSocketConstructor, fetch }` triple — whose WebSocket and `fetch` are **in-memory shims**
(`LoopbackWebSocket` + loopback `fetch`) wired straight into the engine. The client believes it
is talking to a server over a network; every byte is a function call.

It implements `RuntimeHost`: **the single ingress every transport funnels through.** Loopback
(Tier 0), worker/`MessagePort` RPC (Tier 1), and a networked WS server (Tier 2) are all just
different ways to reach the same `RuntimeHost` methods.

### 1.2 What it OWNS (this slice builds these)

| Owns | Why it lives here |
|---|---|
| `RuntimeHost` interface | The host-agnostic ingress contract all transports share. |
| `EmbeddedRuntime` + `EmbeddedRuntimeOptions` + `createEmbeddedRuntime()` | The Tier 0 composition: docstore + transactor + executor + sync handler + HTTP handler in one process. |
| `LoopbackWebSocket` / `LoopbackServerSocket` / `LoopbackBridge` + `createLoopbackWebSocketConstructor()` | The in-memory WebSocket shim and its duplex coordinator. |
| `ClientTransport` + `createTransport()` / `createWebSocketConstructor()` / `createFetch()` | The client-fabrication seam (row 3). |
| Loopback `fetch` (`createLoopbackFetch()`) | In-process `Request`→`Response` with no network. |
| `EmbeddedWriteFanout` / `EmbeddedWriteFanoutAdapter` / `EmbeddedWriteFanoutPayload` + `InMemoryWriteFanoutAdapter` | The transactor→sync **publish boundary** (row 4). |
| `ChangeStreamConsumer` (interface, reserved) | The Tier 2 consumer shape; Tier 0 realizes it via the fanout subscription. |
| `SerializedUdfExecutor` + `EmbeddedExecutionMode` + ALS detection | Serialized execution where `AsyncLocalStorage` is unavailable. |
| `UdfExecutionAdapter` (the ingress glue) + `EmbeddedSyncUdfExecutor` (sync→exec bridge) | The one place "raw request" becomes "typed, authed, context-tagged execution." |
| `HttpHandler` (host wiring) | Serves the core `/api/*` HTTP surface + user `httpAction` routes by delegating to the adapter. |
| `start()` bootstrap orchestration + `refreshSchema()` hot-reload | Lifecycle: system-table bootstrap, schema/index metadata sync, hot reapply. |

### 1.3 What it does NOT own (consumed from dependency slices)

| Not owned | Owned by |
|---|---|
| `DocStore`, `DatabaseAdapter`, `BaseSqlDocStore`, SQLite layout, `TimestampOracle`, table registry | **sqlite-docstore** ([01](../internals/01-storage.md)) |
| `Transactor`, `TransactionContext`, 3-phase OCC, `CommitResult`, `WriteInvalidation` shape, RYOW | **occ-transactor** ([02](../internals/02-transactions-consistency.md)) |
| `encodeIndexKey`/`compareIndexKeys`, `RangeSet`/`KeyRange`/`SerializedKeyRange`, planner, `IndexCursor`, `QueryJournal` | **query-engine** ([04](../internals/04-query-engine.md)) |
| `UdfExec`, the V8 isolate, kernel, syscall ABI, determinism profiles, module loader/analysis | **isolate-executor** ([05](../internals/05-udf-execution.md)) |
| `SyncProtocolHandler`, `SubscriptionManager`, interval tree, `QueryCache`, `SyncSession` + guardrail controllers, the wire message catalog (`Connect`/`ModifyQuerySet`/`Transition`/…), `SyncWebSocket`/`SyncUdfExecutor` interfaces | **reactive-sync-tier** ([03](../internals/03-reactivity-sync.md)) |
| `AuthResolver`/`Principal`, scheduler/cron executors, blob/search/vec stores, error hierarchy, system-table bootstrap helpers | **platform-services** ([07](../internals/07-platform-services.md)) — Foundation consumes the minimal slice (bootstrap helpers, `AuthResolver`, error types). |

The runtime **constructs and connects** these; it never reaches inside them. The discipline from
[06](../internals/06-runtimes-topology.md) holds: *the engine is the same everywhere; a host is a
handful of adapter methods plus a timer and a socket type.* This component is the Node-first host.

### 1.4 Where it sits

```
            ┌──────────────────────── EmbeddedRuntime (RuntimeHost) ────────────────────────┐
  unmodified│                                                                                │
  Convex    │   ClientTransport                          UdfExecutionAdapter (the ingress)   │
  client ──►│  { clientUrl,                 ┌──────────────────┴───────────────────┐         │
            │    webSocketConstructor, ─────┤  loopback WS  ─► createSyncSession    │         │
            │    fetch }              ──────┤  loopback fetch ─► handleRequest      │         │
            │        ▲                      └──────┬───────────────────┬───────────┘         │
            │        │ server→client push          │ execute           │ execute             │
            │   LoopbackBridge ◄── SyncProtocolHandler ◄── EmbeddedSyncUdfExecutor            │
            │  (loopback transport)     (reactive-sync-tier)        │  │                      │
            │                                  ▲ applyWrites        ▼  ▼                      │
            │                                  │            SerializedUdfExecutor? ─► UdfExec │
            │   notifyWrites(inv) ─────────────┘                 (isolate-executor)    │      │
            │        │  (publish boundary)                              │              │      │
            │        ├─► syncHandler.applyWrites(inv)   [local, fast]   ▼              │      │
            │        └─► EmbeddedWriteFanout.publish ─► Adapter ─► (other processes)   │      │
            │                                                Transactor ◄──────────────┘      │
            │                                                  │ CommitResult{commit_ts,…}    │
            │                                                  ▼                              │
            │                                               DocStore (SQLite, WAL)            │
            └────────────────────────────────────────────────────────────────────────────────┘
```

---

## 2. The `RuntimeHost` contract (the single ingress)

`RuntimeHost` is the **host-agnostic** interface. `EmbeddedRuntime` is its Tier 0 implementation;
a Tier 2 networked host implements the same surface. Every transport (loopback, worker, WS) calls
only these methods — that is the row-3 fabrication seam on the **server** side.

```ts
// packages/runtime-embedded/src/runtime-host.ts

/** A snapshot/commit u64 timestamp. bigint in-process; decimal string on the wire. */
export type LogicalTimestamp = bigint;

export type UdfType = "query" | "mutation" | "action" | "httpAction";
export type CallType = "client" | "server";

/** One execution request, as it reaches the host from any transport. */
export interface RuntimeUdfRequest {
  path: string;                       // "messages:list" (module:export)
  args: unknown;                      // JSON args (decoded to engine values by the adapter)
  type: UdfType;
  auth?: AuthToken;                   // raw token + hint; resolver turns it into a Principal
  componentPath?: string;            // "" (root) at Tier 0; reserved for components
  requestId?: string;
  snapshotTimestamp?: LogicalTimestamp; // pin reads to a snapshot (sync re-runs supply this)
  callType?: CallType;               // default "client" for external ingress
}

/** Mirrors UdfResult (isolate-executor) — the reactivity-bearing result. */
export interface RuntimeUdfResult {
  result: unknown;                    // JSON-encodable return value
  logLines: string[];
  trace?: unknown;
  readRanges?: SerializedKeyRange[];  // query footprint  → subscription deps
  writtenRanges?: SerializedKeyRange[]; // mutation footprint → invalidation
  writtenTables?: string[];
  snapshotTimestamp?: LogicalTimestamp; // queries
  commitTimestamp?: LogicalTimestamp;   // mutations
  authAccessed?: boolean;             // affects cacheability
  cacheStatus?: "miss" | "local-hit" | "edge-hit";
}

/** Opaque handle to a registered sync session (one per connected socket). */
export interface SyncSessionHandle {
  readonly sessionKey: string;        // host-assigned, provisional until Connect
  readonly socket: SyncWebSocket;     // server-facing transport (reactive-sync-tier)
}

export interface SyncSessionMeta {
  remoteAddr?: string;                // best-effort; "loopback" at Tier 0
  protocol?: string;
}

export interface NotifyWritesOptions {
  /** Local-only: skip the originating session (it already gets its MutationResponse). */
  excludeSessionId?: string;
  /** When true, do NOT re-publish to the fanout (used when applying a remote payload). */
  localOnly?: boolean;
}

export interface RefreshSchemaResult {
  changed: boolean;                   // false when the module content hash is unchanged
  schemaVersion: string;              // content hash after refresh
  reusedBootstrap: boolean;
  durationsMs: { reloadModules: number; syncMetadata: number; invalidate: number; total: number };
  error?: { code: string; message: string }; // set when reload failed; old schema retained
}

export interface RuntimeHost {
  // ── lifecycle ────────────────────────────────────────────────────────────
  /** Idempotent. Opens the docstore, bootstraps system tables, syncs schema/index metadata,
   *  constructs + wires all subsystems, subscribes the write-fanout. Memoized. */
  start(): Promise<void>;
  /** Graceful teardown: close sessions (FatalError+close), unsubscribe fanout, close docstore. Idempotent. */
  close(): Promise<void>;

  // ── execution ingress (HTTP, internal, cron all land here) ───────────────
  executeUdf(req: RuntimeUdfRequest): Promise<RuntimeUdfResult>;
  executeHttp(request: Request): Promise<Response>;     // user httpAction dispatch
  handleRequest(request: Request): Promise<Response>;   // unified: core /api/* then httpAction then 404

  // ── sync-session ingress (one set of methods for every socket transport) ──
  createSyncSession(socket: SyncWebSocket, meta?: SyncSessionMeta): SyncSessionHandle;
  handleSyncMessage(session: SyncSessionHandle, data: string | ArrayBufferLike): Promise<void>;
  updateSyncSessionId(session: SyncSessionHandle, clientSessionId: string): void;
  destroySyncSession(session: SyncSessionHandle, code?: number, reason?: string): void;

  // ── the publish boundary (row 4) ─────────────────────────────────────────
  /** Apply an invalidation to LOCAL subscribers and PUBLISH it to other processes.
   *  Called by the sync handler after a WS mutation and by the HTTP handler after an HTTP mutation. */
  notifyWrites(invalidation: WriteInvalidation, opts?: NotifyWritesOptions): void;

  // ── client fabrication (row 3) ───────────────────────────────────────────
  createWebSocketConstructor(): LoopbackWebSocketConstructor; // shaped like `typeof WebSocket`
  createFetch(clientUrl?: string): typeof fetch;
  createTransport(clientUrl?: string): ClientTransport;

  // ── dev-loop hot reload ──────────────────────────────────────────────────
  refreshSchema(): Promise<RefreshSchemaResult>;
}
```

**Dependency-owned types referenced above** (restated for the contract; defined in their slices):

```ts
// reactive-sync-tier (03):
export interface SyncWebSocket {           // server-facing socket the handler talks to
  send(data: string): void;
  close(code?: number, reason?: string): void;
  readonly readyState: number;             // 0..3, WebSocket constants
  readonly bufferedAmount?: number;        // backpressure signal (kept honest even on loopback)
}
// query-engine (04) / occ-transactor (02):
export interface SerializedKeyRange { tableId: string; startKey: string; endKey: string | null; isPoint: boolean; }
export interface WriteInvalidation {
  writtenRanges?: SerializedKeyRange[];
  writtenTables?: string[];
  commitTimestamp?: LogicalTimestamp;
  snapshotTimestamp?: LogicalTimestamp;
  shardId?: string;                        // default "default" at Tier 0 (rows 1/2/4 seam)
}
// platform-services (07):
export interface AuthToken { token?: string; tokenTypeHint?: "auto" | "Admin" | "System" | "User" | "None"; impersonating?: unknown; }
```

---

## 3. `EmbeddedRuntime` — the Tier 0 composition

```ts
// packages/runtime-embedded/src/embedded-runtime.ts

export type EmbeddedModuleMap = Record<string, () => Promise<unknown> | unknown>;
/** A real fs/glob ModuleLoader (isolate-executor), an in-memory map, or a mix. */
export type EmbeddedModuleSources = ModuleLoader | EmbeddedModuleMap | Array<ModuleLoader | EmbeddedModuleMap>;

export type EmbeddedExecutionMode = "auto" | "parallel" | "serial";
export type SchemaBootstrapMode = "auto" | "skip";

export interface EmbeddedRuntimeOptions {
  // ── storage (required) ───────────────────────────────────────────────────
  docstore: DocStore;                       // sqlite-docstore; runtime never opens a driver itself
  blobstore?: BlobStore;                    // optional (file storage slice)

  // ── user code ────────────────────────────────────────────────────────────
  modules: EmbeddedModuleSources;           // convex/-equivalent functions + schema + crons
  schemaModulePath?: string;                // default "schema"

  // ── execution ────────────────────────────────────────────────────────────
  executor?: UdfExec;                       // default: the isolate executor (isolate-executor)
  executionMode?: EmbeddedExecutionMode;    // default "auto"
  serializedExecutorOptions?: SerializedExecutorOptions;

  // ── reactivity / fan-out ──────────────────────────────────────────────────
  writeFanoutAdapter?: EmbeddedWriteFanoutAdapter; // default: a fresh InMemoryWriteFanoutAdapter
  writeFanoutConfig?: WriteFanoutConfig;
  syncHandlerOptions?: SyncHandlerOptions;  // guardrail knobs (reactive-sync-tier)

  // ── identity / sharding seam ──────────────────────────────────────────────
  instanceId?: string;                      // logical instance name; default random
  originId?: string;                        // fanout dedup id; default `${instanceId}:${pid}:${rand}`
  shardId?: string;                         // default "default" — threaded onto every invalidation

  // ── auth / http / lifecycle ───────────────────────────────────────────────
  authResolver?: AuthResolver;              // default: insecure single-tenant dev resolver
  clientUrl?: string;                       // dummy base URL for fabricated transport; default "https://embedded.local"
  isDev?: boolean;                          // default true; enables dev error verbosity + InMemoryLogSink
  logSink?: LogSink;                        // default InMemoryLogSink in dev, NoopLogSink in prod
  schemaBootstrap?: SchemaBootstrapMode;    // default "auto"
  now?: () => number;                       // injectable wall clock (tests)
}

export interface EmbeddedRuntime extends RuntimeHost {
  readonly options: Readonly<Required<Pick<EmbeddedRuntimeOptions, "instanceId" | "originId" | "shardId" | "clientUrl">>>;
  readonly services: RuntimeServices;       // { docstore, blobstore?, udfExecutor, … } (isolate-executor bundle)
}

export function createEmbeddedRuntime(options: EmbeddedRuntimeOptions): EmbeddedRuntime;
```

### 3.1 What `createEmbeddedRuntime` composes (construction order)

1. Normalize options; resolve `executionMode` (§7.3); allocate `instanceId`/`originId`/`shardId`.
2. Build the **module registry** from `modules` (fs loader + in-memory map overlay) — isolate-executor.
3. Build `RuntimeServices = { docstore, blobstore?, udfExecutor: <self-ref> }` and the **table registry**
   (`DocStoreTableRegistry` for durable, `MemoryTableRegistry` for `:memory:` dev) — sqlite-docstore.
4. Construct the **base `UdfExec`** (isolate executor) over `RuntimeServices` + module registry + `logSink`.
5. Wrap it: `executor = mode === "serial" ? new SerializedUdfExecutor(base, opts) : base`.
6. Build the **client `UdfExecutionAdapter`** (call type `client`) and the **server adapter**
   (call type `server`, injected back into `RuntimeServices.udfExecutor` for nested calls) — §7.4.
7. Build the **`SyncProtocolHandler`** (reactive-sync-tier) with an `EmbeddedSyncUdfExecutor`
   (§7.5) as its `SyncUdfExecutor` and `this.notifyWrites` as its injected publish callback.
8. Build the **`HttpHandler`** (§8) with `executeFunction` → the client adapter, `notifyWrites` → `this.notifyWrites`.
9. Build the **`EmbeddedWriteFanout`** over `writeFanoutAdapter`, with
   `onRemoteWrite = (inv) => this.applyWritesLocally(inv)` and `originId`.
10. Return the runtime; nothing touches the docstore until `start()`.

`start()` (idempotent, memoized) then runs the bootstrap sequence in §9.

---

## 4. Loopback transport — no network for the in-process client

The Convex client speaks **WebSocket + HTTP**. Tier 0 satisfies both with in-memory shims so the
*unmodified* client cannot tell it is not on a network. Three cooperating objects:

- **`LoopbackWebSocket`** — what the **client** holds. A faithful `WebSocket` implementation.
- **`LoopbackServerSocket`** — what the **sync handler** holds. Implements `SyncWebSocket`.
- **`LoopbackBridge`** — the duplex coordinator owning both, the session handle, and the two
  ordered async delivery queues.

### 4.1 `ClientTransport` & fabrication

```ts
// packages/runtime-embedded/src/loopback/client-transport.ts

/** Shaped like `typeof WebSocket`: `new (url, protocols?) => LoopbackWebSocket`, plus the 4 constants. */
export interface LoopbackWebSocketConstructor {
  new (url: string | URL, protocols?: string | string[]): LoopbackWebSocket;
  readonly CONNECTING: 0; readonly OPEN: 1; readonly CLOSING: 2; readonly CLOSED: 3;
}

/** The triple the Convex client is constructed from. Stable across all tiers (row 3). */
export interface ClientTransport {
  clientUrl: string;                                  // base URL the client builds requests against
  webSocketConstructor: LoopbackWebSocketConstructor; // structurally `typeof WebSocket`
  fetch: typeof fetch;                                // in-process Request→Response
}

export function createLoopbackWebSocketConstructor(host: RuntimeHost): LoopbackWebSocketConstructor;
export function createLoopbackFetch(host: RuntimeHost, clientUrl: string): typeof fetch;
```

`EmbeddedRuntime` implements the trio as:

```ts
createWebSocketConstructor() { return createLoopbackWebSocketConstructor(this); }
createFetch(clientUrl = this.options.clientUrl) { return createLoopbackFetch(this, clientUrl); }
createTransport(clientUrl = this.options.clientUrl): ClientTransport {
  return { clientUrl, webSocketConstructor: this.createWebSocketConstructor(), fetch: this.createFetch(clientUrl) };
}
```

### 4.2 `LoopbackWebSocket` (client-facing)

```ts
// packages/runtime-embedded/src/loopback/loopback-websocket.ts

export class LoopbackWebSocket implements EventTarget {
  static readonly CONNECTING = 0; static readonly OPEN = 1;
  static readonly CLOSING = 2;    static readonly CLOSED = 3;
  readonly CONNECTING = 0; readonly OPEN = 1; readonly CLOSING = 2; readonly CLOSED = 3;

  readonly url: string;
  readyState: 0 | 1 | 2 | 3 = 0;       // CONNECTING
  bufferedAmount = 0;                  // notional; tracked while a frame is in the queue
  binaryType: "blob" | "arraybuffer" = "arraybuffer";
  protocol = ""; extensions = "";

  onopen: ((ev: Event) => void) | null = null;
  onmessage: ((ev: MessageEvent) => void) | null = null;
  onclose: ((ev: CloseEvent) => void) | null = null;
  onerror: ((ev: Event) => void) | null = null;

  // ── client → server (the API the Convex client calls) ──
  send(data: string | ArrayBufferLike | ArrayBufferView): void;     // throws if not OPEN (mirrors WS)
  close(code?: number, reason?: string): void;                      // CLOSING → bridge.disconnect → CLOSED

  // EventTarget surface (clients may use either onX or addEventListener)
  addEventListener(type: string, cb: EventListenerOrEventListenerObject): void;
  removeEventListener(type: string, cb: EventListenerOrEventListenerObject): void;
  dispatchEvent(ev: Event): boolean;

  // ── server → client push (called by the bridge ONLY; never by the client) ──
  openFromBridge(): void;                                           // CONNECTING → OPEN, fire "open"
  messageFromBridge(data: string | ArrayBufferLike): void;          // fire "message"
  closeFromBridge(code: number, reason: string, wasClean: boolean): void; // → CLOSED, fire "close"
  errorFromBridge(message: string): void;                           // fire "error"
}
```

### 4.3 `LoopbackBridge` (the duplex coordinator)

```ts
// packages/runtime-embedded/src/loopback/loopback-bridge.ts

export class LoopbackBridge {
  constructor(host: RuntimeHost, ws: LoopbackWebSocket, meta?: SyncSessionMeta);

  /** Called once, asynchronously, on construction. Registers the server session and opens the client. */
  connect(): void;
  /** client → server. Enqueued FIFO; delivered async to host.handleSyncMessage. */
  send(data: string | ArrayBufferLike): void;
  /** client-initiated close. → host.destroySyncSession + ws.closeFromBridge. */
  disconnect(code?: number, reason?: string): void;

  /** The server-facing socket the sync handler is given (SyncWebSocket). */
  readonly serverSocket: LoopbackServerSocket;
}

/** Implements SyncWebSocket; server→client frames go here. */
export class LoopbackServerSocket implements SyncWebSocket {
  send(data: string): void;            // enqueue FIFO → ws.messageFromBridge (async)
  close(code?: number, reason?: string): void;
  get readyState(): number;            // mirrors ws.readyState
  get bufferedAmount(): number;        // queued server→client bytes (drains to 0 each turn)
}
```

### 4.4 Ordered, non-reentrant delivery (the fidelity rule)

A real WebSocket **never** delivers a message synchronously inside `send()` and **always**
preserves order. The loopback must match this or Tier 0 will diverge subtly from networked tiers
(the explicit risk flagged in [06](../internals/06-runtimes-topology.md)).

**Algorithm — one FIFO queue per direction, drained on a microtask:**

```
DeliveryQueue:
  q: array<frame>           // FIFO
  draining: bool = false
  enqueue(frame):
    q.push(frame); bytes += size(frame)         // bytes feeds bufferedAmount
    if not draining: draining = true; queueMicrotask(drain)
  drain():
    while q not empty:
      frame = q.shift(); bytes -= size(frame)
      deliver(frame)        // ws.messageFromBridge / host.handleSyncMessage
    draining = false
```

Rules:
- **`deliver` is reached only via `queueMicrotask`** — `send()` returns before the peer observes the
  frame. (Use `queueMicrotask`; never call the peer handler inline.)
- **Strict FIFO** within a direction; the two directions are independent.
- `handleSyncMessage` is `async`; the bridge **awaits** it before delivering the next inbound frame
  (per-session serialization, matching the sync handler's own `withSessionLock`). Server→client
  frames do not wait on each other beyond microtask ordering.
- `bufferedAmount` reflects queued-but-undelivered bytes; it returns to 0 each microtask turn. The
  field is **kept honest** so `SessionBackpressureController` (reactive-sync-tier) runs the same code
  path on loopback as on a real socket (no-op in practice, but never bypassed).

### 4.5 Lifecycle sequence

```
new LoopbackWebSocket(url)           // readyState = CONNECTING
  └─ bridge = new LoopbackBridge(host, ws); queueMicrotask(bridge.connect)
bridge.connect():
  session = host.createSyncSession(bridge.serverSocket, meta)   // registers with sync handler
  ws.openFromBridge()                // readyState = OPEN; fire "open"

ws.send(clientMsg)                    // throws if not OPEN
  └─ bridge inbound queue → (await) host.handleSyncMessage(session, clientMsg)

syncHandler → serverSocket.send(serverMsg)
  └─ bridge outbound queue → ws.messageFromBridge(serverMsg)    // fire "message"

ws.close(code, reason)                // readyState = CLOSING
  └─ bridge.disconnect → host.destroySyncSession(session, code, reason)
     └─ ws.closeFromBridge(code, reason, wasClean=true)         // readyState = CLOSED; fire "close"
```

### 4.6 Loopback `fetch`

```ts
createLoopbackFetch(host, clientUrl) → async (input, init) => {
  const request = new Request(new URL(typeof input === "string" ? input : input.url, clientUrl), init);
  return host.handleRequest(request);     // pure in-process call; no socket, no port
}
```

`handleRequest` runs the **same** core HTTP router the Tier 2 networked host would run (§8), so the
client's HTTP path (one-shot queries, action calls, etc.) is identical to networked behavior minus
the wire.

---

## 5. Write fan-out — the transactor→sync publish boundary (row 4)

> **Seam #4 (scalability-spectrum row 4):** the transactor **publishes** invalidations; the sync
> tier **subscribes**. They are never directly coupled. The payload is **serializable from day one**.
> Tier 0 uses an in-memory channel; swap the adapter for BroadcastChannel/Redis/Queues and the *same*
> fan-out spans many processes — each ignoring its own `originId`.

### 5.1 Types

```ts
// packages/runtime-embedded/src/write-fanout/types.ts

export interface EmbeddedWriteFanoutPayload {
  v: 1;                             // envelope version (additive evolution)
  originId: string;                // publishing runtime instance (dedup key)
  messageId: string;               // unique per publish (dedup against redelivery)
  emittedAtMs: number;             // diagnostics only; NOT used for ordering
  shardId: string;                 // "default" at Tier 0 (rows 1/2/4)
  writtenRanges: SerializedKeyRange[];
  writtenTables: string[];
  commitTimestamp: string;         // u64 as decimal string (wire-safe)
  snapshotTimestamp?: string;
}

/** The pluggable transport. In-memory at Tier 0; BroadcastChannel/Redis/Queues later. */
export interface EmbeddedWriteFanoutAdapter {
  publish(payload: EmbeddedWriteFanoutPayload): void | Promise<void>;
  subscribe(listener: (payload: EmbeddedWriteFanoutPayload) => void): () => void; // returns unsubscribe
  close(): void | Promise<void>;
}

export interface WriteFanoutConfig {
  dedupWindow?: number;            // recent messageId LRU size; default 4096
  onError?: (err: unknown, phase: "publish" | "deliver" | "deserialize") => void;
}

export interface EmbeddedWriteFanout {
  readonly originId: string;
  publish(invalidation: WriteInvalidation): void;  // stamp envelope → adapter.publish (best-effort)
  close(): Promise<void>;
}

export function createEmbeddedWriteFanout(args: {
  originId: string;
  adapter: EmbeddedWriteFanoutAdapter;
  onRemoteWrite: (invalidation: WriteInvalidation) => void; // foreign payloads ONLY
  config?: WriteFanoutConfig;
}): EmbeddedWriteFanout;
```

### 5.2 The publish boundary on the runtime

`RuntimeHost.notifyWrites` is the **one** fan-out entry. Two private helpers keep local and remote
paths crisp:

```ts
// EmbeddedRuntime
notifyWrites(inv: WriteInvalidation, opts?: NotifyWritesOptions): void {
  inv.shardId ??= this.options.shardId;            // thread the shard seam (always "default" now)
  this.applyWritesLocally(inv, opts?.excludeSessionId);   // (1) LOCAL fast path
  if (!opts?.localOnly) this.writeFanout.publish(inv);    // (2) CROSS-PROCESS broadcast
}

private applyWritesLocally(inv: WriteInvalidation, excludeSessionId?: string): void {
  // in-process, synchronous, ArrayBuffer ranges (no serialization): re-run overlapping subs, push Transitions
  this.syncHandler.applyWrites(inv, { excludeSessionId });   // reactive-sync-tier
  this.queryCache.invalidateByTables(inv.writtenTables ?? writtenTablesFromRanges(inv.writtenRanges));
}
```

- `createEmbeddedWriteFanout` is wired with `onRemoteWrite = (inv) => this.applyWritesLocally(inv)`.
- On subscribe, the fanout **drops payloads whose `originId === this.originId`** (already applied at
  step 1) and **drops `messageId`s seen within `dedupWindow`** (redelivery from an at-least-once
  adapter). Surviving foreign payloads are deserialized (`SerializedKeyRange` → in-memory) and handed
  to `onRemoteWrite`.

**Invariant:** local subscribers are notified **exactly once** (step 1); remote subscribers exactly
once (their `onRemoteWrite`). No double-apply, no miss. At Tier 0 (one process) step 2 is a cheap
self-ignored no-op.

### 5.3 `InMemoryWriteFanoutAdapter` (Tier 0 default)

```ts
// packages/runtime-embedded/src/write-fanout/in-memory-adapter.ts
export class InMemoryWriteFanoutAdapter implements EmbeddedWriteFanoutAdapter {
  // a Set<listener>; publish() iterates listeners via queueMicrotask (never reentrant);
  // close() clears listeners. One INSTANCE = one bus.
}
/** Shared hub: pass the SAME instance to multiple runtimes in one process so they see each other. */
export function createSharedInMemoryWriteFanoutAdapter(): EmbeddedWriteFanoutAdapter;
```

Default behavior: each runtime gets its **own** instance ⇒ single-runtime fan-out is self-only
(correct). Multi-runtime same-process (e.g. a SharedWorker test, or two embedded engines over one DB
file) share one instance and fan out to each other — the Tier 1 preview, validated at Tier 0 cost.

### 5.4 `ChangeStreamConsumer` (reserved; Tier 2 shape)

```ts
// packages/runtime-embedded/src/write-fanout/change-stream-consumer.ts
export interface ChangeStreamPosition { shardId: string; offset: string; }   // opaque cursor
export interface ChangeStreamConsumer {
  start(): Promise<void>;
  stop(): Promise<void>;
  onChanges(cb: (delta: OplogDelta) => void): () => void;   // OplogDelta from occ-transactor (02)
  getCurrentPosition(): ChangeStreamPosition;
}
```

At Tier 0 the EmbeddedWriteFanout subscription **is** the consumer; `getCurrentPosition` is a local
monotonic counter. At Tier 2 you implement `EmbeddedWriteFanoutAdapter` over a real oplog tail
(`OplogDelta` stream), and `getCurrentPosition` maps to the stream offset for resumable, gapless
consumption. **No engine change** — the runtime keeps calling `notifyWrites`/`onRemoteWrite`.

---

## 6. Why the wire is serializable from day one

Every byte that crosses the publish boundary is JSON-safe:

- `SerializedKeyRange` carries **hex strings**, never `ArrayBuffer`. (The local fast path keeps
  `ArrayBuffer` for speed; only the *published* payload is serialized.)
- `commitTimestamp`/`snapshotTimestamp` are **decimal strings** (u64-as-`Long`), never `bigint`
  (which `JSON.stringify` cannot encode).
- `originId`, `messageId`, `shardId` are strings; `emittedAtMs` a number.

This is the difference that makes row 4 real: an in-memory adapter could *cheat* and pass live
objects, which would silently break the moment you swap in BroadcastChannel/Redis. We forbid that —
the payload type is the contract, and a property test (§12) asserts `deserialize(serialize(x)) ≡ x`.

---

## 7. Execution wiring

### 7.1 `UdfExec` (consumed, not owned)

```ts
// isolate-executor (05) — the executor contract this runtime wraps & calls
export interface UdfExec {
  execute(path: string, args: unknown, type: UdfType, auth?: ResolvedAuth,
          componentPath?: string, requestId?: string, snapshotTimestamp?: LogicalTimestamp): Promise<UdfResult>;
  executeHttp(request: Request, auth?: ResolvedAuth, requestId?: string): Promise<UdfResult>;
}
```

### 7.2 `SerializedUdfExecutor` — correctness without `AsyncLocalStorage`

Some hosts (browser, React Native, older edge runtimes) lack reliable `AsyncLocalStorage`, so
concurrent UDFs could **leak async context** into each other. The fix is to **serialize execution**
through a queue so only one UDF runs at a time. It preserves the full `UdfExec` contract.

```ts
// packages/runtime-embedded/src/execution/serialized-executor.ts
export interface SerializedExecutorOptions {
  maxQueueDepth?: number;     // default 1024; over → reject with ServiceUnavailableError (503)
  onQueueDepth?: (depth: number) => void;
}
export class SerializedUdfExecutor implements UdfExec {
  constructor(inner: UdfExec, options?: SerializedExecutorOptions);
  // execute / executeHttp append to a single promise chain (FIFO); at most one inner call in flight.
}
```

**Algorithm — single-lane promise chain:**

```
tail: Promise = resolved
run(task):
  if depth >= maxQueueDepth: throw ServiceUnavailableError(retryAfterMs)
  depth++
  const slot = tail.then(() => task())          // chain after the previous task
  tail = slot.then(noop, noop)                   // chain ADVANCES even if task rejects (no poison)
  try { return await slot } finally { depth-- }
```

Properties (property-tested, §12): **at most one** inner execution in flight at any instant; FIFO
completion order equals submission order; a rejected task does not stall or reorder the queue.

### 7.3 Resolving `EmbeddedExecutionMode`

```
detectAsyncLocalStorageAvailability():
  try: import node:async_hooks; const als = new AsyncLocalStorage();
       let ok=false; als.run("x", () => { ok = als.getStore() === "x"; }); return ok
  catch: return false

resolveMode(requested):
  "serial"   → serial
  "parallel" → parallel   (caller asserts ALS-safe; log a warning if detection says unsafe)
  "auto"     → detectAsyncLocalStorageAvailability() ? parallel : serial
```

Node 22.5+ (our Tier 0 target) has ALS ⇒ `"auto"` picks **parallel** on the standalone binary and
**serial** in a browser/RN bundle. Documented in the open question on serial-vs-parallel default
([06](../internals/06-runtimes-topology.md)).

### 7.4 `UdfExecutionAdapter` — the ingress glue

The single place "raw transport request" becomes "typed, authed, context-tagged execution." Every
ingress (HTTP, WS, internal, cron) funnels through it so the glue is written **once**.

```ts
// packages/runtime-embedded/src/execution/execution-adapter.ts
export interface UdfExecutionAdapter {
  executeUdf(path: string, jsonArgs: unknown, type: UdfType, auth?: AuthToken,
             componentPath?: string, requestId?: string, snapshotTimestamp?: LogicalTimestamp): Promise<RuntimeUdfResult>;
}
export interface UdfExecutionAdapterDeps {
  executor: UdfExec;
  authResolver: AuthResolver;       // platform-services (07)
  defaultCallType: CallType;        // "client" (external) | "server" (internal)
  logSink: LogSink;
}
export function createUdfExecutionAdapter(deps: UdfExecutionAdapterDeps): UdfExecutionAdapter;
```

`executeUdf` (1) resolves `auth` → `Principal` via the resolver (never throws on bad token —
anonymous on failure), (2) JSON-decodes args to engine values with validation, (3) installs ambient
auth + call context (ALS, or the serialized fallback), (4) delegates to `executor.execute`, (5) maps
`UdfResult` → `RuntimeUdfResult`. `RuntimeHost.executeUdf` is a thin wrapper over the **client**
adapter; the **server** adapter is injected into `RuntimeServices.udfExecutor` for nested calls.

### 7.5 `EmbeddedSyncUdfExecutor` — the sync→exec bridge

The sync handler depends only on a tiny `SyncUdfExecutor` (reactive-sync-tier). The runtime supplies
an adapter from that interface onto the execution adapter, returning **reactivity metadata**:

```ts
// packages/runtime-embedded/src/execution/sync-udf-executor.ts
export interface SyncUdfExecutor {  // reactive-sync-tier (03) — restated
  executeQuery(path: string, args: unknown, auth?: ResolvedAuth, componentPath?: string,
               snapshotTimestamp?: LogicalTimestamp): Promise<QueryExecResult>;     // { result, readRanges, snapshotTimestamp, logLines, authAccessed }
  executeMutation(path: string, args: unknown, auth?: ResolvedAuth, componentPath?: string,
                  requestId?: string): Promise<MutationExecResult>;                 // { result, writtenRanges, writtenTables, commitTimestamp, logLines }
  executeAction(path: string, args: unknown, auth?: ResolvedAuth, componentPath?: string,
                requestId?: string): Promise<ActionExecResult>;
}
export function createEmbeddedSyncUdfExecutor(adapter: UdfExecutionAdapter): SyncUdfExecutor;
```

After `executeMutation`, the handler invokes its injected `notifyWrites` callback = the runtime's
`notifyWrites` (with `excludeSessionId` set to the originating session). That closes the loop:
**mutation → commit → publish boundary → local re-run + cross-process publish.**

---

## 8. HTTP handler (host wiring)

`HttpHandler` is the concrete object that serves HTTP. At Tier 0 it backs the loopback `fetch`; at
Tier 2 the same object is mounted behind a real server. It owns the per-process **query cache** and
delegates to a core router; it never re-implements execution glue.

```ts
// packages/runtime-embedded/src/http/http-handler.ts
export interface HttpHandlerOptions {
  adapter: UdfExecutionAdapter;
  notifyWrites: (inv: WriteInvalidation, opts?: NotifyWritesOptions) => void;  // = runtime.notifyWrites
  authResolver: AuthResolver;
  services: Pick<RuntimeServices, "docstore" | "blobstore">;   // narrowest slice it needs
  queryCache?: QueryCache;       // reactive-sync-tier; shared with the sync tier
  isDev: boolean;
  corsHeaders?: Record<string, string>;
}
export class HttpHandler {
  constructor(options: HttpHandlerOptions);
  handleRequest(request: Request): Promise<Response>;
}
```

**Route table (Foundation minimal core surface; extends as later slices land):**

| Method · path | Purpose | Delegates to |
|---|---|---|
| `POST /api/query` | one-shot query (HTTP path) | `adapter.executeUdf(..., "query")`, query cache |
| `POST /api/mutation` | one-shot mutation | `adapter.executeUdf(..., "mutation")` → `notifyWrites` |
| `POST /api/action` | action call | `adapter.executeUdf(..., "action")` |
| `GET /api/version` · `GET /api/ping` | client handshake / probes | static |
| `* /<userHttpPath>` | user `httpAction` | `runtime.executeHttp(request)` (analysis-routed) |
| else | not found | `404` (structured error) |

Every thrown value is normalized through the **error hierarchy** ([07](../internals/07-platform-services.md)):
each error owns its `httpStatus`/`retryable`/`code`, so the handler serializes any failure via
`toJSON()` without a switch. `OccConflictError` → `409` (retryable); `ForbiddenOperationError`
(e.g. `fetch` in a query) → `400`; auth → `401`/`403`.

---

## 9. Bootstrap & `start()` sequence

`start()` is idempotent and memoized (`#startPromise`). On first call:

```
1. await docstore.setupSchema({})                       // physical tables (idempotent)
2. observe the highest committed ts → TimestampOracle.observeTimestamp(maxTs)   // never reuse logical time
3. if schemaBootstrap === "auto":
     a. ensureSystemTablesBootstrapped(docstore)         // CAS via writeGlobalIfAbsent; returns reused?
     b. modules = await moduleRegistry.load()            // discover convex/-equivalent modules
     c. meta = computeRuntimeMetadataVersion(modules)    // content hash
     d. if meta != storedMeta:
          syncRuntimeMetadata(docstore, tableRegistry, loadedMeta)   // schema docs + index metadata
     e. primeTableRegistry()                             // warm the registry cache
4. construct/attach subsystems if not already (executor, adapter, syncHandler, httpHandler)
5. unsub = writeFanoutAdapter.subscribe(fanout.onPayload)   // begin consuming cross-process writes
6. (later slice) attach TaskExecutor for scheduler/crons; wire setSyncProtocolHandler(syncHandler)
7. mark started; resolve #startPromise
```

- **Concurrency-safe:** `ensureSystemTablesBootstrapped` is CAS-guarded (`writeGlobalIfAbsent`), so two
  racing `start()`s (or two processes on one DB) cannot double-bootstrap. Reported timing
  (`EnsureSystemTablesStats`, `SyncRuntimeMetadataStats`) feeds dev-loop observability.
- **`:memory:` dev** uses `MemoryTableRegistry`; durable deployments use `DocStoreTableRegistry`.
- The scheduler/cron `TaskExecutor` hook (step 6) is **declared but out of scope** for Foundation
  (slice 5); the seam (`notifyWrites` already wired) means scheduled writes will fan out for free
  when that slice lands.

---

## 10. `refreshSchema()` — hot reload without dropping sockets

The dev loop and the single-binary editor need to reapply a changed `schema.ts`/index set
**without** tearing down live transports or sessions. Algorithm:

```
refreshSchema():
  await this.#schemaLock.acquire()                       // serialize against concurrent refreshes
  try:
    t0; moduleRegistry.clearCache(); modules = await moduleRegistry.load()
    newHash = computeRuntimeMetadataVersion(modules)
    if newHash === this.#schemaVersion: return { changed:false, schemaVersion:newHash, … }
    t1; await syncRuntimeMetadata(docstore, tableRegistry, modules)   // reapply index metadata
    schemaService.invalidate(); executor.clearModuleCache(); queryCache.clear()
    this.#schemaVersion = newHash; this.#schemaEpoch++
    t2; // coarse invalidation: a schema/index change can change ANY query's result/plan
    this.applyWritesLocally({ writtenTables: tableRegistry.listTableNames(), shardId })
    return { changed:true, schemaVersion:newHash, reusedBootstrap:true, durationsMs:{…} }
  catch (e):
    return { changed:false, schemaVersion:this.#schemaVersion, error: toStackbaseError(e) }  // KEEP old schema
  finally: this.#schemaLock.release()
```

Key guarantees:
- **Sessions and sockets stay open.** No `createSyncSession`/`destroySyncSession` is called; clients
  keep their WS. They simply receive `Transition`s re-running their queries under the new schema.
- **Coarse but correct.** A schema change invalidates **all tables** (every live query re-runs). This is
  the safe v1; range-precise schema-diff invalidation is a later optimization (consistent with
  "table-level first").
- **Atomic-ish swap.** New executions wait on `#schemaLock`; in-flight executions finish under the old
  schema, then their reactive re-runs pick up the new one. With `SerializedUdfExecutor` this is
  naturally serialized; in parallel mode the lock gates the metadata swap only.
- **Failure-safe.** A broken `schema.ts` (load/analysis error) leaves the **old** schema live and
  returns `{ changed:false, error }` — the dev server reports the error; the app keeps running.

---

## 11. How it works at Tier 0 **now** (end-to-end)

A single process, one SQLite file (or `:memory:`), one `EmbeddedRuntime`. The app does:

```ts
const runtime = createEmbeddedRuntime({ docstore: sqlite("./data.db"), modules: convexModules });
await runtime.start();
const client = new ConvexReactClient(runtime.createTransport());   // unmodified client, in-process
```

**Subscribe + mutate + push, with zero network:**

1. `useQuery("messages:list", {channel})` → client opens `new LoopbackWebSocket(url)` →
   `bridge.connect()` → `createSyncSession(serverSocket)`. Client sends `ModifyQuerySet{Add}`.
2. `handleSyncMessage` → handler runs the query via `EmbeddedSyncUdfExecutor` → `UdfExec` (isolate)
   → `Transactor` snapshot read → `DocStore.index_scan`. The query records its `readRanges`; the
   subscription stores them. Handler pushes `Transition{QueryUpdated}` → `serverSocket.send` →
   `ws.messageFromBridge` → client renders.
3. Another `useMutation("messages:send", …)` → client sends `Mutation` over its loopback WS →
   `handleSyncMessage` → handler `executeMutation` → isolate → `Transactor.commit` (3-phase OCC) →
   `CommitResult{commit_ts, written_ranges, shardId:"default"}`. Handler returns `MutationResponse`
   to the originator, then calls injected `notifyWrites(inv, {excludeSessionId})`.
4. `runtime.notifyWrites` → **(local)** `syncHandler.applyWrites(inv)` intersects `written_ranges`
   against every subscription's `readRanges` (table-level first), re-runs overlapping queries, pushes
   `Transition`s to affected sessions; **(publish)** `writeFanout.publish(inv)` — a self-ignored no-op
   in one process.
5. The first client's `messages:list` overlapped the write → it receives a fresh `Transition`. The
   "network" round trip was a handful of microtasks.

The DB round-trip is an in-process memory access; the realtime push is a function call. That is the
SpacetimeDB speed win, for free, with the Convex DX intact.

---

## 12. The scaleSeam — reserved so WhatsApp-scale attaches with NO rewrite

This component carries **two** of the spectrum's seams. Both are *present but trivial* at Tier 0.

### 12.1 Row 4 — `EmbeddedWriteFanout`/`EmbeddedWriteFanoutAdapter` IS the transactor→sync pub/sub

The transactor never calls the sync tier directly; it goes through `notifyWrites` → **publish**. The
payload is serializable (`SerializedKeyRange`, string timestamps, `originId`, `messageId`, `shardId`).
To span processes you change **only the adapter**:

| Tier | `EmbeddedWriteFanoutAdapter` impl | Reach |
|---|---|---|
| 0 (now) | `InMemoryWriteFanoutAdapter` | one process |
| 1 | `BroadcastChannelAdapter` / Redis pub/sub | a few embedded processes on one DB |
| 2 | adapter over the committer's `OplogDelta` change stream | the whole sync fleet |

Each subscriber **ignores its own `originId`** and **dedups by `messageId`**; the runtime's
`notifyWrites`/`applyWritesLocally`/`onRemoteWrite` logic, the sync handler, and **every app function**
are **unchanged**. `ChangeStreamConsumer` is the reserved Tier 2 consumer face of the identical
publish/subscribe contract.

### 12.2 Row 3 — `RuntimeHost` + `createTransport()` IS the client-fabrication seam

The identical, unmodified client moves across tiers by being handed a **different `ClientTransport`**
— nothing else changes:

| Tier | `ClientTransport.webSocketConstructor` / `fetch` | Server ingress |
|---|---|---|
| 0 (now) | `LoopbackWebSocket` + loopback `fetch` (this slice) | same-process `RuntimeHost` |
| 1 | worker/`MessagePort` RPC transport (reserved §12.3) | `RuntimeHost` behind a `MessagePort`, supervised |
| 2 | real WS constructor + network `fetch` | networked `RuntimeHost` fleet node |

Because **all** transports funnel through the same four `RuntimeHost` sync-session methods +
`handleRequest`, swapping the transport is swapping a constructor, not rewriting the protocol. The
client's `useQuery`/`useMutation` call sites and the typed `api` are byte-for-byte identical at every
tier — *that invariant is the product.*

### 12.3 Reserved (declared, not built) — the Tier 1 bridge

```ts
// packages/runtime-embedded/src/transport/worker-bridge.ts  (RESERVED — Tier 1)
export interface EmbeddedRpcEndpoint {
  postMessage(data: unknown): void;
  addMessageListener(listener: (data: unknown) => void): () => void;
  addCloseListener?(listener: () => void): () => void;
}
export interface WorkerEmbeddedTransport extends ClientTransport { close(): void; }
export function createWorkerTransport(endpoint: EmbeddedRpcEndpoint, options?: WorkerTransportOptions): WorkerEmbeddedTransport;
export function attachEmbeddedRuntimeWorkerServer(runtime: RuntimeHost, endpoint: EmbeddedRpcEndpoint, options?: WorkerServerOptions): { close(): void };
// + supervised variant (health-check + restart/backoff) and SharedWorker (many tabs, one runtime).
```

Foundation does **not** build these; it only proves the seam by making `RuntimeHost` the sole ingress
and `ClientTransport` the sole client-facing shape. The worker/capnweb transport is a later slice that
forwards the *same* WS+fetch traffic across a `MessagePort` to the *same* `RuntimeHost` methods.

### 12.4 The shard seam threaded now (rows 1/2)

`shardId` (default `"default"`) is constructed into the runtime and stamped onto every
`WriteInvalidation` and `EmbeddedWriteFanoutPayload`. Tier 2's `ShardRouter.getShardForDocument`
replaces the constant with a per-conversation hash; the runtime's plumbing is unchanged.

---

## 13. Failure & edge handling

| Area | Case | Behavior |
|---|---|---|
| Loopback WS | `send()` before `OPEN` / after `CLOSED` | Throw `InvalidStateError` (mirror real `WebSocket`). |
| Loopback WS | server frame to an already-closed client | Drop silently (socket gone); count in diagnostics. |
| Loopback WS | reentrancy / ordering | All delivery via `queueMicrotask`, strict per-direction FIFO; `handleSyncMessage` awaited before next inbound. |
| Loopback WS | `createSyncSession` throws | `ws.errorFromBridge(msg)` then `ws.closeFromBridge(1011, …, wasClean=false)`. |
| Loopback WS | `bufferedAmount` fidelity | Tracked honestly (queued bytes); backpressure controllers run the same code path (no-op in practice). |
| Write-fanout | `adapter.publish` rejects (Redis down) | Best-effort: **never** fails the (already-committed) mutation; `onError("publish")`, counted. Local subscribers already notified. Missed remote delivery → subscriber stale until next overlapping write or heartbeat resync (Tier 2 only; impossible single-process). |
| Write-fanout | duplicate redelivery | `messageId` LRU dedup → applied once. |
| Write-fanout | self-echo | `originId === self` → dropped (already applied locally). |
| Write-fanout | malformed payload | `onError("deserialize")`, dropped; does not crash the consumer. |
| Serialized executor | hung UDF blocks the lane | `withOperationTimeout` bounds *client-visible* wait (does not cancel inner work); queue over `maxQueueDepth` → `ServiceUnavailableError` (503, `retryAfterMs`). |
| Serialized executor | task rejects | Chain advances (no poison); error propagates only to that caller. |
| OCC | mutation conflict | Executor replays the deterministic UDF up to `maxRetries`; exhausted → `OccConflictError` (409, retryable) surfaced in `MutationResponse.error`. The runtime maps the error; it does not itself retry. |
| Bootstrap | concurrent `start()` / two processes | CAS (`writeGlobalIfAbsent`) makes bootstrap once-only; `start()` memoized. |
| Bootstrap | oracle restart | `observeTimestamp(maxCommittedTs)` before first allocation ⇒ logical time never goes backward/reused. |
| `refreshSchema` | broken `schema.ts` | Old schema retained; `{ changed:false, error }`; sessions/sockets untouched. |
| `refreshSchema` | concurrent refresh | `#schemaLock` serializes; second caller observes the post-swap hash. |
| Auth | bad/expired token | Resolver returns anonymous `Principal` (never throws); authorization policy decides 401/403 at enforcement. |
| `close()` | double close / mid-flight | Idempotent; sends `FatalError`+close to sessions, unsubscribes fanout, awaits in-flight, closes docstore. |

---

## 14. Test strategy

### 14.1 Unit

- **Loopback WS state machine.** Constants (static + instance), `CONNECTING→OPEN→CLOSING→CLOSED`
  transitions, event firing for both `onX` and `addEventListener`, `send` throws when not `OPEN`,
  `close(code, reason)` produces a clean `CloseEvent`, `binaryType` handling, `bufferedAmount` rises
  then drains.
- **Bridge lifecycle.** `connect` registers exactly one session and fires `open` once; `disconnect`
  destroys the session and fires `close` once; `createSyncSession` throwing → `error` then unclean
  `close`.
- **`notifyWrites` routing.** Local apply called once; `excludeSessionId` honored; `localOnly` skips
  publish; `shardId` defaulted to `"default"`.
- **Mode resolution.** `detectAsyncLocalStorageAvailability` true on Node, false when `async_hooks`
  absent; `"auto"` maps correctly; `"parallel"` warns when detection says unsafe.
- **HTTP route table.** Each core route dispatches to the right adapter call; unknown path → 404;
  thrown `StackbaseError` serialized with correct status via `toJSON()`.

### 14.2 Property tests (the load-bearing ones)

- **Loopback ordered delivery (model-based).** For any random interleaving of `ws.send` (client→server)
  and `serverSocket.send` (server→client), assert: (a) each direction is delivered **FIFO**, (b)
  **exactly once**, (c) **never synchronously** inside `send` (a flag set before `send` returns is
  observed false inside the peer handler), (d) the sequence equals a reference in-order queue model.
- **Write-fanout codec round-trip.** `∀ inv: deserialize(serialize(toPayload(inv))) ≡ inv` over
  generated `WriteInvalidation`s (varied `SerializedKeyRange`s incl. `endKey:null`/point, big u64
  timestamps near 2⁶³, empty/large `writtenTables`). Assert hex keys and string timestamps survive
  `JSON.parse(JSON.stringify(...))` — proves no `ArrayBuffer`/`bigint` leaks into the wire.
- **Fanout fan-in semantics.** With N publishers and M subscribers over one shared adapter: every
  foreign payload is applied **exactly once** per subscriber; self-origin payloads **zero** times;
  duplicated `messageId` **once**; out-of-`emittedAtMs`-order delivery still applies each once
  (ordering is the sync handler's version-bracket job, not the fanout's).
- **Serialized executor concurrency.** Instrument the inner executor with an in-flight counter;
  across random concurrent `execute` calls assert the counter **never exceeds 1**, completion order
  equals submission order, and injected rejections never stall/reorder the lane.

### 14.3 Integration (Tier 0, in-process)

- **Full reactive loop.** Two clients over `createTransport()`; client A `useQuery`, client B
  mutates; assert A receives a `Transition` with the new result and B is excluded from the broadcast
  (gets only its `MutationResponse`). No flicker / no double update.
- **OCC conflict.** Two mutations race on the same document; assert one commits, the other replays and
  resolves, final state is serializable, and subscribers converge to one consistent result; force
  retry-exhaustion to assert a clean `OccConflictError` (409) reaches the client.
- **Bootstrap idempotency.** Fresh docstore → `start()` creates system tables (`reused:false`); second
  `start()` is a no-op (`reused:true`); two runtimes racing `start()` on one DB file bootstrap once.
- **`refreshSchema` hot-reload.** Add an index to the schema module → `refreshSchema()`; assert
  (a) the WS stays open (same session id), (b) the new index is usable by a query, (c) a live
  subscription re-runs, (d) a deliberately broken schema returns `{changed:false,error}` and leaves the
  app live.
- **Multi-process fanout (Tier 1 preview).** Two `EmbeddedRuntime`s sharing one
  `createSharedInMemoryWriteFanoutAdapter()` and one DB: a mutation in A invalidates a subscription in
  B exactly once; kill A's adapter mid-flight → B's subscription is unaffected by A's failure.

### 14.4 Differential fidelity (closes the [06](../internals/06-runtimes-topology.md) risk)

Run the **same** client-protocol script (connect, subscribe, mutate, paginate, reconnect, version-gap
resync) over **(a)** the loopback transport and **(b)** an in-process real-`WebSocketPair`/`MessagePort`
transport pointed at the same `RuntimeHost`. Assert **identical observable client state** at each step
— the proof that `createTransport`'s loopback is behavior-preserving and Tier 0 will not diverge from
networked tiers. (This same harness is reused to validate the Tier 1 worker transport when built.)

---

## 15. Package / module / file layout

```
packages/runtime-embedded/
  package.json                       # @stackbase/runtime-embedded
  src/
    index.ts                         # public: createEmbeddedRuntime, RuntimeHost, ClientTransport, types
    runtime-host.ts                  # RuntimeHost + RuntimeUdfRequest/Result, RefreshSchemaResult, SyncSessionHandle
    embedded-runtime.ts              # EmbeddedRuntime, EmbeddedRuntimeOptions, createEmbeddedRuntime
    options.ts                       # option normalization, EmbeddedModuleSources, defaults
    bootstrap.ts                     # start() sequence: setupSchema, ensureSystemTables, syncRuntimeMetadata
    loopback/
      loopback-websocket.ts          # LoopbackWebSocket (client-facing)
      loopback-bridge.ts             # LoopbackBridge + LoopbackServerSocket + delivery queues
      loopback-fetch.ts              # createLoopbackFetch
      client-transport.ts           # ClientTransport, createLoopbackWebSocketConstructor, fabrication glue
    write-fanout/
      types.ts                       # EmbeddedWriteFanoutPayload/Adapter, WriteFanoutConfig, EmbeddedWriteFanout
      write-fanout.ts                # createEmbeddedWriteFanout (originId filter + messageId dedup)
      in-memory-adapter.ts           # InMemoryWriteFanoutAdapter + createSharedInMemoryWriteFanoutAdapter
      change-stream-consumer.ts      # ChangeStreamConsumer (reserved Tier 2 shape)
    execution/
      serialized-executor.ts         # SerializedUdfExecutor, EmbeddedExecutionMode, ALS detection
      execution-adapter.ts           # UdfExecutionAdapter (client/server factories)
      sync-udf-executor.ts           # EmbeddedSyncUdfExecutor (SyncUdfExecutor bridge)
    http/
      http-handler.ts                # HttpHandler + route table
    transport/
      worker-bridge.ts               # RESERVED: EmbeddedRpcEndpoint, createWorkerTransport, attach… (Tier 1)
    __tests__/
      loopback.prop.test.ts          # ordered-delivery property test
      write-fanout.prop.test.ts      # codec round-trip + fan-in dedup
      serialized-executor.prop.test.ts
      reactive-loop.int.test.ts
      occ-conflict.int.test.ts
      bootstrap.int.test.ts
      refresh-schema.int.test.ts
      transport-fidelity.diff.test.ts
```

Depends (workspace) on `@stackbase/docstore-sqlite`, `@stackbase/transactor`, `@stackbase/query-engine`,
`@stackbase/executor-isolate`, `@stackbase/sync`, and a small `@stackbase/runtime-core` for the shared
contracts (`RuntimeServices`, `AuthResolver`, error types) it consumes. It imports **interfaces**, never
a database driver or a concrete socket type — the runtime-base discipline.

---

## 16. Open issues

1. **Serial vs parallel default (perf).** `"auto"` picks parallel on Node (ALS present) but serializes
   on ALS-less hosts, capping throughput there. Need a confident detector + docs on when a host may
   force `"parallel"`, or Tier 0-in-browser looks slow under concurrency. ([06](../internals/06-runtimes-topology.md))
2. **Cross-process fanout delivery guarantees.** The in-memory default is fire-and-forget. For Tier 1
   (BroadcastChannel/Redis) we must pin at-least-once vs best-effort, the `messageId` dedup window
   size, and behavior while an adapter is briefly down (subscriptions silently stale until a resync).
   Define a heartbeat-driven "resync on suspected gap" so a dropped invalidation degrades to a resync.
3. **Loopback `bufferedAmount` realism.** It drains every microtask, so backpressure never actually
   engages at Tier 0. The differential-fidelity harness must confirm clients that *read* `bufferedAmount`
   behave identically on loopback and a real socket — and that a Tier 2 drop-and-resync path is exercised
   somewhere other than loopback.
4. **`refreshSchema` invalidation breadth.** Coarse "invalidate all tables" is correct but re-runs every
   live query on each dev save. For large dev datasets we may want a schema-diff that only invalidates
   touched tables/indexes — a later optimization, but the epoch hook is reserved.
5. **HTTP surface scope at Foundation.** The minimal `/api/*` set here must stay in lockstep with what
   the Convex client actually calls over HTTP (vs WS). Need to enumerate the exact client HTTP endpoints
   (action calls, one-shot query, `/api/version` handshake) and version-negotiate, so we neither
   under-serve nor over-build before the client slice lands.
6. **Server adapter / nested-call wiring ownership.** The `server`-flavored `UdfExecutionAdapter` is
   injected into `RuntimeServices.udfExecutor` for function-to-function calls — a boundary shared with
   isolate-executor. We must agree which slice constructs it to avoid a circular-init footgun (proposal:
   runtime constructs both adapters; executor receives the server adapter via a late-bound setter).
7. **Multi-runtime-one-DB at Tier 1.** Two embedded processes sharing a SQLite file need the durable
   `DocStoreTableRegistry` and a shared fanout bus; we should validate WAL concurrency + registry cache
   coherence (TTL staleness) before blessing that topology, even though the seam is proven at Tier 0.
8. **`close()` / drain semantics.** Graceful shutdown should drain in-flight executions and flush pending
   `Transition`s before closing sockets; we need a bounded drain timeout and a forced-close fallback so a
   wedged UDF cannot block process exit.
