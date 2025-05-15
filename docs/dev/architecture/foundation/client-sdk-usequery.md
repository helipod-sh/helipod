---
title: Foundation — Client SDK & Reactive useQuery
slug: client-sdk-usequery
status: design (implementation-ready)
audience: engineering (internal)
slice: Foundation
depends_on: [reactive-sync-tier, schema-codegen]
seam_table_rows: [3, 6, 10]
---

# Client SDK & Reactive `useQuery`

> The framework-agnostic **sync-protocol client** and its **reactive React bindings**. It is the
> browser/Node/RN half of the reactive core: it speaks the sync protocol defined by the
> [reactive sync tier](../internals/03-reactivity-sync.md), turns a query into a live subscription,
> applies optimistic mutations, and keeps every subscription on **one consistent logical timestamp**.
> It is **transport-agnostic**: the same client code talks to a Tier 0 in-process loopback engine or
> a Tier 2 networked sync fleet — *only the injected `ClientTransport` changes.*
>
> Clean-room: we studied the shape of the Convex browser/React client and concave's loopback
> transport for **contract shape only**. Everything here is our own implementation. No FSL code is
> reproduced.

---

## 1. Purpose & boundaries

### What it owns

- **The wire client.** Encode `ClientMessage`s, decode `ServerMessage`s, manage the WebSocket
  lifecycle (`Connect`/resume, backoff reconnect), and detect protocol version gaps.
- **The query set.** Content-address `(udfPath, args, componentPath)` into one logical subscription,
  refcount duplicates, assign client-local `QueryId`s, and emit **`ModifyQuerySet` diffs** (never the
  whole set) bracketed by `baseVersion → newVersion`.
- **Reactive reconciliation.** Apply version-bracketed `Transition`s atomically, hold all of a
  client's subscriptions at a single logical `ts` (the "consistent transactional window" → one React
  render pass), and **resync from scratch on any version gap**.
- **The optimistic mutation layer.** Allocate `requestId`s, apply `OptimisticUpdate`s to a local
  overlay immediately, and retire each overlay **exactly when** the authoritative result that
  supersedes it is applied (no flicker, no stuck overlay).
- **Gapless journal pagination.** Store each query's `QueryJournal` and replay it on every
  resubscribe/resync so a reactive paginated list never skips or duplicates rows.
- **The React bindings.** `useQuery`, `useMutation` (+ `withOptimisticUpdate`), `useAction`,
  `usePaginatedQuery`, `StackbaseProvider`, `useStackbaseClient`, built on `useSyncExternalStore`.
- **Auth token plumbing on the client side.** `setAuth(fetchToken)` → `Authenticate` frames and
  re-auth on `AuthError`.

### What it does NOT own

- **No server logic.** It never runs a query, validates OCC, computes read/write sets, or holds
  authoritative results. It is a *cache + reconciler* of what the sync tier sends.
- **No transport implementation.** It consumes an injected `ClientTransport`; it does not open TCP
  sockets, create loopback bridges, or know about Durable Objects. (The loopback bridge is built by
  the embedded runtime; the real WS constructor is built by the networked transport package.)
- **No codegen.** `FunctionReference`, `FunctionArgs`, `FunctionReturnType`, `getFunctionName`, the
  `Value` type and its order-preserving value codec come from **schema-codegen** (`@stackbase/values`).
- **No auth provider integration.** Clerk/Auth0/OIDC wiring is the **Auth slice**; here we only take a
  `(forceRefreshToken) => Promise<string|null>` token fetcher.
- **No binary delta encoder (yet).** Foundation ships the JSON codec; it only *reserves the seam*
  (§10, seam row 10).

---

## 2. Position in the system

```
   React component
   const msgs = useQuery(api.messages.list, { channel })   ← typed via schema-codegen
        │  (useSyncExternalStore)
        ▼
   StackbaseClient ───────────────────────────────────────────────┐
     • LocalSyncState   (query set, versions, journals, diffs)     │
     • OptimisticResults(requestId-keyed overlay)                  │  ClientMessage  ┌──────────────┐
     • ConsistencyMgr   (one ts → one render pass)                 ├────────────────▶│  Sync Tier   │
     • WebSocketManager (connect/resume/backoff/gap→resync)        │◀────────────────┤ (server)     │
                                                                   │  ServerMessage  └──────────────┘
        │ uses                                                     │
        ▼                                                          │
   ClientTransport  = { clientUrl, webSocketConstructor, fetch }   │  ← THE SEAM (row 3)
        │                                                          │
        ├── Tier 0: loopback constructor → in-process engine ──────┘  (no network)
        └── Tier 2: real WS constructor  → wss://router/sync          (connection-sharded fleet)
```

**Upstream contracts we depend on** (must hold for us to be correct):

- **reactive-sync-tier** — the `ClientMessage`/`ServerMessage` wire union (§4), monotonic
  `StateVersion` brackets on every `Transition`, a **per-session `requestId → MutationResponse`
  dedup cache** (so reconnect re-sends are idempotent), and **journal replay** (an `Add` carrying a
  journal resumes the same pagination).
