# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.4.0] — 2025-12-25

### Changed

- **Group commit now defaults ON for single-node Postgres deployments** (OFF for SQLite). `STACKBASE_GROUP_COMMIT` still overrides either direction. Group commit batches concurrent commits into one fsync: benchmarked as a **+39% (8 clients) to +58% (64 clients)** write-throughput win on real containerized Postgres — with lower p50 latency and *byte-identical* latency at 1 client (the opportunistic "batch of 1 when idle" design adds no wait), so there is no low-traffic regression. It stays off on CPU-bound SQLite, where batching is pure overhead (~−8%). Refines Fleet B4's single global 2× auto-enable gate (which missed at 1.63× and shipped dark-off) into the correct store-conditional default. See `docs/dev/research/writes-benchmark.md`.

### Added

- **`bun run bench:writes`** — a write/commit-throughput benchmark axis (`--axis writes`): commit latency + throughput at 1/8/64 concurrent writers, contended read-modify-write (OCC) cost, and group-commit OFF-vs-ON, over SQLite and Postgres. Surfaced that write throughput is single-writer-bound (flat across concurrency; scale by sharding, not threads) and that Postgres is fsync-bound — the ceiling the reactive-path optimizations can't move.

## [1.3.0] — 2025-12-25

**DLR Stage 3 — compute-saving reconnect resume.** Reconnect resume now saves
server CPU, not just bandwidth: when the server can prove a subscribed query's
result is unchanged since the client last saw it, it answers `QueryUnchanged`
**without re-executing the query handler**. Before this, every subscribed query
was fully re-run and re-hashed on reconnect (only the bandwidth half of
"fast-resume" had shipped); this closes the compute half.

### Added

- **Scalar `sinceTs` resume checkpoint.** On reconnect, the client stamps each resubscribe with `sinceTs` = its max observed commit ts (`resync()`); a fresh subscribe carries none. Captured before the session's observed frontier is reset on close, so it always reflects the client's true frontier.
- **Server-side `ResumeRegistry`** (`packages/sync`): a per-`(identity, path, args)` registry of `{readRanges, tables, lastInvalidatedTs, wasDiffable}` over the Stage-1 interval index. `advanceOnCommit` advances `lastInvalidatedTs` on every intersecting commit — **including for entries with no live subscriber** (released entries stay indexed for a 60s TTL), so a write during a client's disconnect gap is never missed. Mirrors `SubscriptionManager.findAffectedByRanges` exactly.
- **The reconnect compute-skip.** On a resubscribe carrying `sinceTs`, a RERUN (non-diffable) query whose `entry.lastInvalidatedTs <= sinceTs` is registered from the retained read-set and answered `QueryUnchanged` with **no `execSub`**. A missing entry (TTL-evicted), `lastInvalidatedTs > sinceTs`, or a diffable sub (which keeps its own fingerprint/QueryDiff resume) all fall through to a normal re-run — conservative by construction.
- `bench:reactive` gains a **`resume-compute`** A/B scenario: N=50 RERUN subscriptions, reconnect re-executions with the skip **ON = 0** vs **OFF = 50** (`reExecsSaved = 50`); a partial-change variant (1 of N touched during the gap) re-executes **exactly 1**.

### Fixed

- **The registry read-set stays in lockstep with live re-runs.** A data-dependent query whose read-set shifts on a live re-run (e.g. `get(user)` then a range keyed on `user.currentRoom`) previously left the registry indexing the *subscribe-time* ranges; a gap write to the *new* range was then missed → a wrong skip → silent stale data. The re-run path (`sendSessionTransition`) now re-upserts the registry with the fresh read-set. (Whole-branch review Critical.)
- **`SetAuth` re-keys the registry entry** to the new identity (release old, retain+upsert new), maintaining the invariant that a subscription's registry key always matches the identity its read-set was produced under — so a reconnect under the new identity finds the migrated entry, and one under the old identity misses and re-runs.
- **`sinceTs` no longer resets to 0 on a real reconnect** — the client snapshots its observed frontier before `closeSession()` clears it (the feature was a silent no-op on genuine reconnects before this).
- **Registry entries are released by the subscription's stored key**, not a key re-derived from the possibly-`SetAuth`-mutated `session.identity` (which would leak the entry). The registry is also swept on the idle timer, not only on commit.

### Boundaries

- Single-node only: the registry is per-node in-memory, so a cross-node reconnect in a fleet finds no entry and safely re-runs. Fleet per-shard resume fragments remain a future DLR stage.

## [1.2.0] — 2025-12-25

**DLR Stage 2c — the key-range-pinned pagination differ.** The third and final
query-shape slice of Differential Log-Tail Reactivity: a `.paginate()` query's
page now receives incremental row diffs instead of a full re-send.

### Added

