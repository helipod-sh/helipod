# Research: a Cloudflare-native (Durable Object) runtime host

**Date:** 2026-03-20
**Status:** Research complete. Next step: brainstorm → spec (recommended: fresh full-context session).
**Strategic decision (user, 2026-03-20):** Cloudflare is a market to WIN. Build a DO-native fast
path that scales cheaply like Lunora, **keep** the R2/S3-object-store path, make both coexist behind
seams — same app code on both. Flexibility is the north star.

## Verdict: (b) achievable, but with named engine changes — NOT a clean re-host

The "we already have the engine, so this is just re-hosting" assumption **does not survive** contact
with the DO execution model. It's achievable behind a `RuntimeHost` seam, but the DO model forces
real architectural work the portable container path never needed. Four named changes (below).

## Hard limits to design against (primary sources, dated)

| Limit | Value | Source |
|---|---|---|
| DO-SQLite size | **10 GB per DO** (GA Apr 7 2025; hard `SQLITE_FULL` on write past it) | CF changelog 2025-04-07 |
| DO memory | **128 MB, billed flat** regardless of usage; instances of a class may share it | CF DO pricing page |
| Concurrency | **single-threaded** — one request at a time | CF "What are DOs" |
| Single-DO throughput | **~1,000 req/s soft ceiling; ~200–500/s for write/storage-heavy** | verified (CF Queues team hit 400 msg/s v1, fixed by SHARDING, never by a faster DO) |
| WS hibernation attachment | **16 KB serialized** per socket — bounds per-socket subscription state | verified |
| Hibernation | idles "several seconds" → hibernates; in-memory state lost; **not billed for duration while idle-eligible** even holding thousands of sockets | CF DO lifecycle |
| Worker Loader (untrusted user JS) | **open beta, paid-only, since Mar 2026**; `globalOutbound: null` blocks egress | verified |
| Free tier | SQLite-backed DOs work on the **Free** plan | CF DO pricing |

## The four named engine changes (this is the real work)

1. **In-memory single-writer mutex → the DO's serial-execution model.** A transactor-DO is
   single-threaded by construction, so the mutex is free — but it's ALSO the hard per-shard write
   ceiling (~200–500 writes/s). A co-located singleton transactor cannot parallelize; horizontal
   decomposition (Lunora's `.shardBy(key)` = one DO per key) is MANDATORY, not optional.
2. **`setInterval` → DO alarms.** ALREADY DONE — this is exactly the wake seam shipped this session
   (`docs/superpowers/specs/2026-03-20-do-alarm-driver-seam-design.md`). The `WakeHost` seam +
   `backstopMs` are the DO-alarm abstraction; the DO host implements `armWake` via `storage.setAlarm`.
   This slice is a down-payment on the DO host.
3. **Persistent in-memory subscription state → survive hibernation via the 16 KB attachment.** The
   sync tier's subscription index currently lives in RAM and assumes a process that never dies. On a
   DO it must serialize per-socket read-set state into the 16 KB WS attachment and rehydrate on
   revival. 16 KB is a real bound — a socket subscribed to many large-range queries may not fit.
4. **R2-object-store-as-single-truth → per-DO sharded storage + a cross-shard query/index layer.**
   The biggest one. Today R2 is one shared linearized log. DO-SQLite is per-DO/per-shard, isolated.
   Cross-shard queries, cross-shard transactions, and global secondary indexes need a new mechanism
   (Lunora routes these to D1's Sessions API for read-your-writes). This is genuinely new engine
   surface, not a host swap.

## The decomposition pattern (from Concave + Lunora)

- Stateless **Worker** = router (terminates HTTP/WS, forwards; holds no state).
- **transactor-DO** (Concave `ConcaveDO` / Lunora `ShardDO`) = the writer + DO-SQLite, one per shard;
  single-threaded serialization IS the OCC/mutex.
- **sync-DO** (Concave `SyncDO` / Lunora `SessionDO`) = WebSockets + subscription index, hibernated.
- Invalidation crosses the DO boundary by RPC: transactor computes changed ranges → notifies the
  sync-DOs → they intersect against read-sets → push. Ordering/consistency across the RPC hop is the
  pitfall to design carefully (parallels our shipped G1/G4 frontier guarantees).
- User query/mutation JS runs in a **Worker Loader** sandbox isolate that can only syscall back to
  the transactor DO (no direct storage/network) — the isolate-ready syscall ABI we already have is
  what makes this viable.

## Economics — why this wins where the container loses

- **Idle / fan-out:** a hibernated DO holds thousands of WebSockets and is NOT billed for duration
  while idle-eligible. The container spins a **3 GiB-floor VM per wake**. For bursty/low-traffic and
  connection-heavy reactive apps, DO is dramatically cheaper — and has a **free entry tier** the
  container path ($5/mo Containers floor) can't match.
- **Sustained writes:** bounded by the single-DO ceiling per shard; you scale by adding shards
  (cheap DOs), not by a bigger box.

## Flexibility / the seam — is it clean?

Mostly, with the four changes above absorbed. The clean abstractions: storage (DO-SQLite vs
R2-object-store, both already behind `DatabaseAdapter`/`ObjectStore` seams), timers (WakeHost —
done), execution host (RuntimeHost — the new seam). The IMPEDANCE MISMATCHES that leak into the
engine: single-threaded-vs-mutex (forces sharding), hibernation-vs-persistent-memory (forces
serialize-to-attachment), per-DO-storage-vs-shared-log (forces the cross-shard layer). These are why
it's (b) not (a).

## Migration / portability between the two paths

The R2-object-store path (one shared log) and the DO-SQLite path (per-shard isolated) are
**different data topologies** — an app doesn't transparently move its live data between them. They
are separate deployments. Same APP CODE (schema + functions) runs on both; the DATA does not
teleport. A migration tool (export from one, import to the other) is a separate follow-on, not free.

## Biggest risk + realistic slice breakdown

**Single biggest risk:** the cross-shard query/index layer (change #4). Single-shard DO-SQLite is
easy and fast; the moment an app needs a query spanning shards or a global unique index, you're
building distributed-query machinery (or leaning on D1 like Lunora). This is where the effort and the
correctness risk concentrate — scope it explicitly and consider shipping single-shard-only first.

**Rough slices (to refine in the spec):**
1. `RuntimeHost` seam extraction — pull the server/host out of `packages/cli`, engine-neutral. (Also
   makes the container path cleaner; worth doing regardless.)
2. DO-SQLite `DatabaseAdapter` — synchronous `ctx.storage.sql.exec`, matches the existing SQLite
   adapter shape well.
3. Single-shard DO host — transactor-DO + sync-DO + Worker router, one shard, WS hibernation with the
   16 KB attachment, reusing the shipped WakeHost/alarm work.
4. Worker Loader sandbox for user JS (open beta — de-risk early).
5. Multi-shard (`.shardBy`) + the cross-shard query/index layer (the hard one; D1 Sessions API is the
   reference).
6. E2E through real Cloudflare (the discipline this session proved matters), + a migration tool.

## Cross-check note

The 10 GB / 128 MB-flat / single-threaded / Free-tier numbers were independently confirmed against
the Cloudflare docs MCP during this session, not just the web-research pass. The ~200–500 writes/s
DO ceiling and the 16 KB attachment bound come from the research pass — worth a direct-docs
confirmation before they become load-bearing in the spec.

Full research transcript: the deep-research workflow run under this session's subagents dir.
