# @helipod/runtime-cloudflare-shard (Enterprise)

> Licensed under the **Helipod Commercial License** — see [`ee/LICENSE`](../../LICENSE). This is a
> paid-tier (scale-out) package. Single-node Cloudflare self-host stays free forever via the
> [`@helipod/runtime-cloudflare`](../../../packages/runtime-cloudflare) package.

**Slice 6, Milestone 1 — multi-shard write scale-out on Cloudflare Durable Objects.** `.shardBy(key)`
→ one Durable Object per shard key. N distinct keys ⇒ N distinct single-threaded DOs ⇒ **N× the
single-DO ~200–500 writes/s ceiling AND N× the 10 GB/DO storage ceiling**.

This is the Cloudflare-native analog of [`ee/fleet`](../fleet) (the portable Postgres/object-store
multi-node scale-out) — a **sibling, not a consumer**: it uses Cloudflare's native
`namespace.getByName(shardKey)` addressing instead of leases/forwarders, and has **no `ee/fleet`
dependency**.

## The routing model

A **stateless Worker** (`createShardWorkerHandler`) resolves each request to the ONE owning shard-DO
and forwards to it. Each shard-DO is an **unmodified** `HelipodDurableObject` from the free
`@helipod/runtime-cloudflare` package (M1 reuses Slice 3 verbatim — no engine change). The DO **name
is the shard key**: there is no shard map, no coordinator, no reshard (a new key just addresses a new
DO forever).

A request's shard key is sourced, in precedence order:

1. **Explicit envelope** — `X-Helipod-Shard: <value>` header or `?shard=<value>` query param. The
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

1. **Explicit** — `?region=<hint>` param or `X-Helipod-Region: <hint>` header. App-controlled and
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
- **`.global()`/D1** → Milestone 2 (not yet built).

## Cross-shard `fanOut` reads (Milestone 2d — shipped)

A **non-reactive, one-shot** cross-shard read: `POST /api/run?fanout=1 { path, args }` (or
`X-Helipod-Fanout: true`) fans the SAME request out to every shard-DO, concatenates each shard's
`{ value: [...] }` array, and returns one merged `{ value }` response. It requires a **fixed shard
count** — routing mode `"hash"` (`shardIdList(numShards)` is the enumerable shard set); mode `"key"`
(one DO per arbitrary key, no directory) has no way to enumerate "every shard", so it's rejected
`FANOUT_REQUIRES_FIXED_SHARDS`. Also rejected: `fanOut` + an explicit `?shard=` key
(`FANOUT_WITH_SHARD_KEY` — target one shard OR fan out, never both), `fanOut` on the WebSocket
`/api/sync` upgrade (`FANOUT_NOT_SUBSCRIBABLE` — fanOut is one-shot, not reactive), and `fanOut` of a
`.shardBy` mutation (fanOut is a read). A shard that throws, times out, responds non-200, or returns a
non-array `value` is **failures-as-data**: recorded in a `partial.failedShards` entry rather than
failing the whole request, so a slow/broken shard degrades the read instead of blocking it. v1 is a
plain concatenation (no ordered k-way merge, no global result limit — each shard already applies its
own query's `.take(n)`); the fan-out pool is bounded (`FANOUT_CONCURRENCY`) with a per-shard timeout.

## Proof

- **Node unit suite** (`bun run test`): routing, canonicalization, `fanOut` routing/worker guards
  (scripted fake namespace), and the one-way licensing gate.
- **Real-workerd suite** (`bun run test:workers`, via `@cloudflare/vitest-pool-workers`): chains TWO
  projects — `vitest.workers.config.ts` (mode `"key"` fixture, `test-workers/*.worker.test.ts`): the
  full Worker→shard-DO path on genuine Durable Objects — distinct keys → distinct DOs, shard isolation,
  shard-scoped reactive push + isolation, `fanOut` rejection (`FANOUT_REQUIRES_FIXED_SHARDS`, no fixed
  shard set), independent commits; and `vitest.workers.hash.config.ts` (a SEPARATE mode-`"hash"`,
  `numShards: 4` fixture — `test-workers/test-worker-hash.ts` / `wrangler.hash.jsonc` —
  `fanOut` needs an enumerable shard set the mode-`"key"` fixture structurally doesn't have):
  `test-workers/fanout.worker.test.ts` proves the union-across-shards concat, both rejection guards, and
  a GENUINE single-shard failure (one shard-DO's own query handler throws for real, not a mocked
  namespace) degrading to `partial.failedShards` — all on real Durable Objects.
- **Deploy rig** (`rig/`): the human-run real-Cloudflare multi-shard E2E (this worktree has no CF
  login) — see [`rig/README.md`](./rig/README.md).
