---
title: Convex Compatibility
---

# Convex Compatibility

> Feature parity status between Stackbase and Convex Cloud.

Stackbase aims for full compatibility with Convex. This page tracks which features are supported, partially supported, or not yet implemented.

## Feature matrix

### Core functionality

| Feature | Status | Notes |
|---------|--------|-------|
| Queries | Full | Deterministic execution, read-your-own-writes |
| Mutations | Full | OCC transactions, atomic writes |
| Actions | Full | External API calls, run queries/mutations |
| Internal functions | Full | `internalQuery`, `internalMutation`, `internalAction` |
| HTTP actions | Full | Custom HTTP endpoints |
| Argument validation | Full | `v.string()`, `v.number()`, etc. |

### Database

| Feature | Status | Notes |
|---------|--------|-------|
| `ctx.db.get()` | Full | Document retrieval by ID |
| `ctx.db.insert()` | Full | Document creation |
| `ctx.db.patch()` | Full | Partial updates |
| `ctx.db.replace()` | Full | Full document replacement |
| `ctx.db.delete()` | Full | Document deletion |
| `ctx.db.query()` | Full | Table queries with filters |
| Indexes | Full | Secondary indexes for queries |
| Pagination | Full | Cursor-based pagination |

### Search

| Feature | Status | Notes |
|---------|--------|-------|
| Full-text search | Full | SQLite FTS5 in built-in adapters |
| Vector search | Basic | Exact (brute-force) search; see [limitations](/build/data-search#vector-search) |

### Authentication

| Feature | Status | Notes |
|---------|--------|-------|
| `ctx.auth.getUserIdentity()` | Full | JWT token validation |
| Third-party providers | Full | Clerk, Auth0, custom OIDC |
| Convex Auth | Not supported | First-party Convex auth system not yet implemented |

### Storage

| Feature | Status | Notes |
|---------|--------|-------|
| `ctx.storage.store()` | Full | File uploads |
| `ctx.storage.get()` | Full | File retrieval |
| `ctx.storage.delete()` | Full | File deletion |
| `ctx.storage.getUrl()` | Full | Signed URLs |

### Scheduling

| Feature | Status | Notes |
|---------|--------|-------|
| `ctx.scheduler.runAfter()` | Full | Delayed function execution |
| `ctx.scheduler.runAt()` | Full | Scheduled function execution |
| Crons | Planned | Recurring scheduled functions |

### Realtime

| Feature | Status | Notes |
|---------|--------|-------|
| Subscriptions | Full | WebSocket-based realtime updates |
| Query invalidation | Full | Range-based selective invalidation |
| Optimistic updates | Full | Client-side via Convex React client |

### Other

| Feature | Status | Notes |
|---------|--------|-------|
| Components | Not supported | Convex component system not yet implemented |
| Environment variables | Full | Via config or platform secrets |
| Streaming exports | Not supported | Data export functionality |

---

## Status definitions

| Status | Meaning |
|--------|---------|
| **Full** | Feature works identically to Convex Cloud |
| **Basic** | Core functionality works, with documented limitations |
| **Planned** | On the roadmap, not yet implemented |
| **Not supported** | Not currently planned or requires significant work |

---

## Runtime support

All supported features work consistently across runtimes:

| Runtime | Status | Notes |
|---------|--------|-------|
| Bun | Production | Self-hosting and local dev. The primary runtime. |
| Node.js | Production | Self-hosting (requires 22.5+, experimental flags) |
| Cloudflare (Durable-Object-native) | Built | `stackbase deploy --target cloudflare` provisions a Durable-Object-native host (`@stackbase/runtime-cloudflare`) — scheduled functions/crons/triggers DO fire, via the DO's own alarm. See [Cloudflare](/deploy/cloudflare). |
| Cloudflare via Containers | Experimental | Not a Workers-native build — this alternative, hand-wired path runs the shipped `stackbase serve` image on **Workers + Containers + R2**. Works, scales to zero, but **scheduled functions, crons, triggers, and the storage reaper do not fire** (the container stops between requests). See [Cloudflare via Containers](/deploy/cloudflare-containers). |

---

## Migration from Convex Cloud

Stackbase is designed as a drop-in replacement for most Convex applications — brought across with the **`stackbase migrate`** CLI command, which rewrites your Convex imports to Stackbase's native `@stackbase/*` surface (it does not run your app unchanged against `convex/*` imports):

1. **No handler logic changes** for queries, mutations, and actions — `query`/`mutation`/`action` keep coming from `./_generated/server`, same as always.
2. **Equivalent client libraries** - `stackbase migrate` rewrites `convex/react` → `@stackbase/client/react` and `convex/browser` → `@stackbase/client`; use `StackbaseProvider`/`StackbaseClient` in place of `ConvexProvider`/`ConvexReactClient`.
3. **Same schema format** - `convex/schema.ts` keeps its shape; `stackbase migrate` rewrites its `defineSchema`/`defineTable`/`v` import from `convex/server`/`convex/values` to `@stackbase/values`.
4. **Same function definitions** - `query`, `mutation`, `action` still come from `./_generated/server`; only the validator/schema import (`v`, `defineSchema`, `defineTable`) moves to `@stackbase/values`.

### What to check before migrating

- [ ] Not using Convex Auth (use Clerk, Auth0, or custom JWT instead)
- [ ] Not using Components
- [ ] Not using Crons (use external scheduler or `runAt` as workaround)
- [ ] Vector search dataset is small enough for exact search, or you're prepared to implement a custom adapter

---

## Reporting compatibility issues

If you encounter behavior that differs from Convex Cloud, please report it. Maintaining compatibility is a priority.

---

