---
title: ElectricSQL — Architecture Research (Postgres sync engine, CDN-cacheable read path)
status: research
---

# ElectricSQL — Architecture Research

> Research date: 2025-11-28. Docs (`electric.ax/docs`) + a two-agent code-verified read of the cloned
> source at `.reference/electric` (tip `9acd04f`; Elixir `sync-service` + `typescript-client`). `file:line`
> pointers throughout.

## 1. Positioning — a radically different answer to the reactive read path

ElectricSQL is a **read-path Postgres sync engine**: *"It syncs data out of Postgres into local clients
over HTTP using a primitive called a Shape."* It sits in front of Postgres, consumes **logical
replication (WAL)**, and exposes each Shape as an **offset-addressed, immutable, CDN-cacheable HTTP log**.

The one idea that matters for Stackbase: **Electric's read path is stateless and CDN-cacheable, so it
scales to "millions of clients" by collapsing them into one origin request — the opposite of Stackbase's
stateful-WebSocket-per-client model.** Where Stackbase holds a live WS + subscription state per client and
computes/pushes per-connection, Electric computes each `(shape, offset)` slice *once*, marks it immutable,
and lets a CDN fan it out. Two very different scaling architectures for the same "reactive query results
to N clients" problem.

**Read-path only.** Electric syncs Postgres→client. **Writes are the app's problem** (write-through your
own API to Postgres) — Electric v1 deliberately dropped the old bidirectional-CRDT model to "focus purely
on efficient data distribution without managing complex transaction coordination."

## 2. Shapes — partial replication with an *indexed* membership filter

A **Shape** (`shapes/shape.ex:31-49`) = `{root_table (OID, survives renames), root_pk, where (a parsed,
typechecked `Replication.Eval.Expr`, not raw SQL), selected_columns, replica (:default|:full),
shape_dependencies}`. A `where` that references a sub-SELECT is decomposed into a **DAG of dependent
shapes** at parse time (`shape.ex:337-376`).

**Membership testing is indexed, not brute-force** — the 4th independent confirmation of "index the
matcher" (alongside SpacetimeDB, RxDB, and our own fan-out benchmark). `Shapes.Filter` keeps ETS indexes
(`EqualityIndex` for `col = const`, `InclusionIndex` for `= ANY`/`@>`, `SubqueryIndex` for subquery
membership) keyed by `{field, operation}` (`filter/where_condition.ex:41-169`). On an incoming change,
`Filter.affected_shapes/2` (`filter.ex:180-240`) unions **O(1) index lookups** with a **linear scan of
only the non-optimizable shapes on that table** — never a global scan. `UpdatedRecord` unions old+new
matches (so move-in/move-out of a shape's WHERE is handled); an evaluation error over-delivers (returns
all shapes) rather than silently dropping.

## 3. WAL → change events → per-shape logs

- **One replication slot per Postgres source**, not per shape. `Postgres.ReplicationClient`
  (`postgres/replication_client.ex`) is a single `Postgrex.ReplicationConnection`; `handle_data`
  (`:494-511`) decodes raw WAL (pgoutput) into Begin/Relation/Insert/Update/Delete/Truncate/Commit, batched
  into `TransactionFragment`s (default 100, to bound memory). Dispatch is async (pauses the socket) so
  keepalives stay responsive.
- **Fan-out**: every fragment passes through one `Replication.ShapeLogCollector` →
  `Shapes.EventRouter`, which computes `Filter.affected_shapes` per change, buckets per shape, and
  synthesizes a **per-shape Begin/Commit** (only for shapes actually touched) so each shape sees its own
  consistent transaction slice (`event_router.ex:78-230`). `DependencyLayers` topologically orders delivery
  so a subquery shape's dependency publishes first.
- **`LogOffset = {tx_offset = Postgres LSN, op_offset = index within txn}`** (`replication/log_offset.ex`)
  — totally ordered, **immutable once assigned** (a given `{lsn, op}` never re-maps). Serializes to the
  wire as `"<tx>_<op>"` — exactly the `offset` query param. Reserved: `-1` = before-all; virtual `0_<n>`
  offsets address the snapshot region, `0_inf` marks the boundary to the first real LSN offset.

> This `{lsn, op_offset}` is the direct analog of Stackbase's `{ts, id}` MVCC-log position — **but
> externally assigned by Postgres**, so Electric inherits ordering/durability from the WAL rather than an
> app-level transactor.

