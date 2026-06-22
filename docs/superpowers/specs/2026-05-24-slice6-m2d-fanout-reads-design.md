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

1. **Router-level fan-out.** The fan-out happens in the multishard router (`route.ts`/`worker.ts`), NOT inside a DO's kernel (a single kernel has no reach to sibling shard-DOs). On a `fanOut` request (mode `"hash"`), the router fans `stub.fetch` to each `shardIdList(numShards)` DO with **bounded concurrency**, collects each shard's `{value}` result.
2. **v1 merge = CONCATENATE (unordered); ordered k-way merge is a deferred follow-on.** The router fans out `{path, args}` and each shard returns its `{value: [...docs]}` (its own slice, internally ordered by that shard's index scan). The router **concatenates** the N slices and applies the query's `limit` to the concatenation. The union is NOT globally sorted (documented) — a caller who needs a global order sorts the (bounded) result. *Why concat for v1:* the router only has `{path, args}`, not the query's sort field, so an ordered merge would require each shard to surface its collect's index/order metadata + a k-way merge by re-encoded index keys — real extra machinery for the ordering half. Concat ships the core value (read across all shards) cleanly and honestly. The **ordered merge** — port `mergeSortedAsyncGenerators` (`ee/packages/objectstore-substrate/src/merge-sorted.ts:52-115`) into a shared home (`@stackbase/index-key-codec`, dedup `objectstore-substrate`'s copy) + surface each shard's collect order + merge by index key — is a **deferred follow-on**, NOT v1.
3. **Non-reactive, one-shot only.** A `fanOut` query cannot be subscribed — fanning invalidation across every shard reactively is out of scope (a different, much larger beast). It runs only over the one-shot `POST /api/run` path. The router **rejects a `fanOut` on the WebSocket `/api/sync` upgrade path** (reuse the existing `isFanoutRequested` gate, `route.ts:75-80`, extended to the WS branch). Reactivity stays shard-isolated (`multishard.worker.test.ts:76` proves the current isolation).
4. **`fanOut` + a shard key = 400.** You either target one shard OR fan out all, never both. The guard sits in `resolveShard` right where the existing fan-out branch (`route.ts:173-183`) precedes the explicit-shard-key branch (`:186-201`) — a new typed `FANOUT_WITH_SHARD_KEY` rejection alongside the existing `errors.ts:10-31` triad.
5. **Failures-as-data.** If a shard's `stub.fetch` fails/times out mid-fan-out, the response carries the **partial** results it got PLUS a list of which shards failed (and why) — a report view degrades gracefully instead of erroring the whole query. The response shape gains a `partial: { failedShards: [{ shardId, error }] }` (or similar) alongside the merged `docs`. A bounded per-shard timeout applies.
6. **fanOut is an HTTP `/api/run` capability, not a reactive-client method (v1).** The interface is the HTTP endpoint the router already gates: `POST /api/run?fanout=1` (or `X-Stackbase-Fanout: true`) with `{ path, args }`. Any HTTP caller reaches it — an admin dashboard, a server-side script, or the multishard E2E's `SELF.fetch`. **The reactive client (`packages/client`) is WebSocket-only** — its `query()` is subscribe-then-unsubscribe over the WS transport, there is no HTTP client method, and the browser `WebSocket` can't set custom request headers — and fanOut is non-reactive (decision 3), so a client-SDK fanOut helper (a NEW one-shot HTTP method on the client) is a **deferred follow-on**, NOT v1. v1 ships the HTTP capability; the endpoint IS the interface.
7. **v1 accepts any query result that is an array; a non-array or a mutation is rejected.** Since v1 concatenates, the fanOut query's per-shard result must be an array of docs (the router concatenates the N arrays). A `fanOut` whose result is not an array (a scalar/object) is rejected ("fanOut requires a query returning a list"). The router also rejects fanning out a `.shardBy` **mutation** (fanOut is a read; a write across shards is nonsensical) — checked from `{path}` in the body. The stricter "clean single ordered collect" requirement only matters for the deferred ordered-merge follow-on.

## Architecture

### 1. (Deferred — ordered-merge follow-on, NOT v1) Shared merge primitive
v1 concatenates, so no merge primitive is extracted. The deferred ordered-merge follow-on moves `mergeSortedAsyncGenerators` + `compareBytesLex` from `ee/packages/objectstore-substrate/src/merge-sorted.ts` into `@stackbase/index-key-codec` (both packages already depend on it; change the file's EE license banner to FSL to match the destination package), updates `objectstore-substrate`'s one import (`sharded-object-doc-store.ts:51`), and merges by re-encoding each shard doc's index key. Not built in M2d v1.

### 2. Router fan-out (`ee/packages/runtime-cloudflare-shard/src/route.ts` + `worker.ts`)
- `resolveShard` gains a `fanOut` resolution kind. On a `fanOut` request:
  - If mode !== `"hash"` → reject `FANOUT_REQUIRES_FIXED_SHARDS`.
  - If an explicit shard key is also present → reject `FANOUT_WITH_SHARD_KEY`.
  - If it's a `/api/sync` (WS) upgrade → reject `FANOUT_NOT_SUBSCRIBABLE`.
  - Else → resolution kind `"fanout"` with the shard list `shardIdList(numShards)`.
- `worker.ts` handles the `"fanout"` resolution: for each shard id in `shardIdList(numShards)`, `ns.idFromName(id)` + `ns.get(id)` + `stub.fetch(request.clone())` with **bounded concurrency** (a small in-flight cap, e.g. 8) and a bounded per-shard timeout; each shard-DO runs the unmodified `/api/run` (returning `{value, committed, commitTs}`). The worker **concatenates** each shard's `value` array (which must be an array — else reject), applies the query's `limit` to the concatenation, and returns ONE JSON response `{ value: <concatenated>, partial: { failedShards: [{ shardId, error }] } }`. A shard whose fetch rejects/times out is recorded in `failedShards`, NOT thrown (failures-as-data).

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
       concatenate N per-shard value arrays (v1 unordered) ──► apply limit
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
- **Unit (Node, `route.ts`):** `resolveShard` returns the `"fanout"` resolution under mode `"hash"`; rejects `FANOUT_REQUIRES_FIXED_SHARDS` under mode `"key"`; `FANOUT_WITH_SHARD_KEY` when a shard key is also present; `FANOUT_NOT_SUBSCRIBABLE` on `/api/sync`; rejects fanning out a `.shardBy` mutation. The worker's concat + limit + failures-as-data logic (unit-testable with a fake namespace whose `get(id).fetch` returns scripted per-shard `{value}` / throws for a "failed" shard).
- **Gate — miniflare multi-shard E2E (`ee/packages/runtime-cloudflare-shard/test-workers/`):** add a NEW **mode-`"hash"`** fixture + `wrangler.jsonc` (a fixed `numShards`, e.g. 4 — the existing fixture is mode `"key"` with no shard count and must NOT just be flipped). Write rows to keys that hash to several shards, then a `fanOut` query returns the **concatenated** union across all shards (assert the full set, order-agnostic — `toEqual(expect.arrayContaining([...]))` / sort-before-compare). Update the existing mode-`"key"` `multishard.worker.test.ts` fan-out assertion to the new `FANOUT_REQUIRES_FIXED_SHARDS` code (mode-`"key"` still can't fan out). Add: `fanOut` + a shard key → `FANOUT_WITH_SHARD_KEY`; `fanOut` on `/api/sync` → `FANOUT_NOT_SUBSCRIBABLE`; a **partial-failure** case (one shard unreachable) → surviving shards' concatenated data + the failed shard in `partial.failedShards`.
- **Regression:** non-`fanOut` shard-scoped queries + shard-isolated reactivity unchanged; the client SDK without `{ fanOut }` byte-identical.

## Package layout / files touched
- `ee/packages/runtime-cloudflare-shard/src/errors.ts` — the new codes `FANOUT_REQUIRES_FIXED_SHARDS`/`FANOUT_WITH_SHARD_KEY`/`FANOUT_NOT_SUBSCRIBABLE` + union arms.
- `ee/packages/runtime-cloudflare-shard/src/route.ts` — the `"fanout"` `ShardResolution` arm (3rd member), the mode/shardKey/WS guards, and a body-read to reject a fanned-out `.shardBy` mutation.
- `ee/packages/runtime-cloudflare-shard/src/worker.ts` — the `"fanout"` branch: `shardIdList(numShards)` fan-out via `stub.fetch(request.clone())`, bounded concurrency + per-shard timeout, concat + limit, `partial.failedShards`.
- `ee/packages/runtime-cloudflare-shard/test-workers/` — a new mode-`"hash"` fixture + `wrangler.jsonc` + the E2E; update the existing mode-`"key"` fan-out assertion.
- **NOT touched in v1:** `packages/index-key-codec`/`objectstore-substrate` (the merge-primitive extraction is the deferred ordered-merge follow-on), `packages/client` (no client helper in v1), the MVCC/executor/kernel (fanOut is a routing-layer concern; `QuerySpecJson`/`QueryBuilder` are untouched).
- `packages/client` — the `{ fanOut?: boolean }` query option + the wire flag; document non-reactive.
- `packages/values`/`packages/executor` — only if the single-collect-shape restriction needs a classifier hook (reuse the existing DLR collectTrace/DIFFABLE_RANGE classification; ideally no new executor code).
- The multishard miniflare E2E (flip the existing test + add the new cases).
- **Untouched:** the MVCC transactor/commit core, the `.global()`/D1 path (M2a–c), the reactive sync tier's per-shard subscription logic.

## Non-goals (explicit — deferred)
- **Ordered (globally-sorted) `fanOut` merge** — v1 concatenates (unordered union). The k-way merge (extract `mergeSortedAsyncGenerators` to `@stackbase/index-key-codec`, surface each shard's collect order, merge by index key) is the primary deferred follow-on.
- **A client-SDK `fanOut` helper** — v1 is the HTTP `/api/run?fanout=1` capability only; a `packages/client` one-shot HTTP method (the client is WS-only today) is a deferred follow-on.
- **`fanOut` on mode `"key"`** (needs a DO-directory subsystem) — out of scope, possibly never.
- **Reactive `fanOut`** (a live cross-shard subscription) — out of scope; `fanOut` is one-shot.
- **Paginated `fanOut`** (merging cursors across shards) — deferred follow-on.
- **`fanOut` over `.global()` tables** — nonsensical (global data isn't sharded); `.global()` is M2a–c.
- **Resharding** (B5 Part 1) — separate.
- **Multi-valued explicit-key fan-out** (comma-separated keys, `route.ts:186-201`) — stays rejected in v1; a possible narrow follow-on.
