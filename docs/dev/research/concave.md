---
title: concave — Architecture Research
status: research
---

# concave — Architecture Research

> Source: `/.reference/concave-docs-raw/llms-full.txt` (complete scraped docs, 3283 lines).
> Rebranded mirror pages live under `/docs/enduser/` (these refer to the project as
> "Stackbase" / `@stackbase/*` / `StackbaseDO`; the canonical names below use the
> original `concave` / `@concavejs/*` / `ConcaveDO` naming from the raw docs).

## 1. Positioning & one-line thesis

concave is a **Convex-compatible runtime for Cloudflare Workers, Bun, and Node.js** —
"100% API compatible with Convex. Self-hosted, multi-runtime, local devtools."

The thesis: take Convex's developer model (reactive queries, mutations, actions,
schema, realtime sync) and make it **portable and self-hostable** across a spectrum of
hosts — from a 14 MB desktop app, to a single 60 MB standalone binary, to a globally
distributed Cloudflare Workers + Durable Objects deployment — *without changing a line
of the user's `convex/` code or the client*. You write standard Convex functions and
point a standard `ConvexReactClient` at a concave URL. The entire value proposition is
"deploy the exact same app anywhere, at the lowest cost the target platform allows,"
achieved through a small set of pluggable interfaces (DocStore / BlobStore / UdfExec /
SyncProtocolHandler) that the engine composes differently per runtime.

## 2. Convex compatibility approach

concave runs Convex functions **unchanged**. It is a re-implementation of the Convex
*server* contract, not a fork of Convex Cloud.

- **User code surface is identical.** Functions live in a `convex/` directory; you
  import `query`, `mutation`, `action` (and `internalQuery/Mutation/Action`) from
  `./_generated/server`, validators (`v`) from `convex/values`, and `defineSchema` /
  `defineTable` from `convex/server`. The official `convex` npm package is a *dependency*
  of a concave project (used for validator helpers and generated types).
- **`_generated/` is produced by concave's own codegen.** `concave codegen` generates
  the same `_generated/api` and `_generated/server` types. It has a "runtime analysis"
  mode (preferred — it loads and introspects your modules) and a `--static` fallback.
  `_generated/` is created on first `concave dev` or `concave codegen`.
- **Module loader maps files to the API tree.** Modules are keyed as `convex/<module>.ts`
  and normalized so `api.tasks.list`, `api.messages.send`, etc. resolve. Loading is via
  `import.meta.glob` in bundler environments, or an explicit module map where glob isn't
  available (e.g. Electrobun).
- **Same clients.** `convex/react` (`useQuery`/`useMutation`), `convex/browser`
  (`ConvexHttpClient`), and the Python client all work; you only swap the URL.
- **Same semantics.** Queries/mutations are deterministic with read-your-own-writes;
  mutations run as OCC transactions with atomic writes. concave *enforces the same
  determinism rules*: in queries/mutations, `fetch()` and `setTimeout()` throw,
  `Math.random()` returns a seeded value, `Date.now()` returns a fixed request
  timestamp, and `crypto.randomUUID()` is blocked — true side effects must go in actions
  or via `ctx.scheduler`.
- **`convex-test` works** because it tests function logic in isolation against an
  in-memory backend.

**Supported (Full):** queries, mutations, actions, internal functions, HTTP actions,
arg validation; full `ctx.db` (get/insert/patch/replace/delete/query, indexes,
cursor pagination); `ctx.auth.getUserIdentity()` with third-party JWT (Clerk, Auth0,
custom OIDC, Firebase via custom JWT); `ctx.storage` (store/get/delete/getUrl);
`ctx.scheduler.runAfter`/`runAt`; subscriptions + range-based invalidation + optimistic
updates; full-text search (SQLite FTS5).

**Limited / not supported:**
- **Vector search = "Basic"** — exact brute-force cosine in built-in SQLite adapters
  (good to ~10k vectors); production scale needs a custom adapter delegating to
  Pinecone/TurboPuffer/pgvector/etc.
- **Convex Auth (first-party) — not supported** (tightly coupled to Convex Cloud); use
  third-party providers. Token verification: extract `iss`, fetch
  `{issuer}/.well-known/jwks.json`, validate signature/exp/aud.
