---
title: Self-Hosted
---

# Self-Hosted (Railway, Fly.io, etc.)

> Run Stackbase on any platform that supports Bun or Node.

Run Stackbase on any platform that supports Bun or Node with persistent storage (Railway, Fly.io, VPS, etc.).

## The model

Any platform that can run a long-lived HTTP server with WebSocket support can host Stackbase. You
run the **`stackbase serve` CLI** — there is no server to write. You'll need persistent disk for
SQLite and blob storage.

## Quick start

```bash
STACKBASE_ADMIN_KEY=$(openssl rand -hex 32) \
  stackbase serve --dir ./convex --data ./data/db.sqlite --port 3000
```

`serve` binds `0.0.0.0`, requires `STACKBASE_ADMIN_KEY` (it refuses to start without one), never
runs codegen (commit your `convex/_generated/` first), and shuts down gracefully on
`SIGTERM`/`SIGINT`. It serves the sync WebSocket, `/api/*`, your `httpAction` routes, and the
dashboard at `/_dashboard` on the same port.

**Node note:** Bun is the primary runtime. On Node, use 22.5+ with the `--experimental-sqlite` flag.

## Storage backends

Storage is selected by flag or environment variable — not by composing adapters in code. The
engine never imports a driver directly.

```bash
# SQLite on local disk (default — no flag needed)
stackbase serve --dir ./convex --data ./data/db.sqlite

# Postgres (or STACKBASE_DATABASE_URL)
stackbase serve --dir ./convex --database-url postgres://user:pass@host:5432/db
```

### S3-compatible blob storage

File storage ([`ctx.storage`](/files)) uses local disk by default. Point it at any S3-compatible
bucket (AWS S3, MinIO, R2) with `--storage-bucket` / `--storage-endpoint` (or
`STACKBASE_STORAGE_BUCKET` / `STACKBASE_STORAGE_ENDPOINT`); credentials come from
`AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY`:

```bash
stackbase serve --dir ./convex --data ./data/db.sqlite \
  --storage-bucket my-bucket \
  --storage-endpoint https://s3.us-east-1.amazonaws.com
```

## Deployment checklist

1. **Commit `convex/_generated/`** - `serve` fails fast if it's missing
2. **Set `STACKBASE_ADMIN_KEY`** - required; `serve` won't start without it
3. **Persist data directory** - SQLite database and blob files must survive restarts
4. **Expose HTTP + WebSocket** - Both protocols on the same port
5. **Configure health checks** - Use `GET /api/health`
6. **Set up reverse proxy** - Stackbase serves plain HTTP; front it with nginx/Caddy/Traefik for TLS

## Platform guides

### Railway

```toml
# railway.toml
[build]
builder = "nixpacks"

[deploy]
startCommand = "stackbase serve --dir ./convex --data /app/data/db.sqlite"
healthcheckPath = "/api/health"
healthcheckTimeout = 30

[[mounts]]
source = "data"
destination = "/app/data"
```

### Fly.io

```toml
# fly.toml
app = "my-stackbase-app"
primary_region = "iad"

[build]
builder = "heroku/buildpacks:20"

[mounts]
source = "data"
destination = "/app/data"

[http_service]
internal_port = 3000
force_https = true

[[http_service.checks]]
interval = "10s"
timeout = "2s"
path = "/api/health"
```

Set `STACKBASE_ADMIN_KEY` as a secret (`fly secrets set` / Railway variables), never in the file.

### Docker

The repo ships a `Dockerfile` whose `runner` stage already runs `stackbase serve` as its
entrypoint — see [Docker self-hosting](/self-hosting) for the `docker compose up` path and the
bake-into-image alternative for immutable deploys.

## Environment variables

| Variable | Description | Default |
|----------|-------------|---------|
| `STACKBASE_ADMIN_KEY` | **Required.** `serve` refuses to start without it. | none |
| `STACKBASE_DATABASE_URL` | Postgres connection string (equivalent to `--database-url`) | unset → SQLite |
| `STACKBASE_STORAGE_BUCKET` / `STACKBASE_STORAGE_ENDPOINT` | S3-compatible blob storage (if used) | unset → local disk |
| `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` | Credentials for S3 blobstore (if used) | none |

---

## Scaling considerations

### Current limitations

A default `stackbase serve` node is a **single-instance deployment**:

| Constraint | Reason | Impact |
|------------|--------|--------|
| Single writer | SQLite needs exclusive file access; Postgres enforces it with an advisory lock | A second node against the same database fails fast rather than corrupting state |
| Stateful server | WebSocket connections are per-server | Can't naively load balance connections |
| Local storage | Blobs stored on disk by default | Requires a persistent volume (or use S3-compatible storage) |

### Scaling options

**For higher load:**
1. **Vertical scaling** - Use a larger instance (more CPU, RAM). This goes further than you'd expect.
2. **Postgres** - `--database-url` moves durability off local disk. Still a single writer.
3. **Object-storage substrate** - `--object-store` puts an S3-compatible bucket at the root of truth.

For a full target architecture (router + sync shards + transactor + change stream), see the
[Scaling blueprint](/deploy/scaling).

---

## Common questions

- **Is this officially supported?** Yes — self-hosting is the baseline deployment story, and
  single-node self-host is free forever.
- **Which platform should I pick?** Any that supports persistent disks and WebSockets.
- **Can I use managed databases?** Yes — Postgres is supported via `--database-url` /
  `STACKBASE_DATABASE_URL`. There are no app-level migrations; the schema is physically schemaless.
  Blob storage can use any S3-compatible bucket.
- **How do I handle multiple instances?** A plain `serve` node is single-writer by design. See the
  [Scaling blueprint](/deploy/scaling).
- **Do I need to write a server file?** No. `stackbase serve` is the entrypoint; there is no
  `createStackbase` API.

---

