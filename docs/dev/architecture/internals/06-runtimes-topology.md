---
title: Internals — Runtimes & Deployment Topology
status: extracted (clean-room notes; concave studied as reference)
---

# Runtimes & Deployment Topology

> Clean-room architecture notes for **Stackbase**. We studied the concave packages
> (`@concavejs/runtime-base`, `@concavejs/runtime-embedded`, `@concavejs/transport-capnweb`,
> `@concavejs/core`; FSL-1.1-Apache-2.0) only to understand the *contracts*. Everything
> below is described in our own words and framed as what **we** will build. No source was
> copied; type/method names are cited as reference points so our implementation can be
> checked for behavioral parity, not textual identity.

---

## Purpose & the runtime abstraction

The core engine (docstore, query engine, UDF executor, sync protocol) should be written
**once** and run unchanged on many *hosts* — a Node server, a Bun server, a Cloudflare
Worker/Durable Object, a browser SharedWorker, or embedded directly in a parent process.
The trick is to factor everything host-specific behind a small set of abstract base classes
and adapter interfaces, so the engine never imports `node:fs`, `ws`, or a Cloudflare binding
directly.

In concave this factoring lives in the `runtime-base` package, which exports exactly four
subsystems (`scheduler`, `sync`, `module-loader`, `components`). Each is a **platform-agnostic
base class with abstract hooks** that a concrete host fills in. Stackbase adopts the same
shape: a `runtime-base`-equivalent that defines the contracts, plus thin per-host packages
that implement the abstract methods.

The three abstract base classes that matter:

- **`FsModuleLoaderBase`** (`module-loader/fs-module-loader-base`) — loads user UDF modules
  (the app's `convex/`-equivalent functions/schema/crons) from a source tree. It owns the
  *logic* (path resolution, caching, directory walking, `foo:bar` ↔ `foo/bar.ts` path
  duality, source-file filtering) but leaves two operations abstract: `fileExists(path)` and
  `importModule(path)`. Node implements those with `fs` + dynamic `import()`; Bun with its
  own loader; Cloudflare with a prebuilt module map (no filesystem at runtime). Config is a
  `ModuleLoaderConfig` — `convexDir` (root), optional `sourcePrefix`, `bundleExternals` (glob
  patterns to keep external during bundling), and `bundleRootDir`. Public surface: `load()`,
  `enumerateModules()` (returns `{ path, source }[]`), and `clearCache()` for hot-reload.

- **`TaskExecutor`** (`scheduler/task-executor`) — the in-process scheduler/cron driver. It
  polls the docstore on an interval (`pollIntervalMs`) for due scheduled functions and crons,
  and executes them through the UDF executor. It is constructed with `(docstore, udfExecutor,
  options)`, exposes `start()` / `stop()`, and `syncCronSpecs(cronSpecs)` to reconcile the
  app's cron definitions into a `_crons` system table at startup or when definitions change.
  It can be wired to a `SyncProtocolHandler` (via `setSyncProtocolHandler`) so that writes
  produced by scheduled work fan out to subscribers. This is the piece that makes "scheduled
  functions" and "cron jobs" work the same way on every host — only the timer source differs.

- **`SyncHandlerBase<TWebSocket>`** (`sync/sync-handler-base`) — the platform-agnostic
  WebSocket sync endpoint. It owns the sync protocol state machine and a `sessions` map
  (`Map` or `WeakMap`, host's choice) keyed by the host's native socket object. The
  abstract hooks are pure socket plumbing: `isWebSocketOpen`, `sendToWebSocket`,
  `closeWebSocket`, `getWebSocketReadyState`, plus a session-id prefix. The lifecycle methods
  (`handleUpgrade`, `handleMessage`, `handleClose`, `handleError`) are concrete and shared.
  The important method for the write path is `notifyWrites(invalidation)` — given a set of
  written ranges/tables and commit/snapshot timestamps, it walks subscribed sessions and
  pushes invalidations. `WriteInvalidation` carries `writtenRanges` (serialized key ranges),
  `writtenTables`, `commitTimestamp`, and `snapshotTimestamp`.

The lesson for Stackbase: **the engine is the same everywhere; a host is a handful of
adapter methods plus a timer and a socket type.**

---

## Multi-runtime model — what differs per host

The same engine targets Node, Bun, and Cloudflare (and browser workers). Concretely, only
these axes vary, and each maps to one abstract hook or adapter:

| Concern | Node | Bun | Cloudflare Worker / DO |
| --- | --- | --- | --- |
| **Module loading** | `fs` + dynamic `import()` (`FsModuleLoaderBase` hooks) | Bun loader / native TS | Prebuilt module map baked at deploy (no fs) |
| **Timers / scheduler** | `setInterval` driving `TaskExecutor` | same | DO alarms drive the poll instead of a long-lived interval |
| **WebSockets** | `ws` socket object as `TWebSocket` | Bun's native WS | Cloudflare WebSocketPair / hibernatable sockets |
| **Storage binding** | local docstore impl (e.g. SQLite/FS) | same | Durable Object storage + a `ShardRouter` returning DO stubs |
| **Session map** | `Map` | `Map` | `WeakMap` where sockets can be GC'd; sticky via shard router |

Because all four base classes are parameterized over their host primitives (`TWebSocket`,
the abstract `fileExists`/`importModule`, the docstore/blobstore interfaces), a new host is a
*new package that subclasses the bases* — not a fork of the engine. Stackbase will ship a
`runtime-node` first, keep the Cloudflare path as a known-good target shape, and treat Bun as
a near-drop-in of Node.

---

## The embedded single-binary runtime (KEY — our Tier 0)

This is the most important piece for Stackbase. The embedded runtime (`runtime-embedded`,
`createConcave(options)` → `EmbeddedRuntime`) runs the **entire stack — transactor, UDF
executor, sync protocol handler, HTTP handler — inside a single process with no sidecar and
no network hop.** This is our **Tier 0**: a single binary a developer can `npm i` and run,
or that we ship as one container, with the database engine and the function runtime co-located.

### What's inside one `EmbeddedRuntime`

From `EmbeddedRuntimeOptions` and the class shape, one instance composes:

- a **docstore** (required) and optional **blobstore** — the storage layer;
- **module sources** (`EmbeddedModuleSources`) — either a real `ModuleLoader` or an in-memory
  `EmbeddedModuleMap` (`Record<string, () => Promise<module> | module>`), or an array mixing
  both. The map form is what lets the runtime run with **zero filesystem**, e.g. bundled into
  a browser or a single binary;
- a **UDF executor** wrapped by an **execution adapter**;
- a **`SyncProtocolHandler`** and an **HTTP handler**;
- a **schema bootstrap mode** (`"auto"` applies schema/indexes on start, `"skip"` defers);
- an **execution mode** (`EmbeddedExecutionMode`: `"auto" | "parallel" | "serial"`).

It implements the shared `RuntimeHost` interface (`abstractions.ts`): `start()`,
`executeUdf(RuntimeUdfRequest)`, `executeHttp(Request)`, the four sync-session methods
(`createSyncSession`, `updateSyncSessionId`, `handleSyncMessage`, `destroySyncSession`),
`handleRequest`, `notifyWrites`, and three **client-fabrication** helpers:
`createWebSocketConstructor()`, `createFetch(clientUrl?)`, and `createTransport(clientUrl?)`.
A nice extra is `refreshSchema()` — re-read the schema module and reapply index metadata
*without* tearing down live transports/sessions, which is exactly what an editor/dev-loop or
single-binary hot-reload needs.

### Loopback WebSocket — no real network for the in-process client

The standard Convex client speaks WebSocket + HTTP. To let that *unmodified* client talk to
an in-process runtime, the embedded runtime hands out a **fake WebSocket** and a **fake
fetch** that are wired straight into the engine — no TCP, no loopback port.

`LoopbackWebSocket` is a full in-memory implementation of the `WebSocket` interface (the
`CONNECTING/OPEN/CLOSING/CLOSED` constants, `send`, `close`, `addEventListener`, the
`onopen/onmessage/onclose/onerror` handlers). It is driven by a `LoopbackBridge`
(`connect` / `send` / `disconnect`) and exposes `*FromBridge` methods (`openFromBridge`,
`messageFromBridge`, `closeFromBridge`, `errorFromBridge`) that the runtime calls to push
data *into* the client. `createLoopbackWebSocketConstructor(bridge)` returns something
shaped like `typeof WebSocket` so the client can't tell the difference. The result:
`createTransport()` yields a `ClientTransport` = `{ clientUrl, webSocketConstructor, fetch }`
that the Convex client accepts verbatim, but every byte stays in-process.

For Stackbase Tier 0, this is the whole magic trick: **the client library, the sync protocol,
and the engine all run in one address space, and the "network" is a function call.**

### Write fan-out to in-process subscribers

In a single process, a mutation commits and any open query subscription must be invalidated.
That's `notifyWrites` on the runtime, backed by the **write-fanout** subsystem
(`write-fanout.ts`). The interesting part is that it's designed to scale *past* one process
too: `createEmbeddedWriteFanout(originId, config, onRemoteWrite)` returns a publisher whose
`publish()` emits an `EmbeddedWriteFanoutPayload` — a versioned envelope with `originId`,
`messageId`, `emittedAtMs`, and the same invalidation fields (`writtenRanges`,
`writtenTables`, `commitTimestamp`). The transport is pluggable via an
`EmbeddedWriteFanoutAdapter` (`publish(payload)` / `subscribe(listener) → unsubscribe` /
`close`). Default/Tier-0 behavior is an in-memory channel; swap the adapter for a
BroadcastChannel, Redis pub/sub, or a message bus and the *same fan-out* spans multiple
embedded processes — each ignores its own `originId` and applies remote writes via
`onRemoteWrite`. This is the seam from "one binary" to "a few binaries sharing a database."

### Serialized executor — correctness without AsyncLocalStorage

`SerializedUdfExecutor` wraps any `UdfExec` and **serializes execution through a queue** so
that only one UDF runs at a time. The reason: environments without `AsyncLocalStorage`
(browser, React Native, some edge runtimes) can leak async context between concurrent
executions. Serializing avoids that bleed. This is the `"serial"` `EmbeddedExecutionMode`;
`"auto"` picks serial where ALS is unavailable and parallel where it's safe. It preserves the
full `UdfExec` contract — `execute(path, args, type, auth?, componentPath?, requestId?,
snapshotTimestamp?)` and `executeHttp(request, auth?, requestId?)`.

---

## Sync transport — capnweb / Cap'n Web RPC

The loopback transport handles "client and runtime in the *same* address space." The next
step out is "client and runtime separated by a **message boundary**" — a Web Worker,
SharedWorker, or a spawned subprocess — but still not a real network server. That's what the
`transport-capnweb` + `transport-bridge` packages do.

The abstraction is `EmbeddedRpcEndpoint` (`worker-bridge.ts`): anything with `postMessage`,
`addMessageListener(listener) → unsubscribe`, and an optional `addCloseListener`. Cap'n Web
(capnweb) implements this over a `MessagePort` with `createCapnwebEndpoint(port)`. On top of
the endpoint:

- **`createWorkerTransport(endpoint, options)`** → a `WorkerEmbeddedTransport` (a
  `ClientTransport` plus `close()`). This is the client side: it forwards Convex client
  WebSocket+fetch traffic across the port to a runtime hosted on the other side. The capnweb
  variant is `createCapnwebWorkerTransport(port, options)`.
- **`attachEmbeddedRuntimeWorkerServer(runtime, endpoint, options)`** / the capnweb
  `attachCapnwebEmbeddedRuntimeServer(runtime, port, options)` — the server side: hosts an
  `EmbeddedRuntime` behind a port so the worker *is* the backend.
- **SharedWorker** variants (`createCapnwebSharedWorkerTransport`,
  `attachCapnwebEmbeddedRuntimeSharedWorkerServer`) let *many browser tabs* share one runtime
  instance through a SharedWorker's `connect` event — one engine, many client connections.
- **Supervisor** (`createSupervisedWorkerTransport` / `createSupervisedCapnwebWorkerTransport`)
  wraps a worker-backed transport with **health checks and restart/backoff**: a
  `workerFactory`, `healthCheckIntervalMs`, `maxConsecutiveHealthFailures`, exponential
  `restartBackoff*` knobs, a `restartRetryLimit`, and a `WorkerSupervisorState`
  (`starting → running → restarting → closed`) surfaced via `onStateChange`. This is how a
  crashed worker-hosted runtime is transparently respawned under a stable client transport.

For Stackbase, the takeaway is that **transport is a strategy, not a fork of the engine**:
loopback (same process) → worker/MessagePort RPC (process-adjacent, supervised) → real
network server (host package). The client never changes; only which `ClientTransport` it's
handed.

---

## Sync topology & sharding (Tier 2)

This is the distributed end of the spectrum: many sync nodes across regions, writes sharded
across committers, with **autoscaling** of the sync tier. It lives in `runtime-base/sync`
(`sync-topology`, `sync-load-report`) and `core/interfaces/shard-router`.

### Shard routing

`ShardRouter<TStub>` (`core/interfaces/shard-router`) is the routing brain, parameterized
over a host stub type (`DurableObjectStub` on Cloudflare, anything elsewhere). Two routing
problems, two strategies:

- **Documents → committers** via **consistent hashing**: `getShardForDocument(docId)` returns
  a shard id for an `InternalDocumentId` (`{ table, internalId }`), and `getCommitterStub(shardId)`
  returns the committer for that shard. Writes are partitioned by document.
- **Clients → sync nodes** via **rendezvous (sticky) hashing**: `getSyncNodeId(clientId)`
  gives a stable sync node per client so a client's subscriptions stay on one node, and
  `getSyncNodeStub(syncNodeId)` resolves it. The doc notes two modes: *Simple* (always the
  same instance — this is Tier 0) and *Distributed* (the hashing above).

### Load reporting & the shard map

Each sync node periodically emits a `SyncNodeLoadReport`: its `shard`, `region`,
`activeSessions`, `reportedAtMs`, and optional rates/utilization
(`messageRatePerSecond`, `notifyRatePerSecond`, `cpuUtilization`, `memoryUtilization`).
`sync-load-report` parses/normalizes these from untrusted request payloads
(`parseSyncLoadReportRequest`, `normalizeSyncLoadReport`) with region/shard fallbacks.

A coordinator folds reports into a **`SyncShardMap`**: `regions → string[]` (the live shards
per region), `notifyShards`, a `generatedAtMs`/`ttlMs` freshness window, a `source`
(`"coordinator" | "kv" | "static"`), and optional `autoscale` metadata. `buildShardMapFromReports`
computes it from `{ logicalInstance, config, reports, previousShardMap }`;
`resolveStaticSyncShardMap` produces a fixed map (no autoscaling), and
`resolveBootstrapSyncShardCandidates` gives initial targets before any reports arrive.
`isValidSyncShardMap` is the type guard for maps fetched from KV. Pool/instance naming is
derived by `buildPooledInstanceName(logicalInstance, "sync" | "udf", nodeId)`, so the sync
pool and the UDF pool scale independently under one logical instance.

### Autoscaling the sync tier

`SyncTopologyConfig` is the control surface. It declares the node inventory
(`syncNodes`, `syncNodesByRegion`, `defaultRegion`), cache/staleness windows
(`shardMapCacheMs`, `nodeStaleMs`), shard bounds (`minShardsPerRegion`, `maxShardsPerRegion`),
and **targets** the autoscaler drives toward: `targetSessionsPerShard`, and optional
`targetMessageRatePerShard`, `targetNotifyRatePerShard`, `targetCpuUtilization`,
`targetMemoryUtilization`. It also configures **auto-shards** — `autoShardsPerRegion` and an
`autoShardPrefix` for naming dynamically-created shards — plus `allowScaleToZero` and a
`scaleProfile` (`"minimal" | "advanced" | "custom"`).

The scaling loop is guarded against thrashing by **cooldowns** (`scaleUp/DownCooldownMs`),
**hysteresis ratios** (`scaleUp/DownHysteresisRatio`), and **per-step caps**
(`maxScaleUp/DownStep`). Per region the autoscaler tracks `SyncAutoscaleRegionState`
(`desiredShards`, last scale up/down timestamps) and emits rich
`SyncAutoscaleRegionDiagnostics` explaining *why* it did or didn't scale — `rawDesired` vs
`adjustedDesired`, and booleans like `scaleUpBlockedByCooldown`,
`scaleDownSuppressedByHysteresis`, `scaleUpLimitedByStep`. All of this rolls up into
`SyncAutoscaleMetadata` attached to the shard map.

For Stackbase, the model is clear: **a coordinator collects per-node load reports, computes a
desired shard count per region under target/cooldown/hysteresis/step constraints, publishes a
shard map (cached with a TTL, stored in KV), and the shard router reads that map to place
clients and route writes.** Tier 0 short-circuits all of it via the "Simple" router that
always returns the single local instance.

---

## Components / manifest — modular apps

Both `runtime-base/components/component-manifest` and `core/components/manifest` describe a
**component model**: an app is a tree of installable components (think mountable mini-backends
with their own modules, schema, and HTTP routes), each potentially sourced locally or from npm.

A `ComponentManifestEntry` records, per component: its `componentPath` and `parentPath`,
`name`/`definitionName`, `depth` in the tree, `modulesDir` and `configPath`,
`dependencyComponentPaths`, the component's declared args
(`definitionArgs: Record<string, ValidatorJSON>`, `optionalDefinitionArgs`) and the
`resolvedArgs` passed at mount, a `sourceType` (`"local" | "npm"` with optional `sourcePath` /
`packageName` / `packageVersion`), and a `hasHttp` flag. A `ComponentManifest` wraps the
root (`rootConfigPath`, `rootModulesDir`) plus the flat `entries[]` list.

The manifest is **scanned from the source tree** (`scanComponentManifestFromConvexDir`,
`scanComponentsFromConvexDir`) and held in a process-global registry
(`set/get/reset/findComponentManifestEntry`, `normalizeComponentPath`). Note the candid
caveat in concave's own comments: component **arg metadata isn't reliably exposed** by the
underlying Convex analysis API yet, so they treat it as forward-compatible — prefer official
analysis when present, otherwise recover the shape from config source as a temporary
fallback. Stackbase should treat component args as best-effort/forward-compatible for the same
reason and design the validator path so it tightens up when the upstream API stabilizes.

The runtime threads `componentPath` through execution everywhere (`RuntimeUdfRequest`,
`UdfExec.execute`, the module loader's `load(modulePath, componentPath?)`), so a component is
fundamentally a *namespace* for modules + schema + routes resolved against the manifest.

---

## How Stackbase reimplements this

**Build order is Tier 0 first, then earn the way up.**

1. **Tier 0 — embedded single binary (ship this first).** One process: docstore + UDF
   executor + sync protocol + HTTP handler, composed exactly like `EmbeddedRuntime`. The
   client talks to it through a **loopback WebSocket + loopback fetch** (`createTransport()`),
   so there is no network and no sidecar. Use the **serialized executor** by default where
   `AsyncLocalStorage` is unavailable; allow parallel where it's safe. Module sources accept
   both a real loader and an in-memory map so the same binary works with or without a
   filesystem. `refreshSchema()`-style hot reload keeps the dev loop tight. **Docker baseline:**
   this single binary in one container, mounting a volume for the docstore, is the entire
   default deployment — no orchestration required.

2. **Tier 1 — process-adjacent / multi-tab.** Reuse the **worker-bridge / capnweb**
   transport to host the runtime behind a `MessagePort` (Web Worker, SharedWorker for shared
   browser state, or a child process), wrapped by the **supervisor** for health-check +
   restart/backoff. Same engine, same client; only the `ClientTransport` changes. Add the
   **write-fanout adapter** (BroadcastChannel/Redis) so a small fleet of embedded processes
   sharing one database stays subscription-consistent.

3. **Tier 2 — distributed sync + sharding.** Promote the `ShardRouter` from "Simple" (always
   local) to "Distributed": **consistent hashing for document→committer**, **rendezvous
   hashing for client→sync-node**. Stand up a **coordinator** that ingests
   `SyncNodeLoadReport`s, runs the autoscaler (targets + cooldown + hysteresis + step caps),
   and publishes a TTL-cached `SyncShardMap` (in KV) with auto-shards per region. Sync and
   UDF pools scale independently under one logical instance.

Throughout, keep the **runtime-base discipline**: the engine never imports host primitives;
every host (Node first, Bun ~free, Cloudflare DO as the proven distributed target) is a thin
subclass supplying `fileExists`/`importModule`, a timer, a socket type, and a storage binding.

---

## Open questions / risks

- **Serial vs parallel execution default.** Serializing every UDF (Tier 0 safety) caps
  throughput. We need a confident `"auto"` detector for ALS availability and clear docs on
  when a host can safely run `"parallel"`, or Tier 0 will look slow under concurrency.
- **Write-fanout delivery guarantees.** The default adapter is in-memory and fire-and-forget
  (`publish` returns void/Promise, no ack). For multi-process Tier 1, we must define
  at-least-once vs best-effort semantics, dedupe by `messageId`, and behavior when an adapter
  (Redis) is briefly down — otherwise subscriptions silently go stale.
- **Coordinator availability & shard-map staleness.** The shard map has a `ttlMs` and a
  `source` of coordinator/kv/static. We must specify behavior when the coordinator is down and
  the cached map expires (fail open to last-known? fall back to static/bootstrap candidates?),
  and how routers converge during a reshard without dropping sticky sessions.
- **Rebalancing live sessions.** Rendezvous hashing keeps clients sticky, but scaling shards
  up/down remaps some clients. The diagnostics model exists, but the *migration* of active
  sync sessions (drain vs hard cutover) is not described and is the riskiest part of Tier 2.
- **Component arg metadata is admittedly unstable upstream.** concave recovers it from config
  source as a fallback. Stackbase must decide how much to depend on validated component args
  vs treating them as advisory, and isolate that code so a future stable API is a clean swap.
- **Cross-shard transactions.** Consistent-hashing documents to committers implies a write
  touching two shards needs coordination. The extracted contracts don't show a 2PC/transaction
  manager; we must confirm whether Tier 2 supports multi-shard atomic writes or constrains
  transactions to a single shard.
- **Loopback transport fidelity.** `LoopbackWebSocket` reimplements the WS interface; any
  client behavior relying on real backpressure, `bufferedAmount`, or binary frames must be
  validated against the in-memory version so Tier 0 doesn't diverge subtly from networked tiers.
