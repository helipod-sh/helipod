---
title: API Compatibility
---

# API Compatibility

> Stackbase implements the full Convex server API.

Stackbase implements the Convex server API. Use the official Convex documentation as the API reference.

## Server API

For `ctx.db`, `ctx.auth`, `ctx.storage`, and `ctx.scheduler`:

- [Database API](https://docs.convex.dev/api/interfaces/server.GenericDatabaseWriter) - `ctx.db` methods
- [Auth API](https://docs.convex.dev/api/interfaces/server.Auth) - `ctx.auth` methods
- [Storage API](https://docs.convex.dev/api/interfaces/server.StorageReader) - `ctx.storage` methods
- [Scheduler API](https://docs.convex.dev/scheduling/scheduled-functions) - `ctx.scheduler` methods

## Function definitions

For `query`, `mutation`, `action`, and `internalQuery/Mutation/Action`:

- [Queries](https://docs.convex.dev/functions/query-functions)
- [Mutations](https://docs.convex.dev/functions/mutation-functions)
- [Actions](https://docs.convex.dev/functions/actions)
- [Internal Functions](https://docs.convex.dev/functions/internal-functions)

## Client libraries

Use the standard Convex client libraries:

- [React](https://docs.convex.dev/client/react)
- [JavaScript/TypeScript](https://docs.convex.dev/client/javascript)
- [Python](https://docs.convex.dev/client/python)

Point them at your Stackbase URL instead of Convex Cloud.

---

## Stackbase-specific APIs

### Runtime factory functions

Create Stackbase runtimes programmatically:

```ts
// Bun
import { createStackbase } from "@stackbase/runtime-bun";

const server = createStackbase({
  convexDir: "./convex",
  docstore: customDocStore,
  blobstore: customBlobStore,
});
await server.listen({ port: 3000 });
```

```ts
// Node.js - same API
import { createStackbase } from "@stackbase/runtime-node";
```

Cloudflare deploys are configured through `stackbase.config.ts`:

```ts
export default {
  cloudflare: {
    storage: {
      docstore: { type: "d1", databaseName: "stackbase-db", databaseId: "your-id" },
      reads: "replica",
    },
    execution: {
      strategy: "auto",
    },
    sync: {
      topology: "global-auto",
      autoShardsPerRegion: 2,
    },
  },
} as const;
```

For custom Cloudflare assembly, `@stackbase/runtime-cf` still exposes `defineStackbaseRuntime()` and the lower-level storage/executor primitives.

### Server methods

The server object returned by `createStackbase()`:

```ts
interface StackbaseServer {
  // Start the HTTP server
  listen(options?: { port?: number; hostname?: string }): Promise<void>;

  // Stop the server and close connections
  close(): Promise<void>;

  // Server URL (available after listen)
  url: string;

  // Bound server port
  port: number;
}
```

### `StackbaseOptions` (Bun/Node)

```ts
interface StackbaseOptions {
  convexDir?: string;
  docstore?: DocStore | ((context: { runtime: "bun" | "node"; options: Readonly<StackbaseOptions> }) => DocStore);
  blobstore?: BlobStore | ((context: { runtime: "bun" | "node"; options: Readonly<StackbaseOptions> }) => BlobStore);
  schema?: "auto" | "skip";
  modules?: ModuleLoader | Record<string, ModuleRegistryEntry> | Array<ModuleLoader | Record<string, ModuleRegistryEntry>>;
}
```

**Usage:**

```ts
const server = createStackbase({ convexDir: "./convex" });
await server.listen({ port: 3000 });
console.log(`Server running at ${server.url}`);

// Later...
await server.close();
```

### Adapter interfaces

For custom storage backends:

```ts
import type { DocStore } from "@stackbase/core/docstore";
import type { BlobStore } from "@stackbase/core/abstractions";
```

See [Data & Storage Adapters](/build/data-search) for details.

---

## Compatibility notes

| Feature | Status |
|---------|--------|
| Queries, mutations, actions | Full support |
| `ctx.db` (CRUD, queries, indexes) | Full support |
| `ctx.auth` | Full support |
| `ctx.storage` | Full support |
| `ctx.scheduler` | Full support |
| Search indexes | Full support |
| Vector indexes | Full support |
| HTTP actions | Full support |
| Crons | Planned |
| Components | Not yet supported |
| Convex Auth | Not yet supported |

---