- **schema-codegen** — the typed `api` object (`FunctionReference<"query"|"mutation"|"action">`),
  `FunctionArgs<F>`, `FunctionReturnType<F>`, `getFunctionName(ref) → udfPath`, and the `Value`
  codec (`valueToJson`/`jsonToValue`, `compareValues`) used to canonicalize args.

---

## 3. The transport seam — `ClientTransport` (seam-table row 3)

This is the single point of swap that lets the **same client and the same app/UI code** run at Tier 0
or Tier 2. The client receives a `ClientTransport` and **never** constructs a socket itself.

```ts
/** The seam. Build one of these per deployment topology; the client is identical across all. */
export interface ClientTransport {
  /** Deployment base URL. Real for networked ("https://acme.stackbase.dev"),
   *  synthetic for loopback ("loopback://local"). Used for HTTP (actions/upload) + diagnostics. */
  readonly clientUrl: string;

  /** A `WebSocket`-compatible constructor already pointed at the sync endpoint.
   *  - Tier 0 loopback: ignores the URL, wires send/recv straight into the in-process engine.
   *  - Tier 2 networked: opens a real socket to wss://<router>/sync. */
  readonly webSocketConstructor: WebSocketConstructor;

  /** fetch impl for non-WS calls (HTTP actions, file upload, SSR one-shot query). */
  readonly fetch: typeof fetch;
}

export type WebSocketConstructor =
  new (url: string, protocols?: string | string[]) => ClientWebSocket;

/** The minimal socket surface the client uses. `bufferedAmount` is REQUIRED (seam row 6):
 *  it is how the client/host reason about backpressure even though Tier 0 never blocks. */
export interface ClientWebSocket {
  readonly readyState: number;          // 0 CONNECTING, 1 OPEN, 2 CLOSING, 3 CLOSED
  readonly bufferedAmount: number;      // bytes queued but not yet sent
  send(data: string | ArrayBufferLike): void;
  close(code?: number, reason?: string): void;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: string | ArrayBufferLike }) => void) | null;
  onclose: ((ev: { code: number; reason: string }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
}
```

> **Why this is sufficient.** Every byte the client sends/receives flows through
> `webSocketConstructor` + `fetch`. A loopback transport satisfies the same interface with in-memory
> delivery; a networked transport satisfies it with a real socket behind a router. Because the client
> only ever sees this interface, *nothing in the client or the app changes between tiers* — the whole
> WhatsApp-scale path attaches by handing the client a different `ClientTransport` constructor. The
> embedded runtime's `createTransport()` returns the loopback one; a `@stackbase/transport-ws` package
> returns the networked one.

---

## 4. The wire protocol contract (the codec seam — row 10)

The protocol is **versioned by monotonic counters**, not message order. Today it is JSON; `u64`
timestamps travel as decimal **strings** and parse to `bigint` internally. The encoding is isolated
behind `MessageCodec` so a binary-delta codec drops in later (§10) with no state-model change.

```ts
/** Monotonic version triple. Every Transition is bracketed by two of these. */
export interface StateVersion {
  querySet: number;   // bumps when the server applies a ModifyQuerySet
  ts: string;         // engine commit timestamp (u64 as decimal string on the wire)
  identity: number;   // bumps when the server applies an Authenticate
}

// ---------- client → server ----------
export type ClientMessage =
  | { type: "Connect"; sessionId: string; connectionCount: number;
      lastCloseReason: string | null; maxObservedTimestamp?: string }
  | { type: "ModifyQuerySet"; baseVersion: number; newVersion: number;
      modifications: QuerySetModification[] }
  | { type: "Mutation"; requestId: number; udfPath: string; args: Value; componentPath?: string }
  | { type: "Action";   requestId: number; udfPath: string; args: Value; componentPath?: string }
  | { type: "Authenticate"; baseVersion: number; tokenType: TokenType; value?: string;
      impersonating?: Value }
  | { type: "Event"; eventType: string; event: Value };

export type QuerySetModification =
  | { type: "Add"; queryId: number; udfPath: string; args: Value;
      journal?: QueryJournal; componentPath?: string }
  | { type: "Remove"; queryId: number };

export type TokenType = "User" | "Admin" | "System" | "None";

// ---------- server → client ----------
export type ServerMessage =
  | { type: "Transition"; startVersion: StateVersion; endVersion: StateVersion;
      modifications: StateModification[] }
  | { type: "MutationResponse"; requestId: number; success: boolean;
      result?: Value; errorMessage?: string; errorData?: Value; ts?: string; logLines: string[] }
  | { type: "ActionResponse"; requestId: number; success: boolean;
      result?: Value; errorMessage?: string; errorData?: Value; logLines: string[] }
  | { type: "AuthError"; error: string; baseVersion?: number; authUpdateAttempted: boolean }
  | { type: "FatalError"; error: string }
  | { type: "Ping" }
  /** Reserved, non-commit kind (scalability-spectrum §2.3, seam row 5). Foundation parses &
   *  ignores it; presence/typing attach here later without a wire break. */
  | { type: "Broadcast"; topic: string; event: Value };

export type StateModification =
  | { type: "QueryUpdated"; queryId: number; value: Value; logLines: string[]; journal: QueryJournal }
  | { type: "QueryFailed"; queryId: number; errorMessage: string; errorData?: Value;
      logLines: string[]; journal: QueryJournal }
  | { type: "QueryRemoved"; queryId: number };

export type QueryJournal = string | null;

/** The encode/decode seam. Tier 0 = JSON. Binary-delta codec swaps in later; it diffs each
 *  QueryUpdated against the value the client last applied at `startVersion` (§10). */
export interface MessageCodec {
  encodeClientMessage(msg: ClientMessage): string | ArrayBufferLike;
  decodeServerMessage(data: string | ArrayBufferLike): ServerMessage;
}
export const jsonCodec: MessageCodec; // the Foundation default
```

