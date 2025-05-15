---
title: Realtime & Sync
---

# Realtime & Sync

> How Stackbase implements realtime subscriptions and query invalidation.

Stackbase implements the same realtime sync protocol as Convex. Subscriptions, automatic updates, and query caching work identically.

## Convex documentation

For client-side usage, see:

- [React Hooks](https://docs.convex.dev/client/react) - `useQuery`, `useMutation`
- [Subscriptions](https://docs.convex.dev/api/modules/react#usequery) - Realtime updates
- [Optimistic Updates](https://docs.convex.dev/client/react/optimistic-updates) - Instant UI feedback

---

## Stackbase sync architecture

Stackbase's realtime system has two components:

### StackbaseDO (execution)

Handles query and mutation execution. After each mutation:
1. Executes the mutation
2. Computes read/write ranges
3. Notifies SyncDO of affected ranges

### SyncDO (subscriptions)

Manages client WebSocket connections and subscriptions:
1. Tracks which queries each client subscribes to
2. Receives write notifications from StackbaseDO
3. Compares write ranges against subscription read ranges
4. Pushes invalidations to affected clients

```
Client ←WebSocket→ SyncDO ←→ StackbaseDO ←→ DocStore
```

---

## Runtime differences

### Cloudflare Workers

- StackbaseDO and SyncDO run as Durable Objects
- WebSocket connections handled by SyncDO
- Multiple StackbaseDO instances coordinate via SyncDO

### Bun / Node.js

- Single-process architecture
- StackbaseDO logic runs in the main process
- WebSocket server built into the HTTP server
- Simpler coordination (same process)

---

## Connection handling

### WebSocket endpoint

Clients connect to `/sync` for realtime subscriptions:

```ts
// Convex client connects automatically
const client = new ConvexReactClient("http://localhost:3000");
// WebSocket: ws://localhost:3000/sync
```

### Reconnection

Stackbase handles reconnection the same as Convex:
- Automatic reconnect on disconnect
- Resubscribes to active queries
- Replays missed updates

---

## Invalidation behavior

Stackbase uses the same range-based invalidation as Convex:

1. **Query execution** tracks which index ranges were read
2. **Mutation execution** tracks which index ranges were written
3. **Overlap detection** compares ranges to find affected queries
4. **Selective invalidation** only notifies queries whose read ranges overlap writes

This means mutations only trigger re-fetches for actually affected queries, not all queries on the same table.

---

## Caching

### Query caching

Stackbase caches query results per subscription. Cache is invalidated when:
- A write overlaps the query's read range
- The subscription is closed
- The client reconnects

### Auth-dependent queries

Queries using `ctx.auth` are cached per-user. Different users see different cached results.

---

---

## Latency expectations

Realtime update latency depends on your deployment:

| Deployment | Typical latency | Notes |
|------------|-----------------|-------|
| **Cloudflare Workers** | 20-100ms | Edge-distributed, latency depends on user proximity to nearest edge |
| **Self-hosted (same region)** | 10-50ms | Direct connection to server |
| **Self-hosted (cross-region)** | 50-200ms | Network round-trip dominates |
| **Local development** | \<10ms | Same machine |

### Factors affecting latency

1. **Geographic distance** - Cloudflare edge reduces this; self-hosted depends on server location
2. **Query complexity** - Simple queries are faster than complex joins
3. **Data size** - Larger result sets take longer to serialize and transmit
4. **WebSocket health** - Reconnections add latency; stable connections are faster

### Optimizing for low latency

- Use indexes to speed up queries
- Limit result set sizes with `.take()` or pagination
- Place self-hosted servers close to your users
- Use Cloudflare Workers for global user bases

---

## Common questions

- **Is the sync protocol the same as Convex?** Yes, standard Convex clients work with Stackbase.
- **Can I use the Convex React client?** Yes, point it at your Stackbase URL.
- **What about latency?** See the table above. Cloudflare Workers offer edge distribution; self-hosted latency depends on server location relative to users.

---

