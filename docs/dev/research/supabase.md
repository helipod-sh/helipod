---
title: Supabase — Architecture Research
status: research
---

# Supabase — Architecture Research

## 1. Positioning & one-line thesis

Supabase is an open-source "Firebase alternative" built on **PostgreSQL** instead of a proprietary document store. The one-line thesis: *take a single, unmodified Postgres database and wrap it in a constellation of stateless microservices so that the database itself becomes the entire backend* — REST/GraphQL APIs, authentication, realtime, storage, and admin all derive their behavior from the Postgres schema and its row-level security policies. The deliberate strategic bet is **"don't reinvent, compose"**: rather than building a new database engine, Supabase assembles best-of-breed, mostly pre-existing open-source tools (PostgREST, GoTrue, Phoenix, etc.) around Postgres and makes them feel like one product. Every project is a real Postgres database you can connect to with `psql`, with full SQL access and no proprietary lock-in at the data layer.

## 2. Postgres-as-the-platform philosophy

Supabase's defining design principle is that **Postgres is not a dependency of the platform — it *is* the platform**, and everything else is a thin, replaceable adapter around it. Concretely:

- **The schema is the source of truth.** Tables, views, functions, and types defined in Postgres automatically become the REST API surface, the GraphQL surface, the realtime change feed, and the generated TypeScript types. There is no separate API definition or ORM-layer schema to keep in sync — the database catalog *is* the API spec.
- **Authorization lives in the database, not the app tier.** Supabase pushes authZ down into Postgres **Row Level Security (RLS)** policies. Every microservice (REST, Realtime, Storage) ultimately runs SQL as a Postgres role, so a single set of RLS policies governs access uniformly across all access paths. You write the rule once, in SQL, and it is enforced whether the request arrives via REST, GraphQL, a realtime subscription, or the storage API.
- **Compose, don't build.** Supabase's components are largely independent open-source servers (many predating Supabase) connected over the network. Each "functions independently while amplifying the others through APIs and webhooks." This means Supabase could adopt PostgREST and GoTrue rather than writing an API server and an auth server from scratch — and it means each piece is independently swappable/scalable.
- **Extensions as features.** Capabilities that would be separate services elsewhere are delivered as Postgres extensions: `pg_graphql` (GraphQL), `pgvector` (embeddings/AI), `pg_cron` (scheduling), `pg_net` (outbound HTTP), `pgjwt`/`pgsodium` (crypto). The platform's surface area grows by adding extensions to one database rather than adding new servers.

The payoff is conceptual coherence: a developer reasons about *one* system (Postgres) and gets a full backend. The cost (see §10) is that "wrap Postgres in many services" produces an operationally heavy, multi-container deployment.

## 3. Component architecture ← deep

Supabase is a set of stateless (or near-stateless) services that all point at one Postgres instance. Requests enter through a single gateway and fan out by URL path.

**Kong (API gateway / edge).** The single public entrypoint (port 8000 in self-hosting). Kong handles API-key auth, CORS, rate limiting, and path-based routing to backend services. Public clients hit `https://<ref>.supabase.co/...` and Kong dispatches:
- `/rest/v1/*` → PostgREST
- `/auth/v1/*` → GoTrue
- `/realtime/v1/*` → Realtime
- `/storage/v1/*` → Storage API
- `/functions/v1/*` → Edge Functions (Deno)
- `/pg/*` / `/graphql/v1` → postgres-meta / pg_graphql

**PostgREST (REST API).** A standalone Haskell web server that introspects the Postgres schema and exposes every table, view, and function as a RESTful endpoint. It compiles each HTTP request into a *single* SQL statement (good for latency and for keeping authorization in one place). It validates the incoming JWT, then `SET ROLE`s into the role named in the JWT (`anon` / `authenticated`) and sets `request.jwt.claims`, so all queries run under RLS. Also serves GraphQL via the `pg_graphql` extension. See §5.