- **Crons — Planned** (only `runAfter`/`runAt` exist today).
- **Components — Not supported** (`concave components` is an experimental stub).
- **Streaming exports — Not supported.**

## 3. Multi-runtime execution model

The same Convex functions ("UDFs") run on three first-class runtimes plus several
embedded variants. Execution is abstracted behind a `UdfExec` interface; what differs is
*where* it runs and *what executes the WebSocket/HTTP layer*.

- **Bun (default, canonical API).** `createConcave({ convexDir })` from
  `@concavejs/runtime-bun`; `await server.listen({ port })`. Uses `bun:sqlite` +
  filesystem blobstore. `Bun.serve()` provides HTTP + WebSocket on one port. Default
  bind is `0.0.0.0` (LAN-accessible — a security note flags this).
- **Node.js (same API).** `@concavejs/runtime-node`; requires **Node 22.5+** with
  `--experimental-sqlite` (and `--experimental-vm-modules`) because it uses the built-in
  `node:sqlite`. Default bind `127.0.0.1`. For Electron, where `--experimental-sqlite`
  can't be passed, a `better-sqlite3` adapter (`@concavejs/docstore-better-sqlite3`) is
  used instead.
- **Cloudflare Workers (recommended for production).** A Worker handles HTTP routing
  (`/api`, `/sync`); execution and state live in **Durable Objects** (`ConcaveDO` for
  execution/transactor, `SyncDO` for sync). Configured declaratively via
  `concave.config.ts` (`cloudflare.{deploy,storage,execution,sync}`); deployed with
  `concave deploy` (wraps wrangler). For hand-assembly, `@concavejs/runtime-cf` exposes
  `defineConcaveRuntime()` and lower-level primitives.
- **Embedded runtimes.** `@concavejs/runtime-embedded` runs the whole engine *inside a
  webview's JS context* (Tauri), talking to the client over a loopback WebSocket
  transport, with SQLite via `@tauri-apps/plugin-sql`. It can also run inside a Web
  Worker, bridged over `postMessage` (`attachEmbeddedRuntimeWorkerServer` +
  `createWorkerTransport`), to keep global-patching/UDF execution off the UI thread.

**Runtime detection / selection.** `concave dev` auto-detects Bun vs Node; `--bun`,
`--node`, `--cf` force a runtime (`--cf` runs `wrangler dev`/Miniflare under the hood).
The docstore factory receives a `{ runtime: "bun" | "node" }` context so adapter choice
can vary per runtime.

**Cloudflare execution strategy** (`cloudflare.execution.strategy`): `auto` |
`inline` | `isolated` | `worker-loader`.
- `inline` — UDFs execute directly in the ConcaveDO.
- `isolated` — UDFs run in an isolate but must **syscall back to the transactor** for
  DocStore/BlobStore access (they never touch storage directly).
- `worker-loader` — for multi-tenant: a Worker Loader runs user code in **sandboxed
  isolates and can block outbound network access** (see `@concavejs/runtime-cloud`).
- The embedded runtime defaults to **serialized** UDF execution where
  `AsyncLocalStorage` is unavailable, to avoid request-context bleed.

**Cross-runtime guarantee:** the same function code yields the same results on CF/Bun/
Node; schema validation and determinism enforcement live in **concave core**, so they're
runtime- and adapter-independent. The docs even ship a parametrized cross-runtime E2E
test pattern.

## 4. Storage adapter architecture ← deep

This is the crux of "deploy anywhere." The engine is **storage-agnostic**: it depends
only on two narrow interfaces, and every deployment target is just a different pair of
adapters wired into the same core.

### The two core interfaces

**`DocStore`** (`@concavejs/core` / `@concavejs/core/docstore`) — an **MVCC document +
index store**. The interface is deliberately low-level and timestamp-aware, which is what
lets concave implement Convex's snapshot/OCC semantics on top of plain SQL/KV backends.
Key methods:
- `setupSchema()`
- `write(documents, indexes, conflictStrategy)` — atomic write of docs + index entries
  with a conflict strategy (the OCC commit path)
- `index_scan(indexId, tableId, readTimestamp, interval, order)` — **range scan over an
  index at a read timestamp** (this is what powers range-based invalidation)