`Value` and its canonical JSON form come from `@stackbase/values`. The `ServerMessage` union is
**versioned and extensible** (note the reserved `Broadcast` kind) per Foundation obligation #5 — the
client must `switch` with a `default:` that ignores unknown kinds rather than throwing.

---

## 5. Public API — the contracts other components depend on

### 5.1 `StackbaseClient` (framework-agnostic core)

```ts
export interface StackbaseClientOptions {
  /** THE SEAM. Loopback (Tier 0) or networked (Tier 2). Required. */
  transport: ClientTransport;
  /** Stable across reconnects for one client instance; enables server-side requestId dedup.
   *  Default: a fresh UUID. */
  sessionId?: string;
  /** Optional auth token fetcher; equivalent to calling setAuth() after construction. */
  auth?: AuthTokenFetcher;
  /** Wire codec. Default jsonCodec. */
  codec?: MessageCodec;
  reconnect?: Partial<ReconnectOptions>;
  /** Warn before tab unload while mutations are in flight (default true in browsers). */
  unsavedChangesWarning?: boolean;
  onServerDisconnect?: (info: { reason: string; willReconnect: boolean }) => void;
  verbose?: boolean;
}

export declare class StackbaseClient {
  constructor(options: StackbaseClientOptions);

  /** Subscribe. Returns a live handle; refcounted by (udfPath,args,componentPath). */
  watchQuery<Q extends FunctionReference<"query">>(
    query: Q, args: FunctionArgs<Q>,
    options?: { journal?: QueryJournal; componentPath?: string },
  ): QuerySubscription<FunctionReturnType<Q>>;

  /** One-shot read: subscribe, await first authoritative value, unsubscribe. */
  query<Q extends FunctionReference<"query">>(
    query: Q, args: FunctionArgs<Q>,
  ): Promise<FunctionReturnType<Q>>;

  /** Optimistic write. Resolves with the authoritative server result (or rejects on app error). */
  mutation<M extends FunctionReference<"mutation">>(
    mutation: M, args: FunctionArgs<M>,
    options?: { optimisticUpdate?: OptimisticUpdate<FunctionArgs<M>> },
  ): Promise<FunctionReturnType<M>>;

  /** Non-transactional, side-effecting call. Never optimistic, never retried on reconnect. */
  action<A extends FunctionReference<"action">>(
    action: A, args: FunctionArgs<A>,
  ): Promise<FunctionReturnType<A>>;

  setAuth(fetchToken: AuthTokenFetcher, onChange?: (isAuthenticated: boolean) => void): void;
  clearAuth(): void;

  connectionState(): ConnectionState;
  /** Flush, send Remove for all queries, close the socket. Idempotent. */
  close(): Promise<void>;
}
```

Methods accept a typed `FunctionReference` (DX parity: `client.mutation(api.messages.send, {...})`)
**or** a bare `string` udfPath; at runtime the client calls `getFunctionName(ref)` from
schema-codegen, so the core carries no React/codegen dependency, only types.

### 5.2 `QuerySubscription`

```ts
export interface QuerySubscription<T = Value> {
  readonly id: number;          // client-local QueryId
  readonly token: QueryToken;   // content-addressed dedup key
  /** Current local value = server truth + optimistic overlay. `undefined` until first result.
   *  THROWS the query's error if it is in a failed state (so useQuery surfaces it in render). */
  localQueryResult(): T | undefined;
  /** Latest journal (for pagination / debugging). */
  currentJournal(): QueryJournal;
  /** Register for change notifications. The callback fires once per consistent window. */
  onUpdate(callback: () => void): Unsubscribe;
  /** Drop one refcount; the underlying subscription is removed when it hits zero. */
  unsubscribe(): void;
}
export type Unsubscribe = () => void;
export type QueryToken = string;   // `${udfPath}|${canonicalArgsJson}|${componentPath ?? ""}`
```

### 5.3 Optimistic updates

```ts
/** Pure, synchronous function. Reads/writes query results in a local overlay. May touch
 *  multiple queries; runs again on every recompute, so it must be deterministic & side-effect free. */
export type OptimisticUpdate<Args extends Record<string, Value> = Record<string, Value>> =
  (localStore: OptimisticLocalStore, args: Args) => void;

export interface OptimisticLocalStore {
  /** Current overlayed value for a subscribed query, or undefined if absent/unloaded. */
  getQuery<Q extends FunctionReference<"query">>(
    query: Q, args: FunctionArgs<Q>): FunctionReturnType<Q> | undefined;
  /** Every currently-tracked instance of `query` (all arg variants) with its current value. */
  getAllQueries<Q extends FunctionReference<"query">>(
    query: Q): Array<{ args: FunctionArgs<Q>; value: FunctionReturnType<Q> | undefined }>;
  /** Overwrite a query's overlay value. `undefined` clears the optimistic value for that query. */
  setQuery<Q extends FunctionReference<"query">>(
    query: Q, args: FunctionArgs<Q>, value: FunctionReturnType<Q> | undefined): void;
}
```

