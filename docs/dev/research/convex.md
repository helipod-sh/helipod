---
title: Convex — Architecture Research
status: research
---

# Convex — Architecture Research

> Researched June 2026. Sources are the official docs (docs.convex.dev), the open-source
> backend repo (github.com/get-convex/convex-backend, Rust), and the Convex engineering blog
> (stack.convex.dev). Where a claim could not be confirmed against a primary source it is
> flagged "Unknown / not public."

## 1. Positioning & one-line thesis

Convex is a **reactive backend-as-a-platform**: a document database, a serverless TypeScript
function runtime, and a realtime sync engine fused into one product. The thesis is that
**reactivity is a database primitive, not an application concern** — you write plain TypeScript
query functions against the database, subscribe to them from the client, and Convex
re-pushes new results automatically and consistently whenever any data the query read
changes. It replaces the usual stack of (Postgres + ORM + REST/GraphQL API + cache +
cache-invalidation logic + WebSocket/pub-sub layer) with a single system whose defining
promise is "**no manual cache invalidation, no manual realtime plumbing.**"

The core mental model: **CRUD/REST is replaced by deterministic functions.** Business logic
lives in transactional TypeScript that runs *inside* the database boundary, not in a separate
app tier talking to the DB over the network.

## 2. Data model & storage engine

**Document model.** Data lives in *tables* of *documents*. A document is an arbitrary
Convex object — JSON extended with 64-bit signed integers and binary (`ArrayBuffer`) data.
Every document gets a system-generated unique `_id` (and `_creationTime`). Schema is
optional but recommended: you declare it in `convex/schema.ts` with validators, and the
types flow end-to-end (see §7). Relationships are modeled by storing `_id`s as foreign
references (helper libraries like Convex Ents add relationship ergonomics on top).

**Storage engine — the important nuance.** Convex does **not** use FoundationDB in the
open-source/self-hosted build (a common misconception). The architecture is a **custom
log-structured store layered on top of an ordinary OLTP database**:

- The cloud product and the self-hosted binary persist to a **relational backing store**:
  **SQLite by default** (single-file, used locally and for small deployments) or
  **Postgres / MySQL** for production. The backing SQL database is used as a **durable
  key/value-ish substrate, not as a relational schema** — Convex does *not* map tables to
  SQL tables; it stores its own log and index structures inside it.
- The central data structure is an **append-only transaction log**. All tables' documents
  are interleaved in one log, ordered by a single **monotonically increasing timestamp**
  that acts as a global version number. "Applying all of the deltas up to a timestamp
  creates the snapshot of the database at that timestamp" — i.e. **MVCC over a shared log**.
- On top of the log, Convex maintains **derived index structures**. The `_id` index maps
  each id to its latest value; user-defined indexes are **sorted B-tree-like structures**
  ordered by the indexed fields. An index is described in the docs as "a data structure that
  allows efficiently mapping a point in logical time to a consistent snapshot of the state of
  the world at that timestamp" — i.e. indexes are themselves multi-version.

  > NOTE: The FoundationDB confusion likely comes from the fact that Convex's *internal
  > production cloud* has used custom storage layers, but the public/self-hosted code path
  > documented in the repo is SQLite/Postgres/MySQL-backed. No FoundationDB dependency
  > exists in the open-source backend.

**Indexes & queries.** Indexes are **explicit and mandatory for performance**. There is no
SQL-style query planner that implicitly chooses an index. A `query()` either does a
**full table scan** or you call `.withIndex("by_author", q => q.eq("author", "Austen"))` to
scan a bounded **index range**. Compound indexes (`["author", "title"]`) sort hierarchically
and support range/prefix queries. The deliberate design choice: **explicit `withIndex` means
query cost is predictable and visible in code** — "fewer surprises in the long run" — at the
cost of more verbose query construction. There is also a separate full-text **search index**
and **vector index** facility.

## 3. Function & execution model

Three function kinds, with sharply different capabilities:

| Kind | Reads DB | Writes DB | Side effects (`fetch`, etc.) | Determinism | Reactive |
|------|----------|-----------|------------------------------|-------------|----------|
| **Query** | ✅ | ❌ | ❌ | Required | ✅ (subscribable) |
| **Mutation** | ✅ | ✅ | ❌ | Required | — (transaction) |
| **Action** | only via `runQuery`/`runMutation` | only via `runMutation` | ✅ | Not required | — |

**Determinism requirement.** Queries and mutations must be **pure functions of their
arguments and database reads**. The runtime *enforces* this rather than trusting the
developer:
- `Math.random()` is **seeded** (reproducible).
- `Date.now()` is **frozen** for the duration of a function (constant snapshot of time);
  `performance.now()` is fixed in queries, increments in mutations.
- `fetch` and other non-deterministic I/O are **simply absent** from the query/mutation
  sandbox.

Determinism is load-bearing: it is what makes OCC retries safe (re-running produces the same
result with no duplicated external side effects) and what makes a query's read set a
**precise** dependency footprint for reactivity.

**Runtimes.** Two execution environments:
- **Convex (V8) runtime** — the default. A custom isolate-based JS runtime, conceptually
  like Cloudflare Workers: V8 isolates, **no cold starts** (always warm), web-standard APIs
  (Web Crypto, TextEncoder, Web Streams, `fetch` *in actions only*). All queries/mutations
  and most actions run here.
- **Node.js runtime** — opt-in per-file via the `"use node"` directive, **actions only**.
  For libraries needing real Node. Pays cold-start cost; lower arg-size limit (5 MiB vs
  16 MiB). Configurable Node 20/22/24.

**Transaction model — OCC + serializability.** Every query and mutation runs as an **atomic
transaction** with three ingredients:
1. **Begin timestamp** — chosen at start; the function sees a fixed MVCC snapshot at that
   timestamp regardless of concurrent writes.
2. **Read set** — *precisely* records everything read, expressed as **index ranges** (not
   just individual doc ids), e.g. "the range of `by_author` for Austen."
3. **Write set** — buffered in memory as a map of id → new value; nothing is persisted
   mid-execution.

A **single centralized committer** finalizes mutations: it assigns a **commit timestamp**
greater than all previous commits, then **walks the transaction log forward from the
transaction's begin timestamp** to see if any committed write **overlaps the read set**. No
overlap → the write set is appended to the log atomically. Overlap → **OCC conflict**: the
write set is discarded and the committer throws a conflict error to the function runner,
which **automatically re-runs the mutation** (safe because of determinism). The guarantee is
**true serializability** (not mere snapshot isolation) with **automatic conflict resolution**
— the developer "writes mutations as if they will always succeed."

## 4. Reactivity / realtime mechanism ← MOST IMPORTANT

This is the heart of the system. The flow, end to end:

**(a) Subscription = a query plus its read set.** When a client calls `useQuery(api.foo.bar, args)`,
the client opens (or reuses) a **WebSocket** to the deployment and registers the query in its
**query set**. The backend runs the query once, returns the result, and — crucially —
**retains the query's read set** (the exact set of index ranges the query touched) in the
client's session state inside the **sync worker**. The subscription *is* `{function, args,
read set, result, timestamp}`.

**(b) Read sets are index ranges, not row lists.** Because the read set is recorded as
**index ranges** (e.g. "`messages` by `channel` where channel = 42, all timestamps"), the
dependency captures not just rows that exist *now* but the *region of keyspace* the query
cares about. This is what makes **insertions** into that range trigger invalidation, not only
edits to already-read rows. Granularity is therefore "the index ranges scanned" — finer than
table-level, coarser than per-document-only.

**(c) Invalidation by log/read-set intersection.** Every committed mutation appends its write
set to the global transaction log. A **subscription manager** holds the read sets of *all*
active subscriptions. On each new committed entry (or batch), it **walks the log once and
tests each entry against the aggregated read sets for overlap.** This is the dual of the OCC
commit check — the *same* read-set-vs-write-set intersection primitive powers both
concurrency control and reactivity. Any subscription whose read set overlaps a write is
marked dirty.

**(d) Recompute and push.** For each dirtied subscription, the **sync worker tells the
function runner to re-run the query** at the new timestamp. If the recomputed result differs,
it **pushes the new result to the client over the WebSocket.** (If a query is determined not
to be affected, it is never re-run — the read-set test avoids needless recomputation.)

**(e) Transactional consistency across queries — the subtle, important part.** The sync
worker **guarantees every query in a client's query set is reported at the same logical
timestamp.** Updates are delivered in **consistent transactional windows**: the client never
sees query A advanced past a mutation while query B lags behind it. The React client applies
all affected `useQuery` updates in a **single render pass**, so the UI never shows a mix of
old and new state. This "consistent snapshot across all of a client's subscriptions" is the
property naive pub/sub systems lack.

**(f) Mutations + optimistic updates.** Mutations are sent over the same WebSocket. The
client supports **optimistic updates** (apply a predicted change locally immediately); the
server tells each client which of its mutations have been applied at the server, so the
client knows when to **roll back the optimistic state** and adopt the authoritative result —
again, atomically with the consistent query window.

**Why this is hard to replicate:** the whole scheme depends on (1) **deterministic queries**
so a read set is a sound, complete dependency footprint; (2) **read sets expressed as index
ranges** so inserts are caught; (3) a **single global ordered log** so "did anything I read
change?" is a single forward scan; and (4) **timestamp-aligned delivery** so multiple
subscriptions stay mutually consistent. Remove any one and the model breaks.

## 5. Scalability model

**Single-writer commit, horizontally-scaled reads.** This is the defining scalability shape:

- **Writes funnel through one committer per backend instance.** Serializability + the
  log-append + the OCC read-set check are done by a **single committer** that assigns the
  global monotonic commit timestamps. This is intentionally a **single-writer** design — it's
  what makes the global ordered log and precise invalidation tractable. The committer is the
  throughput ceiling for writes.
- **Reads/function execution are horizontally scaled out** via a service called **Funrun**
  ("function runner"). Original constraint: V8 caps at **128 threads**, so one backend could
  only run 128 functions concurrently. Convex split execution into **Funrun, a read-only gRPC
  service** that loads a DB snapshot, executes the user functions, and returns results +
  read/write sets to the backend; the backend's committer then does conflict-checking and
  commits. Any backend can fan out to **many Funrun instances**, scaled to demand, letting
  pro customers "run 10× as many functions concurrently." Reported **median query/mutation
  latency stays < 20 ms** despite the extra network hop.
- **Funrun optimizations:** **Rendezvous hashing** to route a given client's requests to the
  same node (cache locality), **async LRU caches** of modules/indexes/schemas/table metadata,
  and **V8 isolate/context reuse** across requests.
- **Co-location:** backend and Funrun instances run in the **same region** to keep the hop
  cheap.

**Backend instance model.** Each Convex deployment ("backend") is effectively its own
instance with its own log/committer. The self-hosted binary is **single-node by default**;
scaling a single deployment beyond one machine's committer is not a turnkey feature.

**Multi-region.** Public details are thin. Funrun co-locates with its backend in-region;
genuine multi-region active/active replication of a single deployment is **Unknown / not
public**. The model is regionally scoped per deployment.

**Known limits.** Single-writer write throughput per deployment; SQLite backing store
**serializes writes** (use Postgres/MySQL for production write concurrency); per-function
limits on argument sizes (16 MiB V8 / 5 MiB Node), execution time, and read/write set sizes;
explicit indexes required to avoid table-scan blowups. Exact numeric ceilings vary by plan
and are partly Unknown / not public.

## 6. Deployment & self-hosting

- **Open source:** `github.com/get-convex/convex-backend` (Rust). Layout: `crates/` holds the
  Rust backend (`local_backend/` is the application server); `npm-packages/` holds the
  TypeScript packages (client libraries, UDF runtime, system functions); `self-hosted/`
  holds deployment assets.
- **Self-hosting:** ship as a **Docker image (recommended)** or **prebuilt binary**. The
  self-hosted product includes "**most features of the cloud product, including the dashboard
  and CLI.**" Linux/Mac are well-tested; Windows is not. A **telemetry beacon** is on by
  default (`--disable-beacon` to turn off). You must rotate the default **instance secret /
  admin key** before exposing it.
- **Backing store / dependencies:** **SQLite by default** (zero external dependency — data in
  a Docker-managed volume); **Postgres or MySQL** for production scale/resilience. You provide
  durable storage (e.g. AWS EBS) for the volume. File/blob storage uses local disk or S3-
  compatible object storage. No FoundationDB, no Kafka, no Redis required.
- **Footprint:** community guidance — ~**2 GB RAM VPS with SQLite** for dev; ~**4 GB RAM with
  Postgres in the same region** for production. It is a genuinely lightweight single-binary
  deploy.
- **Client connection:** apps point at the deployment URL; `npx convex dev`/`deploy` push
  functions and codegen against self-hosted instances just like cloud (with an admin key).

## 7. Developer experience (DX)

The DX is the product's biggest differentiator. What specifically makes it good:

- **`npx convex dev` — the live dev loop.** Watches the `convex/` directory; on any change to
  a function or `schema.ts` it **pushes the new code to your dev deployment and regenerates
  types** in `convex/_generated/`. No build step, no migrations command for code, no redeploy
  cycle — save a file, the backend is updated within ~a second.
- **End-to-end type safety via codegen, no codegen language.** Codegen scans your exported
  functions, strips non-entry-point exports, and emits a typed `api` object in
  `convex/_generated/api.d.ts` mapping module paths → function references, plus
  `dataModel.d.ts` derived from your schema. The result: `useQuery(api.messages.list, {...})`
  is **fully type-checked** — wrong table names, wrong arg shapes, wrong `Id<"table">` types,
  and wrong return types are all **compile errors**, on both server and client, with no
  hand-written API client. (Note: the generated files must be committed; code won't typecheck
  without them.)
- **One language, no network seam.** Business logic is plain TypeScript that calls the DB
  directly (`ctx.db.query(...)`) inside a transaction — no ORM, no SQL, no REST/GraphQL layer
  to define, version, or serialize across.
- **Reactivity for free.** `const data = useQuery(...)` is *automatically live* — no
  subscriptions to wire, no cache keys, no invalidation logic, no WebSocket code. This is the
  "magic" moment: a normal-looking hook that updates itself.
- **Batteries included:** schema + validators, indexes, scheduled functions / cron, file
  storage, full-text and vector search, auth integrations, and a **dashboard** (data browser,
  function logs, runner) — all in the one product and mirrored in self-host.
- **Optimistic updates** are a first-class client API for snappy mutations.

The throughline: the framework **eliminates whole categories of code** (API layer, cache,
invalidation, realtime transport, client types) rather than making them easier to write.

## 8. The ONE transferable idea

**Make the read set a first-class, precisely-tracked object — expressed as index ranges — and
reuse the same read-set-vs-write-set intersection primitive for BOTH concurrency control and
reactivity.**

Everything good about Convex falls out of this one decision. Because every query/mutation runs
deterministically over a snapshot and records *exactly* what it read as index ranges:
- **OCC serializability** is "does any committed write since my begin-timestamp intersect my
  read set?"
- **Reactive invalidation** is the *same question* asked continuously for every live
  subscription against the write log.

So a single mechanism — read-set intersection over an ordered write log — delivers
serializable transactions, automatic conflict-retry, and precise realtime invalidation with
no developer-authored cache keys. If you build a Convex-like system, this is the kernel to get
right first; the WebSocket transport, the codegen, and the runtime are comparatively
mechanical once you have it. The enabling preconditions you must also adopt: **deterministic
function execution** (so read sets are sound) and a **single ordered commit log** (so "did it
change?" is one forward scan).

## 9. Weaknesses / things to avoid

- **Single-writer ceiling.** All writes for a deployment serialize through one committer +
  one ordered log. Great for consistency, but it's a hard write-throughput cap; there is no
  built-in horizontal write sharding for a single deployment. Don't pick this shape for write-
  saturated workloads (high-rate telemetry/event ingest) without a plan.
- **Reactivity has a cost at scale.** Every commit is tested against every active
  subscription's read set. Very broad read sets (table scans, huge ranges) or enormous
  subscriber counts make a hot document invalidate floods of subscriptions and trigger mass
  recomputation. "Queries that scale" is a real discipline you must teach users — narrow
  read sets, good indexes.
- **Explicit-index burden.** No automatic query planner: forget `withIndex` and you silently
  get a full table scan (slow query *and* an enormous read set that over-invalidates).
- **Determinism is restrictive.** No `fetch`/randomness/wall-clock in queries/mutations;
  anything non-deterministic must move to an **action**, which is *not* transactional and
  *not* reactive. The query/mutation/action split is a real cognitive load, and actions
  reintroduce at-least-once / side-effect-ordering concerns the core model otherwise removes.
- **OCC under contention.** Hot keys cause repeated OCC aborts/retries; throughput on a
  contended document degrades. Serializability isn't free.
- **Backing-store caveats.** SQLite default serializes writes — fine for dev, a footgun if
  someone runs production on it. Self-hosted is single-node; HA/replication is your problem.
- **Lock-in / paradigm.** It's a whole-stack commitment (its DB, its functions, its client).
  Migrating *out* means rebuilding the API + realtime layer you never had to write. Some
  multi-region and exact-limit internals are **not public**, which matters for capacity
  planning.

## 10. Sources

- https://stack.convex.dev/how-convex-works — transaction log, MVCC, read/write sets, OCC committer, subscription manager, sync worker (primary internals source)
- https://docs.convex.dev/database/advanced/occ — OCC, serializability, deterministic retry, conflict detection
- https://docs.convex.dev/functions/runtimes — V8 vs Node runtime, determinism enforcement (seeded random, frozen time), API surface, limits
- https://stack.convex.dev/horizontally-scaling-functions — Funrun gRPC service, V8 128-thread limit, single-committer + scaled reads, rendezvous hashing, isolate reuse, <20ms latency
- https://stack.convex.dev/convex-query-performance — indexes as sorted structures, index ranges, full table scans, read-set bounding
- https://docs.convex.dev/database/reading-data/indexes/ — explicit `withIndex`, compound indexes
- https://github.com/get-convex/convex-backend — Rust repo layout (crates/, npm-packages/, self-hosted/), SQLite/Postgres support, Docker/binary
- https://github.com/get-convex/convex-backend/blob/main/self-hosted/README.md — self-hosting, backing store, beacon, secrets
- https://stack.convex.dev/self-hosted-develop-and-deploy — self-hosting workflow, SQLite default / Postgres for prod
- https://news.convex.dev/self-hosting/ — self-hosting feature parity
- https://docs.convex.dev/cli/reference/dev — `npx convex dev` watch + push + codegen loop
- https://docs.convex.dev/cli/reference/codegen — generated types in convex/_generated
- https://stack.convex.dev/code-spelunking-uncovering-convex-s-api-generation-secrets — how the typed `api` object is generated
- https://docs.convex.dev/understanding/best-practices/typescript — end-to-end type safety, schema-derived types
- https://docs.convex.dev/functions/mutation-functions and /functions/query-functions — query/mutation/action semantics, transactions
- https://docs.convex.dev/understanding/ — ACID guarantees, serializable isolation, OCC/MVCC positioning
- https://stack.convex.dev/queries-that-scale — read-set/subscription cost discipline