- `load_documents(range, order)`
- `previous_revisions(...)` / `previous_revisions_of_documents(...)` — MVCC history for
  conflict detection
- `get(id, readTimestamp)`, `scan(tableId, readTimestamp)`,
  `scanPaginated(tableId, cursor, limit, order, readTimestamp)`, `count(tableId)`
- `getGlobal(key)` / `writeGlobal(key, value)` — engine metadata
- `search(indexId, searchQuery, filters, options)` — full-text
- `vectorSearch(indexId, vector, limit, filters)` — vectors

The presence of `readTimestamp` on reads and `previous_revisions` for writes means
**MVCC and OCC are pushed down into the adapter contract**, not bolted on per backend —
every adapter expresses the same consistency model.

**`BlobStore`** (`@concavejs/core/abstractions`) — `store(blob, options)` →
`{ _id, sha256, size, uploadedAt }`, `get`, `delete`, `getUrl`. Backs `ctx.storage`.

### Adapter matrix

| Concern | Cloudflare | Bun | Node |
|---|---|---|---|
| DocStore | DO SQLite (`docstore-cf-do`, default), D1 (`docstore-cf-d1`), Hyperdrive→Postgres (`docstore-cf-hyperdrive`) | `docstore-bun-sqlite` | `docstore-node-sqlite`, or `better-sqlite3` (Electron) |
| BlobStore | R2 (`blobstore-cf-r2`) | FS (`blobstore-bun-fs`), S3 (`blobstore-bun-s3`) | FS (`blobstore-node-fs`), S3 |
| Vectors | Basic (in-adapter) or external via custom | Basic (FTS5 + brute-force) | Basic |

Tauri adds `@concavejs/docstore-tauri-sql` (with busy-retry for SQLite contention and
schema versioning for forward/backward compat).

### Why this keeps the engine portable

- **One contract, many backends.** Core only ever calls `DocStore`/`BlobStore`. D1 vs DO
  SQLite vs Postgres-via-Hyperdrive vs bun:sqlite are interchangeable; the schema is the
  same across all, only data migration differs.
- **Search/vector live *in the adapter*.** FTS5 and brute-force cosine ship in the
  built-in SQLite adapters; to scale vectors you implement one method (`vectorSearch`) in
  a custom DocStore that calls Pinecone/TurboPuffer/pgvector — the engine is unchanged.
  Same pattern for DynamoDB or any other backend.
- **Adapters are injected as factories.** `docstore: ({ runtime }) => new SqliteDocStore(...)`,
  `blobstore: () => new FsBlobStore(...)`. On Cloudflare the factories receive
  `{ state: DurableObjectState, env, instance }` so a DO can build a DocStore bound to its
  own storage.
- **`reads: "replica"`** is a storage-level knob (CF) to serve reads from replicas.

The docs explicitly point at the SQLite adapters as the **most complete reference**
implementation (they include FTS and vector search) for anyone writing a custom docstore.

## 5. Realtime / sync mechanism

concave re-implements **Convex's exact sync protocol**, so a stock `ConvexReactClient`
gets realtime updates by connecting to `/sync` (WebSocket). The mechanism is
**range-based selective invalidation**, split across two roles:

- **ConcaveDO (execution/transactor):** executes the mutation, **computes read/write
  ranges**, commits to DocStore, then notifies SyncDO of the affected ranges (written
  ranges, written tables, commit timestamp).
- **SyncDO (subscriptions):** owns the client WebSockets; tracks which **read ranges**
  each subscribed query depends on; on a write notification, **compares write ranges
  against subscription read ranges** and pushes invalidations only to queries whose reads
  actually overlap the writes.

```
Client ←WebSocket→ SyncDO ←→ ConcaveDO ←→ DocStore
```

This is the important correctness property the docs stress repeatedly: **invalidation is
range-based, not table-based**, so a mutation only re-fires the queries it genuinely
affects. Query results are cached per subscription (and **per-user** when the query reads
`ctx.auth`); cache is dropped on overlapping write, subscription close, or reconnect.
Reconnection auto-resubscribes and replays missed updates.