**GoTrue (Auth).** A standalone Go server (Supabase's fork of Netlify's GoTrue) for user management: email/password, magic links, OTP, OAuth social providers, SAML/SSO, MFA. It is JWT-based — on login it issues a signed JWT whose `role` claim (`authenticated`) and `sub` claim (the user UUID) are exactly what PostgREST/Realtime/Storage use to enforce RLS. User records live in the `auth` schema *inside the same Postgres database*, so `auth.uid()` is callable directly from RLS policies. This tight coupling — auth state is just rows in Postgres — is what makes "authorization in the database" work end to end.

**Realtime (Elixir/Phoenix).** A globally distributed Elixir cluster exposing WebSockets, providing three features — Postgres Changes, Broadcast, and Presence (see §4). Chosen for the BEAM VM's ability to hold millions of concurrent lightweight processes (one per socket) and to cluster across regions. It reads Postgres's WAL via a logical replication slot for change streaming and uses Phoenix.PubSub for cross-node message fan-out.

**Storage API (Node/TypeScript).** An S3-compatible object storage service. Large objects live in a backing blob store (S3/GCS or local disk self-hosted), but **all file/bucket metadata is stored in Postgres**. Because object paths are rows in Postgres, the *same* RLS mechanism secures file access — you write Postgres policies that decide who can read/write a given path. Exposes three protocols over the same buckets: a REST API, a resumable TUS upload endpoint, and an S3-compatible endpoint at `/storage/v1/s3`. Optional CDN + on-the-fly image transformations.

**postgres-meta.** A REST API over Postgres administration (tables, columns, roles, policies, extensions, running queries). This is the backend that powers Studio's table editor and SQL tooling without giving the dashboard raw superuser SQL access.

**Studio (Dashboard).** An open-source Next.js app: table editor, SQL editor, RLS policy editor, auth user management, storage browser, logs. It talks to postgres-meta and the other service APIs — it is a client of the platform, not a privileged core component.

**Supavisor.** Multi-tenant connection pooler (see §6).

**Edge Functions (Deno).** A Deno runtime for serverless TypeScript/JavaScript, for custom server logic that doesn't fit the auto-generated API.

How they fit: the schema defines the data; GoTrue mints JWTs; Kong routes; PostgREST/Realtime/Storage each take that JWT, assume a Postgres role, and let **RLS** be the one authorization brain shared by all of them.

## 4. Realtime mechanism

Supabase Realtime is an **Elixir/Phoenix** application (the BEAM VM handles huge numbers of concurrent socket processes cheaply and clusters across regions). Clients open a WebSocket and subscribe to a **Channel**; three distinct features ride on that channel:

**(a) Postgres Changes (CDC).** Realtime opens a **logical replication slot** against the database and reads the **Write-Ahead Log (WAL)**. For each committed change it consults subscriptions, appends the matching subscriber IDs to the WAL record, and routes the change (as JSON with `old`/`new` records) to the right sockets via the Erlang VM. Supports row-level filtering (`eq`, `in`, etc. on a column) and respects RLS — a change is only delivered to a user if that user's role could `SELECT` the row. Latency is roughly **50–200ms** (WAL processing + replication). Critically, **WAL processing is single-threaded to preserve ordering**, which is the main scaling bottleneck of this approach (see scaling note below).

**(b) Broadcast.** Low-latency, ephemeral client-to-client (or server-to-client) messaging using **Phoenix.PubSub** (PG2 adapter) for cluster-wide fan-out, with messages taking the shortest path between geographically close clients (sub-50ms typical). Broadcast does *not* require touching Postgres — ideal for cursors, typing indicators, game state, whiteboard strokes, anything > ~10 events/sec/user. Supabase now also supports **"Broadcast from the database"**: a Postgres trigger calls `realtime.broadcast_changes()` which writes to the `realtime.messages` table (partitioned daily, ~3-day retention); Realtime has a replication slot/publication on `realtime.messages` and forwards those inserts to channels. This lets you send *only selected columns* to *specific channels* using SQL, and it scales database-driven updates to "tens of thousands of connected users" far better than raw Postgres Changes.

**(c) Presence.** A distributed, in-memory key/value store backed by a **CRDT** that tracks which users are online and their shared state, replicated across all cluster nodes. Used for "who's here" / shared-cursor metadata.

