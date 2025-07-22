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
  bun run --filter @stackbase/cli stackbase codegen --dir convex
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
- Postgres adapter, `stackbase deploy` (push-based deploys), and TLS/multi-node are not part of this
  slice — see the repo `CLAUDE.md` for what's shipped vs. deferred.
