# Fleet Slice 1 — Symmetric Nodes, Lease-Based Writer, Live Failover

**Status:** approved design (brainstormed 2025-08-28)
**Research basis:** `docs/dev/architecture/tier2-topology-research.md` (the "symmetric log-fed fleet")
**Business basis:** `docs/dev/business-model-and-licensing.md` (fleet impls → `ee/`, commercial license, no gate yet)

## Goal

The first multi-node Stackbase deployment: **N identical `stackbase serve` processes over one
shared Postgres**, where any node serves everything (queries, subscriptions, mutations, actions),
exactly one node at a time holds the writer role via a **lease acquired through the store
itself**, and killing the writer causes another node to **take over live** — no coordinator
service, no role configuration, no client changes.

Approach chosen: **staged symmetric fleet.** Sync nodes read the shared Postgres directly in
this slice; the log-tailed local embedded replica is Slice 2 — a drop-in `DocStore` swap behind
the existing seam, no protocol changes. Direct-PG reads are fine at 2–5 nodes; the replica is
the 10+-node optimization.

## Non-goals (explicitly out of scope)

Embedded local replicas (Slice 2) · write sharding / multiple writers · autoscale/topology
config · server backpressure/heartbeat controllers · query cache · live session migration ·
load-balancer tooling (docs say "point clients at any node") · fencing tokens beyond the
advisory lock's session semantics (deferred to the write-sharding slice) · client SDK changes
(none needed).

## Architecture

### 1. Node lifecycle — symmetric boot, emergent roles

- Fleet mode is opt-in: `stackbase serve --fleet` (or `STACKBASE_FLEET=1`). Requires
  `--database-url` (Postgres; SQLite + fleet is a fail-fast error) and an advertised URL
  (`--advertise-url` / `STACKBASE_ADVERTISE_URL`, e.g. `http://10.0.0.5:3210`) other nodes can
  reach this node on.
- Every node boots identically and calls the new `tryAcquireWriterLock(): Promise<boolean>`
  (non-blocking `pg_try_advisory_lock` on the existing `ADVISORY_LOCK_KEY`):
  - **true → writer:** full runtime — transactor (writes enabled), scheduler/cron/reaper
    drivers, deploy endpoint. Writes its row to `fleet_lease` (see §2).
  - **false → sync node:** serves queries + subscriptions read-only, forwards writes (§5),
    retries the lease every 2s. On acquiring it later → **promotes**: flips the store to
    writable, starts the drivers, updates `fleet_lease`.
- **Without `--fleet`, behavior is byte-for-byte today's:** second node fails fast on the lock.
  Backward compatible.
- **No demotion path.** A writer that loses its Postgres session must exit (process supervisor /
  Docker restarts it; it rejoins as a sync node). Stated limitation, keeps slice 1 correct and
  simple.
- If `--fleet` is passed but `@stackbase/fleet` (the ee package) is not installed, serve exits
  with a clear install-instruction error. Serve loads the fleet package by dynamic import so
  FSL core has no hard dependency on ee code.

### 2. The store is the coordinator — `fleet_lease`

One new table, created by fleet setup (idempotent DDL):

```sql
CREATE TABLE IF NOT EXISTS fleet_lease (
  id         int PRIMARY KEY CHECK (id = 1),
  epoch      bigint NOT NULL,          -- +1 on every acquisition (observability + cheap fencing hook)
  writer_url text   NOT NULL,          -- the advertised URL of the current lease holder
  acquired_at timestamptz NOT NULL
);
```