### 5.4 Auth, connection, reconnect

```ts
export type AuthTokenFetcher =
  (args: { forceRefreshToken: boolean }) => Promise<string | null | undefined>;

export interface ConnectionState {
  isWebSocketConnected: boolean;
  lastCloseReason: string | null;
  connectionCount: number;          // # of socket opens this client instance
  inflightMutations: number;
  inflightActions: number;
  timeOfOldestInflightRequest: number | null;
  querySetVersion: number;
  appliedTs: string | null;         // maxObservedTimestamp, decimal string
}

export interface ReconnectOptions {
  initialBackoffMs: number;   // default 100
  maxBackoffMs: number;       // default 16_000
  backoffMultiplier: number;  // default 2
  jitter: number;             // default 0.5  (±50%)
}
```

### 5.5 React bindings (`@stackbase/react`)

```ts
export function StackbaseProvider(
  props: { client: StackbaseClient; children: React.ReactNode }): JSX.Element;
export function useStackbaseClient(): StackbaseClient;

/** Live query. `"skip"` opts out (returns undefined, holds no subscription). Returns `undefined`
 *  while loading; the resolved value once available; re-renders on every update. Throws in render
 *  if the query failed. */
export function useQuery<Q extends FunctionReference<"query">>(
  query: Q, args: FunctionArgs<Q> | "skip",
): FunctionReturnType<Q> | undefined;

export interface ReactMutation<M extends FunctionReference<"mutation">> {
  (args: FunctionArgs<M>): Promise<FunctionReturnType<M>>;
  withOptimisticUpdate(fn: OptimisticUpdate<FunctionArgs<M>>): ReactMutation<M>;
}
export function useMutation<M extends FunctionReference<"mutation">>(mutation: M): ReactMutation<M>;

export function useAction<A extends FunctionReference<"action">>(
  action: A): (args: FunctionArgs<A>) => Promise<FunctionReturnType<A>>;

/** Gapless reactive pagination built on the per-query journal (§7.4). */
export function usePaginatedQuery<Q extends FunctionReference<"query">>(
  query: Q,
  args: FunctionArgs<Q> | "skip",
  options: { initialNumItems: number },
): {
  results: Array<PageItem<Q>>;
  status: "LoadingFirstPage" | "CanLoadMore" | "LoadingMore" | "Exhausted";
  loadMore: (numItems: number) => void;
  isLoading: boolean;
};
```

> `useQuery` is implemented with `useSyncExternalStore(sub.onUpdate, sub.localQueryResult,
> sub.localQueryResult)`. `localQueryResult()` returns a **stable reference** that only changes when
> the value changes (the client memoizes the last emitted value per token via `compareValues`), which
> is what keeps `useSyncExternalStore` from looping and gives tear-free reads.

---

## 6. Internal architecture & data structures

Four cooperating managers behind `StackbaseClient`:

### 6.1 `LocalSyncState` — the query set + diffing

```ts
interface QueryEntry {
  queryId: number;
  token: QueryToken;
  udfPath: string;
  args: Value;
  componentPath?: string;
  refCount: number;
  journal: QueryJournal;          // last journal from QueryUpdated; re-sent on Add/resync
  serverValue: Value | undefined; // authoritative (pre-overlay) result, undefined until first
  serverError: { message: string; data?: Value } | undefined;
  serverVersion: StateVersion | undefined;
}

class LocalSyncState {
  private byToken = new Map<QueryToken, QueryEntry>();
  private byQueryId = new Map<number, QueryEntry>();
  private nextQueryId = 0;
  private querySetVersion = 0;
  private pending: QuerySetModification[] = [];   // batched within a microtask
  // ...
}
```

- **Content addressing.** `QueryToken = `${udfPath}|${canonicalArgs}|${componentPath ?? ""}``, where
  `canonicalArgs = JSON.stringify(valueToJson(args))` with **sorted object keys**. Identical queries
  collapse to one entry regardless of arg key order (proven by property test, §12).
- **Diff emission.** `subscribe` / `unsubscribe` mutate `byToken` and push `Add`/`Remove` onto
  `pending`. A microtask flush coalesces a burst into **one** `ModifyQuerySet { baseVersion:
  querySetVersion, newVersion: querySetVersion+1, modifications }`, then advances `querySetVersion`.
  The client never resends the full set — only the delta (scalability: a client with 10⁴ live
  subscriptions never re-uploads them).

### 6.2 `OptimisticQueryResults` — the requestId-keyed overlay

```ts
interface OutstandingUpdate {
  requestId: number;
  serverTs: bigint | null;     // set when MutationResponse arrives; null while in flight
  apply: (store: OptimisticLocalStore) => void;
}

class OptimisticQueryResults {
  private outstanding: OutstandingUpdate[] = [];   // ordered by requestId == submission order
  private lastEmitted = new Map<QueryToken, Value | undefined>();
  // ...
}
```

