# Slice-6 M2d — Cross-shard `fanOut` reads — Design Spec

**Date:** 2026-05-24
**Status:** Design (pre-plan). Brainstorming complete; awaiting user review before the implementation plan.
**Slice:** M2d of Slice-6 M2. The opt-in, **non-reactive** read that queries a *sharded* table across every shard and merges the results. Parent spec `docs/superpowers/specs/2026-03-20-multishard-crossshard-slice6-design.md` §6.4 T8; decision 3 (offer `fanOut`) already answered = YES. Distinct from M2a–c's `.global()`/D1 path (which lives in D1) — `fanOut` reads the existing per-shard DO-SQLite MVCC tables.

> **Note on file:line references.** Mapped 2026-05-24 (grounding from the M2d exploration); load-bearing but point-in-time — the plan must re-confirm each against current code.

## Goal

Let a query with **no shard key** run across **every** shard of a fixed-shard-count deployment and return the merged result — the "read a sharded table across all shards for an admin/report view" case, without moving that data to a `.global()` table. Today a shard-key-less query on a sharded table is rejected (`SHARD_KEY_REQUIRED`), and an explicit fan-out request is rejected (`CROSS_SHARD_UNSUPPORTED`, `ee/packages/runtime-cloudflare-shard/src/route.ts:173-183`). M2d flips the fan-out rejection into a real fan-out-and-merge.

## The load-bearing decision (made as CTO)

**`fanOut` requires a FIXED-shard-count deployment (routing mode `"hash"`); it is rejected on the default per-key mode (`"key"`).** This is a real, permanent product boundary, not a temporary limitation:

- Mode `"key"` (the DEFAULT) addresses a **new Durable Object per unique key value, with no directory anywhere** (`ee/packages/runtime-cloudflare-shard/src/canonical.ts:43-51`; its own doc: "No fixed shard count, no reshard, no shard map"). Cloudflare has **no API to list DOs by namespace**, so "all shards" is **unenumerable by construction** in this mode — fan-out is impossible without building a whole durable DO-directory/membership subsystem, which contradicts mode `"key"`'s entire philosophy.
- Mode `"hash"` (a fixed `NUM_SHARDS`) already has the enumeration primitive: `shardIdList(numShards)` (`packages/id-codec/src/jump-hash.ts:73-77`) returns `["default", "s1", … "s{N-1}"]` — the exact "all shards" list the fleet tier already uses (`ee/packages/fleet/src/balancer.ts:109`). fan-out is well-defined and buildable there.

So M2d ships `fanOut` for `"hash"`-mode (fixed-`NUM_SHARDS`) deployments; a `fanOut` request against a `"key"`-mode deployment is rejected with a clear typed error (`FANOUT_REQUIRES_FIXED_SHARDS` or similar) explaining it needs a fixed shard count. Adding a DO-directory to enable `fanOut` on mode `"key"` is explicitly out of scope (a separate, large feature if ever wanted).

## Other decisions (CTO calls)

