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

## Geographic placement — this is why sharding scales *geographically*

A Durable Object is **single-homed**: it is pinned to **one** data center at creation and **never
moves**. By default it lands near whoever **first** `get()`s it. `get(id, { locationHint })` overrides
that placement — but **only the first `get()` for a given DO is honored** (the DO is pinned
thereafter; see the [data-location reference](https://developers.cloudflare.com/durable-objects/reference/data-location/)).

This is *why* multi-shard is the unit of geographic scale-out: each shard-DO is a distinct object, so
**each can be placed near its own audience** — `roomTokyo` in `apac-ne`, `roomBerlin` in `weur` — at the
same time, with no shared bottleneck between them. The router derives that hint per request, from the
envelope, in precedence order (each **stable per shard key** where possible, so the one `get()` that
counts is deterministic):

1. **Explicit** — `?region=<hint>` param or `X-Stackbase-Region: <hint>` header. App-controlled and
   fully deterministic (mirrors `?shard=`). An invalid explicit hint is a hard `INVALID_REGION_HINT`
   400 at the edge — never passed to `get()`, because a bad hint would mis-place the DO **permanently**.
2. **Region-prefixed key (opt-in)** — with `regionPrefixedKeys: true`, a shard-key value of the form
   `"<hint>:<rest>"` (e.g. `"enam:room123"`) derives its hint from the prefix. Off by default (no app is
   forced into a key format); the **full** key value still names the DO — the prefix is read for
   placement only.
3. **Auto from origin** — `request.cf.continent` mapped to the nearest hint, placing a **new** shard
   near the user who first creates it. This is *also* Cloudflare's own default, so it is a made-explicit
   convenience, not a new guarantee — and it is **first-requester-wins** (not stable across requesters).
4. **Default** — no hint. The router forwards with **no options bag** — byte-identical to the pre-hint
   behavior.

Valid hints are the 11 Cloudflare region codes (`wnam enam sam weur eeur apac apac-ne apac-se oc afr
me`); jurisdictions (`eu`/`fedramp`) are a **separate** mechanism, not a `locationHint` value.

**Honest boundary:** the **reactive/write path always routes to the DO's home** — a subscriber and a
committer for `roomTokyo` both reach the Tokyo-placed DO wherever *they* are. Placement optimizes for
the **audience of a shard**, so place a shard near where most of its traffic originates. Routing itself
is a stateless, **O(1)** name derivation (no shard map, no coordinator, no lock) — so it stays constant
regardless of how many shards exist. True cross-region latency improvement can only be *measured* from a
distributed load test against a real deploy (see [`rig/README.md`](./rig/README.md)); the real-workerd
suite proves the hint is threaded and the routing is O(1), not the latency delta.

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