## 4. Snapshot + gap-free stitch (xmin/xmax/xip_list)

Initial snapshot (`postgres/snapshot_query.ex:42-105`): a `REPEATABLE READ READ ONLY` txn captures
`pg_current_snapshot()` = `{xmin, xmax, xip_list}` + current LSN *before* streaming the shape's rows, then
appends a **`snapshot-end`** control message carrying `xmin/xmax/xip_list` (as strings — uint64 would
mangle in JS). Stitching (`replication/changes.ex:169-183`): every WAL txn arriving during/after the
snapshot is tested against that `pg_snapshot` — `xid < xmin` ⇒ already in snapshot ⇒ **skip** (dedup);
`xid >= xmax` ⇒ **keep**; in-between ⇒ check `xip_list`. Once a txn is provably post-snapshot, filtering is
disabled permanently. Result: **no row is both in the snapshot and replayed from WAL, and none in between
is dropped** — a gap-free, duplicate-free stitch, using only Postgres's own visibility machinery.

## 5. Storage — an immutable, offset-addressed, chunked log (what makes it cacheable)

`ShapeCache.Storage` behaviour; production impl `PureFileStorage` (`shape_cache/pure_file_storage.ex`).
Per shape: a `snapshot/` dir of chunked JSON-line files, and a `log/` dir of binary fixed-format records
`<<tx_offset::64, op_offset::64, key_size::32, key, op_type::8, flag::8, json_size::64, json>>` + a
`chunk_index` of `{min_offset, max_offset, byte_range}` for **seek-by-offset without scanning**. Writes are
buffered (64KB/1s) and mirrored into ETS so an offset not yet fsynced is still readable (2-layer design);
durability boundary = `last_persisted_txn_offset`. **Each offset range is immutable → each catch-up chunk
is a byte-identical, CDN-cacheable HTTP response.**

Lifecycle: shapes are **lazily created** on first request; the **handle** = `phash2(canonical shape) +
µs-timestamp` (`shape.ex:139-145`) so identical requests share a handle. Expiry: **LRU** (`ExpiryManager`,
`max_shapes`) + DDL/truncate → **rotate the handle** (treat as invalidating). Cleanup is staged/async so it
never blocks the hot path.

## 6. The HTTP sync protocol + the CDN-cacheability mechanism (the headline)

`GET /v1/shape` (`plug/serve_shape_plug.ex`) — initial, catch-up, and live all use the **same
`(offset, handle)` pair**, not separate endpoints. Admission control classifies `:initial` vs `:existing`
from handle presence (ETS check, no DB) to cap concurrency per class.

**Cache headers** (`api/response.ex:207-331`) — the whole trick:
- **Initial (`offset=-1`):** `max-age=604800` (1 wk private), **`s-maxage=3600`** (1 hr CDN) — clients keep
  it long, CDNs revalidate sooner.
- **Catch-up chunk:** `max-age=60, stale-while-revalidate=300`.
- **Live long-poll:** `max-age=5` (short).
- **409 (shape rotated/`must-refetch`):** `max-age=60, must-revalidate` — briefly cached as a "redirect" so
  a stampede converges on one origin refetch.