The overlay is **recomputed**, never patched in place: start from `LocalSyncState` server values, then
replay every `outstanding.apply` in requestId order against a working `OptimisticLocalStore`. The final
per-token value is the overlay. A token whose value differs from `lastEmitted` is notified.

### 6.3 `ConsistencyManager` — one ts → one render pass

A `Transition` may update many queries; retiring optimistic overlays may touch more. All of it is
applied inside **one synchronous batch**, so React 18 auto-batches into a single render and the UI
never shows query A advanced past a mutation while query B lags (Convex's "consistent transactional
window"). For React ≤17 the batch is wrapped in `reactDom.unstable_batchedUpdates` via an injectable
`setBatchingImplementation(fn)`.

### 6.4 `WebSocketManager` — connect / resume / backoff / gap→resync

Owns the `ClientWebSocket` (built from `transport.webSocketConstructor`), the `Connect` handshake,
inbound dispatch, outbound ordering, the reconnect timer, and the **current applied `StateVersion`**.
It is the component that detects a version gap and triggers `restart()`.

---

## 7. Key algorithms

### 7.1 Subscribe → `ModifyQuerySet` diff

```
watchQuery(udfPath, args, {journal}):
  token = contentAddress(udfPath, args, componentPath)
  e = byToken.get(token)
  if e: e.refCount++          # dedup: share one server subscription
  else:
    e = { queryId: nextQueryId++, token, udfPath, args, componentPath,
          refCount: 1, journal: journal ?? null, serverValue: undefined, ... }
    byToken.set(token, e); byQueryId.set(e.queryId, e)
    pending.push({ type:"Add", queryId:e.queryId, udfPath, args, journal:e.journal, componentPath })
    scheduleFlush()           # microtask-coalesced
  return makeSubscriptionHandle(e)

unsubscribe(e):
  if --e.refCount == 0:
    pending.push({ type:"Remove", queryId:e.queryId })
    byToken.delete(e.token)      # local removal is immediate; server confirms via QueryRemoved
    scheduleFlush()

flush():                          # at most one ModifyQuerySet per microtask
  if pending.empty || socket not OPEN: return
  mods = drain(pending)
  send({ type:"ModifyQuerySet", baseVersion: querySetVersion,
         newVersion: querySetVersion+1, modifications: mods })
  querySetVersion += 1
```

### 7.2 Apply a `Transition` + version-gap → full resync (seam row 6)

This is the **core correctness rule**. A `Transition` is applied **iff** its `startVersion` equals the
client's current applied version, field-for-field. Any mismatch ⇒ a frame was missed (server dropped it
under backpressure, or we reconnected) ⇒ **resync from scratch**. A dropped frame degrades to a resync,
never to silent divergence.

```
onTransition(t):
  if not versionEquals(t.startVersion, current):   # ANY gap (querySet|ts|identity)
     return restart()                              # full resync — never patch across a gap
  beginConsistentWindow():                         # single React render pass
     # 1. apply authoritative results FIRST
     for m in t.modifications:
        e = byQueryId.get(m.queryId); if !e: continue
        switch m.type:
          QueryUpdated: e.serverValue = m.value; e.serverError = undefined
                        e.journal = m.journal; e.serverVersion = t.endVersion
          QueryFailed:  e.serverError = {message:m.errorMessage, data:m.errorData}
                        e.serverValue = undefined; e.journal = m.journal
          QueryRemoved: byQueryId.delete(m.queryId)
     # 2. THEN retire optimistic overlays now covered by authoritative data
     optimistic.retireThrough(t.endVersion.ts)     # drop outstanding with serverTs <= endVersion.ts
     # 3. recompute overlays and notify changed tokens once
     current = t.endVersion
     maxObservedTimestamp = max(maxObservedTimestamp, t.endVersion.ts)
     optimistic.recomputeAndNotify(affectedTokens)
```

`restart()` is unified with reconnect (§7.5): reset `current` to zero, reopen via `Connect`, and
re-`Add` **every** live `QueryEntry` (with its stored `journal`) from `baseVersion 0`. The server
rebuilds all results; the next `Transition` re-establishes a consistent window.

### 7.3 Optimistic mutation lifecycle (requestId-keyed)

```
mutation(udfPath, args, {optimisticUpdate}):
  requestId = nextRequestId++         # per-session monotonic; stable across reconnects
  promise = registerInflight(requestId)
  if optimisticUpdate:
     optimistic.add({ requestId, serverTs:null, apply: store => optimisticUpdate(store, args) })
     optimistic.recomputeAndNotify(allAffectedTokens)     # instant UI, synchronous
  send({ type:"Mutation", requestId, udfPath, args, componentPath })
  return promise

onMutationResponse(r):
  if r.success:
     optimistic.setServerTs(r.requestId, BigInt(r.ts))    # mark "completed at ts" — DO NOT drop yet
     resolveInflight(r.requestId, r.result)
  else:
     optimistic.remove(r.requestId)                       # immediate rollback
     optimistic.recomputeAndNotify(affectedTokens)
     rejectInflight(r.requestId, makeError(r.errorMessage, r.errorData))
```

