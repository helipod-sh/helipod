---
title: Tier 2 Topology — Research, Second Thought, and the Proposed Unique Design
status: slice 1 SHIPPED (symmetric fleet, lease-based writer, live failover) + slice 2 SHIPPED (embedded local replicas — every sync node serves reads off a file-backed replica tailing the shared log, read-your-own-writes, Postgres-outage read tolerance — see docs/enduser/deploy/fleet.md); beyond slice 2 remains research/pre-spec
decided: —
date: 2025-08-28
audience: engineering (internal)
---

# Tier 2 Topology — Research & Second Thought

> How Stackbase should actually scale out. This records BOTH passes of the design research:
> the **first proposal** (synthesized from our internal research docs — concave/Convex/Lunora/
> Supabase) and the **second thought** (a fresh web sweep of 2024–2026 state-of-the-art), which
> found two real flaws in the first proposal and produced a simpler, more original design.
> Companion to [scalability-spectrum.md](./scalability-spectrum.md) (the reserved seams) and
> [scaling-reality.md](./scaling-reality.md) (the JS/Bun connection-tier numbers).
>
> Business framing (locked separately, [business-model-and-licensing.md](../business-model-and-licensing.md)):
> scale is the future paid tier; seams stay in FSL core; fleet *implementations* land in a
> reserved `ee/` area under the commercial license from their first commit. Everything runs
> free until the (later) license-key gate.

## 0. Context — what the seam inventory found (2025-08-28)

Before designing, we audited the 10 reserved seams from `scalability-spectrum.md` §3 against
the actual code:

- **Genuinely wired (drop-in):** write-fanout publisher indirection (seam 4, `EmbeddedWriteFanoutAdapter`,
  serializable `OplogDelta`), ephemeral broadcast ingress (5), transport-agnostic sync handler (3),
  `shardId` threading on every commit (1), client **version-gap → full resync** (6 — the one piece
  the docs said "cannot be bolted on later"; it is built).
- **Typed but consumed by nothing:** `ShardRouter` / `ShardKeyResolver` / `.shardKey()` — shardId
  is hard-`"default"`; the store impls drop the param.
