# Deploy rig — the real-Cloudflare MULTI-SHARD E2E (Slice 6, M1)

This is the **deploy-ready-but-unrun** flagship gate for multi-shard write scale-out. The build
worktree has **no Cloudflare account/login**, so the `wrangler deploy` + real-`*.workers.dev` E2E is
scripted here for a human to run — it is **not faked**. The lower fidelity tier (real-workerd via
`vitest-pool-workers`, `bun run test:workers`) already passes in CI; this closes the last gap: real
Cloudflare, real per-DO placement across shards, real cross-datacenter routing.

## What's here

- `wrangler.jsonc` — the deploy config: `nodejs_compat`, ONE `HELIPOD_DO` Durable Object binding
  (the multi-shard router addresses N instances of it by shard-key name), a `new_sqlite_classes`
  migration (DO-SQLite storage).
- `fixture/worker.ts` — the multi-shard Worker/DO entry (hand-written stand-in for what
  `generateShardWorkerEntrySource` codegens): static imports of the fixture `convex/`, `export class
  HelipodDO extends HelipodDurableObject` (the **unmodified free** host — a shard-DO IS Slice 3),
  and `export default createShardWorkerHandler("HELIPOD_DO", { mode: "key", loaded })` (this ee
  package). The single-shard rig default-exports `createWorkerHandler` instead — that one line is the
  **licensing switch** (free single-shard vs paid multi-shard).
- `fixture/convex/` — a minimal SHARDED app: `messages` partitioned by `.shardKey("roomId")`, so
  `messages:send` routes by its `roomId` arg to one DO per room.
- `e2e.mjs` — the assertion script (health → shard isolation → shard-scoped reactive push + isolation
  → cross-shard rejection → aggregate throughput).

## The exact commands a human runs

```bash
# 0. from this dir, with the repo built (bun run build) and wrangler available (npx wrangler ...):
cd ee/packages/runtime-cloudflare-shard/rig

# 1. authenticate (opens a browser)
npx wrangler login

# 2. set the admin key as a SECRET (do NOT leave a placeholder in wrangler.jsonc)
npx wrangler secret put HELIPOD_ADMIN_KEY      # paste a strong secret

# 3. deploy — builds fixture/worker.ts into a Worker + the HelipodDO Durable Object class
npx wrangler deploy
#    → prints a URL like https://helipod-do-shard-fixture.<subdomain>.workers.dev

# 4. run the multi-shard E2E against the real deployment
node e2e.mjs --url https://helipod-do-shard-fixture.<subdomain>.workers.dev
```

## Geographic placement — the point of per-shard DOs

A Durable Object is **single-homed**: pinned to one data center at creation, it **never moves**, and
by default lands near whoever **first** `get()`s it. Because each shard key is a **distinct DO**, each
shard can be placed near **its own** audience via `get(id, { locationHint })` — `roomTokyo` in
`apac-ne`, `roomBerlin` in `weur`, at the same time. **Only the first `get()` for a given DO is
honored** (it is pinned thereafter), so the router derives a **stable-per-key** hint where possible.
Placement precedence (see the package README for detail):

1. **Explicit** `?region=<hint>` / `X-Helipod-Region: <hint>` — deterministic, app-controlled;
   an invalid hint is a hard `INVALID_REGION_HINT` 400 (never mis-places a DO permanently).
2. **Region-prefixed key** (`regionPrefixedKeys: true`) — `"enam:room123"` → `enam` (opt-in; the full
   value still names the DO).
3. **Auto from `request.cf.continent`** — places a new shard near its first requester (also CF's own
   default; first-requester-wins).
4. **Default** — no hint (byte-identical forward).

The **reactive/write path always routes to the DO's home**, so place a shard near where most of its
traffic originates. Routing is a stateless **O(1)** name derivation — no shard map, no coordinator, no
lock — so it stays constant regardless of shard count (the no-shared-bottleneck property).

## What the E2E proves (and what it can't)

**Proves, on real Cloudflare:**
1. writes to two shard keys (`roomA`, `roomB`) land in **two different DOs** — `roomA`'s write is
   invisible to a query routed to `roomB`'s DO (physical isolation, not a leak);
2. a shard-scoped WebSocket on `roomR` receives a reactive push for a `roomR` commit **and is not
   woken by a commit on another shard** (reactivity does not cross the DO boundary);
3. a cross-shard fan-out is **rejected** with the typed `CROSS_SHARD_UNSUPPORTED` (never partial data);
4. N concurrent commits to N distinct keys land in N distinct single-threaded DOs — the **N× write
   scale-out** claim (each DO its own thread + its own 10 GB DO-SQLite).

**Cannot cover without a paid multi-region setup:** true cross-datacenter DO placement latency per
shard, and hibernation eviction timing across many shards. Those are observational, not correctness —
the isolation and reactivity correctness are fully covered by the real-workerd tier + this script.
**Placement in particular is deploy-pending to *measure*:** the real-workerd tier proves a `?region=`
hint is threaded into `get(id, { locationHint })` and that routing is O(1), but a single vantage cannot
observe which data center a DO landed in — the true cross-region latency delta needs a **distributed
load test against this real deploy** (issue requests to the same shard from several regions and compare
round-trip against an unhinted baseline).

## Non-goals (M1 — enforced, documented, not silently broken)

- A **reactive** query/mutation spanning multiple shards → refused (`CROSS_SHARD_UNSUPPORTED`). Use a
  shard-scoped query, or (M2) move genuinely-global data to a `.global()` table.
- **Cross-shard global-unique** → M2 (`.global()`/D1). Within one shard key, uniqueness is free.
- **`.global()`/D1** and the opt-in **non-reactive fan-out read** → Milestone 2.