**Realtime Authorization / row-level filtering.** Authorization is enforced through Postgres RLS. For Postgres Changes, deliverability is checked against the subscriber's RLS visibility. For Broadcast/Presence, access is governed by **RLS policies on the `realtime.messages` table** — a user can only join/receive on a channel if policy allows, so the same SQL authorization model extends to realtime.

**Scaling limits of this approach.** The honest tradeoffs:
- **Postgres Changes is the bottleneck.** Single-threaded WAL processing to preserve order means change throughput is capped; under heavy write load or many distinct subscriptions, latency grows and it does not scale linearly. Supabase's own guidance is to migrate high-volume use cases to **Broadcast** (client-to-client or broadcast-from-DB) which sidesteps WAL replay per subscriber.
- A logical replication slot adds load to the primary and can cause WAL retention/bloat if the consumer falls behind.
- Per-row RLS checks on every change event add CPU cost at high event rates.
- The takeaway for designers: **CDC-over-WAL is convenient but is the least scalable realtime primitive; a pub/sub broadcast bus is what you actually scale on.**

## 5. Data model & API generation

**Auto-generated REST (PostgREST).** Point PostgREST at a Postgres schema and every table/view becomes a CRUD resource, every function (`RPC`) becomes a callable endpoint, with filtering, ordering, pagination, embedded resource expansion (foreign-key joins via `?select=...,related(*)`), and bulk operations — all compiled to a single SQL statement per request. Schema changes are reflected immediately; there's no codegen/deploy step for the API itself.

**Auto-generated GraphQL (`pg_graphql`).** A Postgres extension written in Rust that reflects the schema into a GraphQL API executed *inside the database*, served at `/graphql/v1`. Same schema, same RLS — a second API shape over identical data.

**Row Level Security as the authorization model.** This is the linchpin. Postgres roles used:
- `anon` — unauthenticated/public requests.
- `authenticated` — a logged-in user (JWT present).
- `service_role` — backend/admin key that **bypasses RLS** (server-side only, never shipped to clients).

Flow: client sends the JWT (from GoTrue) in `Authorization: Bearer` plus the API key. PostgREST/Realtime/Storage verify the JWT, then `SET ROLE` to the role in the JWT and populate `request.jwt.claims`. Inside Postgres, RLS policies use helpers like `auth.uid()` and `auth.jwt()` to scope rows (e.g. `USING (user_id = auth.uid())`). Because *every* access path resolves to a Postgres role under RLS, you author authorization **once in SQL** and it holds across REST, GraphQL, Realtime, and Storage. A deliberate security invariant: there is **no way to escalate from `anon` to `service_role` mid-request**.

**Typed client generation.** `supabase gen types typescript` introspects the schema and emits TypeScript (also Go, Swift) types for tables, views, enums, and functions. Passing these to `supabase-js` yields **end-to-end type safety** — the query builder knows column names/types, and responses are typed — without an ORM. Types are regenerated whenever the schema changes (locally via `--local`, against prod via `--linked`, or in CI via GitHub Actions).

## 6. Scalability model

**Connection pooling — Supavisor.** Postgres connections are expensive (one OS process each), and serverless clients open many short connections. Supabase built **Supavisor**, a cloud-native, multi-tenant pooler in **Elixir** (with José Valim / Dashbit), designed to proxy **~1 million** client connections into a small pool of real Postgres connections. Multi-tenancy is encoded in the username (`user.tenant_ref`) so one pooler IP serves many databases. It runs as a cluster where **only one node holds the direct connections to a given database**, and that pool's PID is gossiped to all nodes via an in-memory KV store; when read replicas are added, Supavisor spreads connections across them. Two modes: **session mode (port 5432)** keeps a connection for the session and supports prepared statements; **transaction mode (port 6543)** pools at the transaction level, ideal for stateless serverless functions. (Earlier/local stacks used **PgBouncer**; Supavisor is the cloud successor and adds query load-balancing across replicas.)

**Read replicas.** Postgres physical read replicas scale read traffic; Supavisor can route reads to replicas. Writes still go to a single primary — the classic Postgres vertical-write ceiling remains.