**Runtime differences:**
- **Cloudflare:** ConcaveDO and SyncDO are **Durable Objects**. SyncDO holds the
  WebSocket connections (using **WebSocket Hibernation** to keep memory/cost low), and
  multiple ConcaveDO instances coordinate *through* SyncDO. DO single-threading gives the
  serialized writer needed for OCC.
- **Bun/Node:** single-process — ConcaveDO logic runs in-process and the WebSocket server
  is built into the HTTP server; coordination is trivial (same process).

**Topology / sharding config** (`cloudflare.sync`): `topology` = `single` |
`global-auto` | `global-manual`; plus `defaultRegion` (e.g. `iad`) and
`autoShardsPerRegion`. This is the declarative front door to the scaling blueprint below.

Latency expectations: CF edge 20–100ms, self-hosted same-region 10–50ms, cross-region
50–200ms, local <10ms.

## 6. Deployment targets & cost story

The unifying idea: the **runtime/adapter pair adapts to whatever the cheapest viable
host is for a given app size**, so you never pay for more infrastructure than the
deployment shape needs.

- **Cloudflare Workers + DO (recommended, scales to global).** Requires Workers Paid
  (for DOs). Pieces: Worker (routing), DOs (ConcaveDO execution + SyncDO sync), D1 *or*
  **DO SQLite** for docs, optional R2 for files. Cost lever: **DO SQLite is the default
  and is included with Workers Paid — no separate DB bill**; move to D1 only for large
  datasets/analytics. Indicative pricing in docs: Workers $5/mo + $0.50/M req; DO
  $0.15/M req + storage; D1 $0.001/M rows read; R2 $0.015/GB. Scale-to-zero sync shards
  keep idle cost near zero.
- **Self-hosted (Railway / Fly.io / Docker / VPS).** Any host that runs a long-lived
  Bun/Node HTTP+WS server with a persistent disk for SQLite + blobs. railway.toml /
  fly.toml / Dockerfile examples provided; health check at `GET /health`. Cheapest for a
  steady single-tenant workload — one small box, no per-request billing.
- **Standalone binary (`concave build`).** Single ~60 MB self-contained executable
  bundling Bun runtime + concave core + bun:sqlite + your `convex/` code + deps
  (dashboard optional via `--no-dashboard`). Cross-compiles to linux-x64/darwin-arm64/
  windows-x64. Run `./concave-server --port --data-dir`; emits a machine-readable
  `{"ready":true,"port":...,"url":...}` JSON line on startup for parent processes.
  Zero runtime install at deploy time → cheapest/simplest ops.
- **Desktop, local-first.** Electrobun (Bun main process + system WebView, **~14 MB
  bundle, sub-50ms cold start**, bun:sqlite, no sidecar), Electron (`better-sqlite3` in
  main process), Tauri (in-webview embedded runtime, no localhost sidecar). All run the
  *same* engine as a library; data is local SQLite — effectively **$0 backend cost**.

Cost story in one line: same code, and you pick the point on the curve — free/local
desktop, single cheap box, one binary, or pay-per-request edge that scales to zero.

## 7. Scaling blueprint

The docs present a **target architecture** (explicitly a blueprint — not all turnkey
yet) that is the same shape on every platform, with a single consistent writer and a
horizontally scaled sync tier:

- **Router** — routes `/api` → transactor (single writer), `/sync` → a sync shard
  (many replicas). On CF, region selection uses `request.cf.colo` + a region map; router
  reads a cached shard map and should only consult the coordinator on cache miss.
- **Sync shards** — hold session state, subscription cache, query-result cache; **never
  write DocStore directly**; consume a **change stream** to invalidate queries. On CF:
  `SyncDO` instances named `sync/<tenant>/<region>/<shardId>`, using WebSocket
  hibernation.
- **Transactor** — the single writer per tenant/instance (`tx/<tenant>/<instance>` /
  singleton `ConcaveDO`): executes UDFs, runs OCC, commits, and **emits change events**
  (written ranges/tables, commit timestamps).
- **Change stream** — fans out write deltas to all sync shards (avoids N-way notify as
  shard count grows). CF: Queues or a DO-backed log. Fly: Postgres LISTEN/NOTIFY or Redis
  Streams. Railway: Redis Streams / Postgres NOTIFY.
