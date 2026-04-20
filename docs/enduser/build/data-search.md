---
title: Data Storage & Search
status: planned
---

# Data Storage & Search

> Storage adapters and search capabilities for your Stackbase deployment.

> 🚧 **Planned — not yet shipped.** This page describes an intended adapter-composition model and a
> search feature set. **Neither exists as described**, and the code below will not run.
>
> - **Search is not built.** Full-text search and vector search have **no implementation** —
>   `.searchIndex()` parses in `schema.ts` but nothing executes it. Ignore both sections below.
> - **Adapters are not composed in app code.** The page's premise — passing `docstore:`/`blobstore:`
>   to `createStackbase` — inverts the real architecture. `createStackbase` doesn't exist, and every
>   adapter package named here (`@stackbase/docstore-bun-sqlite`, `@stackbase/docstore-cf-d1`,
>   `@stackbase/blobstore-cf-r2`, …) is fictional. Real backends are picked with **CLI flags/env**:
>   `--database-url` (Postgres), `--object-store` (S3-compatible), `--storage-bucket` (file
>   storage). Real packages: `@stackbase/docstore-sqlite`, `@stackbase/docstore-postgres`,
>   `@stackbase/blobstore-fs`, `@stackbase/blobstore-s3`.
>
> **What works today:** `ctx.db` (reading/writing data, indexes) and `ctx.storage` file storage are
> fully shipped. See **[Files](/files)** for the real file-storage guide, and
> [Docker self-hosting](/self-hosting) for choosing a backend.

This page covers:
- **Storage Adapters** - Pluggable backends for documents and files
- **Search Capabilities** - Full-text and vector search support

## Convex documentation

For database and storage APIs, see:

- [Reading Data](https://docs.convex.dev/database/reading-data) - Queries and `ctx.db`
- [Writing Data](https://docs.convex.dev/database/writing-data) - Mutations and inserts
- [File Storage](https://docs.convex.dev/file-storage) - `ctx.storage` API
- [Full-Text Search](https://docs.convex.dev/text-search) - Search indexes
- [Vector Search](https://docs.convex.dev/vector-search) - Semantic search

---

## Docstore adapters

The docstore handles all document and index storage. Choose based on your deployment target.

### Cloudflare

| Adapter | Package | Best for |
|---------|---------|----------|
| **DO SQLite** | `@stackbase/docstore-cf-do` | Default for Cloudflare Workers. Data stored in Durable Object storage. |
| **D1** | `@stackbase/docstore-cf-d1` | Cloudflare's serverless SQL database. Better for larger datasets. |
| **Hyperdrive** | `@stackbase/docstore-cf-hyperdrive` | Connect to external Postgres via Cloudflare Hyperdrive. |

### Bun / Node.js

| Adapter | Package | Best for |
|---------|---------|----------|
| **Bun SQLite** | `@stackbase/docstore-bun-sqlite` | Local development and self-hosting with Bun. |
| **Node SQLite** | `@stackbase/docstore-node-sqlite` | Self-hosting with Node.js (requires `--experimental-sqlite`). |

### Configuration

Adapters are configured when creating the server:

```ts
import { createStackbase, SqliteDocStore } from "@stackbase/runtime-bun";

const server = createStackbase({
  docstore: ({ runtime }) => new SqliteDocStore(`./data/${runtime}.db`),
  convexDir: "./convex",
});
await server.listen({ port: 3000 });
```

---

## Blobstore adapters

The blobstore handles file uploads via `ctx.storage`.

### Cloudflare

| Adapter | Package | Best for |
|---------|---------|----------|
| **R2** | `@stackbase/blobstore-cf-r2` | Cloudflare R2 object storage. Default for Workers. |

### Bun / Node.js

| Adapter | Package | Best for |
|---------|---------|----------|
| **Filesystem** | `@stackbase/blobstore-bun-fs` / `@stackbase/blobstore-node-fs` | Local development. Files stored on disk. |
| **S3** | `@stackbase/blobstore-bun-s3` | Production self-hosting with S3-compatible storage. |

### Configuration

```ts
import { createStackbase, FsBlobStore, S3BlobStore } from "@stackbase/runtime-bun";

// Filesystem (default for local dev)
const server = createStackbase({
  blobstore: () => new FsBlobStore("./data/files"),
  convexDir: "./convex",
});

// S3-compatible storage
const server = createStackbase({
  blobstore: () =>
    new S3BlobStore({
      bucket: "my-bucket",
      endpoint: "https://s3.amazonaws.com",
      accessKeyId: process.env.AWS_ACCESS_KEY_ID!,
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!,
    }),
  convexDir: "./convex",
});
```

---

---

## Search capabilities

### Full-text search

FTS is implemented in the docstore adapter. All built-in SQLite adapters support search indexes defined in your schema using SQLite FTS5.

```ts
// Define a search index in your schema
defineTable({
  title: v.string(),
  body: v.string(),
}).searchIndex("search_content", {
  searchField: "body",
  filterFields: ["title"],
})
```

### Vector search

Vector search is handled by the docstore adapter. Built-in SQLite adapters provide **basic** vector search support.

#### What "Basic" vector search means

The built-in SQLite adapters use brute-force cosine similarity search:

| Aspect | Built-in (Basic) | External Vector DB |
|--------|------------------|-------------------|
| **Algorithm** | Exact (brute-force) | Approximate (ANN) |
| **Scale** | Hundreds to low thousands of vectors | Millions+ |
| **Latency** | O(n) - grows with dataset | O(log n) or better |
| **Accuracy** | 100% (exact) | 95-99% (configurable) |
| **Best for** | Development, small datasets | Production at scale |

#### When to use a custom adapter

Consider a custom docstore adapter with an external vector database when:
- You have more than ~10,000 vectors
- Query latency becomes unacceptable
- You need advanced features (filtering, metadata, hybrid search)

Popular options include Pinecone, TurboPuffer, Weaviate, and pgvector.

```ts
// Custom adapter delegates vectorSearch to external service
class MyDocStore implements DocStore {
  async vectorSearch(indexId, vector, limit, filters) {
    // Call Pinecone, TurboPuffer, etc.
    return await this.vectorDb.query(vector, limit);
  }
}
```

---

## Custom adapters

Implement `DocStore` or `BlobStore` interfaces for custom backends:

```ts
import type { DocStore } from "@stackbase/core/docstore";
import type { BlobStore } from "@stackbase/core/abstractions";

// See packages/docstore-*/src for implementation examples
```

## Common questions

- **Which docstore should I use?** DO SQLite for Cloudflare, Bun/Node SQLite for self-hosting.
- **Can I use Postgres directly?** Yes, via Hyperdrive adapter on Cloudflare.
- **Is data portable between adapters?** The schema is the same, but you'd need to migrate data manually.

---

