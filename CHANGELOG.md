# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Public releases are versioned from `0.1.0` (the first npm publish). Entries below
`0.1.0` predate publication and used an internal milestone numbering (`1.x`);
they are kept as development history.

## [0.1.1] — 2026-07-22

- `@helipod/cli` exposes a `./bin` subpath export so the `helipod` umbrella
  package can ship the CLI as its own `helipod` command.

## [0.1.0] — 2026-07-21

**Initial public release.** The whole platform, published to npm:

- **`helipod`** — the one-package install: client SDK (`helipod`), React hooks
  (`helipod/react`), server function authoring (`helipod/server`), schema +
  validators (`helipod/values`), component composition (`helipod/config`), and
  the `helipod` CLI (`dev`, `serve`, `deploy`, `build`, `migrate`).
- **Components** (opt-in): `@helipod/auth` (OAuth, passkeys, TOTP MFA, email
  flows), `@helipod/scheduler` (scheduled functions + crons),
  `@helipod/workflow` (durable workflows with saga compensation),
  `@helipod/triggers`, `@helipod/notifications`, `@helipod/authz`.
- **Enterprise** (source-available, commercial license, free in this phase):
  `@helipod/fleet` (multi-node scale-out), `@helipod/objectstore-substrate`,
  `@helipod/runtime-cloudflare-shard`.
- Engine internals published as `@helipod/*` (storage adapters for SQLite,
  Postgres, Cloudflare D1/DO; MVCC transactor; reactive sync; executor;
  file storage; offline outbox).

## [1.7.0] — 2026-06-06

**Postgres read performance and a native Bun.SQL client.** The Postgres adapter's
read path now streams, and a second driver — Bun's native `Bun.SQL` — ships as the
default client under the Bun runtime. Both live entirely beneath the `DocStore` seam:
the engine is unchanged, and a SQLite deployment is byte-identical to before.
Validated end-to-end against real PostgreSQL 16.

### Added

- **Streaming `index_scan` for Postgres** (`@helipod/docstore-postgres`, default-on; kill switch `HELIPOD_PG_STREAM=0`). Paginated/limited reads (`paginate`, `.take(n)`, `.first()`) now stream from a server-side cursor that stops fetching the moment the query engine breaks early, instead of materializing the whole index range — measured **−92% p50 wall-clock and ≈1000× fewer rows fetched** at 100k rows on the paginated shape (PGlite substrate; the win is work-avoided, not just transfer). `NodePgClient` streams via `pg-cursor` over a bounded read-connection pool; the cursor is non-holdable/lazy with adaptive `FETCH` batching (64→2048). Reactivity is unchanged — the recorded read-set already tracked loop consumption, not fetch. A client without cursor support transparently falls back to buffered reads, so results are always identical (proven by running the full docstore conformance suite over both the streaming and buffered paths).
- **Native Bun.SQL Postgres client** (`BunSqlClient`, selected automatically under the Bun runtime; `NodePgClient`/`pg` stays the client on Node). ≈10–17% faster per query on a local server, a per-query constant that applies to every query. Implements the full `PgClient` seam: pinned-connection single-writer advisory lock, per-shard commit connections + two-int shard advisory locks (fleet), a bounded stream-reservation pool, and `queryStream` (built on `DECLARE`/`FETCH`, since Bun.SQL exposes no native cursor API). Type-codec parity with `pg`: `bigint: true` for int8 columns, bytea → `Uint8Array`, and SQLSTATE re-tagged from Bun.SQL's `.errno` onto `.code` so the shared duplicate-object race-swallow works. `helipod serve`'s fleet shard-count probe and `fleet reshard` also select it under Bun.

### Fixed

