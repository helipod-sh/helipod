---
title: Docker Self-Hosting
---

# Docker Self-Hosting

> `docker compose up` — the whole Stackbase backend, one container, one volume.

This is the baseline self-host path: a generic `stackbase:latest` image (built from the repo's
`Dockerfile`) running `stackbase serve`, with your app's `convex/` bind-mounted in and its SQLite
database on a named volume so data survives container restarts.

## Prerequisites

- A `convex/` directory with **committed `_generated/`**. `serve` never runs codegen — it fails
  fast if `convex/_generated/server.ts` is missing. Run codegen before building/deploying:

  ```bash
  bun run build
  bun packages/cli/dist/bin.js codegen --dir convex
  # or, once the CLI is installed as `stackbase`:
  stackbase codegen --dir convex
  ```

- Docker and Docker Compose.

## 1) Set a strong admin key

`stackbase serve` refuses to start without `STACKBASE_ADMIN_KEY` — there is no default, and unlike
`stackbase dev` it never embeds the key into the dashboard HTML. Put it in a `.env` file next to
`docker-compose.yml` (Compose loads `.env` automatically):

```bash
# .env
STACKBASE_ADMIN_KEY=$(openssl rand -hex 32)
```

## 2) `docker compose up`

From the repo root:

```bash
docker compose up
```

This builds the image (`target: runner` in the `Dockerfile`), starts the container, binds it to
`0.0.0.0:3000`, bind-mounts `./convex` read-only into `/app/convex`, and persists SQLite on the
`stackbase-data` named volume at `/data/db.sqlite`. The container command is:

```
serve --dir /app/convex --data /data/db.sqlite
```

## 3) Open the dashboard

The dashboard is served at **`http://localhost:3000/_dashboard`**. Because the admin key is never
baked into the served HTML in `serve` mode, the SPA prompts you for it on load — paste the value
you set in `.env`. The API itself is reachable at `http://localhost:3000` (sync WebSocket, `/api/*`
HTTP, `httpAction` routes).

## 4) Data persistence

The SQLite database lives on the `stackbase-data` Docker volume, not inside the container. Stopping
and restarting the container (`docker compose down && docker compose up`) does not lose data — only
`docker compose down -v` (which explicitly deletes volumes) does. See the smoke check below to
verify this yourself.

## Alternative: bake the app into an immutable image

The default compose file bind-mounts `convex/` at run time, which is convenient for local
self-hosting but means the image alone isn't a deployable artifact. For an immutable image (e.g. to
push to a registry and deploy elsewhere), build a small wrapper `Dockerfile` on top of
`stackbase:latest` that copies your app in instead of mounting it:

```dockerfile
FROM stackbase:latest
COPY ./convex /app/convex
# ENTRYPOINT/CMD are inherited from stackbase:latest (serve --dir /app/convex --data /data/db.sqlite)
```

Build and run it without a bind mount:

```bash
docker build -t myapp:latest .
docker run -p 3000:3000 -e STACKBASE_ADMIN_KEY=... -v stackbase-data:/data myapp:latest
```

## Using Postgres

SQLite is the zero-config default — the sections above work as-is with no extra setup. Postgres is
an **opt-in** alternative storage backend for when you want a managed database (durability,
backups, replicas managed outside the container) instead of the SQLite file on a Docker volume.

Point `serve` at a Postgres database with the `--database-url` flag or the `STACKBASE_DATABASE_URL`
environment variable (the flag wins if both are set):

```bash
# flag
stackbase serve --dir convex --database-url postgres://user:pass@host:5432/db

# or env var
STACKBASE_DATABASE_URL=postgres://user:pass@host:5432/db stackbase serve --dir convex
```

Leave both unset and `serve` falls back to SQLite (`--data`/`db.sqlite`) exactly as described above.

### Compose with a `postgres:16` service

Add a `postgres` service to `docker-compose.yml` and drop the `--data` flag / SQLite volume in favor
of `STACKBASE_DATABASE_URL`:

```yaml
services:
  stackbase:
    build:
      context: .
      target: runner
    ports:
      - "3000:3000"
    volumes:
      - ./convex:/app/convex:ro
    environment:
      STACKBASE_ADMIN_KEY: ${STACKBASE_ADMIN_KEY}
      STACKBASE_DATABASE_URL: postgres://stackbase:stackbase@postgres:5432/stackbase
    command: serve --dir /app/convex
    depends_on:
      - postgres

  postgres:
    image: postgres:16
    restart: unless-stopped
    environment:
      POSTGRES_USER: stackbase
      POSTGRES_PASSWORD: stackbase
      POSTGRES_DB: stackbase
    volumes:
      - postgres-data:/var/lib/postgresql/data

volumes:
  postgres-data:
```