**The no-flicker invariant.** A completed optimistic update is retired (in `retireThrough`, §7.2) only
when a `Transition` advances the client `ts` **past** the mutation's `serverTs` — i.e. only once the
authoritative query results that reflect the mutation have been applied. Between `MutationResponse` and
that `Transition`, the overlay stays. This holds **regardless of how many OCC retries the server did**:
the client sees one final `serverTs` and reconciles exactly once.

### 7.4 Gapless journal pagination

Each `QueryUpdated` carries a `journal` (opaque end-cursor state). The client stores it on the
`QueryEntry` and **re-sends it inside the `Add`** on every resubscribe/resync, so the server resumes the
identical pagination window — no rows skipped or duplicated as data shifts at the head while you scroll
the tail. `usePaginatedQuery` layers on top: it holds an ordered list of page subscriptions, each a
normal `watchQuery` whose journal pins its page boundary; `loadMore(n)` adds the next page subscription;
all pages live in one consistent window so the merged list is always coherent.

### 7.5 Reconnect / resume + mutation replay

```
onSocketClose(code, reason):
  lastCloseReason = reason; isConnected = false
  fail all in-flight ACTIONS (non-idempotent, no replay) with a disconnect error
  scheduleReconnect()                       # exp backoff: initial*mult^n, capped, ±jitter

onSocketOpen():
  connectionCount++; isConnected = true; backoff = initial
  current = ZERO_VERSION
  send Connect{ sessionId, connectionCount, lastCloseReason, maxObservedTimestamp }
  re-Add every live QueryEntry (with journal) at baseVersion 0   # = restart()
  re-send Authenticate if an auth token is set
  re-send every in-flight MUTATION with its ORIGINAL requestId   # server dedups (idempotent)
```

- **Mutations** are replayed on reconnect with their original `requestId`. Because `sessionId` is
  stable, the sync tier's per-session `requestId → MutationResponse` cache makes replay idempotent
  (already-applied mutations return the cached response; never double-applied).
- **Actions** are **not** replayed (non-deterministic, no server-side replay record). An in-flight
  action across a disconnect rejects with a clear error — the app retries explicitly if it wants to.

### 7.6 Auth flow

`setAuth(fetchToken)` fetches a token and sends `Authenticate { baseVersion: identityVersion,
tokenType:"User", value: token }`. On `AuthError`, the client calls `fetchToken({ forceRefreshToken:
true })` once and retries; persistent failure surfaces "unauthenticated" via the `onChange` callback
and rejects auth-gated work. Token refresh is also scheduled ahead of expiry when the fetcher exposes it
(JWT `exp`); details belong to the Auth slice — here we only drive the `Authenticate`/`AuthError`
handshake.

---

## 8. Package / module / file layout

```
packages/
  client/                         # @stackbase/client — framework-agnostic core (no React)
    src/
      index.ts                    # public exports: StackbaseClient + all types
      client.ts                   # StackbaseClient facade
      transport/
        types.ts                  # ClientTransport, ClientWebSocket, WebSocketConstructor
        websocket-manager.ts      # connect/resume/backoff, inbound dispatch, gap→restart
      protocol/
        messages.ts               # ClientMessage / ServerMessage / StateModification / StateVersion
        codec.ts                  # jsonCodec (MessageCodec); binary codec lands here later
        version.ts                # versionEquals, versionCompare, ZERO_VERSION, parse/format u64
      sync/
        local-sync-state.ts       # query set, querySetVersion, ModifyQuerySet diffing, journals
        query-token.ts            # contentAddress(udfPath,args,componentPath) — canonical args
        consistency.ts            # ConsistencyManager (one window → one render pass + batching)
      optimistic/
        optimistic-results.ts     # OptimisticQueryResults (requestId overlay, retireThrough)
        local-store.ts            # OptimisticLocalStore impl over a working value map
      requests/
        request-manager.ts        # requestId alloc, in-flight mutation/action promises, replay
      auth/
        auth-manager.ts           # setAuth/clearAuth, Authenticate frames, AuthError refresh
      util/
        backoff.ts, batched-updates.ts, equality.ts (compareValues bridge)
    test/ ...

  react/                          # @stackbase/react — bindings (depends on @stackbase/client)
    src/
      index.ts
      provider.tsx                # StackbaseProvider, useStackbaseClient (React context)
      use-query.ts                # useQuery via useSyncExternalStore
      use-mutation.ts             # useMutation + ReactMutation.withOptimisticUpdate
      use-action.ts
      use-paginated-query.ts      # usePaginatedQuery on top of the journal
      use-auth.ts                 # useStackbaseAuth (isLoading/isAuthenticated)
    test/ ...
```

Depends on `@stackbase/values` (schema-codegen output: `FunctionReference`, `FunctionArgs`,
`FunctionReturnType`, `getFunctionName`, `Value` codec). A thin `@stackbase/react-convex-shim` can
re-export the hooks under `convex/react` names for drop-in Convex compatibility (compatibility doc
promise), but that is a packaging detail, not core.

---

## 9. Tier 0 today (single binary, loopback)

At Tier 0 the client, the sync protocol, and the engine all live in **one address space**; the
"network" is a function call.

