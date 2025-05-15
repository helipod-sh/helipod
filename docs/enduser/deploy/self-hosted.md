---
title: Self-Hosted
---

# Self-Hosted (Railway, Fly.io, etc.)

> Run Stackbase on any platform that supports Bun or Node.

Run Stackbase on any platform that supports Bun or Node with persistent storage (Railway, Fly.io, VPS, etc.).

## The model

Any platform that can run a long-lived HTTP server with WebSocket support can host the Bun or Node runtime. You'll need persistent disk for SQLite and blob storage.

## Quick start

### Bun runtime

```ts
import { createStackbase } from "@stackbase/runtime-bun";

const server = createStackbase({
  convexDir: "./convex",
});
await server.listen({ port: 3000 });

console.log(`Server running at ${server.url}`);
```

### Node runtime

```ts
import { createStackbase } from "@stackbase/runtime-node";

const server = createStackbase({
  convexDir: "./convex",
});
await server.listen({ port: 3000, hostname: "127.0.0.1" });

console.log(`Server running at ${server.url}`);
```

**Node note:** Run with `--experimental-sqlite` flag (Node 22.5+).

## Advanced configuration

For more control, pass explicit adapters:

```ts
import { createStackbase, SqliteDocStore, FsBlobStore } from "@stackbase/runtime-bun";

const server = createStackbase({
  convexDir: "./convex",
  docstore: ({ runtime }) => new SqliteDocStore(`./data/${runtime}.sqlite`),
  blobstore: () => new FsBlobStore("./data/files"),
  schema: "auto", // or "skip" to avoid schema.ts loading at boot
});
await server.listen({ port: 8080, hostname: "0.0.0.0" });
```

### Custom storage backends

Use S3-compatible storage for blobs:

```ts
import { createStackbase, S3BlobStore } from "@stackbase/runtime-bun";

const server = createStackbase({
  convexDir: "./convex",
  blobstore: () =>
    new S3BlobStore({
      bucket: "my-bucket",
      endpoint: "https://s3.us-east-1.amazonaws.com",
      accessKeyId: process.env.AWS_ACCESS_KEY_ID,
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    }),
});
```

## Deployment checklist

1. **Persist data directory** - SQLite database and blob files must survive restarts
2. **Expose HTTP + WebSocket** - Both protocols on the same port
3. **Set environment variables** - Any secrets your app needs
4. **Configure health checks** - Use `GET /health`
5. **Set up reverse proxy** - For TLS termination if needed

## Platform guides

### Railway

```toml
# railway.toml
[build]
builder = "nixpacks"

[deploy]
startCommand = "bun run server.ts"
healthcheckPath = "/health"
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
path = "/health"
```

### Docker

```dockerfile
FROM oven/bun:1

WORKDIR /app
COPY package.json bun.lockb ./
RUN bun install --frozen-lockfile

COPY . .

VOLUME /app/data
EXPOSE 3000

CMD ["bun", "run", "server.ts"]
```

## Environment variables

| Variable | Description | Default |
|----------|-------------|---------|
| `PORT` | Server port | `3000` |
| `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` | Credentials for S3 blobstore (if used) | none |
| `AWS_REGION` | Region for S3-compatible endpoints (if used) | none |

---

## Scaling considerations

### Current limitations

The Bun and Node.js runtimes are designed for **single-instance deployments**:

| Constraint | Reason | Impact |
|------------|--------|--------|
| Single instance | SQLite requires exclusive file access | No horizontal scaling |
| Stateful server | WebSocket connections are per-server | Can't load balance connections |
| Local storage | Blobs stored on disk by default | Requires persistent volume |

### Scaling options

**For higher load:**
1. **Vertical scaling** - Use a larger instance (more CPU, RAM)
2. **Cloudflare deployment** - DO-based architecture scales automatically
3. **Custom docstore adapter** - Implement with Postgres for multi-instance support

For a full target architecture (router + sync shards + transactor + change stream) on Fly.io/Railway and similar platforms, see the [Scaling blueprint](/deploy/scaling).

**For high availability:**
1. **Cloudflare Workers** - Built-in redundancy and edge distribution
2. **Database replication** - Use Hyperdrive adapter with replicated Postgres

### When to use Cloudflare instead

Consider Cloudflare Workers deployment when:
- You need horizontal scaling
- You want edge distribution
- You need high availability without managing infrastructure
- Traffic exceeds what a single instance can handle

---

## Common questions

- **Is this officially supported?** Cloudflare Workers is the primary target; self-hosting works via Bun/Node runtimes.
- **Which platform should I pick?** Any that supports persistent disks and WebSockets.
- **Can I use managed databases?** Not yet for the docstore; SQLite is required. Blob storage can use S3.
- **How do I handle multiple instances?** Single-instance only; the SQLite docstore doesn't support multi-node deployments. For scaling, use Cloudflare Workers or implement a custom Postgres-backed docstore.

---

