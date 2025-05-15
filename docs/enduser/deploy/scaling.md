---
title: Scaling Blueprint
---

# Scaling Blueprint (Cloudflare, Fly.io, Railway)

> Recommended scaling architecture for Stackbase across CF and self-hosted platforms.

This page describes the target scaling architecture for Stackbase. It is a blueprint, not a guarantee that every piece is shipped as a turnkey feature yet. Use it to design deployments and glue code consistently across platforms.

## General pattern (platform agnostic)

Stackbase scales by keeping a single consistent writer (the transactor) and scaling the sync tier horizontally.

- Router
  - Routes `/api` to the transactor (single writer).
  - Routes `/sync` (WebSocket) to a sync shard (many replicas).
- Sync shards
  - Hold session state, subscription cache, and query result cache.
  - Never write to DocStore directly.
  - Consume a change stream to invalidate queries.
- Transactor
  - Executes UDFs, runs OCC, commits to DocStore.
  - Emits change events (written ranges, written tables, commit timestamps).
- Change stream
  - Delivers write deltas to all sync shards.
  - Avoids N fan-out posts when shard count grows.
- Coordinator
  - Maintains shard map and autoscaling decisions.
  - Publishes shard map to a fast cache for router reads.

## Building blocks (library level)

Core interfaces that map cleanly across platforms:

- `UdfExec` for execution.
- `DocStore` for MVCC persistence.
- `BlobStore` for blobs.
- `SyncProtocolHandler` for WebSocket sync state machine.
- `SyncUdfExecutor` for sync-to-UDF execution.
- `ChangeStreamConsumer` (recommended) for invalidation delivery.

## Pseudocode (conceptual wiring)

The following is intentionally pseudocode to illustrate composition, not a current exported API:

```ts
// Router: select a sync shard and proxy WS connections.
const shardMap = await shardMapCache.get(tenantId, region);
const shard = rendezvousHash(sessionId, shardMap.shards);
proxyWebSocket(request, shard.url);
```

```ts
// Sync shard: one WS server + SyncProtocolHandler.
const handler = new SyncProtocolHandler(shardId, syncUdfExecutor);
ws.onMessage(async (raw) => {
  const msg = parseClientMessage(raw);
  const responses = await handler.handleMessage(sessionId, msg);
  responses.forEach((r) => ws.send(JSON.stringify(encodeServerMessage(r))));
});
changeStream.onDelta((delta) => {
  handler.notifyWrites(delta.writtenRanges, delta.writtenTables, delta.commitTimestamp);
});
```

```ts
// Transactor: single writer, emits change events.
const udfExec = new InlineUdfExecutor(docstore, blobstore);
const result = await udfExec.execute(path, args, type, auth);
changeLog.append({
  commitTimestamp: result.commitTimestamp,
  writtenRanges: result.writtenRanges,
  writtenTables: result.writtenTables,
});
```

```ts
// Coordinator: heartbeats + shard map updates.
if (metrics.overloaded) addShard();
if (metrics.idle) drainShard();
publishShardMapToCache();
```

## Stackbase as a library (single-node transactor)

Use this as the starting point when you want a transactor you can compose behind a router or when bootstrapping a small deployment.

```ts
import { createStackbase, SqliteDocStore, FsBlobStore } from "@stackbase/runtime-bun";

const server = createStackbase({
  convexDir: "./convex",
  docstore: ({ runtime }) => new SqliteDocStore(`./data/${runtime}.sqlite`),
  blobstore: () => new FsBlobStore("./data/storage"),
  schema: "auto",
});
await server.listen({ port: 3000, hostname: "0.0.0.0" });
```

## Cloudflare (unique path)

Cloudflare is the most distinct target because Durable Objects define the scaling primitives.

- Router
  - Worker routes `/api` to a singleton StackbaseDO.
  - Worker routes `/sync` to a SyncDO shard chosen by hash.
  - Region selection uses `request.cf.colo` and a region map.
- Sync shards
  - SyncDO instances: `sync/<tenant>/<region>/<shardId>`.
  - Use WebSocket hibernation to keep memory down.
- Transactor
  - StackbaseDO singleton: `tx/<tenant>/<instance>`.
  - UDF execution inline or isolated; all writes go through the StackbaseDO DocStore.
- Coordinator
  - Coordinator DO maintains shard map + autoscaling.
  - Writes shard map to KV for router reads.
- Change stream
  - Recommended: Queues or a DO-backed log to fan out invalidations.
  - Avoid direct N-way notify when shard counts grow.

### Runtime-cloud and runtime-cf knobs (implemented)

`@stackbase/runtime-cloud` and `@stackbase/runtime-cf` support coordinator-driven sync routing with static fallback:

- Durable Object bindings
  - `SYNC_COORDINATOR_DO`: maintains shard map + receives load reports
  - `SYNC_DO`: sync shard instances
  - `STACKBASE_DO`: singleton transactor
- Optional cache binding
  - `SYNC_SHARD_MAP_KV`: cached shard map for cheap router reads
- Router env vars
  - `STACKBASE_SYNC_NODE_IDS` (CSV/JSON list) global shard pool
  - `STACKBASE_SYNC_NODE_IDS_BY_REGION` (JSON object) region shard pools
  - `STACKBASE_SYNC_REGION_MAP` (JSON object) `colo -> region`
  - `STACKBASE_SYNC_DEFAULT_REGION` (default: `global`)
  - `STACKBASE_SYNC_SHARD_MAP_CACHE_MS` (default: `5000`)
