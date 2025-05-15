---
title: Cloudflare (Recommended)
---

# Cloudflare (Recommended)

> Production deployment with Workers + Durable Objects.

Deploy a production Stackbase backend on Cloudflare Workers + Durable Objects.

## Prerequisites

1. A Cloudflare account with Workers Paid plan (required for Durable Objects)
2. Wrangler CLI installed (`npm install -g wrangler`)
3. Authenticated with Cloudflare (`wrangler login`)

## Deploy

```bash
stackbase deploy
```

The CLI will prompt for required Cloudflare settings the first time. Re-runs use saved config.

---

## Required Cloudflare resources

| Resource | Purpose |
|----------|---------|
| **Worker** | HTTP routing (`/api`, `/sync`) |
| **Durable Objects** | Execution (StackbaseDO) + sync state (SyncDO) |
| **D1 or DO SQLite** | Document storage |
| **R2** (optional) | File storage for `ctx.storage` |

---

## Database choice: D1 vs DO SQLite

| Feature | DO SQLite | D1 |
|---------|-----------|-----|
| Setup | Automatic | Requires D1 database creation |
| Scale | Per-DO (good for most apps) | Shared across Workers |
| Cost | Included with DO | Separate D1 billing |
| Best for | Most applications | Large datasets, analytics |

### Cost considerations

| Resource | Free tier | Paid pricing |
|----------|-----------|--------------|
| Workers | 100k requests/day | $5/mo + $0.50/million requests |
| Durable Objects | Included with Workers Paid | $0.15/million requests + storage |
| D1 | 5M rows read/day, 100k writes | $0.001/million rows read |
| R2 | 10GB storage, 10M reads | $0.015/GB storage |

**Recommendation**: Start with DO SQLite (included with Workers Paid). Move to D1 if you need larger datasets or want separate database scaling.

See [Cloudflare pricing](https://developers.cloudflare.com/workers/platform/pricing/) for current rates.

**Default**: DO SQLite (no extra setup required)

**To use D1**: Create a database and add it to `cloudflare.storage`:

```bash
wrangler d1 create stackbase-db
```

```ts
// stackbase.config.ts
export default {
  cloudflare: {
    storage: {
      docstore: { type: "d1", databaseName: "stackbase-db", databaseId: "your-id" },
    },
  },
} as const;
```

---

## Environment variables

Set environment variables for your deployment:

```bash
# Via wrangler
wrangler secret put MY_SECRET

# Or in stackbase.config.ts for non-sensitive values
const config: StackbaseConfig = {
  vars: {
    PUBLIC_API_URL: "https://api.example.com"
  }
};
```

Access in your functions:

```ts
export const myAction = action({
  handler: async (ctx) => {
    const secret = process.env.MY_SECRET;
  }
});
```

---

## CLI deploy flags

```bash
# Deploy to Cloudflare (default)
stackbase deploy

# Deploy to specific environment
stackbase deploy --env production
stackbase deploy --env staging

# Custom worker name
stackbase deploy --name my-app-backend

# Preview without deploying
stackbase deploy --dry-run

# Force rebuild
stackbase deploy --force
```

---

## R2 file storage

To use `ctx.storage` for file uploads, add an R2 bucket:

```bash
wrangler r2 bucket create stackbase-storage
```

```ts
// stackbase.config.ts
export default {
  cloudflare: {
    storage: {
      blobstore: { type: "r2", bucketName: "stackbase-storage" },
    },
  },
} as const;
```

## Recommended config surface

```ts
export default {
  cloudflare: {
    deploy: {
      workersDev: true,
      placement: { mode: "smart" },
    },
    storage: {
      docstore: { type: "d1", databaseName: "stackbase-db", databaseId: "your-id" },
      blobstore: { type: "r2", bucketName: "stackbase-storage" },
      reads: "replica",
    },
    execution: {
      strategy: "auto",
    },
    sync: {
      topology: "global-auto",
      defaultRegion: "iad",
      autoShardsPerRegion: 2,
    },
  },
} as const;
```

---

## Compatibility flags

Required flags for Node.js compatibility:

```ts
// stackbase.config.ts
const config: StackbaseConfig = {
  compatibilityDate: "2025-10-01",
  compatibilityFlags: ["nodejs_compat", "nodejs_als"]
};
```

---

## Custom domains

After deploying, add a custom domain via the Cloudflare dashboard:

1. Go to Workers & Pages > your worker
2. Settings > Triggers > Custom Domains
3. Add your domain

Update your client to use the new URL:

```ts
const client = new ConvexReactClient("https://api.yourapp.com");
```

---

## Worker Loader (advanced)

For multi-tenant deployments requiring per-tenant isolation, a Worker Loader can run user code in sandboxed isolates and block outbound network access.

See `@stackbase/runtime-cloud` for the multi-tenant runtime.

## Scaling blueprint

For autoscaling sync shards, coordinator design, and change stream patterns on Cloudflare, see the [Scaling blueprint](/deploy/scaling).

---

## Common questions

- **Do I need D1?** No. DO SQLite is the default and works well for most apps.
- **Do I need R2?** Only if your app uses `ctx.storage` for file uploads.
- **Can I use RPC between DOs?** Yes, DO RPC is supported with modern compatibility dates.
- **How do I check deploy status?** Run `wrangler deployments list` or check the Cloudflare dashboard.

---