1. **Router-level fan-out.** The fan-out happens in the multishard router (`route.ts`/`worker.ts`), NOT inside a DO's kernel (a single kernel has no reach to sibling shard-DOs). On a `fanOut` request (mode `"hash"`), the router fans `stub.fetch` to each `shardIdList(numShards)` DO with **bounded concurrency**, collects each shard's result.
2. **Ordered merge via `mergeSortedAsyncGenerators`.** This primitive already exists (`ee/packages/objectstore-substrate/src/merge-sorted.ts:52-115`, a textbook k-way merge, generic over `T` + comparator + order + limit, already used by `ShardedObjectStoreDocStore`). `runtime-cloudflare-shard` can't import `objectstore-substrate` (sibling `ee/` packages, no edge). **Extract `mergeSortedAsyncGenerators` + `compareBytesLex` into a shared home** (`@stackbase/index-key-codec` — it already owns index-key byte ordering and is depended on by both) and have `objectstore-substrate` re-import from there (dedup its local copy). The router merges the N per-shard ordered results by re-encoding each returned doc's index key (via `@stackbase/index-key-codec`, using the query's index fields) and comparing key bytes — guaranteeing the merge order exactly matches each shard's own index-scan order. Unordered query → concatenate. The query's `limit` is applied AFTER the merge.
3. **Non-reactive, one-shot only.** A `fanOut` query cannot be subscribed — fanning invalidation across every shard reactively is out of scope (a different, much larger beast). It runs only over the one-shot `POST /api/run` path. The router **rejects a `fanOut` on the WebSocket `/api/sync` upgrade path** (reuse the existing `isFanoutRequested` gate, `route.ts:75-80`, extended to the WS branch). Reactivity stays shard-isolated (`multishard.worker.test.ts:76` proves the current isolation).
4. **`fanOut` + a shard key = 400.** You either target one shard OR fan out all, never both. The guard sits in `resolveShard` right where the existing fan-out branch (`route.ts:173-183`) precedes the explicit-shard-key branch (`:186-201`) — a new typed `FANOUT_WITH_SHARD_KEY` rejection alongside the existing `errors.ts:10-31` triad.
5. **Failures-as-data.** If a shard's `stub.fetch` fails/times out mid-fan-out, the response carries the **partial** results it got PLUS a list of which shards failed (and why) — a report view degrades gracefully instead of erroring the whole query. The response shape gains a `partial: { failedShards: [{ shardId, error }] }` (or similar) alongside the merged `docs`. A bounded per-shard timeout applies.
6. **Opt-in at the call site (not inside the function).** `fanOut` is a property of the *invocation*, not the query body — the caller marks a query invocation `fanOut` (the wire flag `X-Stackbase-Fanout: true` / `?fanout=1` already exists as the rejection gate). The client SDK gains a `{ fanOut: true }` option on the query call (`client.query(fn, args, { fanOut: true })` and the equivalent on `useQuery`, documented non-reactive). The query FUNCTION is a normal query over the sharded table (no shard key); the router runs it on every shard and merges.
7. **v1 supports a single-collect-shape query.** The router can only merge a result it understands as an ordered/unordered row list. v1 requires the `fanOut` query to be a clean single `collect()` (the DLR `DIFFABLE_RANGE`-classifiable passthrough shape the executor already recognizes, `kernel.ts` collectTrace machinery), so the router knows the index/order to merge by. A `fanOut` query that does post-processing / returns a non-list / multiple collects is rejected with a clear error ("fanOut supports a single ordered collect"). Pagination-across-shards is a deferred follow-on (merging cursors across shards is its own problem).

## Architecture

### 1. Shared merge primitive (`@stackbase/index-key-codec`)
Move `mergeSortedAsyncGenerators<T>(sources, keyCompare, order, limit?)` + `compareBytesLex` from `objectstore-substrate/src/merge-sorted.ts` into `@stackbase/index-key-codec` (a new exported module). Update `objectstore-substrate`'s `ShardedObjectStoreDocStore` to import from there (behavior byte-identical — pure move + re-export). Now `runtime-cloudflare-shard` can import it too.

### 2. Router fan-out (`ee/packages/runtime-cloudflare-shard/src/route.ts` + `worker.ts`)
- `resolveShard` gains a `fanOut` resolution kind. On a `fanOut` request:
  - If mode !== `"hash"` → reject `FANOUT_REQUIRES_FIXED_SHARDS`.
  - If an explicit shard key is also present → reject `FANOUT_WITH_SHARD_KEY`.
  - If it's a `/api/sync` (WS) upgrade → reject `FANOUT_NOT_SUBSCRIBABLE`.
  - Else → resolution kind `"fanout"` with the shard list `shardIdList(numShards)`.
- `worker.ts` handles the `"fanout"` resolution: for each shard id, build the DO stub (`ns.idFromName(shardName(id))`, `ns.get`) and `stub.fetch(request)` (cloning the request per shard) with **bounded concurrency** (a small pool, e.g. 8 in flight); each returns that shard's JSON result. Wrap each shard's `docs` array as an async generator, merge via `mergeSortedAsyncGenerators` keyed by the query's index (re-encode each doc's key), apply `limit`, and return one merged JSON response with the `partial.failedShards` list. A shard whose fetch rejects/times out is recorded in `failedShards`, not thrown.

### 3. Call-site opt-in (client SDK + the wire flag)
- The client query call gains `{ fanOut?: boolean }`; when set, the request carries `X-Stackbase-Fanout: true` (or the existing `?fanout=1`). Documented as non-reactive (a `fanOut` `useQuery` does not live-update; a one-shot fetch).
- The query function is unchanged (a normal query over the sharded table with no shard key).

### 4. Non-reactive + mutual-exclusion guards
All at the router (`resolveShard`), reusing the existing `isFanoutRequested` + `errors.ts` pattern — see decisions 3/4/the mode guard.

