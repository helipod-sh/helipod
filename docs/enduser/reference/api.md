---
title: API Compatibility
---

# API Compatibility

> Stackbase's function-authoring API is Convex-compatible in shape.

Stackbase's server API is **Convex-compatible in shape**, so Convex's documentation is a useful
reference for the handler surface below. It is not a complete match — full-text and vector search
are not built, and the canonical import surface is `@stackbase/*`, never `convex/*`
(see [Convex Compatibility](/reference/compatibility)).

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

Stackbase ships its own client — **`@stackbase/client`** (with `@stackbase/client/react` for
`useQuery`/`useMutation`). Use it in place of `convex/react` / `convex/browser`;
`stackbase migrate` rewrites those imports for you.

> 🚧 **Planned:** a Python client. Today the client SDK is TypeScript/JavaScript only.

---

## Stackbase-specific APIs

> 🚧 **Planned — not yet shipped.** Everything in this section (the `createStackbase` runtime
> factories, `StackbaseServer`, `StackbaseOptions`, and the `@stackbase/core` adapter interfaces)
> describes an intended programmatic-embedding API that **does not exist**. The code below will not
> run.
>
> **What works today:** the [`stackbase dev`](/local/dev-server) and
> [`stackbase serve`](/self-hosting) CLI entrypoints, plus
> [`stackbase build`](/deploy/standalone-binary) to compile a self-contained binary. Storage
> backends are chosen with flags/env (`--database-url`, `--object-store`, `--storage-bucket`), not
> by composing adapters in code. The only runtime package is `@stackbase/runtime-embedded`.

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
| `ctx.storage` | Full support — see [Files](/files) |
| `ctx.scheduler` | Full support (`@stackbase/scheduler`) |
| HTTP actions | Full support |
| Crons | Full support (`cronJobs()`, `@stackbase/scheduler`) |
| Components | Full support — `@stackbase/scheduler`, `@stackbase/workflow`, `@stackbase/triggers`, `@stackbase/auth`, `@stackbase/authz` |
| Durable workflows + saga | Full support (`@stackbase/workflow`) — beyond Convex's built-ins |
| Search indexes | 🚧 **Not built** — `.searchIndex()` parses in `schema.ts` but has no execution path |
| Vector indexes | 🚧 **Not built** — no `vectorSearch` implementation |
| Convex Auth | Not supported — use `@stackbase/auth` |

---