1. The embedded runtime composes transactor + executor + sync handler + HTTP in-process and exposes
   `createTransport()` → a `ClientTransport` whose `webSocketConstructor` is a **loopback** constructor
   wired to an in-memory bridge, and whose `fetch` calls the in-process HTTP handler. (Built by the
   embedded-runtime component; the client just receives it.)
2. App code constructs the client **identically to every other tier**:
   ```ts
   const client = new StackbaseClient({ transport: runtime.createTransport() });
   // React:  <StackbaseProvider client={client}> … useQuery(api.messages.list, { channel }) … </StackbaseProvider>
   ```
3. `Connect` → loopback `send` enqueues into the in-process sync handler; the handler runs the query
   via a direct executor call and returns a `Transition` straight back through the bridge. A mutation
   commits, the runtime calls the sync handler's `notifyWrites` (via the write-fanout publisher), the
   handler re-runs the affected subscriptions and pushes a `Transition` — **all synchronously, no TCP,
   sub-millisecond.**
4. Backpressure/heartbeat are effectively no-ops on loopback (`bufferedAmount` is ~0), but the
   `bufferedAmount` field and the version-gap→resync path are **present and exercised by the same code**
   — so the networked tier inherits correct behavior, not a different code path.

The result: `const data = useQuery(...)` is automatically live against the in-process engine with zero
configuration — the PocketBase-light DX, with the Convex-grade reactive hook.

---

## 10. Scale seam reserved — WhatsApp-scale attaches with no app/engine rewrite

The component's job in the scalability mandate is to keep three seams open at Tier 0 (their trivial
loopback forms) so Endpoint B is adapters + config, never a rewrite.

| Seam (row) | What Foundation ships at Tier 0 | How Tier 2 attaches — no app/engine change |
|---|---|---|
| **Transport (row 3)** | `ClientTransport` injected; client never builds a socket. Loopback constructor. | Hand the client a **networked** `ClientTransport` (`@stackbase/transport-ws`) pointed at a router in front of a **connection-sharded sync fleet** (rendezvous-hashed client→node). Same client, same `useQuery`. Only the constructor changes. |
| **Any-gap → full-resync (row 6)** | `bufferedAmount` in `ClientWebSocket`; `onTransition` resyncs on **any** `StateVersion` mismatch; reconnect = restart. | Tier 2 sync nodes drop frames to slow consumers under backpressure. Because the client treats a dropped/missed frame as a **version gap → full resync**, a drop degrades to a resync — **never silent divergence**. This client behavior is *exactly what makes server-side message-drops correct*; it cannot be bolted on later. |
| **Version brackets as ack points (row 10)** | `MessageCodec` isolates the wire; `StateVersion` start/end brackets every `Transition`; the client retains last-applied value per query. | A **binary-delta codec** swaps in behind `MessageCodec`: each `QueryUpdated` becomes a compact diff against the value the client last applied at `startVersion`. The version brackets are the per-client **ack points** the diff is computed against. The state model (record reads → match writes → recompute → push) is unchanged; only `encodeClientMessage`/`decodeServerMessage` change. |

Two more it keeps honest: the `ServerMessage` union is **versioned/extensible with a reserved
`Broadcast` kind** (row 5 — presence/typing attach without a wire break; Foundation parses-and-ignores
it), and `componentPath` is threaded through `Add`/`Mutation`/`Action` though components are unbuilt.
The app's `useQuery`/`useMutation` call sites and the typed `api` are **byte-for-byte identical** A→B.

---

## 11. Failure & edge handling

| Situation | Client behavior |
|---|---|
| **Version gap** (`startVersion ≠ current`) | Full resync: reset version, re-`Connect`, re-`Add` all queries with journals at base 0. The single most important rule. |
| **Socket close / error** | Mark disconnected, record `lastCloseReason`, fail in-flight **actions**, schedule exp-backoff+jitter reconnect, then resume + replay mutations. |
| **`FatalError`** | Stop reconnecting, reject all in-flight requests, surface to `onServerDisconnect`; deliver an error to all subscriptions. |
| **`AuthError`** | `fetchToken({forceRefreshToken:true})` once and re-`Authenticate`; persistent failure → `isAuthenticated:false` via `onChange`. |
| **`QueryFailed`** | Store the per-query error; that query's `localQueryResult()` throws (useQuery surfaces it). **Other queries stay live.** |
| **Mutation app error** (`success:false`) | Reject the promise with `{message,data}`; remove its optimistic update (rollback) and recompute immediately. |
| **OCC retries on server** | Invisible to the client — it sees only the final `MutationResponse.ts`; the optimistic overlay survives the latency and reconciles exactly once. |
| **Optimistic update throws** | Catch, log, skip that update for this recompute; never corrupt the working store or other overlays. |
| **`setQuery` on an unsubscribed query** | Allowed; value lives in the working store so later updates in the batch see it; no subscriber ⇒ no emit; overwritten when/if a server result arrives. |
| **Reconnect mutation replay** | Re-sent with original `requestId`; server dedups via per-session cache (idempotent). Requires the sync-tier contract. |
| **In-flight action across disconnect** | Rejected with a disconnect error (no automatic replay). |
| **`useQuery(..., "skip")`** | Holds no subscription, returns `undefined`; flipping to real args subscribes; flipping back unsubscribes. |
| **Args with different key order / `undefined` fields** | Canonicalized (sorted keys, `undefined` dropped per the value codec) so identical logical args share one `QueryToken`. |
| **Unknown `ServerMessage` kind** (e.g. future `Broadcast`) | Ignored via `default:` — forward-compatible, no throw. |
| **Out-of-order / duplicate `Transition`** | Caught by the start-version check ⇒ resync. |
| **Subscribe then unsubscribe same tick** | Net diff in one batched `ModifyQuerySet`; refcount keeps shared subs alive. |