**Per-project isolation / multi-tenancy.** On the hosted platform, **each project is its own dedicated Postgres instance** (its own compute), not a shared schema in a giant multi-tenant DB. Isolation is at the *project* boundary; the shared multi-tenant layers are the pooler (Supavisor) and the Realtime cluster. This gives strong noisy-neighbor isolation at the data layer at the cost of running many small databases.

**Scaling knobs, summarized:** vertical compute scaling per project, read replicas for reads, Supavisor for connection fan-in, Realtime cluster for sockets, stateless services (PostgREST/GoTrue/Storage) scale horizontally behind the gateway. The hard ceiling is **single-primary write throughput** — there is no built-in horizontal write sharding.

## 7. Deployment & self-hosting

**Self-hosted stack = one big docker-compose.** The reference self-hosting setup is a Docker Compose file orchestrating roughly **~11–14 containers** (count varies with optional logging/analytics), all fronted by Kong. A representative service list:

- `db` — Postgres (with Supabase extensions) :5432
- `kong` — API gateway :8000
- `auth` — GoTrue :9999
- `rest` — PostgREST :3000
- `realtime` — Realtime (Elixir) :4000
- `storage` — Storage API :5000
- `imgproxy` — image transformations (for Storage)
- `meta` — postgres-meta :8080
- `studio` — dashboard
- `functions` — Edge Functions (Deno)
- `supavisor` — connection pooler (in newer stacks)
- `vector` + `analytics` (Logflare) — optional log collection/analytics (`docker-compose.logs.yml`)

This is a **non-trivial footprint** to run and operate: ~a dozen long-lived processes spanning Postgres, Haskell, Go, Elixir, Node, Rust, and Deno runtimes, plus a Kong gateway and a logging pipeline — all to stand up "a backend." It runs comfortably on a single beefy VM for small/medium workloads but is clearly heavier than a single-process BaaS.

**Supabase CLI for local dev.** A **single Go binary**. `supabase init` + `supabase start` spins the *entire* stack locally in Docker (mirroring production services), giving a real local Postgres + APIs + Studio. It also drives **migrations** (`supabase migration new` / `up`, `supabase db push`/`pull`/`diff`), **type generation** (`supabase gen types`), Edge Function deploys, and project linking (`supabase link`). The local stack is the same images as self-hosting, so local ≈ prod.

## 8. Developer experience (DX)

- **One binary, full local stack.** `supabase start` reproduces the whole production environment locally in Docker — real Postgres, real APIs, real Studio — so there's no mock/prod divergence.
- **Migrations as plain SQL files.** Versioned migrations in `supabase/migrations`, `db diff` to capture schema changes, `db push` to apply. Git-friendly, CI-friendly.
- **End-to-end types without an ORM.** Generated TS types + the `supabase-js` query builder give typed queries/responses straight from the DB schema; regenerate on schema change (locally or in CI via GitHub Actions).
- **Studio dashboard.** Table editor, SQL editor, RLS policy editor, auth user admin, storage browser, logs — a genuinely good visual layer, all backed by postgres-meta and the service APIs.
- **Client libraries.** `supabase-js` (and Flutter/Swift/Python/etc.) unify REST, Auth, Realtime, and Storage behind one client object, so `supabase.from('table').select()`, `supabase.auth.signIn()`, `supabase.channel()`, and `supabase.storage` share one auth context.
- **SQL-first authorization.** Once you internalize RLS, writing a policy is the *only* place you express access control — fewer scattered authZ checks. (The flip side: RLS has a learning curve and is easy to get subtly wrong — see §10.)

## 9. The ONE transferable idea

**Make the database schema the single source of truth for the entire backend, and push authorization down into the database so one set of policies governs every access path.** Everything else — auto-generated REST/GraphQL, generated client types, realtime change feeds, file-access rules — is *derived* from the schema + RLS rather than separately defined and kept in sync. This collapses the usual stack of "DB schema + ORM models + API layer + authZ middleware + type definitions," each a place for drift and bugs, into one declarative artifact. The leverage is enormous: define a table and a policy, and you instantly have a secured REST endpoint, a GraphQL field, a typed client, and an authorized realtime subscription. For anyone designing a "deploy-anywhere BaaS," **schema-as-API + authorization-in-the-data-layer** is the idea worth stealing — it's what lets a small team offer a Firebase-sized feature set.

