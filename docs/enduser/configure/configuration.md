---
title: Configuration & Extensibility
---

# Configuration & Extensibility

> stackbase.config.ts plus custom adapters.

Customize Stackbase configuration, use it as a library, and plug in custom adapters when needed.

## CLI config file

Create `stackbase.config.ts` in your project root:

```ts
// stackbase.config.ts
import type { StackbaseConfig } from "@stackbase/cli";

const config: StackbaseConfig = {
  // Server settings
  port: 3000,
  ip: "127.0.0.1",

  // Cloudflare runtime settings
  compatibilityDate: "2025-10-01",
  compatibilityFlags: ["nodejs_compat", "nodejs_als"],

  cloudflare: {
    deploy: {
      workersDev: true,
      placement: { mode: "smart" },
    },
    storage: {
      docstore: { type: "d1", databaseName: "stackbase-db", databaseId: "..." },
      blobstore: { type: "r2", bucketName: "stackbase-storage" },
      reads: "replica",
      vectorize: { indexName: "stackbase-vectors" },
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

  // Environment variables
  vars: {
    PUBLIC_API_URL: "https://api.example.com",
  },
};

export default config;
```

---

## Config options reference

### Server

| Option | Type | Description |
|--------|------|-------------|
| `port` | `number` | HTTP server port (default: 3000) |
| `ip` | `string` | Bind address (default: "127.0.0.1") |
| `workerEntry` | `string` | Custom worker entry point |

### Cloudflare

| Option | Type | Description |
|--------|------|-------------|
| `compatibilityDate` | `string` | Cloudflare compatibility date |
| `compatibilityFlags` | `string[]` | Feature flags (nodejs_compat, etc.) |
| `cloudflare.deploy` | `object` | Workers.dev + placement settings |
| `cloudflare.storage` | `object` | Stackbase storage choices (`do-sqlite`, `d1`, `hyperdrive`, `r2`) |
| `cloudflare.execution` | `object` | Execution strategy (`auto`, `inline`, `isolated`, `worker-loader`) |
| `cloudflare.sync` | `object` | Sync topology (`single`, `global-auto`, `global-manual`) |

### Storage

| Option | Type | Description |
|--------|------|-------------|
| `cloudflare.storage.docstore` | `object` | Primary docstore configuration |
| `cloudflare.storage.blobstore` | `object` | Optional blobstore configuration |
| `cloudflare.storage.vectorize` | `object` | Optional Vectorize binding |

### Environment

| Option | Type | Description |
|--------|------|-------------|
| `vars` | `Record<string, string>` | Environment variables |

---

## Library usage (programmatic)

Embed Stackbase as a library instead of using the CLI.

### Bun runtime (canonical API)

```ts
import { createStackbase } from "@stackbase/runtime-bun";

const server = createStackbase({
  convexDir: "./convex",
});
await server.listen({ port: 3000 });
```

### Node.js runtime (same API)

```ts
import { createStackbase } from "@stackbase/runtime-node";

const server = createStackbase({ convexDir: "./convex" });
await server.listen({ port: 3000, hostname: "127.0.0.1" });
```

**Note**: Node.js requires `--experimental-sqlite` flag (Node.js 22.5+).

### Bun/Node with explicit adapter builders

```ts
import { createStackbase, SqliteDocStore, FsBlobStore } from "@stackbase/runtime-bun";

const server = createStackbase({
  convexDir: "./convex",
  docstore: ({ runtime }) => new SqliteDocStore(`./data/${runtime}.sqlite`),
  blobstore: () => new FsBlobStore("./data/storage"),
  schema: "auto", // or "skip" to bypass schema.ts loading
});
```

### Cloudflare Workers (recommended)

