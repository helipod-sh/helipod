# Stackbase

A Convex-compatible, self-hostable reactive backend. Write TypeScript query/mutation functions, run them server-side and transactionally, and get **reactive** results — when the underlying data changes, subscribed clients are pushed updates over a WebSocket. **Lightweight by default, scalable on demand** — the same app code runs as a single binary on a $5 VPS or (eventually) as a distributed fleet (see [docs/dev/architecture/scalability-spectrum.md](docs/dev/architecture/scalability-spectrum.md)).

> Status: **pre-1.0, but working end-to-end.** The reactive engine and Tier 0 production tooling are built and tested on both Node and Bun. Distributed Tier 2 and search/vector remain deferred. Architecture lives in [docs/dev/architecture/](docs/dev/architecture/); this is a clean-room implementation (see [CLAUDE.md](CLAUDE.md)).

## What works today

- **Reactive core** — MVCC document-log storage, a single-writer OCC transactor, a query engine with cursor pagination, and range-precise subscription invalidation: a write only re-runs the subscriptions whose read-set it intersects. No polling.
- **Pluggable storage** — everything rides a narrow `DocStore` seam. Ships **embedded SQLite** (zero-config, single-file, the default) and **Postgres** (single-node, opt-in via a connection string, no app-schema migrations). The engine never learns which database it's on.
- **The `stackbase` CLI** — `dev` (watch + hot-reload + serve sync/HTTP), `serve` (production entrypoint), `deploy` (live hot-swap onto a running server), `build` (compile the app to a single self-contained binary), and typed `codegen`.
- **Client SDK** — framework-agnostic client + `useQuery`/`useMutation`/`useAction` React hooks over the WebSocket sync protocol, plus a fully typed `api` from codegen.
- **Dashboard** ([apps/dashboard](apps/dashboard)) — a live data browser (reactive via admin subscriptions, cursor pagination, structured filters), a logs viewer, and a function runner.
- **Functions beyond queries/mutations** — `action`s (side-effect escape hatch that runs outside the transaction: `fetch`, clock, `ctx.runQuery`/`runMutation`/`runAction`), `httpAction` + an `httpRouter()` for webhooks/custom HTTP endpoints.
- **Pluggable components** ([components/](components/)) — opt-in per project via `stackbase.config.ts`: **auth**, **authz**, **scheduler** (`ctx.scheduler.runAfter`/`runAt`, crons, retries/backoff), and **workflow** (durable multi-step workflows with deterministic replay, `waitForEvent`, and saga/compensation).
- **File storage** — always-on (not opt-in): a `_storage` system table + `Id<"_storage">` + `ctx.storage`, on a pluggable `BlobStore` seam (**embedded filesystem**, zero-config default, or **S3-compatible object storage** for scale). Two-phase uploads (proxied through the engine on FS, presigned direct-to-bucket on S3), private-by-default bearer-token serving, and a background reaper that reclaims abandoned/deleted blobs. See [docs/enduser/files.md](docs/enduser/files.md).
- **Self-host** — `docker compose up` brings up the engine + dashboard on a persistent volume; a single-binary build embeds everything but the database file.

## Measured performance

A single **1-vCPU / 512MB container of the shipped image serves 2,000 live reactive subscribers at ~12% CPU** (~102ms hot-push p50, ~21KB RSS per connection, disconnect-storm recovery in the reconnect window), and fleet nodes add horizontally with proven cgroup isolation (hammering one node moves its neighbors by −0.7%) and 15–16ms cross-node propagation. Measured, not estimated — the numbers come from a committed benchmark suite that boots the repo's own `Dockerfile` image under enforced cpu/memory budgets, and each finding documents its own limits (the capacity run hit Docker Desktop's port-forward ceiling before the node's; all containers shared one host — no multi-machine claim is made).

- [benchmarks/docs/docker-fleet-findings.md](benchmarks/docs/docker-fleet-findings.md) — the budget capacity table, isolation proof, and WAN-latency multipliers
- [benchmarks/docs/connections-findings.md](benchmarks/docs/connections-findings.md) — single-node connection scale (10,000 subscribers/node measured clean)
- [benchmarks/docs/fleet-connections-findings.md](benchmarks/docs/fleet-connections-findings.md) — multi-node fleet behavior: cross-node latency, failover, parallelization

Reproduce with `bun run bench:dockerfleet` (requires Docker); baselines are committed under [benchmarks/baselines/](benchmarks/baselines/).

## Repository layout