- On promotion the new writer upserts `{epoch: epoch+1, writer_url, acquired_at: now()}`.
- Sync nodes read `writer_url` for forwarding, cache it, and refresh on any forward failure.
- The advisory lock (session-scoped, auto-released when the holder's session dies) remains the
  *mutual exclusion*; `fleet_lease` is *discovery*. There is no other registry and no
  coordinator process.

### 3. Read-only store mode (FSL core change)

`PostgresDocStore` gains `{ readOnly?: boolean }`:
- `readOnly: true` → `setupSchema()` runs the idempotent DDL but does **not** take the writer
  lock; `write()` throws `ReadOnlyStoreError`. (Concurrent `CREATE TABLE IF NOT EXISTS` races
  are benign in PG; the writer normally wins the boot race anyway.)
- The embedded runtime gains a matching read-only role: queries/subscriptions run unchanged
  (they already read at a `readTimestamp` against the shared store — always current); the
  transactor's write path and all write-bearing drivers (scheduler, crons, storage reaper) are
  started **only on the writer**.

### 4. Reactive wake-up — advisory bus, log is truth

- **Writer side:** a fleet `WriteFanoutAdapter` wrapper publishes to the local in-memory channel
  (unchanged Tier 0 path for its own subscribers) **and** issues
  `NOTIFY stackbase_commits, '<commitTs>'` on the shared Postgres.
- **Sync-node side:** a `CommitNotifier` holds a dedicated `LISTEN stackbase_commits` connection
  plus a **1s poll fallback** (`maxTimestamp() > watermark`) so a missed NOTIFY degrades to at
  most 1s latency, never to missed updates. On wake it:
  1. reads log entries since its in-memory `watermark` from the **existing `indexes` table**
     (`SELECT index_id, key, table_id FROM indexes WHERE ts > $watermark AND ts <= $newMax`) —
     written keys per commit are already persisted, so invalidation input is **derived, not
     transmitted**;
  2. constructs a `WriteInvalidation` (point key-ranges per written index key + `writtenTables`
     from `table_id`, commit/snapshot timestamps) and calls the local `notifyWrites` — from
     there, range-precise invalidation and subscription push work exactly as today;
  3. advances `watermark`.
- NOTIFY payload is just the commit timestamp (~tens of bytes; the 8KB NOTIFY cap is irrelevant).

### 5. Write forwarding — connect to any node

- New internal endpoint on every node: `POST /_fleet/run`, bearer-authenticated with the
  deployment **admin key** (both nodes already share `STACKBASE_ADMIN_KEY`; unauthenticated →
  401 before anything runs). Body: `{ path, args, identity, kind }` (kind: mutation | action).
- A sync node receiving a client mutation/action (WS `Mutation`/`Action` message or public
  `POST /api/run`) forwards it to the current `writer_url`, threading the caller's identity
  token verbatim, and relays the result (value or error) back on the client's socket/response.
- Actions forward whole (they run on the writer in slice 1 — their inner `ctx.runMutation`
  needs the writer anyway; distributing action execution is a later optimization). Likewise a
  sync node **proxies public `httpAction` requests** (`http.ts` routes) to the writer verbatim
  and relays the raw `Response` — same reason, same admin-key-authenticated internal hop.
- Forward failure (writer down mid-failover): refresh `writer_url` from `fleet_lease`, retry
  once; if still failing, surface the error to the client (mutations are client-retryable and
  the failure window is the lease-retry interval, ~2s).
- Queries and subscriptions are **never** forwarded — every node serves them locally.

### 6. Failover walk-through

Kill the writer → its PG session dies → advisory lock auto-releases → within ≤2s a sync node's
retry acquires it → upserts `fleet_lease` (epoch+1, its URL) → promotes (store writable,
transactor + drivers start; the scheduler driver's recovery scan already handles jobs the dead
writer left mid-flight, per its at-most-once design) → other sync nodes' next forward hits the
old URL, fails, refreshes, lands on the new writer. In-flight mutations on the dead writer fail
visibly to their callers. Subscriptions on sync nodes never drop.

### 7. Package layout — the ee/ boundary

**New: `ee/packages/fleet` → `@stackbase/fleet`** (first ee package; commercial license header +
`ee/LICENSE` referencing the business doc; free to use today, no key gate):
- `LeaseManager` — try/retry/promote loop + `fleet_lease` upsert/read.
- `CommitNotifier` — writer-side NOTIFY wrapper adapter + sync-side LISTEN/poll + range
  derivation from the `indexes` table.
- `WriteForwarder` — client of `/_fleet/run` with writer-URL cache/refresh.
- `fleetNode()` — the lifecycle composition serve calls (role state machine: syncing → writer).

**FSL core changes (small seams only):**
- `docstore-postgres`: `readOnly` option, `tryAcquireWriterLock` on `PgClient` (+ PGlite no-op),
  a `listen(channel, cb)` capability on `NodePgClient`.
- `runtime-embedded`: accept an external `WriteFanoutAdapter` (already pluggable — verify),
  read-only role (skip write drivers), `promoteToWriter()` hook.
- `cli` serve: `--fleet`/`--advertise-url` parsing, dynamic import of `@stackbase/fleet`,
  `/_fleet/run` route (admin-key gated), forward-instead-of-execute branch when role=sync.
- Workspace: add `ee/*` to workspaces + turbo; root `bun run build/test` covers it.

### 8. Testing

- **Unit (PGlite/SQLite where possible):** range derivation from `indexes` rows → correct
  `WriteInvalidation`; `fleet_lease` upsert/epoch logic; forwarder URL cache/refresh/retry;
  read-only store rejects writes.
- **Ship gate — real E2E** (`ee/packages/fleet/test/fleet-e2e.test.ts`, Docker-gated like
  `postgres-e2e.test.ts`, per [[e2e-through-shipped-entrypoint]]): `postgres:16` container +
  **two real `stackbase serve --fleet` processes**:
  1. subscribe on node B → mutate **via node B** (forwarded to A) → value commits and the
     reactive push lands on B's subscription;
  2. **kill A** → B promotes (observe `fleet_lease.epoch` bump) → mutate via B again → succeeds
     locally and pushes;
  3. boot a fresh node C → it joins as sync node, serves the same subscription state.
- Full monorepo gate stays green (build/typecheck/test), including everything non-fleet
  (no-`--fleet` behavior unchanged).

## Error handling summary

| Failure | Behavior |
|---|---|
| Second node, no `--fleet` | Today's fail-fast (unchanged) |
| `--fleet` without Postgres | Fail-fast with clear error |
| `--fleet` without ee package | Fail-fast with install instruction |
| Writer dies | Auto-failover ≤ ~2s; in-flight mutations fail visibly; subscriptions unaffected |
| NOTIFY missed | 1s poll fallback (log is truth) |
| Forward hits stale writer URL | Refresh from `fleet_lease`, retry once, then surface error |
| Writer loses PG session | Process exits; supervisor restarts it as sync node (no demotion path) |
| Sync node calls `write()` | `ReadOnlyStoreError` (defense-in-depth; the role split prevents it) |

## Slice 2 preview (not this spec)

Swap each sync node's `PostgresDocStore` for a log-tailed local `SqliteDocStore` replica
(bootstrap via `load_documents`, apply loop, watermark reads) — removes primary read load at
10+ nodes. Pure store swap behind the `DocStore` seam; nothing in this slice's protocol,
forwarding, or lease design changes.
