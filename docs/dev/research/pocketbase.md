---
title: PocketBase — Architecture Research
status: research
---

# PocketBase — Architecture Research

> Research date: 2025-05-15. Current release referenced: **v0.39.5** (June 2026). PocketBase is pre-1.0 and explicitly does not guarantee full backward compatibility before v1.0.0.

## 1. Positioning & one-line thesis

**PocketBase is an open-source backend shipped as a single ~11–15 MB self-contained executable: an embedded SQLite database + auto-generated REST API + realtime subscriptions + auth + file storage + admin dashboard, with zero external dependencies.**

It positions itself as a lightweight, self-hostable alternative to Firebase/Supabase for small-to-medium apps, prototypes, mobile/SPA backends, and internal tools. Its entire reason for existing is operational minimalism: one file, one process, one data directory. It is a "personal project" by a single primary author (Gani Georgiev), which is itself part of the thesis — the scope is deliberately constrained to what one binary can do well on one node.

The transferable insight is not "use SQLite." It is: **collapse the entire backend stack (DB, API server, auth server, file server, realtime broker, admin UI) into one in-process Go binary so that there are no network hops, no orchestration, and no config between the components.**

## 2. The single-binary / embedded-SQLite model  ← MOST IMPORTANT

This is the core of why PocketBase stays small and simple. Several design choices compound:

**One statically-linked Go executable.** Go compiles everything — the HTTP server, the SQLite driver, the realtime broker, the embedded admin UI (a Svelte SPA embedded into the binary via Go's `embed`), and optionally a JavaScript engine — into one statically-linked file. There is no Node.js, no Python, no shared libraries, no separate database server, no message broker, no container runtime required. Deployment is "copy the binary to a server and run `./pocketbase serve`." The v0.39.5 distributions are ~11–12 MB per platform (Linux/macOS/Windows/FreeBSD, x64 + ARM64).

**Pure-Go SQLite driver (no CGO).** By default PocketBase uses `modernc.org/sqlite`, a pure-Go transpiled port of SQLite, so builds require **no CGO and no C toolchain** (`CGO_ENABLED=0`). This is what makes cross-compilation trivial and keeps the binary truly portable. Users who want the C driver can register `mattn/go-sqlite3` instead, but that requires `CGO_ENABLED=1`. The default path keeps things dependency-free.

**Embedded, in-process database.** SQLite runs *inside* the same process as the API server. There is no database connection over a socket or network — data access is a function call into the same address space. This is the single biggest performance and simplicity win: it eliminates an entire network round trip, connection pooling against an external server, separate DB credentials/config, and a separate failure domain. "In-process is physically faster than any networked database can ever be."

**File-based storage / zero-config.** On first `serve`, PocketBase creates a `pb_data/` directory containing:
- `data.db` — the main application database (collections, records).
- `auxiliary.db` — a *second* SQLite database used for logs and ephemeral system/meta information, deliberately separated so high-volume log writes don't contend with application data writes.
- `storage/` — uploaded files on the local filesystem.

There is also `pb_migrations/` (schema migration files) and optional `pb_hooks/` (JS extension scripts). Backup = essentially copying `pb_data/`. There is no config server or config database; settings live in the DB and are edited from the admin UI.

**WAL mode + carefully tuned pragmas.** SQLite is opened in **WAL (Write-Ahead Logging)** mode, which allows *multiple concurrent readers with a single writer*. PocketBase sets a battery of pragmas for server workloads:
- `journal_mode = WAL` (concurrency)
- `synchronous = NORMAL` (durability/speed tradeoff appropriate for WAL)
- `journal_size_limit = 200000000`
- `temp_store = MEMORY`
- `cache_size = -32000` (~32 MB page cache)
- `foreign_keys = ON`
- `busy_timeout` set, **plus** application-level auto-retry on `SQLITE_BUSY` for both reads and writes as a fallback to minimize busy errors under contention.

**Why this is so operationally light.** Every component that a "normal" stack runs as a separate process/service (Postgres, an API server, Redis/pub-sub for realtime, an object store, an auth service, an admin panel) is instead a Go package linked into one binary talking in-memory. The operational surface is: one process, one data dir, one port. There is nothing to wire together, nothing to keep in version sync, and nothing to network-secure between components.

## 3. Data model & API

**Collections and records.** The data model is "collections" (≈ tables) containing "records" (≈ rows). Each collection has a typed schema (text, number, bool, email, url, date, select, relation, file, json, autodate, etc.). Every record automatically gets an `id` and timestamp fields. Schema is defined visually in the admin UI (or via migrations / the Go/JS API), and PocketBase generates the underlying SQLite tables.

**Auto-generated REST-ish API.** Defining a collection automatically exposes a full CRUD REST API — no codegen step, no controllers to write:
- `GET /api/collections/{collection}/records` (list/search)
- `GET /api/collections/{collection}/records/{id}` (view)
- `POST /api/collections/{collection}/records` (create)
- `PATCH /api/collections/{collection}/records/{id}` (update)
- `DELETE /api/collections/{collection}/records/{id}` (delete)

**Querying.** Rich query params on the list endpoint:
- `filter` — expression language, e.g. `(title~'abc' && created>'2022-01-01')`, with operators `=, !=, >, <, >=, <=, ~` (like), `&&`, `||`. Array/multi-value fields support "any of" matching via `?`-prefixed operators.
- `sort` — `+`/`-` prefixes, e.g. `sort=-created,id`.
- `page` / `perPage` — pagination, returns `totalItems` / `totalPages`.
- `expand` — auto-join related records up to **6 levels deep**, returned under an `expand` property.
- `fields` — sparse field selection, with modifiers like `:excerpt(200,true)`.

**Access control via API rules.** Instead of writing middleware, each collection has five declarative rule expressions evaluated per request: `listRule`, `viewRule`, `createRule`, `updateRule`, `deleteRule`. Each is either `null` (superuser-only), `""` (public), or a filter-like expression referencing the request (`@request.auth.id`), the record, and relations. Authorization is data-driven configuration, not code — a major simplicity lever, since the same rule engine secures REST *and* realtime.

## 4. Realtime mechanism

**Transport: Server-Sent Events (SSE), confirmed — not WebSockets.** Realtime is implemented as ordinary long-lived `GET` HTTP requests held open as an SSE stream. This is a deliberate simplification: SSE is plain HTTP, works through standard proxies, needs no protocol upgrade, and auto-reconnects in browsers.

**Connection lifecycle:**
1. Client opens the SSE connection (`GET /api/realtime`); server immediately sends a `PB_CONNECT` event containing a generated **client ID**.
2. Client calls `POST /api/realtime` (a separate request) to *set* its subscription list, passing the client ID. Auth (the `Authorization` header) is evaluated at this "set subscriptions" step.
3. Server pushes `create` / `update` / `delete` events for subscribed records/collections down the open SSE stream.
4. If no message is sent for **5 minutes**, the server sends a disconnect to reap leaked/forgotten connections.

**Subscription granularity & filtering.** A client can subscribe to a whole collection or to a single record by ID. Access is enforced with the *same* collection rules as REST: subscribing to a single record uses the `viewRule`; subscribing to a collection uses the `listRule`. So a client only receives events for records it is actually allowed to see.

**How events are produced — application-level, in-memory broker.** This is the key architectural fact and the source of its limits. PocketBase does **not** use any database-level change feed/NOTIFY (SQLite has none). Instead, realtime is *application-level monitoring*: when a record create/update/delete flows through PocketBase's own model layer (`realtime.go` / `bindEvents`), the server broadcasts to the in-process broker, which fans out over the open SSE connections.

**Scaling characteristics & limits (important):**
- Because change detection is in-process, **events only fire for writes that go through that running PocketBase instance.** Direct writes to `data.db` (e.g. an external `sqlite3` session) bypass realtime entirely.
- The same fact means realtime **does not naturally scale horizontally**: a second PocketBase node would not know about writes on the first node, since there is no shared pub/sub bus. Realtime is inherently single-node.
- Each subscriber is a held-open file descriptor. At high concurrency you hit the OS file-descriptor limit (default ~1024) and get "Too many open files"; the fix is raising `ulimit -n` / systemd `LimitNOFILE`. This is the practical ceiling on concurrent realtime clients, bounded by FDs and RAM rather than by a hard internal cap.

## 5. Extensibility model

PocketBase is extended **without forking**, two ways:

**(A) As a Go framework (most powerful).** PocketBase is published as a normal Go package. You:
1. `import "github.com/pocketbase/pocketbase"`
2. `app := pocketbase.New()`
3. Register hooks / custom routes / cron jobs *before* `app.Start()`
4. `go build` → you get *your own* single static binary that still includes everything PocketBase does.

Extension points include lifecycle **event hooks** (e.g. `OnRecordCreate`, `OnRecordAfterUpdateSuccess`, `OnServe`/`OnBootstrap`, request hooks), **custom HTTP routes** registered on `se.Router` inside the serve hook, **scheduled jobs** (cron), **migrations**, direct **DB access**, mailer, template rendering, console commands, and filesystem access. Because it's just a Go program, you can layer in arbitrary business logic and still ship one file.

**(B) JavaScript hooks via `goja` (no Node required).** The prebuilt executable (since v0.17) embeds **goja**, a pure-Go ES5 JavaScript interpreter. You drop `*.pb.js` files into a `pb_hooks/` directory; they're loaded in filename order and can register the same kinds of hooks/routes as the Go API. Key facts:
- Globals exposed: `$app` (app instance), `$apis` (routing/middleware), `$security`, `__hooks` (paths), etc. Go method names become camelCase in JS (`FindRecordById` → `findRecordById`); Go errors become JS exceptions.
- On UNIX, editing files in `pb_hooks/` **auto-restarts/reloads** the process — fast iteration without recompiling.
- Performance: PocketBase keeps a **prewarmed pool of 15 JS runtimes** (tunable with `--hooksPool`) so per-request hook latency stays close to native Go. Larger pools cost more RAM.
- Limits inherited from goja: ES5-ish (incomplete ES6), no `setTimeout`/`setInterval`/concurrency inside handlers, and some friction with wrapped Go types (e.g. needing `get()`/`set()` for JSON fields).

The "JS for quick logic, Go for serious extension, neither requires forking" split is itself a lightness strategy — most users never compile anything.

## 6. Auth & files

**Auth (built-in, stateless).** Authentication is a first-class part of the data model: "auth collections" (e.g. `users`, plus the special `_superusers`) carry credentials and identity fields. Mechanisms:
- **Password / identity** auth (email by default, or any unique field such as username).
- **OAuth2** with many providers configurable from the admin UI — Google, GitHub, Microsoft, GitLab, Apple, Discord, Facebook, Twitter/X, Spotify, and others (dozens supported).
- **OTP** (one-time password emailed to the user; returns an `otpId`, auto-verifies email on success).
- **MFA** (v0.23+): require any two distinct auth methods; first success returns an `mfaId` that the second method must present.

Tokens are **stateless HS256 JWTs**: a client is authenticated as long as it sends a valid `Authorization` header. There are **no server-side sessions and tokens are not stored in the DB** — "logout" is just discarding the token client-side. There's an auth-refresh endpoint for new claims. For server-to-server/API-key use cases, a superuser can mint a non-renewable `_superusers` impersonation token. Statelessness = no session store = less to run, consistent with the overall thesis.

**Files.** File fields attach binaries to records via `multipart/form-data`. Storage backends:
- **Local filesystem** (`pb_data/storage/`) by default — recommended for speed and simple backup.
- **S3-compatible** (AWS S3, MinIO, Wasabi, DigitalOcean Spaces, etc.), configured in the admin UI, for when local disk is constrained.

Uploaded files keep a sanitized original filename plus a ~10-char random suffix. Multi-file fields use `+` (append) / `-` (delete by filename) modifiers. **Image thumbnails** are generated on demand via `?thumb=WxH` with crop/fit variants (`WxHt`, `WxHb`, `WxHf`, `0xH`, `Wx0`) for jpg/png/gif (partial webp). **Protected files** require a short-lived (~2 min) file token (`pb.files.getToken()`) and are gated by the collection's view rule.

## 7. Scalability model & limits

**Single-node by design.** PocketBase is fundamentally a one-process, one-machine system. SQLite-in-process and the in-memory realtime broker both assume a single writer/owner of the data, so there is no built-in horizontal scaling or clustering. This is an intentional tradeoff, not an oversight — it's what buys the simplicity.

**Vertical scaling is the primary lever.** You scale up (more CPU/RAM/faster disk), not out. WAL mode means reads scale well (many concurrent readers); writes serialize through a single writer, which is the main throughput limit. In practice SQLite handles surprisingly high read/write rates for typical app workloads on one box.

**What happens under load:**
- Many concurrent realtime (SSE) clients consume file descriptors; raise `ulimit -n` / systemd `LimitNOFILE` to avoid "Too many open files."
- Memory pressure: set `GOMEMLIMIT` to make Go's GC more aggressive in constrained environments and avoid OOM kills.
- Write contention surfaces as `SQLITE_BUSY`, mitigated by `busy_timeout` + PocketBase's application-level retry, but heavy concurrent writes are the ceiling.
- A built-in **rate limiter** exists (v0.23.0+) to blunt abuse; a reverse proxy can add more.

**Replication / HA (not built in).** The official production guide does **not** ship or endorse a replication mechanism. The community pattern is to bolt on SQLite streaming-replication tools — **Litestream** (continuous WAL shipping to S3 for point-in-time backup/restore) or **LiteFS** (a FUSE-based replicated SQLite filesystem) — but these are external and add real complexity, and LiteFS-style read replicas don't make PocketBase's *realtime* or *writes* multi-node. Treat HA as "fast restore from a streamed backup," not "active-active cluster."

**Backups.** Built-in backup API produces full `pb_data` ZIP snapshots, but it briefly sets the app read-only and is discouraged for large (2 GB+) datasets; for those, use `sqlite3 .backup` + `rsync` (or Litestream).

**Honest limit:** if you need multi-region active-active, horizontal write scaling, or millions of concurrent realtime clients, PocketBase is the wrong tool. Its sweet spot is anything that comfortably fits one well-provisioned node.

## 8. Deployment & footprint

- **Footprint:** a single executable, ~11–12 MB (v0.39.5), per OS/arch. RAM usage is modest at idle; grows with the JS runtime pool (15 × goja by default) and the number of open SSE connections.
- **Deploy:** download/scp the binary + run `./pocketbase serve` (commonly behind a reverse proxy for TLS, or use the built-in Let's Encrypt option). No Docker required (though images exist), no DB to provision, no migrations service, no message broker. State is just the `pb_data/` directory.
- **Cross-platform / cross-compile:** because the default build is CGO-free pure Go, `GOOS`/`GOARCH` cross-compilation "just works," which is why prebuilt binaries exist for Linux/macOS/Windows/FreeBSD on x64 and ARM64.
- **Custom builds:** extending in Go yields the *same* deployment story — one self-contained binary you produced with `go build`.

## 9. Developer experience (DX)

- **Admin dashboard UI:** a Svelte SPA embedded in the binary, served at `/_/`. First run prompts you to create a superuser. You design collections/schema, set API rules, browse/edit records, configure auth providers and S3, view logs, run backups — all visually. Time-to-first-working-API is essentially "download, run, click to make a collection," on the order of a few minutes.
- **Auto API + no boilerplate:** defining a collection instantly gives you secured CRUD + realtime + file handling with no server code.
- **Official client SDKs:** **JavaScript** (browser, Node.js, React Native — works with React/Vue/Svelte/vanilla) and **Dart** (Flutter web/mobile/desktop/CLI). SDKs wrap auth, CRUD, filters, realtime subscriptions, and file URLs/thumbnails.
- **Fast iteration:** JS hooks in `pb_hooks/` hot-reload on save (UNIX); Go users get one `go build`.
- **Zero-to-working** is the headline DX win — there is no provisioning, no schema migration tooling to learn before you start, and no separate services to boot.

## 10. The ONE transferable idea

**Collapse the whole backend into one in-process binary with an embedded database, and make the database in-process rather than networked.** The dominant cost and complexity in conventional backends comes from the *seams* between services — app server ↔ database ↔ cache/pub-sub ↔ object store ↔ auth service ↔ admin tool — each a separate process, network hop, config file, credential, and failure domain. PocketBase deletes those seams by linking everything into one Go process where the database is a function call away. For a "lightweight tier" in a new system, the borrowable move is: **default to an embedded engine (SQLite) running in the same process as your API, ship it as a single artifact with a self-creating data directory, and only introduce out-of-process services when a real scaling wall forces it.** You trade horizontal scalability for an enormous reduction in operational and cognitive surface — and for most apps that trade is correct.

Secondary transferable ideas worth stealing: (1) **declarative per-collection access rules** that secure REST and realtime from one source of truth instead of hand-written middleware; (2) **SSE over WebSockets** for realtime when you want plain-HTTP simplicity and proxy compatibility; (3) **an embedded pure-Go scripting engine (goja) with a prewarmed runtime pool** so users extend behavior without a separate language runtime or recompile.

## 11. Weaknesses / limits / things to avoid

- **Single-node ceiling.** No clustering, no horizontal write scaling, no native HA. One box is the whole system. Realtime and writes cannot be spread across nodes.
- **Realtime is in-process only.** Out-of-band DB writes don't emit events; you can't fan realtime across multiple instances without building your own bus. Concurrent SSE clients are bounded by file descriptors and RAM.
- **SQLite write contention.** Single-writer model means write-heavy/high-concurrency-write workloads serialize; expect `SQLITE_BUSY` pressure at the top end despite WAL + retries.
- **Pre-1.0 / breaking changes.** No backward-compatibility guarantee before v1.0.0; upgrades can require migration. Read the changelog before bumping.
- **Bus-factor / scope.** Primarily a single-maintainer project with deliberately bounded scope; don't expect enterprise features (multi-tenant clustering, fine-grained RBAC beyond rules, etc.).
- **Backup gotchas at scale.** Built-in ZIP backup goes read-only and is discouraged for 2 GB+ datasets; you must adopt `sqlite3 .backup`/`rsync`/Litestream yourself, and replication is an external bolt-on with its own complexity.
- **JS hook constraints.** goja is ES5-ish, no real async/concurrency, some Go-type friction; heavy logic belongs in Go, not `pb_hooks`.
- **Not a Postgres replacement.** No advanced SQL features, extensions, or analytical workloads at large scale; complex relational/analytics needs outgrow it.
- **Vendor-shaped data model.** Collections + rules are convenient but somewhat opinionated; very custom schemas or non-CRUD access patterns fight the grain.

## 12. Sources

- [PocketBase Docs — Introduction / How to use](https://pocketbase.io/docs/)
- [PocketBase GitHub repository (README, source)](https://github.com/pocketbase/pocketbase)
- [Docs — Extend with Go (Overview)](https://pocketbase.io/docs/go-overview/)
- [Docs — Extend with JavaScript (Overview / goja)](https://pocketbase.io/docs/js-overview/)
- [Docs — Web API: Records (REST, filtering, expand, rules)](https://pocketbase.io/docs/api-records/)
- [Docs — Web API: Realtime (SSE)](https://pocketbase.io/docs/api-realtime/)
- [Docs — Authentication](https://pocketbase.io/docs/authentication/)
- [Docs — Files handling (storage, thumbnails, protected files)](https://pocketbase.io/docs/files-handling/)
- [Docs — Going to production (scaling, FDs, backups, rate limiting)](https://pocketbase.io/docs/going-to-production/)
- [GitHub Discussion #5579 — How does realtime actually work (app-level monitoring)](https://github.com/pocketbase/pocketbase/discussions/5579)
- [GitHub Discussion #5107 — How does subscription work (SSE GET, PB_CONNECT)](https://github.com/pocketbase/pocketbase/discussions/5107)
- [GitHub Discussion #2448 — Architecture overview (data.db + auxiliary.db, WAL pragmas, modernc driver)](https://github.com/pocketbase/pocketbase/discussions/2448)
- [PocketBase JS SDK](https://github.com/pocketbase/js-sdk) · [Dart SDK](https://github.com/pocketbase/dart-sdk)
- [Better Stack — What is PocketBase? Features, Limitations, Use Cases](https://betterstack.com/community/guides/database-platforms/pocketbase-backend/)
- [DevTech Insights — The One-File Backend: Scaling a SaaS on SQLite & PocketBase](https://devtechinsights.com/sqlite-pocketbase-saas-architecture/)