`docker compose up` now persists to the `postgres-data` named volume instead of `stackbase-data`;
the rest of the guide (admin key, dashboard, `docker compose down`/`up` persistence) applies
unchanged.

### Single-writer constraint

Exactly **one** Stackbase engine may be connected to a given Postgres database at a time. On boot,
the engine takes a `pg_advisory_lock`; a second `serve`/`dev` process pointed at the same database
fails fast with an error instead of silently corrupting state. This is a **single-node durability**
story — a stronger, externally-managed database for a single writer — **not** clustering or
multi-node write scale-out. Running two engines against the same Postgres database for high
availability is not supported; that's out of scope until the distributed-sync tier.

### No schema migrations

The Postgres adapter is **physically schemaless**: it stores documents in a small, fixed set of
internal tables (the same MVCC-log shape the SQLite adapter uses), so your app's tables and fields
are *data*, not DDL. Adding a table, adding a field, or changing your `schema.ts` as the app evolves
needs no `ALTER TABLE`/migration step against Postgres — the physical schema never changes shape
underneath you.

### Known limitations

- **Single pinned connection, no automatic reconnect.** The engine holds exactly one Postgres
  connection for its lifetime — the same connection the single-writer advisory lock and
  transaction pinning depend on. If that connection drops (a network blip, a Postgres restart,
  a failover), the engine does **not** transparently reconnect; restart the Stackbase process to
  re-establish it. SQLite, being a local file, has no equivalent failure mode — this is a
  trade-off that comes with talking to Postgres over the network.
- **An unclean process kill can briefly hold the lock.** The single-writer guard is a
  **session-level** `pg_advisory_lock`. A graceful shutdown (`SIGTERM`) releases it immediately.
  But if the process is killed uncleanly (`SIGKILL`, a crash), an immediate restart against the
  same database may briefly fail with "another engine already connected" until Postgres notices
  the dead session and releases the lock — typically within seconds.

Neither of these is a clustering/HA limitation — they're consequences of the single-node,
single-writer durability story already described above, not new constraints on top of it.

## Scaling out (fleet)

Everything above is **single-node**: one `stackbase serve` process, one database. When you need
more than one node — for redundancy, or because one process's write throughput isn't enough —
Stackbase has a first multi-node story built on top of the same Postgres backend described above:
**`stackbase serve --fleet`**. N identical nodes share one Postgres database; the first to grab a
lease becomes the writer, the rest serve reads and forward writes to it, and killing the writer
promotes another node live, with no coordinator service and no per-node role configuration.

See [Fleet (Multi-Node)](/deploy/fleet) for requirements, a 2-node Docker Compose example,
failover behavior, and current limits (single writer, no autoscaler, `ee/`-licensed).

## Reverse proxy / TLS

Stackbase serves plain HTTP — `serve` has no TLS support built in. For a public deployment, put a
reverse proxy (nginx, Caddy, or Traefik) in front of the container to terminate TLS and forward to
`stackbase:3000`. The sync WebSocket and `httpAction` routes both proxy transparently over standard
HTTP upgrade; no special proxy configuration is needed beyond normal WebSocket passthrough.

## Manual smoke check

After any change to the `Dockerfile` or `docker-compose.yml`, verify the whole loop by hand:

```bash
# 1) Bring it up
docker compose up -d

# 2) Health check
curl -f localhost:3000/api/health

# 3) Open the dashboard in a browser, paste the admin key from .env
open http://localhost:3000/_dashboard

# 4) Write some data via the dashboard or a mutation, then restart
docker compose down
docker compose up -d

# 5) Confirm the data is still there (dashboard, or another curl/query)
```

If step 5 shows the data you wrote in step 4, the persistent-volume story works end-to-end.

## Related

- [`stackbase dev`](/local/dev-server) — the local development server (auto-codegen, hot reload,
  embedded admin key). `serve` is its production counterpart: no codegen, `0.0.0.0`, required key,
  graceful shutdown on `SIGTERM`/`SIGINT`.
- [`stackbase deploy`](/deploying) — push functions + additive schema to an already-running `serve`
  deployment, live, no restart. Opt-in per deployment via `--allow-deploy`.
- [Using Postgres](#using-postgres) above — opt-in Postgres storage backend, single-writer guard, no
  migrations needed.
- [Fleet (Multi-Node)](/deploy/fleet) — `stackbase serve --fleet`, multiple nodes over shared
  Postgres, live failover. See [Scaling out (fleet)](#scaling-out-fleet) above.
- TLS termination is not part of this slice — see the repo `CLAUDE.md` for what's shipped vs.
  deferred.