## Data flow

```
client.query(fn, args, { fanOut: true })  ──►  POST /api/run  +  X-Stackbase-Fanout: true

router resolveShard:
  mode "key"?         ──► 400 FANOUT_REQUIRES_FIXED_SHARDS
  explicit shard key? ──► 400 FANOUT_WITH_SHARD_KEY
  /api/sync (WS)?     ──► 400 FANOUT_NOT_SUBSCRIBABLE
  else (mode "hash")  ──► fan out to shardIdList(numShards):
       for each shard (bounded concurrency): stub.fetch(clone(request)) ──► that shard's ordered docs slice
       merge N slices (mergeSortedAsyncGenerators, key = query index; unordered → concat) ──► apply limit
       shard fetch failed/timed out ──► record in partial.failedShards (do NOT throw)
  return { docs: <merged>, partial: { failedShards: [...] } }
```

## Error handling
- **Mode `"key"`** fan-out → `FANOUT_REQUIRES_FIXED_SHARDS` (clear: needs a fixed shard count).
- **`fanOut` + shard key** → `FANOUT_WITH_SHARD_KEY`.
- **`fanOut` on `/api/sync`** → `FANOUT_NOT_SUBSCRIBABLE`.
- **A shard's fetch fails/times out** → recorded in `partial.failedShards` with the shard id + error; the merged result of the surviving shards is still returned (failures-as-data). A bounded per-shard timeout prevents one hung DO from hanging the whole fan-out.
- **Non-single-collect `fanOut` query** → rejected with "fanOut supports a single ordered collect" (v1 shape restriction).

## Testing
- **Unit:** the shared `mergeSortedAsyncGenerators` move (objectstore-substrate suite stays green — pure re-import); the router's mode/shardKey/WS guards; the doc-key re-encode comparator matches per-shard index order.
- **Gate — miniflare multi-shard E2E (`ee/packages/runtime-cloudflare-shard/test-workers/`):** FLIP the existing `multishard.worker.test.ts:62-68` assertion (which today asserts `?fanout=1` → 400 `CROSS_SHARD_UNSUPPORTED`) to: a `fanOut` query over a fixed-`NUM_SHARDS` deployment writes rows to several shards, then a `fanOut` read returns the **merged, correctly-ordered** union across shards; a mode-`"key"` deployment's `fanOut` still 400s (`FANOUT_REQUIRES_FIXED_SHARDS`); `fanOut` + a shard key 400s; a `fanOut` on `/api/sync` 400s; and a **partial-failure** case (one shard made unreachable) returns the surviving shards' merged data + the failed shard in `partial.failedShards`.
- **Regression:** non-`fanOut` shard-scoped queries + shard-isolated reactivity unchanged; the client SDK without `{ fanOut }` byte-identical.

## Package layout / files touched
- `packages/index-key-codec` — new `merge-sorted` module (moved from objectstore-substrate) + export.
- `packages/objectstore-substrate` (ee) — re-import `mergeSortedAsyncGenerators`/`compareBytesLex` from index-key-codec (delete local copy).
- `ee/packages/runtime-cloudflare-shard/src/{route.ts,worker.ts,errors.ts}` — the `fanout` resolution kind, the three guards, the fan-out-and-merge in the worker, the new error codes.
- `packages/client` — the `{ fanOut?: boolean }` query option + the wire flag; document non-reactive.
- `packages/values`/`packages/executor` — only if the single-collect-shape restriction needs a classifier hook (reuse the existing DLR collectTrace/DIFFABLE_RANGE classification; ideally no new executor code).
- The multishard miniflare E2E (flip the existing test + add the new cases).
- **Untouched:** the MVCC transactor/commit core, the `.global()`/D1 path (M2a–c), the reactive sync tier's per-shard subscription logic.

## Non-goals (explicit — deferred)
- **`fanOut` on mode `"key"`** (needs a DO-directory subsystem) — out of scope, possibly never.
- **Reactive `fanOut`** (a live cross-shard subscription) — out of scope; `fanOut` is one-shot.
- **Paginated `fanOut`** (merging cursors across shards) — deferred follow-on.
- **`fanOut` over `.global()` tables** — nonsensical (global data isn't sharded); `.global()` is M2a–c.
- **Resharding** (B5 Part 1) — separate.
- **Multi-valued explicit-key fan-out** (comma-separated keys, `route.ts:186-201`) — stays rejected in v1; a possible narrow follow-on.