- **Absent entirely:** the `STACKBASE_SYNC_*` autoscale config (doc-only — zero code),
  `SyncTopologyConfig`/`SyncShardMap`/`SyncNodeLoadReport`, the query cache (seam 8), the
  server-side backpressure/heartbeat controllers (seam 6's server half), any multi-node concept
  (`getSyncNodeId` → `"local"`).

So Tier 2 is *reserved*, not half-built. The un-retrofittable protocol pieces exist; the
distributed runtime does not.

## 1. FIRST PROPOSAL (from internal research) — the "n8n-style" plan

Synthesized from `docs/dev/research/{convex,concave,lunora,supabase,spacetimedb,pocketbase}.md`:

- **Role-flagged single binary** (the n8n queue-mode shape): same artifact, `--role writer` /
  `--role sync`, all nodes sharing one Postgres.
- **Change stream:** concave's fan-out bus, transport pluggable behind the existing
  `EmbeddedWriteFanoutAdapter`; default **Postgres LISTEN/NOTIFY** (zero extra infra), Redis
  Streams as the harder-guarantee upgrade.
- **"The bus is advisory; the log is truth."** Delivery guarantees (the docs' open question)
  answered by making the bus a wake-up hint only — a node that misses a message reconciles from
  the durable MVCC log (`load_documents(tsRange)`), and the client already full-resyncs on any
  version gap.
- **Write sharding** deferred to a later slice (single writer first — connections axis before
  writes axis). Cross-shard transactions rejected in v1 (Lunora's honest answer).
- **Coordinator + TTL shard map + autoscaler** (concave's blueprint) as a later slice for seam 9.
- **Borrow table:** Convex → single committer + stateless executor pool + read-set∩write-set
  fan-out (their scaled path is proprietary — building it open *is* the opportunity); concave →
  the fan-out bus + coordinator blueprint (never shipped; they lacked a Postgres DocStore — we
  have one); Lunora → hibernation-shaped subscription state, op-log replay for gapless reconnect,
  reject-cross-shard honesty (NOT their per-field DO sharding — that's their hot-shard wall);
  Supabase → the fleet shape (NOT WAL-tailing — their bottleneck — and not the 12-container
  footprint); PocketBase/SpacetimeDB → the single-binary thesis (their vertical-only ceiling is
  what Tier 2 removes).
- **Deployment answers settled here and unchanged by the second thought:** VPS/droplet/k8s
  first-class; Cloudflare edge = a later adapter family (DO/D1/Queues — the seams are the
  DO-shaped cut points); Vercel = frontend-only, honestly (serverless can't hold sockets or a
  single writer).

## 2. SECOND THOUGHT — the web sweep (2024–2026 state of the art)

| Pattern | Who | The idea |
|---|---|---|
| **Stateless-symmetric nodes over shared storage** | WarpStream, SlateDB | *No node is special.* Any agent can lead anything; the only stateful service is storage. Autoscale = add/remove identical nodes; zero rebalancing. |
| **Leases via storage CAS** | SlateDB; S3 conditional writes (2024) | Leader election with **no coordinator service** — compare-and-swap on the store itself is the lock/lease/fencing. |
| **Embedded replicas** | Turso/libSQL; Zero's zero-cache | Each node holds a **real local SQLite file** fed by log shipping; reads are local microseconds; only writes travel. Read-your-writes preserved. |
| **Compute/storage separation** | Neon (safekeepers/pageservers) | Compute streams WAL out; storage scales independently. |
| **Read-path over cacheable HTTP** | ElectricSQL (shapes) | Sync deltas as CDN-cacheable shape logs — fan-out collapses into the CDN; "no persistent socket tax"; readers share the shape log read-only. |
| **Deterministic command-log replication** | Calvin, VoltDB | Replicate the *inputs* (function calls), not the effects; replicas re-execute deterministically. |
| **Portable actors + hibernation** | Rivet (OSS Durable Objects), CF DO | Self-hostable actor substrate exists now; idle sockets cost storage, not compute (plan ~low-thousands of sockets per actor, shard by room). |
| **Hub + dial-in workers** | iii (iii.dev) | Workers connect INTO a central engine and register functions — great for polyglot compute, but the hub is a coordinator/SPOF: the anti-pattern this design rejects. See [research/iii.md](../research/iii.md) for what we DO borrow (server-side `onChange` triggers, polyglot action workers, Apache client SDK). |

Sources: WarpStream architecture docs · slatedb.io · morling.dev "Leader Election With S3
Conditional Writes" · docs.turso.tech embedded replicas · neon.com architecture-overview ·
zero.rocicorp.dev · electric-sql.com Postgres sync · github.com/rivet-dev/rivet · Cloudflare DO
WebSocket-hibernation docs · VoltDB "How VoltDB does Transactions" · Calvin (Muratbuffalo
summary).

### The two flaws this exposed in the first proposal

1. **Hidden read bottleneck.** "1 writer + N sync nodes over shared Postgres" has every sync
   node re-running invalidated queries *against the shared primary*. Adding sync nodes adds read
   load to the one Postgres — that is not horizontal scaling, it moves the wall. Convex (Funrun
   caches), Zero (zero-cache replica), Turso (embedded replicas), and Electric (shape logs) all
   solved exactly this; none let the fan-out tier query the primary.
2. **Static roles are one generation behind.** `--role writer/--role sync` means manual topology
   and no failover story (writer dies → an operator restarts it). WarpStream/SlateDB showed the
   modern answer: **symmetric nodes + lease-based ownership**; roles are *emergent*, not
   configured.

## 3. THE PROPOSED DESIGN — "symmetric log-fed fleet"

> **Every node is the same binary. The database is its own coordinator. The log feeds everyone.**

1. **Symmetric nodes, emergent roles — no coordinator service, ever.** Every node runs identical
   `stackbase serve` (no role flags). The single-writer role per shard is a **lease acquired
   through the store itself** — and the Postgres adapter's `pg_advisory_lock` single-writer guard
   *already is* that lease; S3 conditional-writes later give the identical CAS primitive on a
   bucket. Writer dies → lease released/expires → any node picks it up. Failover for free;
   autoscale = launch more identical nodes. concave's whole Coordinator + KV + shard-map
   *service* collapses into tables in the store (lease table + shard map as rows).
2. **Every node feeds itself an embedded replica by tailing the log.** A sync node never queries
   the primary — it replays the MVCC document log into a **local in-process `SqliteDocStore`**
   (Turso's trick applied to our document log) and re-runs subscriptions against the local
   replica *at the replica's watermark timestamp*. The engine is pre-adapted: queries already
   execute at a `readTimestamp` against any `DocStore`, so replica lag is just "run at the
   watermark you have" — MVCC semantics handle it natively, no new consistency model. Primary
   load per sync node = one log-tail cursor, regardless of socket count.
3. **The bus stays advisory; the log stays truth** (kept from the first proposal —
   LISTEN/NOTIFY wake-up hints; correctness from log replay). Cleaner now: the replay that makes
   best-effort delivery safe is the *same mechanism* that feeds the replica.

**Two later moats enabled (not slice 1):**
- **Deterministic UDF command-log geo-replication** (Calvin/VoltDB): our mutations are
  deterministic *by design* (the reactivity model demands it), so replicas can re-execute the
  tiny function-call log instead of shipping data. Supabase/PocketBase structurally cannot do
  this; Convex doesn't exploit it. No BaaS ships deterministic replication.
- **Tier S — object-storage substrate as just another `DocStore`** (SlateDB): single-writer LSM
  over a bucket with CAS fencing; a fleet whose only stateful dependency is **a bucket** — $0
  idle, no database server. The WarpStream economics for a reactive BaaS.
- (Also compatible later: an Electric-style CDN-cacheable HTTP delta read path — the
  version-bracketed `Transition` protocol is already close to a log-offset model. Keep the wire
  from precluding it; do not build it now.)

**Uniqueness check (honest):** each piece exists somewhere; the *combination* — reactive
read-set∩write-set BaaS + symmetric lease-based fleet + log-fed embedded replicas +
deterministic command log, self-hostable on anything — is shipped by no one. Convex's scaled
tier is proprietary and centralized; Zero and Electric are read-path only (no writer/BaaS
story); Rivet is an actor substrate, not a reactive database; Lunora is Cloudflare-locked. The
moat is the prerequisites (deterministic UDFs, MVCC log, timestamped reads, narrow DocStore
seam) — competitors would have to rebuild their cores to get them.

### What changed vs. the first proposal

| First proposal (n8n-style) | Proposed (second thought) |
|---|---|
| Static `--role writer/sync` flags | **Symmetric nodes; writer = store lease; roles emergent; failover free** |
| Sync nodes query shared Postgres | **Sync nodes tail the log into a local embedded replica; primary sees only tail cursors** |
| Coordinator + shard-map service (seam 9, from zero) | **Deleted — the store is the coordinator (lease + shard tables in the DB)** |
| LISTEN/NOTIFY advisory bus; log is truth | Unchanged ✓ |
| Seams in FSL core; fleet impls in `ee/` | Unchanged ✓ |
| Redis Streams as optional bus upgrade | Unchanged; plus **Tier S (bucket-only) named as a future adapter** |
| VPS first / CF-edge later / Vercel = frontend-only | Unchanged ✓ |
| Single-writer-per-shard; cross-shard txns rejected v1 | Unchanged ✓ (write-sharding is a later slice; the lease design is what per-shard writers hang off) |

### Honest caveats / open spec questions

- Per-node replica costs disk/memory + cold-start catch-up → snapshot bootstrap strategy needed.
- `OplogDelta` carries **ranges, not values** → the tail is pull-based (node pulls log entries
  since its watermark — a cheap indexed range read; Litestream/Turso model). Pull vs. enriching
  the bus payload is a spec decision (lean pull: keeps the bus tiny and advisory).
- Writes still land on one Postgres until the write-sharding slice (fine: connections axis
  first).
- Lease semantics: advisory-lock session leases vs. row-based leases with expiry + fencing
  tokens (spec decision; must survive node crash + clock skew).
- LISTEN/NOTIFY payload cap (~8KB) is fine for advisory pings.
- Live-session migration during reshard (drain vs cutover) and cross-shard transaction policy
  remain the riskiest later-slice questions — v1 policy: reject cross-shard, document it.

## 4. Slice 1 (to be spec'd next)

Two identical processes + one Postgres:
node A holds the writer lease; node B tails the log into its local replica and serves a live
WebSocket subscription; a mutation on A reactively pushes on B (via LISTEN/NOTIFY wake-up +
log replay); **kill A → B (or a fresh node) takes the lease and writes continue.**
Failover is demoable in slice 1 — the lease is the existing advisory lock, the replica is the
existing `SqliteDocStore` + a tail loop. E2E through the real `stackbase serve` entrypoint, per
[[e2e-through-shipped-entrypoint]] convention.

## 5. Verdict

The first proposal was not wrong — single-writer-per-shard, advisory bus, log-as-truth, `ee/`
placement, and the deploy-anywhere answers all survive scrutiny. It was one topology generation
behind. The revised design is simultaneously **simpler** (no coordinator service, no role
config) and **more original** (the symmetric log-fed fleet combination is unshipped anywhere).
