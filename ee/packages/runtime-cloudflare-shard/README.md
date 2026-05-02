# @stackbase/runtime-cloudflare-shard (Enterprise)

> Licensed under the **Stackbase Commercial License** — see [`ee/LICENSE`](../../LICENSE). This is a
> paid-tier (scale-out) package. Single-node Cloudflare self-host stays free forever via the
> [`@stackbase/runtime-cloudflare`](../../../packages/runtime-cloudflare) package.

**Slice 6, Milestone 1 — multi-shard write scale-out on Cloudflare Durable Objects.** `.shardBy(key)`
→ one Durable Object per shard key. N distinct keys ⇒ N distinct single-threaded DOs ⇒ **N× the
single-DO ~200–500 writes/s ceiling AND N× the 10 GB/DO storage ceiling**.

This is the Cloudflare-native analog of [`ee/fleet`](../fleet) (the portable Postgres/object-store
multi-node scale-out) — a **sibling, not a consumer**: it uses Cloudflare's native
`namespace.getByName(shardKey)` addressing instead of leases/forwarders, and has **no `ee/fleet`
dependency**.

## The routing model

A **stateless Worker** (`createShardWorkerHandler`) resolves each request to the ONE owning shard-DO
and forwards to it. Each shard-DO is an **unmodified** `StackbaseDurableObject` from the free
`@stackbase/runtime-cloudflare` package (M1 reuses Slice 3 verbatim — no engine change). The DO **name
is the shard key**: there is no shard map, no coordinator, no reshard (a new key just addresses a new
DO forever).

A request's shard key is sourced, in precedence order:

1. **Explicit envelope** — `X-Stackbase-Shard: <value>` header or `?shard=<value>` query param. The
   primary mechanism, and the only one that works for a WebSocket upgrade (a shard-scoped socket:
   `wss://…/api/sync?shard=<roomId>`) and for a query (queries declare no `shardBy`).
2. **Derived** — for `POST /api/run`, a mutation declaring `shardBy` has its key extracted from the
   args exactly as the engine's executor does.
3. **Default** — no key ⇒ the `"default"` DO (unsharded tables + no-`shardBy` mutations), byte-identical
   to a single-shard Slice-3 deploy.

Two routing modes: **`"key"`** (default — one DO per distinct value, collision-safe name encoding) or
**`"hash"`** (fixed-N jump-consistent-hash, byte-identical `ShardId` to the portable path).

The licensing switch is the app's Worker entry: a single-shard app `export default
createWorkerHandler(...)` (free package); a multi-shard app `export default createShardWorkerHandler(...)`
(this package). Nothing in the free package imports this one.

## Non-goals (M1 — enforced with a typed error, never silently broken)

- A **reactive** query/mutation spanning **multiple shards** → rejected with
  `CROSS_SHARD_UNSUPPORTED` (HTTP 400). A shard-scoped reactive subscription lives on exactly one DO,
  so Slice 3's in-DO G1/G4 ordering carries over unchanged; a cross-shard reactive query would re-open
  distributed cross-shard invalidation — deferred by construction.
- **Cross-shard global-unique** → Milestone 2 (`.global()`/D1). Uniqueness **within one shard key** is
  free (a per-DO local index).
- A `.shardBy` mutation whose args omit the shard key → rejected with `SHARD_KEY_REQUIRED`.
- **`.global()`/D1** and the opt-in **non-reactive fan-out read** → Milestone 2.

## Proof

- **Node unit suite** (`bun run test`): routing, canonicalization, and the one-way licensing gate.
- **Real-workerd suite** (`bun run test:workers`, via `@cloudflare/vitest-pool-workers`): the full
  Worker→shard-DO path on genuine Durable Objects — distinct keys → distinct DOs, shard isolation,
  shard-scoped reactive push + isolation, cross-shard rejection, independent commits.
- **Deploy rig** (`rig/`): the human-run real-Cloudflare multi-shard E2E (this worktree has no CF
  login) — see [`rig/README.md`](./rig/README.md).