- **Coordinator** — maintains the shard map + autoscaling decisions, publishing the map
  to a fast cache (CF: KV) for cheap router reads.

**Implemented CF knobs** (`@concavejs/runtime-cloud` / `@concavejs/runtime-cf`):
DO bindings `SYNC_COORDINATOR_DO`, `SYNC_DO`, `CONCAVE_DO`; optional `SYNC_SHARD_MAP_KV`;
router env (`CONCAVE_SYNC_NODE_IDS`, `..._BY_REGION`, `..._REGION_MAP`,
`..._DEFAULT_REGION`, `..._SHARD_MAP_CACHE_MS`). **Auto-shards without manual node IDs**
via `CONCAVE_SYNC_AUTO_SHARDS_PER_REGION` (+ `AUTO_SHARD_PREFIX`).

**Autoscaling envelope:** profile (`minimal`/`advanced`/`custom`), scale-to-zero,
min/max shards per region, target sessions / message-rate / notify-rate / CPU / memory
per shard, scale up/down cooldowns, hysteresis ratios, max step, node-stale ms. Sync
shards report `activeSessions` (plus message/notify rates, optional CPU/mem) to the
coordinator; the coordinator computes `desired` shard count per region, clamps to
min..max, and guards with hysteresis/cooldown/max-step to avoid thrash. **Draining
shards stay in `notifyShards`** until their sessions hit zero, so existing clients keep
getting invalidations during scale-down; scale-to-zero is allowed only when
`SYNC_COORDINATOR_DO` is bound (so notify fanout can rebuild from live reports). On CF,
"spin up" is just *routing to a new DO name*; "spin down" is ceasing new routing and
letting sessions close. Observability: `GET /shard-map` on the coordinator returns
`autoscale` metadata (desired state per region + guard diagnostics).

**Guardrails (all platforms):** keep the transactor the single writer per tenant; sync
shards never touch DocStore; isolated UDFs syscall back to the transactor for storage;
**invalidation must be read/write-range based, not table-only**; shard-map reads must be
cheap.

## 8. Developer experience (DX)

- **Fast path:** `npm i -g @concavejs/cli` → `concave init` (scaffolds `convex/` +
  starter fn) → `concave dev` (Bun by default) → dashboard at `/_dashboard` → `concave
  deploy`.
- **CLI:** `init`, `dev` (`--bun`/`--node`/`--cf`, `--port`), `codegen`
  (runtime-analysis or `--static`), `run <fn> [jsonArgs]` (`--url` to target a server),
  `data [table] [--limit]`, `deploy` (`--env`, `--name`, `--dry-run`, `--force`),
  `build` (standalone binary), `components` (experimental).
- **Local dashboard** (`/_dashboard`): data browser (view/filter/edit docs — edits are
  real mutations), function runner (queries/mutations/actions with JSON args), schema
  viewer, system info. **Dev-only, unauthenticated** — docs strongly warn not to expose
  it in prod (block the route / exclude assets).
- **DevTools overlay** (`@concavejs/devtools`, Vite plugin auto-injects in dev / excludes
  in prod): Activity (unified ops with status/duration, searchable by path/args/results/
  logs), Subscriptions, Performance (latency percentiles, slowest ops), Logs, Errors.
  Toggle `Cmd/Ctrl+Shift+D`. Web only.
- **Local data** in `./.concave/local/` (SQLite + files); config in `.concave/`.
- **Testing:** `convex-test` for fast unit tests (in-memory), plus E2E against a real
  concave server via `ConvexHttpClient`, including a parametrized **cross-runtime** test
  harness and CI examples.
- **Config:** optional `concave.config.ts` (typed `ConcaveConfig`) — server (port/ip/
  workerEntry), CF (compatibilityDate/flags, deploy/storage/execution/sync), `vars`.
  Or use it programmatically as a library (`createConcave` / `defineConcaveRuntime`).

The headline DX win: **a Convex developer needs to learn essentially nothing new** — same
functions, same client, same schema — they only gain CLI/deploy verbs and the ability to
self-host.

## 9. The ONE transferable idea

**Push MVCC + OCC down into a narrow, timestamp-aware storage interface (`DocStore`), and
treat realtime sync as range-overlap detection over that interface — then every backend
and every host is just a different adapter pair behind the same engine.**