---

## 12. Test strategy

### Unit
- **Codec round-trip.** `decodeServerMessage(encode(x)) deepEquals x` for every `ServerMessage`/
  `ClientMessage` variant, incl. `u64` ts as string ↔ bigint and `Value` edge types.
- **Version logic.** `versionEquals`/`versionCompare` truth table; gap detection fires on a mismatch in
  **any** of `querySet`/`ts`/`identity`.
- **Query-set diffing.** subscribe/unsubscribe with refcounting produces the expected `Add`/`Remove`
  sequence; microtask coalescing yields one `ModifyQuerySet` per burst; `baseVersion→newVersion` chains
  with no gaps.
- **Journal plumbing.** A stored journal is re-sent verbatim inside the `Add` on resync.
- **Optimistic ordering.** Apply A then B, response B then A, transition past A then B — overlay retires
  in the right order, no flicker, no leak; mutation failure rolls back immediately.
- **Reconnect replay.** In-flight mutations re-sent with original `requestId`; actions rejected.

### Property / model-based (the high-value ones)
- **Optimistic reconciliation invariant.** For any random interleaving of `mutation(optimistic)`,
  `MutationResponse(ts)`, and `Transition(start,end)` events, after the stream drains the client state
  **equals** the pure server state with all completed updates retired — i.e. `outstanding` is empty and
  every token equals its server value. No interleaving leaves a stuck or doubly-applied overlay.
- **Version-gap safety.** Generate a full `Transition` stream from a reference server model, then drop
  an arbitrary subset of frames. Assert the client either applies a contiguous bracket chain or
  resyncs, and that its **final converged state equals the reference** — it never silently diverges.
  (This is the row-6 correctness proof.)
- **Query-set convergence.** Random subscribe/unsubscribe sequences → replay the emitted diff stream
  through a model server → the model's active set **equals** the client's live `byToken` set; version
  chain gapless.
- **Content-address canonicality.** For random `Value` args, any key-permutation /
  `undefined`-injection maps to the **same** `QueryToken`; distinct args map to distinct tokens
  (round-trips through the value codec's total order — shares the order-preserving codec property test
  from the query engine).
- **OCC-conflict transparency.** Simulate the server retrying a mutation `N` times before responding;
  assert the client's optimistic overlay reconciles **exactly once** at the final ts for all `N`.

### Integration (loopback) & conformance harness
- A `FakeWebSocket` implementing `ClientWebSocket` (scriptable `bufferedAmount`, inject close/error)
  and a `MockTransport` that scripts `ServerMessage` sequences drive deterministic gap/backpressure/
  reconnect scenarios without a network.
- End-to-end against the **embedded loopback engine**: `useQuery` goes live, a `useMutation` with
  `withOptimisticUpdate` shows instant UI then reconciles, a `usePaginatedQuery` stays gapless while
  rows are inserted at the head — asserting a **single render pass** per consistent window (render-count
  assertion via a test renderer).

---

## 13. Open issues

- **Cross-session mutation replay safety.** Idempotent reconnect replay relies on the sync tier keeping
  a per-session `requestId → MutationResponse` cache. Its TTL/eviction and behavior when the cache has
  expired (re-apply vs. surface error) must be pinned with reactive-sync-tier — otherwise a slow
  reconnect could double-apply.
- **Action delivery semantics on disconnect.** We reject in-flight actions (no replay). Confirm this
  matches the DX bar, or offer an opt-in `retryOnReconnect` for explicitly idempotent actions.
- **Render-batching across React versions.** Single-render-pass relies on React 18 auto-batching; the
  injected `unstable_batchedUpdates` path for React ≤17 and React Native needs verification under
  concurrent features (`useTransition`).
- **`getAllQueries` cost.** Optimistic updates that scan all instances of a query are O(instances) per
  recompute; for a large fan-out (many channels) this may need an index. Measure before optimizing.
- **`maxObservedTimestamp` fast-path.** The exact server contract for resuming from a client-supplied
  ts (skip re-execution if nothing changed) is a sync-tier decision; until defined, resync re-runs all
  queries — correct but not minimal.
- **Binary-delta state contract (row 10, future).** A delta codec makes the server stateful about each
  client's last-acked value; needs a fuzzing harness comparing delta-applied state to full-snapshot
  state, and a clean fallback to full snapshots on any ack mismatch.
- **Auth/identity version interplay with optimistic updates.** A mid-flight identity change
  (`Authenticate`) bumps `identity` and can invalidate auth-dependent queries; the interaction with
  outstanding optimistic updates keyed by ts (not identity) needs explicit tests.
- **Unsaved-changes warning UX.** Warning on unload while mutations are in flight is browser-only and
  can be surprising; decide default-on vs opt-in.