```
packages/            # the engine, in dependency order (see design §3)
  values/            # Convex-compatible value system, validators, schema
  errors/            # structured engine error hierarchy
  id-codec/          # document/index id + storage-id encoding
  index-key-codec/   # order-preserving index-key encoding
  docstore/          # the storage seam (async DocStore contract)
  docstore-sqlite/   # SQLite adapter — embedded, zero-config default
  docstore-postgres/ # Postgres adapter — single-node, opt-in via --database-url
  transactor/        # single-writer OCC transaction manager
  query-engine/      # query execution + cursor pagination
  executor/          # isolate-safe syscall executor
  sync/              # reactive subscription tier (subscribe → write → push)
  runtime-embedded/  # embedded runtime + loopback/WebSocket transports
  component/         # component composition (namespaced tables, driver seam)
  blobstore/         # the byte-storage seam (async BlobStore contract)
  blobstore-fs/      # filesystem blob adapter — embedded, zero-config default
  blobstore-s3/      # S3-compatible blob adapter — any bucket, opt-in via --storage-bucket
  storage/           # _storage system table + ctx.storage facade + upload/serve HTTP routes + orphan reaper
  codegen/           # typed Doc/Id/api generation
  admin/             # admin API (data browser, deploy)
  client/            # framework-agnostic client + React hooks
  cli/               # the stackbase CLI (dev / serve / deploy / build / codegen)
components/          # pluggable, opt-in via stackbase.config.ts
  auth/  authz/  scheduler/  workflow/
apps/
  dashboard/         # live data browser, logs, function runner
examples/
  chat/  auth-demo/  # runnable sample apps that double as integration tests
docs/
  enduser/           # public product docs (the eventual docs site)
  dev/               # engineering: architecture, research, clean-room internals
  superpowers/       # design specs + implementation plans
```

## Develop

Requires **[Bun](https://bun.com) ≥ 1.2** (the package manager + runtime). Node ≥ 22 is a fully-supported *target*, but the dev workflow runs on Bun.

```bash
bun install         # bootstrap the workspace
bun run build       # build every package (Turborepo, topological)
bun run test        # run all tests (vitest, under Node)
bun run typecheck   # tsc --noEmit across packages
bun run dev         # watch mode
```

Single package, e.g. just the value system:

```bash
bun run --filter @stackbase/values test
bun run --filter @stackbase/values test compare   # one test name/file filter
```

## The `stackbase` CLI

```bash
stackbase dev        # local: watch functions, hot-reload, serve sync + HTTP + dashboard
stackbase serve      # production: requires STACKBASE_ADMIN_KEY, binds 0.0.0.0, graceful shutdown
stackbase deploy     # hot-swap functions + additive schema onto a running `serve` (opt-in)
stackbase build      # compile the app to a single self-contained binary
stackbase codegen    # regenerate the typed api / Doc / Id types
```

## Run (Tier 0)

```bash
docker compose up        # one container, one volume — embedded SQLite (zero config)
```

`stackbase serve` is the production entrypoint (requires `STACKBASE_ADMIN_KEY`); `docker compose up` runs it against a bind-mounted `convex/` with a persistent SQLite volume.

### Storage: SQLite (default) or Postgres

SQLite is the zero-config default and needs nothing. To use **Postgres** instead — same app code, no schema migrations — point the server at a connection string:

```bash
stackbase serve --database-url postgres://user:pass@host:5432/db
# or
STACKBASE_DATABASE_URL=postgres://user:pass@host:5432/db stackbase serve
```

Postgres is a **single-node** backend (one engine per database — a second fails fast on a single-writer advisory lock); it is durable networked storage, not clustering. See [docs/enduser/self-hosting.md](docs/enduser/self-hosting.md) for a `docker compose` Postgres service, the persistence model, and known limitations.

### File storage: filesystem (default) or S3/R2

File storage is always on — no opt-in needed. The filesystem backend is the zero-config default (`<data-dir>/storage`); point at an S3-compatible bucket instead — same `ctx.storage` app code either way — via flag or env var:

```bash
stackbase serve --storage-bucket my-app-uploads --storage-endpoint https://s3.us-east-1.amazonaws.com
# or
STACKBASE_STORAGE_BUCKET=my-app-uploads stackbase serve
```

`STACKBASE_STORAGE_ENDPOINT`/`STACKBASE_STORAGE_REGION`/`STACKBASE_STORAGE_PUBLIC_URL` plus the standard `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY` round out the S3 config (flags win over env, same convention as `--database-url`). See [docs/enduser/files.md](docs/enduser/files.md) for the full guide, including the upload flow and the private-by-default access model.

## License

MIT.