Why it's the thing to borrow: the entire "deploy anywhere at low cost" story falls out of
one design decision. Because reads carry a `readTimestamp`, writes expose
`previous_revisions`, and the engine tracks read/write *ranges* (not whole tables),
concave gets Convex's snapshot-consistent reactive semantics on top of *any* store that
can do an ordered, point-in-time range scan — SQLite, D1, DO storage, or Postgres. The
sync tier never needs to understand storage at all; it only compares read ranges to write
ranges. That single abstraction is what lets the *same* core run unchanged from a 14 MB
desktop app to an autoscaling edge fleet. If you're building a portable reactive backend,
this is the load-bearing idea: **define consistency at the interface boundary, make
invalidation range-based, and keep storage/transport/execution as swappable adapters.**

## 10. Weaknesses / gaps / things to avoid

- **The scaling blueprint is aspirational.** The docs explicitly say it "is a blueprint,
  not a guarantee that every piece is shipped." Router/coordinator/change-stream wiring is
  partly pseudocode ("not a current exported API"); only the CF autoscale knobs are marked
  implemented. Don't assume turnkey multi-region.
- **Self-hosted Bun/Node is single-instance only.** SQLite needs exclusive file access;
  WebSocket state is per-server; no horizontal scaling and no connection load-balancing.
  Multi-node self-hosting requires a custom Postgres-backed DocStore that doesn't ship.
- **Vector search doesn't scale.** Built-in = exact brute-force, O(n), ~10k vectors max;
  anything real needs a custom adapter + external vector DB.
- **Feature gaps vs Convex:** Crons (Planned), Components (stub/not supported), Convex
  Auth (not supported — must use Clerk/Auth0/OIDC), streaming exports (not supported).
  Migrating off Convex Auth means migrating users first.
- **Desktop/local-first caveats:** single instance, **no cloud sync** ("future feature")
  — so local-first apps can't yet roam across devices.
- **Operational sharp edges:** dashboard is unauthenticated full-DB access (must be
  blocked in prod); Bun dev binds `0.0.0.0` by default (LAN-exposed); Node needs 22.5+ and
  experimental flags; CF requires the Paid plan for DOs; standalone binary is ~60 MB.
- **Project risk:** the original concave.dev author is gone; the docs are effectively the
  only surviving artifact, and the `/docs/enduser/` mirror has already been rebranded to
  "Stackbase," so naming/package paths (`@concavejs/*` vs `@stackbase/*`) are in flux.

## 11. Sources

- **Primary:** `/.reference/concave-docs-raw/llms-full.txt` (full scraped docs, 3283
  lines). Sections used:
  - Configuration & Extensibility — config schema, `ConcaveOptions` /
    `ConcaveCfRuntimeOptions`, `DocStore`/`BlobStore` interfaces, adapter reference table
    (L8–280).
  - Desktop: Electrobun (L282–476), Electron (L703–889), Tauri (L1088–1232).
  - Cloudflare deploy + cost tables + execution/Worker Loader (L479–700).
  - Self-Hosted Railway/Fly/Docker + scaling limits (L891–1085).
  - Standalone Binary (L1235–1419).
  - Scaling Blueprint — router/sync/transactor/coordinator/change-stream, CF autoscale
    knobs (L1422–1643).
  - Quickstart / CLI (L1646–1746), DevTools (L1749–1927), Dashboard (L1930–2059),
    Dev Server (L2062–2199).
  - Realtime & Sync — ConcaveDO/SyncDO, range invalidation, latency (L2202–2343).
  - Data Storage & Search — adapter matrices, FTS5, vector limits (L2346–2518).
  - Authentication (L2521–2594), Testing (L2597–2797), Backend Functions / determinism
    (L2800–2925), Schema (L2928–2997), Convex Compatibility matrix (L3000–3126), API
    Compatibility (L3129–3283).
- **Secondary:** `/docs/enduser/` rebranded mirror (`Stackbase`/`@stackbase/*`) —
  confirmed identical structure; `configure/configuration.md`, `deploy/cloudflare.md`,
  `deploy/scaling.md`, `build/data-search.md`, `reference/api.md`.
