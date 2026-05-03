---
title: Scaling Blueprint
---

# Scaling Blueprint (Fly.io, Railway, and similar)

> Recommended scaling architecture for Stackbase across self-hosted platforms.

This page describes the target scaling architecture for Stackbase. It is a blueprint, not a guarantee that every piece is shipped as a turnkey feature yet. Use it to design deployments and glue code consistently across platforms.

> **Not a Cloudflare page.** Cloudflare runs a single containerized node, not this topology — see
> [Cloudflare](/deploy/cloudflare).

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

## Stackbase as a single node

Use this as the starting point when you want a node you can compose behind a router, or when
bootstrapping a small deployment. A node is the shipped `stackbase serve` CLI — storage backend is
selected by flag/env, not by composing adapters in code:

```bash
# SQLite on local disk (default — no flag needed)
stackbase serve --dir ./convex --data ./data/db.sqlite

# Postgres
stackbase serve --dir ./convex --database-url postgres://…

# S3-compatible object storage as the substrate
stackbase serve --dir ./convex --object-store s3+https://…
```

`STACKBASE_ADMIN_KEY` is required. See [Docker self-hosting](/self-hosting) for the full flag and
environment surface.

## Cloudflare

Cloudflare does **not** run a Workers-native or Durable-Object-native build of Stackbase, and there
is no DO-based sync-shard/coordinator topology. Cloudflare runs the same shipped `stackbase serve`
image every other target runs, inside **Containers**, with **R2** as the substrate — a single node,
not a sharded fleet. Scaling knobs on this page do not apply to it.

It is **experimental**, and scheduled functions/crons/triggers do not fire there. See
[Cloudflare](/deploy/cloudflare) for what actually works, what it costs, and the gaps.

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