- **Incremental `QueryDiff`s for `.paginate()` subscriptions.** After the initial load, a page is pinned to its `[startBound, endBound)` key interval and reactively diffed as a fixed two-sided-bound `DIFFABLE` query — **reusing the Stage 2b range differ verbatim**. This dissolves the count-bounded "pull-in" problem: every write (insert/edit/delete/move) diffs with zero store reads. The page's row count drifts from its initial `pageSize` under live edits (correct reactive semantics — new items appear, deleted items vanish; the boundary stays put so page N+1 stays contiguous). Reference-grounded in Convex's `(cursor, continueCursor]` key-bounded pages and this project's own "known boundary keys" DLR design.
- **Object-return passthrough by identity** — the `PaginationResult` object is brand-checked (extending Stage 2b's collect-array brand), so a handler that post-processes the result (`.page`, `{...result}`, a mapped page), reads twice, uses a read policy, or hits a `maxScan` cap falls back to RERUN.
- Only `.page` diffs; `nextCursor`/`hasMore`/`scanCapped` are pinned at load and never re-sent. Resume via `QueryUnchanged` works over the whole `PaginationResult`.

### Fixed

- **Descending page bounds** — the page's key interval is now computed correctly for `order:"desc"` (previously an asc-only formula covered *none* of a desc page's rows → missed invalidation). The query engine owns the bound math per order.
- **`scanCapped` pages decline to RERUN** — a `maxScan`-truncated page has an un-owned bounds gap, so it is no longer classified diffable (silent-wrong-data guard, mirroring `.take()`/limit).

### Performance

- `bench:reactive` gains a **`diffbytes-paginate`** scenario: **475 B/update** (a ~20-row full-page re-send was ~2.6 KB), matching `diffbytes-scan` — the per-update cost is proportional to the change, not the page size. No regression on other scenarios.

### Deferred

- Page rebalancing (`splitCursor`) for an unboundedly-growing page, and later DLR stages (Stage 3 log-tail catch-up, Stage 4 optimistic-over-diffs, Stage 5 fleet per-shard fragments).

## [1.1.0] — 2025-12-25

**DLR Stage 2b — the single-index-range `collect()` differ.** The second stage of
Differential Log-Tail Reactivity: list subscriptions now receive incremental row
diffs instead of a full re-send on every write.

### Added

- **Incremental `QueryDiff`s for single-index-range `collect()` subscriptions.** A `.eq(...).collect()` query (with optional declarative `.where()` filters) whose result the handler returns unmodified is classified `DIFFABLE_RANGE`; on each committed write the server derives an `add`/`edit`/`remove`/`move` row diff **from the commit's written docs with no store re-read** and sends just the diff. Requires the client to advertise `supportsQueryDiff`; the diff engages under single-node sharding (the flagship `examples/chat` gets it).
- **`orderKey` on the row-diff vocabulary** — the engine's index-entry key (`extractIndexKey`, incl. the `_creationTime`/`_id` tiebreak) rides each change; the client sorts its materialized row-map by it (`compareKeyBytes`) to reproduce `collect()` order. The drift checksum folds `orderKey` so a missed reorder/move is caught.
- **`QueryDiff` reset descriptor** (`{ mode: "byid" | "range", orderDir }`) so the client renders by-id (sole row) vs range (sorted array) and knows the sort direction.
- **DIFFABLE subscriptions resume via `QueryUnchanged`** — a diffable sub carries a content fingerprint on its reset and echoes it on reconnect; an unchanged re-run answers with the tiny `QueryUnchanged` marker instead of a full reset.
- **Executor floating-read capture** — an un-awaited query `.collect()`'s read ranges are now recorded (drain-before-snapshot), closing a latent missed-invalidation hole for all queries.

### Fixed

- **The range-diff path was unreachable in production** — the embedded runtime's `syncExecutor.runQuery` dropped the `diffableRange` classification; now forwarded (caught by an end-to-end test through the real server).
- **Response-before-Transition ordering for the diff path** — the synchronous `QueryDiff` fan-out could beat a client's own `MutationResponse`, breaking the optimistic no-flicker guarantee. Now ordered by a per-`commitTs` **microtask latch** (released on every post-commit outcome, incl. `commitThenThrow`; disconnect backstop) — robust under timer-phase starvation, where a timer-based fix deadlocked the notify pipeline.
- **Passthrough guard now proves array identity, not content** — a data-vacuous JS post-op (`slice`/`filter` that happens to be a no-op on current data) can no longer be misclassified diffable and later render permanently wrong data.
- **`SetAuth`/RERUN-fallback on a range sub** no longer leaves stale `diffRows`/`renderMode` on the client (a transient cross-identity frame); it reverts to RERUN rendering and self-heals.
- `.take()`/limit, tables with a read policy, multi-read and post-processed handlers are conservatively excluded from `DIFFABLE_RANGE` (→ RERUN).

### Performance

- `bench:reactive` **`diffbytes-scan` 2647 → 482 B/update (−82%)**; per-update wire cost is now proportional to the change, not the collection size (so the reduction grows with list size). Propagation latency unchanged (±2%). The benchmark's byte metric was corrected to measure actual inbound wire-frame bytes.

### Deferred

- Pagination-boundary diffs (Stage 2c), log-tail catch-up (Stage 3), optimistic-over-diffs (Stage 4), and fleet per-shard fragments (Stage 5) remain future DLR stages.

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

[1.4.0]: https://example.com/releases/tag/v1.4.0
[1.3.0]: https://example.com/releases/tag/v1.3.0
[1.2.0]: https://example.com/releases/tag/v1.2.0
[1.1.0]: https://example.com/releases/tag/v1.1.0
[1.0.0]: https://example.com/releases/tag/v1.0.0