- Low-maintenance autoscale (optional, no manual node IDs)
  - `STACKBASE_SYNC_AUTO_SHARDS_PER_REGION` (candidate shard pool size per region)
  - `STACKBASE_SYNC_AUTO_SHARD_PREFIX` (default: `auto`)
- Autoscaling envelope
  - `STACKBASE_SYNC_AUTOSCALE_PROFILE` (`minimal`, `advanced`, `custom`)
  - `STACKBASE_SYNC_SCALE_TO_ZERO` (`true` allows `min=0`)
  - `STACKBASE_SYNC_MIN_SHARDS_PER_REGION`
  - `STACKBASE_SYNC_MAX_SHARDS_PER_REGION`
  - `STACKBASE_SYNC_TARGET_SESSIONS_PER_SHARD`
  - `STACKBASE_SYNC_TARGET_MESSAGE_RATE_PER_SHARD`
  - `STACKBASE_SYNC_TARGET_NOTIFY_RATE_PER_SHARD`
  - `STACKBASE_SYNC_TARGET_CPU_UTILIZATION`
  - `STACKBASE_SYNC_TARGET_MEMORY_UTILIZATION`
  - `STACKBASE_SYNC_SCALE_UP_COOLDOWN_MS`, `STACKBASE_SYNC_SCALE_DOWN_COOLDOWN_MS`
  - `STACKBASE_SYNC_SCALE_UP_HYSTERESIS_RATIO`, `STACKBASE_SYNC_SCALE_DOWN_HYSTERESIS_RATIO`
  - `STACKBASE_SYNC_MAX_SCALE_UP_STEP`, `STACKBASE_SYNC_MAX_SCALE_DOWN_STEP`
  - `STACKBASE_SYNC_NODE_STALE_MS`

Sync shards report `activeSessions` to the coordinator. The coordinator computes route shards per region and a separate notify shard list so draining nodes still receive invalidations until their sessions hit zero.
`SyncDO` reports session count plus message/notify rates by default; optional CPU/memory utilization fields can also be supplied in load reports.

If you do not set `STACKBASE_SYNC_NODE_IDS` or `STACKBASE_SYNC_NODE_IDS_BY_REGION`, the runtime can generate shard IDs automatically from the autoscale envelope. Set `STACKBASE_SYNC_AUTO_SHARDS_PER_REGION` (or just `STACKBASE_SYNC_MAX_SHARDS_PER_REGION`) to a value greater than 1 to enable this mode.

### How sync nodes scale up and down

- Scale up
  - SyncDOs report `activeSessions` by region to `SyncCoordinatorDO`.
  - Coordinator computes desired shard count from load signals per region:
    - sessions, message rate, notify rate, CPU utilization, memory utilization.
  - `desired` is clamped to `min..max`, then guarded by hysteresis, cooldown, and max-step limits to avoid thrash.
- Scale down
  - As sessions drain, `desired` falls and coordinator routes new connections to a smaller shard subset.
  - Previous shards stay in `notifyShards` while they still report active sessions, so existing clients continue receiving invalidations.
  - Once a shard reports no load and becomes stale past `STACKBASE_SYNC_NODE_STALE_MS`, it drops out of notify fanout.
  - If `STACKBASE_SYNC_SCALE_TO_ZERO=true` and `STACKBASE_SYNC_MIN_SHARDS_PER_REGION=0`, regions can scale to zero active sync shards.
  - Scale-to-zero requires `SYNC_COORDINATOR_DO` to be bound so notify fanout can safely rebuild from live reports.
- Spin-up/down behavior on Cloudflare
  - Durable Objects are created on demand when routed to, so “spin up” is routing traffic to a new shard name.
  - “Spin down” is stopping new routing and allowing sessions on that shard to close naturally.

### Autoscale observability

- `GET /shard-map` on `SyncCoordinatorDO` now includes `autoscale` metadata:
  - `regions`: last desired shard state per region.
  - `diagnostics`: per-region totals and guard decisions (cooldown/hysteresis/step-limits).

For `@stackbase/runtime-cf`, `defineStackbaseRuntime()` uses this routing by default unless you provide a custom `worker.resolveRouteTargets`.

## Fly.io (self-hosted, multi-region)

Fly is closer to a standard VM/container pattern but supports multi-region routing.

- Services
  - `router`: stateless HTTP + WS router.
  - `sync`: autoscaled replicas for `/sync`.
  - `tx`: singleton transactor per tenant (or per shard later).
  - `coord`: coordinator for shard map + autoscaling.
- Routing
  - Use `fly-replay` or edge proxy rules to keep WS near users.
  - Router uses shard map from Redis or Postgres.
- Storage
  - `tx` uses SQLite on a volume (single writer) or Postgres for HA.
  - Blob storage on S3/R2.
- Change stream
  - Postgres LISTEN/NOTIFY or Redis Streams.

## Railway (self-hosted, single region by default)

Railway is similar to Fly but typically single-region unless you build a custom multi-region setup.

- Services
  - `router`, `sync` (autoscaled), `tx` (singleton), `coord`.
- Routing
  - Sticky sessions based on session ID hash.
  - Shard map stored in Redis (fast) or Postgres (durable).
- Storage
  - Postgres recommended for transactor durability.
  - Blob storage on S3/R2.
- Change stream
  - Redis Streams or Postgres NOTIFY.

## Practical guardrails (all platforms)

- Keep the transactor as the single writer for a tenant/instance.
- Sync shards never touch DocStore directly.
- Isolated UDFs must syscall back to the transactor for DocStore and blobstore.
- Query invalidation must be based on read/write ranges, not table-only invalidation.
- Router should only consult the coordinator on cache miss; shard map reads must be cheap.

---

