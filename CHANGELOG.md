# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0] — 2025-12-25

First tagged release. An open-source, self-hostable reactive Backend-as-a-Service:
write TypeScript query/mutation/action functions, run them server-side and
transactionally, and get **reactive** results pushed to subscribed clients over a
WebSocket. Full TypeScript end-to-end (engine, CLI, client SDK); pluggable storage;
Bun-primary with full Node support; deploy anywhere. Licensed FSL-1.1-Apache-2.0.

### Core engine & reactivity

- **MVCC document store** on an append-only log (`{ts, id, value, prev_ts}`), single-writer OCC transactor with 3-phase commit and deterministic-UDF replay on conflict.
- **Reactive subscriptions:** queries record a read-set; mutations compute a write-set; a subscription re-runs only when a committed write-set **intersects** its read-set. Range-precise invalidation.
- **Isolate-safe syscall executor** — the syscall ABI is fully serializable across a V8 isolate.
- **Query engine** with declarative index ranges (`.eq/.gt/.gte/.lt/.lte`), structured `.where()` post-filters, ordering, and cursor pagination.

### Storage (pluggable — the engine never imports a driver)

- **`@stackbase/docstore-sqlite`** (zero-config default) and **`@stackbase/docstore-postgres`** (`pg` driver, `pg_advisory_lock` single-writer, no app-schema migrations), selected via `--database-url`/`STACKBASE_DATABASE_URL`. Behavioral parity via a shared conformance suite.
- **File storage** (`@stackbase/storage`): `_storage` system table + `ctx.storage`, two-phase proxied (FS) / presigned (S3) uploads behind a `BlobStore` seam (`@stackbase/blobstore-fs`, `@stackbase/blobstore-s3`), private-by-default HMAC capability URLs, background orphan reaper, Range requests.

### Functions

- **Queries / mutations** with typed args validators and inferred handler types.
- **Actions** — run outside the transaction (native `fetch`/`Date`/`Math.random`, no `ctx.db`), callable from the client, scheduler, other functions, and `POST /api/run`.
- **`httpAction` + HTTP router** — `http.ts` webhook endpoints (`Request`→`Response`) at Convex-parity paths, with reserved-path guards.

### Scheduling, workflows, triggers (opt-in components)

- **`@stackbase/scheduler`** — `runAfter`/`runAt`/`cancel`, `cronJobs()` with catch-up policies, retries/backoff, cascading cancel, on a recurring **driver** seam.
- **`@stackbase/workflow`** — durable multi-step workflows via deterministic replay over a `workflows`/`steps`/`events` journal; `step.run*`/`sleep`/`waitForEvent`, `Promise.all` fan-out, a live `workflow:status` query, and **saga/compensation** (reverse-order unwind, halt-on-failed-compensation, cancel-compensates).
- **`@stackbase/triggers`** — durable cursor over the MVCC log (missed changes impossible by construction), at-least-once in-order per-document delivery, self-pause + circuit breaker.

### Client SDK

- **`useQuery`/`useMutation`/`useAction`**, framework-agnostic core + React hooks.
- **Optimistic updates** — `withOptimisticUpdate`, the "Gated Ledger" no-flicker reconciliation (drop-on-observed-inclusion), deterministic temp ids/timestamps.
- **Durable offline sync (the Receipted Outbox)** — `indexedDBOutbox()`/`fsOutbox()`/`memoryOutbox()`, per-`(identity, clientId, seq)` receipts atomic with commit, FIFO drain, reload/crash survival, poison-pill policy, full observability, multi-tab safety, cross-tab live rendering, Background-Sync headless drain, and client-supplied ids (`mintId`) for offline create-then-reference chains.
- **Reconnect resume** — content-fingerprinted subscriptions; an unchanged re-run answers with a tiny `QueryUnchanged` marker (~99% less reconnect bandwidth).

### Deploy & operations

- **`stackbase dev`** — watch + codegen + hot reload + serve sync/HTTP/dashboard.
- **`stackbase serve`** — production entrypoint (required admin key, `0.0.0.0`, graceful shutdown), working **Docker `docker compose up`** self-host, key-less dashboard.
- **`stackbase deploy`** — opt-in push-based live hot-swap of functions + additive-only schema onto a running `serve`, atomic swap.
- **`stackbase build`** — single self-contained executable via `bun build --compile`, cross-compile targets, `{"ready":…}` startup line.
- **`stackbase migrate`** — Convex-first on-ramp (import codemod + divergence report).
- **Dashboard** (`apps/dashboard`) — live data browser (admin sync subscriptions, cursor pagination, structured filters), logs viewer, function runner.

### Tiered scale-out (Tier 2, `ee/@stackbase/fleet`)

- Multi-node **fleet** with store-as-coordinator leases and failover; embedded read replicas (RYOW); **write sharding** on the Fenced Frontier protocol (per-shard OCC, rendezvous balancing, epoch fencing, hybrid nodes, group-commit escape hatch).

### Reactive-path optimizations (Differential Log-Tail Reactivity)

- **DLR Stage 1** — interval-indexed subscription matcher: `findAffectedByRanges` goes O(N) linear scan → per-keyspace augmented interval tree, O(log N + k). Measured: `fanout-selective-10000` propagation p50 6.72 ms → 0.24 ms (−96%).
- **DLR Stage 2a** — by-id `QueryDiff` pipeline skeleton: a `db.get(id)` subscription receives incremental row-diffs instead of full re-sends, with a client materialized cache and drift-checksum self-heal.

### Tooling & DX

- **Codegen** — typed `Doc`/`Id`/`api`, args + returns validators driving the typed client.
- **`@stackbase/test`** — Layer-1 `createTestStackbase` over the real engine + a conformance suite.
- **`@stackbase/bench`** — reactive benchmark harness (`bun run bench:reactive`/`bench:compare`).

[1.0.0]: https://example.com/releases/tag/v1.0.0