- **Errors:** `no-store`.
- **ETag** = `"<handle>:<requested-offset>:<response-offset>"` → conditional `304`. `electric-*` headers
  carry `handle`, `offset` (the next request's `offset`), `cursor`, `schema`, `up-to-date`.

**Request collapsing** is the entire stateless story: identical logical state ⇒ byte-identical URL ⇒ the
CDN serves **one** origin fetch and fans it to N clients. The origin computes each `(handle, offset)`
*once*; the CDN does the fan-out, not the sync service.

**The clever bit — collapsing even *live* long-polls** (`plug/utils.ex:66-93`): the live `cursor` param is a
time bucket — `get_next_interval_timestamp` rounds time into `long_poll_timeout`-sized windows (default
20 s) since a fixed epoch. Clients whose live requests land in the same window compute the **same cursor**
⇒ **same URL ⇒ collapse at the CDN even for live updates** (with jitter for pathological desync). This is
how a *push*-feeling system stays CDN-cacheable.

**Live long-poll** (`api.ex:799-976`): the server registers the request as a shape-event listener and does
a blocking `receive` for `:new_changes` / `:shape_rotation` / timeout (20 s). On change → return the new
log slice; on timeout → 200 with just the `up-to-date` control message. An SSE variant (`live_sse=true`)
streams frames for up to 60 s.

## 7. TS client materialization

`ShapeStream` (transport, `client.ts`) + `Shape` (materialized view, `shape.ts`). The client loop is an
async trampoline (`#requestShape` tail-calls itself, `client.ts:1127`); an immutable state machine
(`shape-stream-state.ts`: `Initial → Syncing → Live`, plus `Paused`/`Error`) tracks `offset`/`handle`/
`cursor` from the `electric-*` response headers and detects stale-CDN responses by comparing the returned
handle to a locally-tracked expired handle. `Shape#process` (`shape.ts:198-272`) applies `insert/update/
delete` (keyed by `message.key`) into a `Map<key, row>` — `changes_only` mode applies updates/deletes only
for keys it's seen an insert for. **Notify semantics guarantee consistent snapshots**: subscribers are
notified only on the `syncing → up-to-date` transition, or on any change once already up-to-date — never
mid-sync. `must-refetch` (409) clears local state, marks the handle expired, and retries fresh.

## 8. Stackbase ↔ Electric

| Dimension | ElectricSQL | Stackbase |
|---|---|---|
| Read-path transport | **Stateless HTTP, CDN-cacheable** offset log | Stateful **WebSocket per client** |
| Scaling the fan-out | **CDN request-collapsing** (origin computes once) | Server pushes per-connection |
| Change source | **Postgres logical replication (WAL)** | Own append-only **MVCC log** |
| Log position | `{LSN, op_offset}` (Postgres-assigned) | `{ts, id}` (transactor-assigned) |
| Reactive matcher | **Indexed** shape-membership filter (ETS) | Linear `findAffectedByRanges` scan (backlog #1) |
| Query surface | table + where + columns (Shapes) | full query/mutation functions |
| Writes | **App's problem** (write-through your API) | First-class transactional mutations |
| Consistency | Snapshot+WAL stitched via xmin/xmax/xip_list | MVCC commit + read/write-set intersect |

Electric is *narrower* (read-only CDC, no functions, no writes) but its **read-path scaling model is
genuinely different and worth stealing selectively.**

## 9. What Stackbase should take from Electric

(Detailed as backlog items in [`../../../benchmarks/docs/performance-backlog.md`](../../../benchmarks/docs/performance-backlog.md).)

1. **Indexed shape/subscription membership** — a *4th* confirmation of backlog **#1** (index the matcher).
   Electric's ETS `EqualityIndex`/`InclusionIndex` is a concrete reference for indexing subscriptions by
   `(field, value)`.
2. **STRATEGIC: an optional CDN-cacheable HTTP read tier.** For read-heavy fan-out (many clients, same
   data), an immutable offset-log-over-HTTP endpoint would let a CDN absorb the fan-out that WebSockets
   force onto the origin. Includes the **live-cursor time-bucketing** trick to keep even live updates
   collapsible. Big architectural option, not a quick perf fix — but it's the one thing Electric does that
   a stateful-WS reactive engine fundamentally can't.
3. **Gap-free snapshot+log stitching (xmin/xmax/xip_list)** — the exact technique to make Stackbase's
   deferred **version-gap resync** (backlog #13) correct over an HTTP/log endpoint: initial consistent
   snapshot + WAL/log catch-up with no dup/gap.
4. **Handle-rotation + `must-refetch` as the compaction/invalidation escape hatch** — a clean pattern for
   invalidating a cacheable log when it compacts or its shape changes.
5. **WAL/logical-replication as a change source** — validates the fleet replica-tailer direction; an
   alternative to app-level change hooks.

## 10. What NOT to copy

- **Read-only / no writes / no functions** — Electric deliberately gave up the write path and any
  server-side compute. Stackbase's transactional mutations + server functions are its reason to exist;
  don't trade them away. Borrow the read-path *transport*, not the scope.
- **Postgres-only, WAL-coupled** — Electric is welded to Postgres logical replication; Stackbase's
  pluggable-store model can't couple that tightly (though the *technique* ports to reading our own log).

## 11. Sources

Two-agent source read of `.reference/electric` (tip `9acd04f`): `packages/sync-service/lib/electric/{shapes,
replication,shape_cache,postgres,plug}/*` and `packages/typescript-client/src/*`; docs at `electric.ax`.
See [`spacetimedb-internals.md`](spacetimedb-internals.md) and [`rxdb-internals.md`](rxdb-internals.md) for
the other two reactive systems — the three converge on incremental maintenance + indexed matching.