```ts
export default {
  cloudflare: {
    deploy: {
      workersDev: true,
      placement: { mode: "smart" },
    },
    storage: {
      docstore: { type: "d1", databaseName: "stackbase-db", databaseId: "your-id" },
      blobstore: { type: "r2", bucketName: "stackbase-assets" },
      reads: "replica",
      vectorize: { indexName: "stackbase-vectors" },
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

Use the programmatic `defineStackbaseRuntime()` API only when you are assembling a custom runtime by hand.

---

## Programmatic option types

### Bun/Node `StackbaseOptions`

```ts
interface StackbaseOptions {
  convexDir?: string;
  docstore?: DocStore | ((context: { runtime: "bun" | "node"; options: Readonly<StackbaseOptions> }) => DocStore);
  blobstore?: BlobStore | ((context: { runtime: "bun" | "node"; options: Readonly<StackbaseOptions> }) => BlobStore);
  schema?: "auto" | "skip";
  modules?: ModuleLoader | Record<string, ModuleRegistryEntry> | Array<ModuleLoader | Record<string, ModuleRegistryEntry>>;
}
```

### Cloudflare `StackbaseCfRuntimeOptions`

```ts
interface StackbaseCfRuntimeOptions<Env> {
  worker: {
    bindings: {
      getStackbaseNamespace: (env: Env, ctx: ExecutionContext) => DurableObjectNamespace | undefined;
      getSyncNamespace: (env: Env, ctx: ExecutionContext) => DurableObjectNamespace | undefined;
    };
    moduleLoader?: ModuleLoader | ModuleLoader[];
    moduleLoaders?: ModuleLoader[];
    configureModuleLoaders?: (registry: ModuleRegistry) => void;
  };
  durableObject: {
    docstore: (context: { state: DurableObjectState; env: Env; instance: string }) => DocStore;
    blobstore?: (context: { state: DurableObjectState; env: Env; instance: string }) => BlobStore | undefined;
    udfExecutor: (context: {
      state: DurableObjectState;
      env: Env;
      instance: string;
      docstore: DocStore;
      blobstore?: BlobStore;
    }) => UdfExec;
  };
}
```

---

## Custom adapters

Implement the `DocStore` or `BlobStore` interfaces for custom backends.

### DocStore interface

```ts
import type { DocStore } from "@stackbase/core";

export class MyDocStore implements DocStore {
  async setupSchema() {}
  async write(documents, indexes, conflictStrategy) {}
  async *index_scan(indexId, tableId, readTimestamp, interval, order) {}
  async *load_documents(range, order) {}
  async getGlobal(key) { return null; }
  async writeGlobal(key, value) {}
  async previous_revisions(queries) { return new Map(); }
  async previous_revisions_of_documents(queries) { return new Map(); }
  async count(tableId) { return 0; }
  async get(id, readTimestamp) { return null; }
  async scan(tableId, readTimestamp) { return []; }
  async scanPaginated(tableId, cursor, limit, order, readTimestamp) {
    return { documents: [], nextCursor: null, hasMore: false };
  }
  async search(indexId, searchQuery, filters, options) { return []; }
  async vectorSearch(indexId, vector, limit, filters) { return []; }
}
```

### BlobStore interface

```ts
import type { BlobStore } from "@stackbase/core";

export class MyBlobStore implements BlobStore {
  async store(blob, options) {
    return { _id: "...", sha256: "...", size: 0, uploadedAt: Date.now() };
  }
  async get(storageId) { return null; }
  async delete(storageId) {}
  async getUrl(storageId) { return null; }
}
```

### Reference implementations

Study these adapter implementations in the Stackbase repository:

| Adapter | Package | Source |
|---------|---------|--------|
| Bun SQLite | `@stackbase/docstore-bun-sqlite` | `packages/docstore-bun-sqlite/src` |
| Node SQLite | `@stackbase/docstore-node-sqlite` | `packages/docstore-node-sqlite/src` |
| D1 | `@stackbase/docstore-cf-d1` | `packages/docstore-cf-d1/src` |
| Filesystem | `@stackbase/blobstore-bun-fs` | `packages/blobstore-bun-fs/src` |
| S3 | `@stackbase/blobstore-bun-s3` | `packages/blobstore-bun-s3/src` |
| R2 | `@stackbase/blobstore-cf-r2` | `packages/blobstore-cf-r2/src` |

The SQLite adapters are the most complete reference for implementing a custom docstore, including full-text search and vector search.

---

## Common questions

- **Can I use DynamoDB?** Yes, via a custom docstore adapter.
- **Can I use TurboPuffer for vectors?** Yes, by wiring `vectorSearch` in a custom docstore.
- **Where are defaults stored?** The CLI stores config in `.stackbase/` and data in `.stackbase/local/`.

---