- **Read-pool waiter starvation** — a released read connection is now handed directly to the oldest queued waiter (FIFO) instead of returned to idle where a fresh caller could steal it in the microtask gap; pooled read connections also apply `statement_timeout`/`idle_in_transaction_session_timeout` so a runaway scan can't pin a pool slot indefinitely.
- **`BunSqlClient.close()` shutdown hang** — an in-flight `queryStream` reservation is now tracked and force-released on `close()`, so graceful shutdown can't block indefinitely on `sql.end()`.
- **Real-Postgres conformance isolation** — the docstore conformance suite's per-test reset now truncates the Receipted-Outbox tables (`client_mutations`/`client_floors`) too. Their omission had let state accumulate across tests on a persistent server, breaking the table-wide `sweepExpiredClientMutations`/`pruneClientMutations` count assertions — surfaced the first time the suite ran against a real PostgreSQL server rather than in-process PGlite (the production reaper code was correct).

## [1.6.0] — 2026-06-06

**Cloudflare deployment tier — validated on real Cloudflare.** Helipod now runs
natively on Cloudflare's Durable-Object platform, from a single global DO up to a
multi-shard fleet with a shared global table in D1. The tier was built as a seam
(the engine never learns it's on Cloudflare) across the preceding week; this
release is the point at which all three tiers were **deployed to and proven on
real Cloudflare**, not just the local `workerd`/miniflare emulator.

### Added

- **Durable-Object-native host** (`@helipod/runtime-cloudflare`). A `HelipodDurableObject` co-locates the single-writer transactor, storage, WebSockets, and the subscription index in one DO. Storage is `@helipod/docstore-do-sqlite` (`DoSqliteAdapter` over `ctx.storage.sql`, full docstore-conformance parity); file storage is `@helipod/blobstore-r2` (a Workers-safe R2 `BlobStore`, wired into `ctx.storage`). A `RuntimeHost` seam extracted the serve/single-writer/wake/storage responsibilities out of the CLI with zero behavior change, so the same engine hosts on a process or a DO. Includes a portable⇄DO-native data-migration tool (dump codec + admin endpoints + CLI).
- **Multi-shard writers** (`@helipod/runtime-cloudflare-shard`, EE). `.shardBy(key)` routes each key to its own DO (one single-threaded writer + 10 GB DO-SQLite each) via a stateless router — `"key"` mode (one DO per key value) or `"hash"` mode (fixed-N jump-hash). Geographic `locationHint` placement. Write throughput and storage both scale with the number of active shard keys.
- **Global tables in Cloudflare D1** (`@helipod/docstore-d1` + `.global()` schema mode). A `.global()` table lives in one shared D1 database, readable and writable from every shard-DO — write-through with read-your-own-writes, an additive-only unique-index gate, and a co-write guard (a single mutation cannot write both a sharded and a global table). Global reactivity is poll-based (an alarm-driven poller over a `_global_versions` counter); a push/CDC upgrade is deferred.
- **Cross-shard `fanOut` reads** (M2d). An opt-in, non-reactive, HTTP-only query (`POST /api/run?fanout=1`) that reads a sharded table across every shard of a fixed-shard-count (`"hash"`) deployment and concatenates the results, with bounded concurrency, a per-shard timeout, and failures-as-data (`partial.failedShards`). Read-only by construction: a mutation or action sent to the fan-out is rejected (`FANOUT_NOT_A_QUERY`), and a total-failure fan-out returns 502 rather than masking auth/outage as an empty result.
- **Turnkey `cloudflare` deploy target** (`helipod deploy --target cloudflare`). Reconciles `wrangler.jsonc` bindings (DO + `new_sqlite_classes` migration + `nodejs_compat`, optional R2) and shells `wrangler deploy`; never bundles a provider SDK.

### Validated

- **All three Cloudflare tiers proven on a real deployment** (not the emulator), each via a committed deploy rig + E2E:
  - **Single-DO host** — in-CF write latency **155.7 ms** (vs ≈1500 ms for the container→R2 WAN path), reactive push across a real DO, real-R2 file storage with `Range` support, persistence across requests.
  - **Multi-shard scale-out** — shard isolation, shard-scoped reactivity (no cross-shard wake), and **20 concurrent commits to 20 distinct shard-DOs in ~1.4 s**.
  - **Multi-shard + `.global()`/D1 composed** (a first) — a `.global()` row written through one shard-DO is read back through another (shared D1, read-your-writes across shards), and the D1 unique index is enforced across shard boundaries. New rig at `ee/packages/runtime-cloudflare-shard/rig-d1/`.

### Fixed

- **`fanOut` read-only enforcement** — the guard now permits only `query` functions to fan out and fails closed when a function's type can't be classified, closing a hole where a non-sharded mutation or an action sent with `?fanout=1` would have been committed on every shard (N-way write/side-effect amplification).
- **Shard deploy-E2E assertion** — the multi-shard rig's E2E expected the pre-M2d `CROSS_SHARD_UNSUPPORTED`; a mode-`"key"` `?fanout=1` now correctly returns `FANOUT_REQUIRES_FIXED_SHARDS` (caught by the first real-Cloudflare run of the rig).

## [1.5.0] — 2026-05-15

Authentication hardening and notification delivery. `@helipod/auth` gains TOTP
two-factor and passkeys/WebAuthn; `@helipod/notifications` gains multi-provider
fallback and a mobile/web push channel. All four are **opt-in** and
backward-compatible — a deployment that configures none is byte-identical to
before. Each shipped through an adversarial whole-branch security review.

### Added

- **TOTP two-factor authentication** (`@helipod/auth`, opt-in via `defineAuth({ mfa })`). RFC 6238 TOTP (Google Authenticator/Authy/1Password/…) with one-time recovery codes. The TOTP secret is **AES-256-GCM-encrypted at rest** (AAD-bound to the user id; recoverable because verification must recompute the code — unlike the one-way-hashed session tokens/email codes), under a keyring sourced from the environment with fail-fast validation. Enrollment is two-phase (`startMfaEnrollment` → `confirmMfaEnrollment` proving a live code, so a user can't lock themselves out mid-setup). Every first-factor path (password, magic-link, OTP, email verification, password reset, and OAuth/JWT sign-in) routes through one `finishSignIn` interposition that returns `{ mfaRequired, pendingToken, expiresAt }` instead of a session; `completeMfaSignIn` (a live TOTP **or** a recovery code) then mints. `disableMfa`/`regenerateRecoveryCodes` require a fresh second factor (proof of possession, so a stolen live token can't strip 2FA). `finishSignIn` never replaces the `mintSession` chokepoint — a static-source guard test fails CI if a gated site ever mints directly.
- **Passkeys / WebAuthn** (`@helipod/auth`, opt-in via `defineAuth({ passkeys })`). Phishing-resistant passwordless sign-in (Face ID / Touch ID / Windows Hello / security keys / synced platform passkeys). Registration attestation + authentication assertion run behind the sole `@simplewebauthn/server` seam, with all crypto confined to actions (the transactor stays crypto-free). Usernameless (discoverable) **and** email-scoped sign-in; anonymous-then-register is a passwordless-bootstrap path. Atomic signature-counter **clone detection** (a regressed/repeated counter is rejected with no mint and no state change), consume-before-validate single-use challenges, per-user credential limit, and anti-enumeration (an unknown email's `begin` is byte-shaped like a known one; every failure is one generic message). Reactive device management — `listPasskeys`/`renamePasskey`/`revokePasskey` (display metadata only; the public key and counter never leave the server). Client recipe uses `@simplewebauthn/browser` + `client.action(...)`.
- **Multi-provider fallback for notifications** (`@helipod/notifications`). An email/SMS channel can configure `fallbacks: Provider[]` alongside its `provider`. Within **one** delivery attempt, `deliverOutbound` walks the ordered `[provider, ...fallbacks]` list and succeeds on the first provider that works; only an all-fail attempt fails, re-entering the unchanged retry/backoff/dead-letter path (its `retryable` verdict is the OR across every tried provider). The inbound delivery webhook tries every configured provider's `verify()` in order (first match wins; only the primary receives the channel-level `webhookSecret`, each fallback carries its own signing material). One additive `messages.providerName` field; zero behavior change when no fallbacks are set.
- **Push channel for notifications** (`@helipod/notifications`). A fourth `"push"` channel plugging into the same `recordSend` chokepoint, driver, retry/backoff, and preferences/critical-bypass/topics machinery as email/SMS/in-app. A **self-only** device-token registry (`registerPushToken`/`unregisterPushToken` resolve the subject from the caller, never a `userId` arg); a send snapshots the server-chosen recipient's tokens, groups them by provider, fans out, and prunes tokens a provider reports permanently invalid. Three adapters on the `PushProvider` seam: `expoPush` (chunked batch), `fcmPush` (service-account OAuth2 + cached access token), and `apnsPush` (ES256 JWT via `jose`, over `node:http2` — Apple's provider API is HTTP/2-only). Per-user push preferences honored with the same critical-bypass as other channels. Additive schema (`pushTokens` table; `messages.tokens`).

### Security

- **A passkey cannot bypass an enrolled second factor.** Passkey authentication mints through the same `finishSignIn` gate as every other first factor, so an MFA-enrolled user still completes TOTP after a passkey sign-in (passkeys and MFA were designed in parallel; routing the mint through the shared chokepoint closes the interaction gap). A client-supplied non-string WebAuthn `userHandle` is folded into the one generic reject rather than throwing a distinct error (no credential-existence oracle).
- **The notification delivery webhook fails closed.** It writes only after a provider's signature verifies, 401s before any write when none do, and treats a provider `verify()` that *throws* (rather than returning false) as "did not verify" — so a misbehaving provider can't 500 the endpoint or let one fallback's throw swallow another's legitimately-signed callback.
- **Push delivery never silently strands a device.** Because push provider groups are disjoint device sets (unlike email/SMS fallback alternates), a retryable failure in any group re-queues the whole message rather than marking it sent on a partial success; permanently-invalid tokens are pruned even on a failed attempt, and device tokens are cleared from terminal message rows.

## [1.4.0] — 2025-12-25

### Changed

- **Group commit now defaults ON for single-node Postgres deployments** (OFF for SQLite). `HELIPOD_GROUP_COMMIT` still overrides either direction. Group commit batches concurrent commits into one fsync: benchmarked as a **+39% (8 clients) to +58% (64 clients)** write-throughput win on real containerized Postgres — with lower p50 latency and *byte-identical* latency at 1 client (the opportunistic "batch of 1 when idle" design adds no wait), so there is no low-traffic regression. It stays off on CPU-bound SQLite, where batching is pure overhead (~−8%). Refines Fleet B4's single global 2× auto-enable gate (which missed at 1.63× and shipped dark-off) into the correct store-conditional default. See `docs/dev/research/writes-benchmark.md`.

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

- **`@helipod/docstore-sqlite`** (zero-config default) and **`@helipod/docstore-postgres`** (`pg` driver, `pg_advisory_lock` single-writer, no app-schema migrations), selected via `--database-url`/`HELIPOD_DATABASE_URL`. Behavioral parity via a shared conformance suite.
- **File storage** (`@helipod/storage`): `_storage` system table + `ctx.storage`, two-phase proxied (FS) / presigned (S3) uploads behind a `BlobStore` seam (`@helipod/blobstore-fs`, `@helipod/blobstore-s3`), private-by-default HMAC capability URLs, background orphan reaper, Range requests.

### Functions

- **Queries / mutations** with typed args validators and inferred handler types.
- **Actions** — run outside the transaction (native `fetch`/`Date`/`Math.random`, no `ctx.db`), callable from the client, scheduler, other functions, and `POST /api/run`.
- **`httpAction` + HTTP router** — `http.ts` webhook endpoints (`Request`→`Response`) at Convex-parity paths, with reserved-path guards.

### Scheduling, workflows, triggers (opt-in components)

- **`@helipod/scheduler`** — `runAfter`/`runAt`/`cancel`, `cronJobs()` with catch-up policies, retries/backoff, cascading cancel, on a recurring **driver** seam.
- **`@helipod/workflow`** — durable multi-step workflows via deterministic replay over a `workflows`/`steps`/`events` journal; `step.run*`/`sleep`/`waitForEvent`, `Promise.all` fan-out, a live `workflow:status` query, and **saga/compensation** (reverse-order unwind, halt-on-failed-compensation, cancel-compensates).
- **`@helipod/triggers`** — durable cursor over the MVCC log (missed changes impossible by construction), at-least-once in-order per-document delivery, self-pause + circuit breaker.

### Client SDK

- **`useQuery`/`useMutation`/`useAction`**, framework-agnostic core + React hooks.
- **Optimistic updates** — `withOptimisticUpdate`, the "Gated Ledger" no-flicker reconciliation (drop-on-observed-inclusion), deterministic temp ids/timestamps.
- **Durable offline sync (the Receipted Outbox)** — `indexedDBOutbox()`/`fsOutbox()`/`memoryOutbox()`, per-`(identity, clientId, seq)` receipts atomic with commit, FIFO drain, reload/crash survival, poison-pill policy, full observability, multi-tab safety, cross-tab live rendering, Background-Sync headless drain, and client-supplied ids (`mintId`) for offline create-then-reference chains.
- **Reconnect resume** — content-fingerprinted subscriptions; an unchanged re-run answers with a tiny `QueryUnchanged` marker (~99% less reconnect bandwidth).

### Deploy & operations

- **`helipod dev`** — watch + codegen + hot reload + serve sync/HTTP/dashboard.
- **`helipod serve`** — production entrypoint (required admin key, `0.0.0.0`, graceful shutdown), working **Docker `docker compose up`** self-host, key-less dashboard.
- **`helipod deploy`** — opt-in push-based live hot-swap of functions + additive-only schema onto a running `serve`, atomic swap.
- **`helipod build`** — single self-contained executable via `bun build --compile`, cross-compile targets, `{"ready":…}` startup line.
- **`helipod migrate`** — Convex-first on-ramp (import codemod + divergence report).
- **Dashboard** (`apps/dashboard`) — live data browser (admin sync subscriptions, cursor pagination, structured filters), logs viewer, function runner.

### Tiered scale-out (Tier 2, `ee/@helipod/fleet`)

- Multi-node **fleet** with store-as-coordinator leases and failover; embedded read replicas (RYOW); **write sharding** on the Fenced Frontier protocol (per-shard OCC, rendezvous balancing, epoch fencing, hybrid nodes, group-commit escape hatch).

### Reactive-path optimizations (Differential Log-Tail Reactivity)

- **DLR Stage 1** — interval-indexed subscription matcher: `findAffectedByRanges` goes O(N) linear scan → per-keyspace augmented interval tree, O(log N + k). Measured: `fanout-selective-10000` propagation p50 6.72 ms → 0.24 ms (−96%).
- **DLR Stage 2a** — by-id `QueryDiff` pipeline skeleton: a `db.get(id)` subscription receives incremental row-diffs instead of full re-sends, with a client materialized cache and drift-checksum self-heal.

### Tooling & DX

- **Codegen** — typed `Doc`/`Id`/`api`, args + returns validators driving the typed client.
- **`@helipod/test`** — Layer-1 `createTestHelipod` over the real engine + a conformance suite.
- **`@helipod/bench`** — reactive benchmark harness (`bun run bench:reactive`/`bench:compare`).

[1.5.0]: https://example.com/releases/tag/v1.5.0
[1.4.0]: https://example.com/releases/tag/v1.4.0
[1.3.0]: https://example.com/releases/tag/v1.3.0
[1.2.0]: https://example.com/releases/tag/v1.2.0
[1.1.0]: https://example.com/releases/tag/v1.1.0
[1.0.0]: https://example.com/releases/tag/v1.0.0