## 10. Weaknesses / heaviness / things to avoid

- **Operational heaviness.** ~12 containers across 6+ language runtimes plus Kong and a logging pipeline is a lot of moving parts for "a backend." This directly contradicts a "lightweight, deploy-anywhere" goal — upgrades, inter-service version skew, and debugging across Haskell/Go/Elixir/Node/Rust/Deno are real costs. A leaner target would consolidate services (or make most of them optional).
- **Realtime CDC doesn't scale.** Postgres Changes is single-threaded WAL replay with per-event RLS checks; it's convenient but the first thing to fall over under load. Don't build a high-throughput system on CDC-over-WAL — design for a broadcast/pub-sub bus from day one and treat WAL streaming as a low-volume convenience.
- **Single-primary write ceiling.** Reads scale (replicas), connections scale (Supavisor), sockets scale (BEAM cluster) — but **writes do not shard**. Postgres remains a vertical-scaling write bottleneck; there is no built-in horizontal write partitioning.
- **RLS is powerful but sharp.** All security funnels through SQL policies. Policies are easy to get subtly wrong (especially `INSERT`/`UPDATE` `WITH CHECK`), can be **hard to debug**, and add per-row CPU overhead — RLS performance tuning (wrapping `auth.uid()` in `select`, indexing policy columns) is a known footgun. A misconfigured policy is a data breach.
- **Connection-pooler caveats.** Transaction-mode pooling breaks prepared statements / session features; teams must consciously pick session vs transaction mode and route accordingly.
- **`service_role` key is a loaded gun.** It bypasses RLS entirely; leaking it (e.g., bundling it client-side) defeats the whole authorization model. The security perimeter depends on disciplined key handling.
- **Per-project = a database per tenant.** Strong isolation, but it means operating *many* Postgres instances; it doesn't give you a cheap shared-schema multi-tenant model out of the box.
- **Coupling to Postgres internals.** Leaning on logical replication slots, WAL, and many extensions ties realtime/availability to Postgres operational details (slot retention, WAL bloat, extension compatibility on upgrade).

## 11. Sources

- [Supabase Architecture overview — Supabase Docs](https://supabase.com/docs/guides/getting-started/architecture)
- [Realtime Architecture — Supabase Docs](https://supabase.com/docs/guides/realtime/architecture)
- [Realtime: Broadcast from the Database — Supabase Blog](https://supabase.com/blog/realtime-broadcast-from-database)
- [Realtime Benchmarks — Supabase Docs](https://supabase.com/docs/guides/realtime/benchmarks)
- [Realtime Limits — Supabase Docs](https://supabase.com/docs/guides/realtime/limits)
- [Serverless / Auto-generated API (PostgREST) — Supabase Docs](https://supabase.com/docs/guides/api)
- [Postgres Roles — Supabase Docs](https://supabase.com/docs/guides/database/postgres/roles)
- [Row Level Security — Supabase Docs](https://supabase.com/docs/guides/database/postgres/row-level-security)
- [Understanding API keys (anon / service_role) — Supabase Docs](https://supabase.com/docs/guides/api/api-keys)
- [Supavisor: Scaling Postgres to 1 Million Connections — Supabase Blog](https://supabase.com/blog/supavisor-1-million)
- [supabase/supavisor — GitHub](https://github.com/supabase/supavisor)
- [Connect to your database (pooler modes) — Supabase Docs](https://supabase.com/docs/guides/database/connecting-to-postgres)
- [Self-Hosting with Docker — Supabase Docs](https://supabase.com/docs/guides/self-hosting/docker)
- [supabase/storage (S3-compatible, metadata in Postgres) — GitHub](https://github.com/supabase/storage)
- [Supabase Storage now supports the S3 protocol — Supabase Blog](https://supabase.com/blog/s3-compatible-storage)
- [CLI Reference — Supabase Docs](https://supabase.com/docs/reference/cli/introduction)
- [Generating TypeScript Types — Supabase Docs](https://supabase.com/docs/guides/api/rest/generating-types)
- [Docker Compose Architecture — DeepWiki (supabase/supabase)](https://deepwiki.com/supabase/supabase/3.1-docker-compose-architecture)
