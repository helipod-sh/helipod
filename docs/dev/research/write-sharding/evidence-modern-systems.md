# Web-Evidence Report: Multi-Writer Commit Ordering & Safe Read Visibility

Research sweep for Stackbase write-sharding design (slice: remove the single-writer ceiling on the Tier-2 fleet while preserving the one-global-timestamp reactivity contract). Each system is analyzed against the two hard problems: (1) safe visibility when timestamps commit out of order across parallel writers, (2) knowing a mutation's shard before execution. Sources cited inline; synthesis at the end.

---

## 1. TiDB / PD — Centralized Timestamp Oracle (TSO)

**Mechanism.** PD (Placement Driver) is a singleton allocator of hybrid timestamps (physical ms + 18-bit logical counter) for the whole cluster. Every transaction fetches a start_ts and a commit_ts from PD over RPC. To survive restarts without re-issuing timestamps, PD persists only a *timestamp window* (e.g. "high water = now + 3s") to etcd and serves the actual allocations purely from memory; on failover the new leader starts above the persisted window. Clients and TiDB nodes *batch* TSO requests: each requester keeps at most one pending RPC to PD and folds all concurrent transactions' timestamp needs into it, so load-induced batching self-compensates — the busier the system, the bigger the batches.

**What orders commits.** The single TSO's strictly monotonic counter. Commit order = TSO order; Percolator-style 2PC makes the commit_ts the serialization point.

**Read-visibility rule.** A reader at start_ts sees exactly commits with commit_ts ≤ start_ts; because commit requires a round-trip to the same oracle, "I got ts X" implies every smaller ts was already handed out (though possibly not yet *committed* — TiKV resolves in-flight locks it encounters, which is the mechanism that closes the "allocated but not landed" gap: a reader that hits a lock at ts ≤ its snapshot must wait/resolve it).

**Coordination cost per commit.** 2 TSO round-trips per read-write transaction (start + commit), amortized by batching to a fraction of an RPC each. PD allocates *millions of timestamps per second*; the persistent-window trick means etcd writes happen every few seconds, not per allocation. The real cost is network latency to PD, which is why TiDB grew `PARALLEL`/`PARALLEL-FAST` TSO modes to overlap TSO waits with other work.

**Bottlenecks.** PD leader is a singleton (failover gap, cross-region latency); every transaction touches it. Batching pushes the ceiling far out but never removes it.

**Applicability to Stackbase.** Very high. Stackbase already has a lease-elected coordinator (the store's `fleet_lease`). A "TSO endpoint" on the coordinator — batched allocation of contiguous ts ranges to shard writers, with the high-water persisted in a Postgres row (the etcd-window trick maps 1:1 to a single `UPDATE fleet_ts` per window, not per commit) — keeps the ONE global bigint line without a new service. The lock-resolution insight matters: allocation order ≠ landing order, so a TSO alone does **not** solve safe visibility; you still need a frontier protocol (see Kafka/CRDB below).
Sources: [PingCAP TSO blog](https://www.pingcap.com/blog/how-an-open-source-distributed-newsql-database-delivers-time-services/), [TiKV deep dive: Timestamp Oracle](https://tikv.org/deep-dive/distributed-transaction/timestamp-oracle/), [tikv/pd wiki](https://github.com/tikv/pd/wiki/Timestamp-Oracle), [TiDB TSO docs](https://docs.pingcap.com/tidb/stable/tso/), [perf tuning](https://docs.pingcap.com/tidb/stable/tidb-performance-tuning-config/)

---

## 2. CockroachDB — Hybrid Logical Clocks + Closed Timestamps

**Mechanism.** No central oracle: every node timestamps with an HLC (physical NTP-synced clock + logical counter, bounded skew). Writes go through per-range Raft leaseholders. Each range continuously *closes* timestamps: the leaseholder promises "no new write will ever land at or below ts T on this range," targeting T ≈ now − 3s (`kv.closed_timestamp.target_duration`). A write arriving below the closed frontier is *pushed* to a higher timestamp (possibly forcing a transaction refresh/restart) — the frontier never retreats.

**What orders commits.** Per-range Raft log order; cross-range consistency comes from HLC timestamps + uncertainty intervals (reads restart if they see a value in their uncertainty window).

**Read-visibility rule.** A follower may serve a read at ts X iff X ≤ its known closed timestamp for that range AND it has applied the Raft log up to the position the closed-ts update referenced (`<timestamp, log position>` pairs — MLAI, min log applied index). This is the crucial two-part rule: *a closed timestamp is only meaningful relative to a log prefix you've fully applied.*

**Coordination cost per commit.** Near zero marginal cost: closed-ts info is piggybacked inside ordinary Raft commands; when a range is idle, a node-level *side transport* broadcasts bulk updates every 200ms (`side_transport_interval`), grouped by timestamp, one message covering many ranges. The costs are (a) staleness (readers of the closed frontier lag ~3s by default, tunable down) and (b) occasional write pushes/restarts when a slow write straddles the frontier.

**Bottlenecks.** None central — that's the point. The tradeoff surfaces as: follower reads are always stale by the target duration; making the frontier tight increases write restarts.

**Applicability to Stackbase.** The **closed-timestamp frontier is the single most transferable read-visibility idea**: each shard writer periodically publishes "everything ≤ F_s on shard s is durably in the log" and the fleet-wide safe snapshot is `min(F_s)` over active shards. Stackbase doesn't need HLCs (Postgres itself can be the clock/allocator), but the `<frontier, log position>` pairing maps directly onto "replica watermark valid only after applying all log rows ≤ F". The push-writes-above-the-frontier rule translates to: a shard writer must never commit at a ts below the frontier it already published.
Sources: [CRDB follower reads docs](https://www.cockroachlabs.com/docs/stable/follower-reads), [An epic read on follower reads](https://www.cockroachlabs.com/blog/follower-reads-stale-data/), [follower reads RFC](https://github.com/cockroachdb/cockroach/blob/master/docs/RFCS/20180603_follower_reads.md), [implementation RFC](https://github.com/cockroachdb/cockroach/blob/master/docs/RFCS/20181227_follower_reads_implementation.md), [transaction layer](https://www.cockroachlabs.com/docs/stable/architecture/transaction-layer)

---

## 3. Google Spanner — TrueTime Commit-Wait

**Mechanism.** TrueTime exposes clock uncertainty as an interval [earliest, latest] backed by GPS/atomic clocks (ε ≈ 1–4ms). A commit picks ts = TT.now().latest, then **waits out the uncertainty** (until TT.now().earliest > ts) before acknowledging — guaranteeing that by the time a commit is visible, its timestamp is definitely in the past everywhere. This yields external consistency (real-time order ⇒ timestamp order) with zero cross-node coordination about ordering itself.

**What orders commits.** Physical time, made trustworthy by hardware-bounded uncertainty; per-group Paxos logs provide durability order.

**Read-visibility rule.** Each Paxos group tracks t_safe (min of Paxos-applied ts and the earliest prepared-but-uncommitted transaction's ts); a replica serves a snapshot read at t iff t ≤ t_safe. Note the shape: *safe time = min over in-flight things* — the same min-frontier pattern again.

**Coordination cost per commit.** ~ε of wall-clock wait (historically ~8ms, now lower), usually overlapped with Paxos replication so the marginal cost is small — but it is an irreducible latency floor bought with special hardware.

**Bottlenecks.** None architectural; the dependency is the clock infrastructure itself.

**Applicability to Stackbase.** The commit-wait trick is **not** transferable (no atomic clocks in "deploy anywhere self-host"; NTP ε would mean 100ms+ waits). What transfers is the *t_safe* formulation: safe-read time = min(applied frontier, earliest in-flight commit ts) — computable from bookkeeping, no clocks needed, when timestamps come from a shared allocator.
Sources: [Spanner paper](https://research.google.com/pubs/archive/39966.pdf), [Spanner TrueTime & external consistency docs](https://docs.cloud.google.com/spanner/docs/true-time-external-consistency), [Life of Spanner reads/writes](https://cloud.google.com/spanner/docs/whitepapers/life-of-reads-and-writes), [MIT 6.824 Spanner FAQ](https://pdos.csail.mit.edu/6.824/papers/spanner-faq.txt)

---

## 4. FoundationDB — Sequencer + Parallel Resolvers (ordering without serializing execution)

**Mechanism.** An unbundled pipeline: a singleton **Sequencer** hands out read versions and commit versions (advancing ~1M versions/sec, in memory, no disk I/O — it does *nothing else*); **Commit Proxies** batch client commits, get one commit version per batch; **Resolvers** — *range-partitioned by key* — run OCC conflict checks in parallel, each holding the last 5s of committed write ranges for its key slice; a transaction commits iff *all* touched resolvers say yes; **LogServers** fsync the mutations; storage servers tail the logs. Critically, every version handed out carries the **previous commit version (LSN chaining)**: a downstream consumer receiving version 101 with prev=99 knows it must wait for 99 — order is re-established at every consumer *without a watermark service or gossip*.

**What orders commits.** The sequencer's version counter — a pure ordering service. Execution, conflict checking, durability, and application are all parallel/sharded; only *number handout* is serialized.

**Read-visibility rule.** A read version from a GRV proxy = the max committed version known durable across logs (proxies confirm logs are live). LogServers/storage apply strictly in prev-LSN-chain order, so "applied through V" is by construction a dense prefix.

**Coordination cost per commit.** One in-memory RPC to the sequencer per *batch* (proxies batch aggressively), one parallel fan-out to the resolvers covering the txn's ranges, one fan-out to logs. No global consensus per commit. Known wart: a conflict detected at one resolver isn't communicated to the others, which then remember phantom writes → false conflicts later (admitted in the paper and in Jingyu Zhou's critique).

**Bottlenecks.** The sequencer is a singleton (mitigated by being trivially cheap); recovery halts the pipeline briefly; resolver false positives.

**Applicability to Stackbase.** This is the **strongest architectural template**: it proves you can keep ONE global monotonic version line (Stackbase's core invariant!) while writers execute and validate in parallel — the thing serialized is timestamp *allocation*, not commits. The Stackbase mapping is unusually clean: coordinator lease-holder = sequencer (batched ts-range grants over `/_fleet`), per-shard writers = proxy+resolver fused (each shard's `recentCommits` ring already IS a range-partitioned resolver, since cross-shard transactions are rejected v1 — no multi-resolver vote needed at all). Prev-ts chaining on log rows gives replicas gap detection for free: apply row (ts=101, prev=99) only after 99, making the watermark rigorous without any extra protocol.
Sources: [FDB architecture docs](https://apple.github.io/foundationdb/architecture.html), [FDB SIGMOD paper (pdf)](https://www.foundationdb.org/files/fdb-paper.pdf), [uvdn7's notes on the FDB paper](https://uvdn7.github.io/notes-on-the-foundationdb-paper/), [Jingyu Zhou's critique](https://medium.com/@jingyuzhou/a-critique-on-foundationdb-transaction-system-8b640c06f6cd), [kv-architecture](https://apple.github.io/foundationdb/kv-architecture.html)

---

## 5. Calvin / VoltDB — Deterministic Sequencing (order inputs, execute in parallel)

**Mechanism (Calvin).** Invert the pipeline: instead of executing then ordering commits, *order the inputs first*. Sequencer nodes collect transaction requests into 10ms epoch batches, durably log the batch, and merge batches into one global input sequence; schedulers on every partition then execute deterministically in exactly that order (deterministic lock acquisition), so all replicas/partitions reach identical states with no commit-time coordination and **no aborts from contention**. **VoltDB** is the degenerate single-machine form: each partition is a single-threaded engine executing queued stored procedures serially — no locks, no latches; a *command log* records invocations (inputs), not effects.

**What orders commits.** The input log's epoch/batch order. Commit order is decided *before* execution.

**Read-visibility rule.** Trivial per partition: state after input k is deterministic; a replica that has executed prefix k serves reads at k. Cross-partition consistent reads need an epoch boundary (all partitions caught up to epoch e).

**Coordination cost per commit.** One append to the input log (batched per epoch). Zero commit-time coordination. Cost is paid in latency (epoch batching, ≥10ms) and in the requirement that read/write sets be knowable up front (Calvin needs reconnaissance queries for dependent transactions).

**Bottlenecks.** Latency floor from epoching; poor fit for interactive transactions whose read set depends on reads (Stackbase mutations are arbitrary TS — read sets are NOT known up front, so full Calvin is out). VoltDB's per-partition serial loop is, notably, exactly Stackbase's current per-writer model.

**Applicability to Stackbase.** Full Calvin: no (dynamic read sets). Two ideas transfer: (a) **epoch ticks** — quantizing visibility advancement into small batches makes multi-shard snapshot publication cheap (publish "epoch e closed" instead of per-commit frontier updates); Convex already batches many writes into one ts the same way. (b) The philosophical license: Stackbase's single-writer-per-shard IS VoltDB's partition model, already validated at 100k+ TPS/partition scale — per-shard serial execution is not the thing to fix; visibility stitching is.
Sources: [Calvin paper summary (Murat)](https://muratbuffalo.blogspot.com/2022/04/calvin-fast-distributed-transactions.html), [the morning paper on Calvin](https://blog.acolyer.org/2019/03/29/calvin-fast-distributed-transactions-for-partitioned-database-systems/), [Fauna: Spanner vs Calvin](https://fauna.com/blog/distributed-consistency-at-scale-spanner-vs-calvin), [VoltDB technical overview (pdf)](https://www.voltactivedata.com/wp-content/uploads/2017/03/hv-white-paper-voltdb-technical-overview.pdf), [How VoltDB does transactions (pdf)](https://voltactivedata.com/wp-content/uploads/2017/03/lv-technical-note-how-voltdb-does-transactions.pdf)

---

## 6. Kafka — High Watermark + Last Stable Offset

**Mechanism.** Per partition, the leader tracks each in-sync replica's fetched offset; the **high watermark (HWM)** = min over ISR of replicated offsets. Consumers may only read below HWM — data above it could be lost on leader failover. With transactions, HWM is insufficient (an *uncommitted* transaction's records can be fully replicated), so the **last stable offset (LSO)** = the offset of the first still-open transaction; `read_committed` consumers read only below LSO, and later records — even committed ones — are *withheld until the earlier open transaction resolves*.

**What orders commits.** Append order in the partition log (single leader per partition). Cross-partition: nothing — Kafka deliberately has no global order.

**Read-visibility rule.** Two stacked min-frontiers: HWM (durability: min over replicas) and LSO (atomicity: min over open transactions). Note LSO's exact shape: *the safe prefix ends at the oldest in-flight thing, regardless of what finished after it* — precisely Stackbase's "A committed 101 but B's 99 is in flight" problem, answered by: expose only up to 98 until 99 lands or aborts.

**Coordination cost per commit.** Zero dedicated messages — HWM advancement piggybacks on the followers' ordinary fetch requests (advances on the *second* fetch, confirming persistence); LSO is local bookkeeping on the broker from transaction markers.

**Bottlenecks.** Per-partition single leader (the same per-shard ceiling Stackbase already accepts); LSO head-of-line blocking: one stuck transaction freezes read_committed consumers for the whole partition (bounded by `transaction.max.timeout.ms`).

**Applicability to Stackbase.** Direct. The fleet log tail should stop assuming "ts dense below max" and instead compute a **last-stable-timestamp**: safe_ts = (min over shard writers of "smallest allocated-but-uncommitted ts") − 1, with allocations that die reclaimed by a timeout/abort marker (Kafka's transaction timeout ≙ a lease-style TTL on allocated ts ranges). Head-of-line blocking is the cost to manage: allocate ts ranges small/late and expire them fast.
Sources: [HWM explained (2minutestreaming)](https://blog.2minutestreaming.com/p/kafka-high-watermark-offset), [Confluent: transactions & exactly-once](https://developer.confluent.io/courses/architecture/transactions/), [KIP-1166 HWM replication](https://cwiki.apache.org/confluence/display/KAFKA/KIP-1166:+Improve+high-watermark+replication), [KAFKA-9807 race: reads above LSO](https://issues.apache.org/jira/browse/KAFKA-9807), [read_committed/LSO semantics (KafkaConsumer javadoc)](https://kafka.apache.org/22/javadoc/org/apache/kafka/clients/consumer/KafkaConsumer.html)

---

## 7. Neon — Safekeeper Quorum WAL

**Mechanism.** Compute (Postgres) streams WAL to N safekeepers; a record is committed when a majority have fsynced it (Paxos-flavored protocol: compute is proposer, safekeepers acceptors, pageservers learners). A term/election mechanism guarantees at most one active WAL writer per timeline; commit_lsn = the highest LSN acknowledged by a quorum. Pageservers tail safekeepers and only materialize pages from WAL ≤ commit_lsn.

**What orders commits.** The single Postgres primary's WAL append order (LSN). Quorum is for *durability*, not ordering — still one writer per timeline.

**Read-visibility rule.** Readers (pageservers, hence read replicas) trust only WAL below the quorum-acknowledged commit_lsn — again min-over-acceptors, the HWM shape.

**Coordination cost per commit.** One parallel WAL push + majority ack per commit group (piggybacked/pipelined; latency = network RTT to quorum rather than local fsync).

**Bottlenecks.** Single writer per timeline by design; safekeeper quorum availability.

**Applicability to Stackbase.** Low for the sharding problem itself (Neon does not do multi-writer), but two confirmations: (a) "single writer per unit, elected by lease/term, readers trust a quorum/authority watermark" is exactly Stackbase's shipped fleet — Neon validates extending it per-shard (one elected writer *per timeline* ≙ per shard); (b) log-position watermark published by the durability authority, not inferred by readers, is the correct direction of information flow.
Sources: [neon walservice.md](https://github.com/neondatabase/neon/blob/main/docs/walservice.md), [safekeeper protocol](https://github.com/neondatabase/neon/blob/main/docs/safekeeper-protocol.md), [Jack Vanlightly's Neon analysis](https://jack-vanlightly.com/analyses/2023/11/15/neon-serverless-postgresql-asds-chapter-3), [Neon architecture overview](https://neon.com/docs/introduction/architecture-overview)

---

## 8. YugabyteDB — Hybrid Time + Safe Time

**Mechanism.** Like CRDB: HLC per node (NTP/chrony-synced physical component + logical counter; hard cap 500ms skew, nodes exceeding it are removed), Raft per tablet. Reads pick ht_read, then each tablet **waits for its local safe time to reach ht_read** before serving — safe time accounts for Raft-applied entries and pending intents below the read time.

**What orders commits.** Per-tablet Raft; cross-tablet via HLC timestamps propagated on every RPC (receiving a message advances your clock — Lamport-style causality carrying).

**Read-visibility rule.** safe_time(tablet) = f(last Raft-applied ht, earliest in-flight intent); serve read at t iff t ≤ safe_time — readers *wait* rather than fail, converting uncertainty into bounded latency.

**Coordination cost per commit.** None beyond Raft itself; HLC piggybacks on existing messages. Cost appears as read-side waits when clocks drift or writes are in flight.

**Bottlenecks.** Clock-skew dependence (NTP quality); per-tablet leader ceiling.

**Applicability to Stackbase.** Moderate. HLCs are unnecessary while a shared Postgres exists to allocate the one bigint line. But "reader waits until safe time ≥ requested ts" is exactly Stackbase's shipped read-your-own-writes watermark wait — extend it to a per-shard vector: wait until every relevant shard frontier ≥ commitTs. The message-piggyback pattern (every fleet RPC carries the sender's frontier) is a cheap way to keep frontiers fresh without extra traffic.
Sources: [YB transactional I/O path](https://docs.yugabyte.com/stable/architecture/transactions/transactional-io-path/), [transactions overview](https://docs.yugabyte.com/preview/architecture/transactions/transactions-overview/), [YB clock-sync blog](https://www.yugabyte.com/blog/evolving-clock-sync-for-distributed-databases/)

---

## 9. Vitess (vindexes) & Citus (distribution columns) — Mutation-Routing DX Precedents

**Vitess.** Every sharded table declares a **Primary Vindex**: a function from column value(s) → keyspace_id → shard. VTGate computes it from the *statement's values before execution* and routes to the owning shard; inserts derive their target shard from the primary vindex. Secondary vindexes (including lookup tables) narrow non-key queries; a scatter to all shards is the documented fallback. **Citus.** One distribution column per table; hash(column) → shard placement. Queries filtered on the distribution column route to a single worker ("router executor"); tables sharing a distribution column are *co-located* so joins/multi-row transactions stay single-shard; cross-shard queries fan out and merge on the coordinator. **VoltDB** likewise partitions procedures by a declared parameter — a single-partition procedure executes with zero coordination.

**What orders commits / visibility.** N/A (both delegate per-shard ordering to the underlying MySQL/Postgres; neither offers a cross-shard consistent snapshot in the default path — an honest precedent for Stackbase's "cross-shard transactions rejected v1").

**Coordination cost.** Routing is a pure client/proxy-side hash — zero coordination when the key is present.

**Applicability to Stackbase.** This is the DX playbook, and it converges from three independent systems: *declare one column/argument per table (and per mutation) as the shard key; the router computes the shard from values available before execution; co-locate tables that share a key; anything without a key falls back to the default shard or a fan-out read.* Stackbase's dormant `.shardKey(field)` schema API + `mutation({shardBy})` maps exactly: resolve shard from args (Vitess-style function of an arg → shardId), route via existing `/_fleet/run` forwarding to that shard's lease holder. Tier-0 story: with one process holding every shard lease, `shardBy` is a no-op annotation — identical app code, zero shard awareness, which is precisely how a single-node Citus/VoltDB behaves.
Sources: [Vitess vindexes reference](https://vitess.io/docs/22.0/reference/features/vindexes/), [Choosing a Primary Vindex](https://vitess.io/blog/2019-02-07-choosing-a-vindex/), [Vitess keyspace ID](https://vitess.io/docs/23.0/concepts/keyspace-id/), [Citus: choosing a distribution column](https://docs.citusdata.com/en/stable/sharding/data_modeling.html), [VoltDB technical overview](https://www.odbms.org/wp-content/uploads/2013/11/VoltDBTechnicalOverview.pdf)

---

## 10. Convex — Committer Scaling (the direct competitor's published position)

**Mechanism.** Convex's committer is "the sole writer to the transaction log": it assigns each transaction a commit ts larger than all previous, validates OCC by scanning the log between begin_ts and commit_ts for read-set overlaps, and appends the write set. Multiple writes share one ts for atomic batches (state jumps snapshot-to-snapshot). Subscriptions reuse the same machinery: the subscription manager walks the log past each cached query's begin ts and intersects with read sets. What Convex has published about *scaling* is confined to the read/execute side: **Funrun**, a fleet of stateless function-runner instances executing JS against snapshots, with the backend's committer still the single serialization point ("preserve the abstraction of one transaction at a time... with the throughput of a concurrent database").

**Read-visibility rule.** Trivial — one committer means the log is dense by construction; a reader at ts X sees the prefix ≤ X.

**Bottlenecks.** The committer itself. **Nothing published describes sharding or parallelizing it** — no blog/talk found on multi-committer Convex; their scaling patterns doc instead teaches app authors to reduce OCC conflicts. Their cloud shards at the *deployment* level (each app = one backend on PlanetScale/MySQL).

**Applicability to Stackbase.** Two takeaways: (a) Stackbase's shipped fleet (parallel executors, single committer) is already at published-Convex parity; (b) per-shard committers with a stitched global visibility frontier would be **genuinely beyond anything Convex has published** — supporting the "uniquely solved" ambition, and also a warning that no reference implementation exists to copy: the frontier protocol must be designed, not transplanted.
Sources: [How Convex Works](https://stack.convex.dev/how-convex-works), [How We Horizontally Scaled Function Execution](https://stack.convex.dev/horizontally-scaling-functions), [Optimize transaction throughput](https://stack.convex.dev/high-throughput-mutations-via-precise-queries)

---

## 11. Bonus: the Postgres-native safe-prefix problem (identical to Stackbase's watermark bug, in the wild)

The exact failure Stackbase fears — "tail a table by a monotonically allocated number; a slower transaction's smaller number becomes visible *after* you advanced your cursor past it; that row is skipped forever" — is a documented Postgres footgun with documented Postgres-only fixes:

1. **xid8 snapshot-horizon filter**: add `transaction_id xid8 default pg_current_xact_id()`; tail with `WHERE seq > cursor AND transaction_id < pg_snapshot_xmin(pg_current_snapshot())` — only rows whose writing transaction is older than every still-running transaction are eligible, so the prefix is provably stable. Tradeoff: **any** long-running transaction in the database stalls the frontier (a 2-minute transaction = 2-minute visibility lag).
2. **Advisory-lock min-pending watermark** (Sequin's production fix): each inserting transaction takes a transaction-scoped advisory lock encoding the minimum sequence value it will use; readers join `pg_locks` to compute min pending across active writers and cap their cursor there. Parallel writes stay uncapped; the frontier is per-*writer* rather than database-global, so unrelated long transactions don't stall it.
3. **Logical decoding / CDC**: tail the WAL instead — WAL emits in true commit order. (Heavier: replication slots, not "just a table.")

This is the min-over-in-flight (LSO) pattern implemented with zero infra beyond Postgres itself — and note the advisory-lock variant reuses the primitive Stackbase's fleet lease already depends on.
Sources: [Sequin: Postgres sequences can commit out-of-order](https://blog.sequinstream.com/postgres-sequences-can-commit-out-of-order/), [event-driven.io: ordering in the Postgres outbox](https://event-driven.io/en/ordering_in_postgres_outbox/), [Decodable: revisiting the outbox pattern](https://www.decodable.co/blog/revisiting-the-outbox-pattern), [Cybertec: gaps in sequences](https://www.cybertec-postgresql.com/en/gaps-in-sequences-postgresql/)

---

# The 5 transferable mechanisms for Stackbase, ranked

**1. Min-over-writers stable frontier (Kafka LSO/HWM + Spanner t_safe + CRDB closed-ts — the convergent pattern).** Every system that lets readers see a multi-writer log solves visibility the same way: *the safe prefix ends just below the oldest in-flight commit, published by the writers themselves, and a frontier is only meaningful paired with "applied through position P."* For Stackbase: each shard writer maintains a frontier F_s = (its last committed ts, or the smallest ts it has allocated-but-not-committed, minus 1), published as a Postgres row (piggybacked on the commit's own transaction — zero extra round trips — plus a 200ms idle heartbeat, CRDB side-transport style, so an idle shard never stalls the fleet). Global stable ts = min(F_s) over shards holding leases. Replica watermarks, StateVersion brackets, and pagination snapshots all move from "max ts seen" to "min frontier" — a one-concept change that fixes the skipped-ts-99 bug everywhere at once. Failure handling comes free from the existing lease machinery: a dead writer's lease expiry releases its frontier from the min. This is rank 1 because it is the *only* piece that is strictly mandatory for correctness, it costs ~zero per commit, and it needs nothing but Postgres.

**2. Ordering allocation ≠ execution serialization: a batched ts allocator on the existing coordinator, with prev-ts chaining (FoundationDB sequencer + TiDB TSO window).** Keep the ONE global bigint line — don't move to HLC vectors — by making the lease coordinator grant contiguous ts *batches* to shard writers (FDB: 1M versions/sec from a do-nothing-else singleton; TiDB: millions/sec with request batching; persistence via the etcd-window trick = one Postgres row update per *window*, not per commit). Since cross-shard transactions are rejected v1, each shard writer is a self-contained range-partitioned resolver (its in-memory `recentCommits` ring, unchanged) — FDB proves the OCC stays fully parallel. Stamp every log row with `prevTs` (its shard's previous commit, or the global chain within a batch): any consumer can then *verify* prefix density mechanically instead of trusting it, which turns the frontier of mechanism 1 from a convention into a checkable invariant. Rank 2 because it preserves every existing engine invariant (one ts line, OCC ring, snapshot reads) while removing the write ceiling — the minimal-diff parallelism design.

**3. Declarative shard-key routing resolved from args before execution (Vitess primary vindex ≡ Citus distribution column ≡ VoltDB partition parameter).** Three independent systems converged on the identical DX, so this is a solved design problem: one declared key per table (`.shardKey(field)` — already in the schema API), `mutation({shardBy: (args) => …})` (or infer from a validated arg named by the schema key) computed *client/router-side before execution*, routed via the existing `/_fleet/run` forwarding to the shard's lease holder; tables sharing a key are co-located; keyless mutations go to the default shard. Tier-0/single-writer degenerates to a no-op annotation — same app code, zero awareness — exactly matching single-node Citus/VoltDB behavior, and satisfying the same-code-at-every-tier requirement. Rank 3 because it's the entire answer to hard problem 2 and its risk profile is near zero (precedented, additive, dormant seams already typed).

**4. Postgres-native stable-prefix reads: xid8 `pg_current_xact_id()` column + `pg_snapshot_xmin` filtering, or the advisory-lock min-pending watermark (Sequin/outbox literature).** The zero-new-protocol implementation substrate for mechanism 1: writers already write through Postgres transactions, so "in-flight" is something Postgres *itself* can report — either filter the log tail by the snapshot horizon (simplest; beware unrelated long transactions stalling it) or encode each writer's min-pending ts in a transaction-scoped advisory lock and have tailers compute the min from `pg_locks` (surgical; immune to unrelated transactions; reuses the exact primitive the fleet lease already uses). Rank 4 because it's the cheapest credible v1 of the frontier — possibly the whole v1 — and doubles as a belt-and-suspenders correctness check under the explicit frontier rows even later; it only ranks below 1–3 because it's Postgres-specific (the future object-storage substrate would need mechanism 1's explicit frontiers anyway) and the xid8 variant has the long-transaction stall.

**5. Epoch-quantized visibility ticks (Calvin's 10ms epochs + Convex's many-writes-one-ts atomic batches).** Advance the *published* global frontier in small discrete epochs rather than per commit: shard writers commit freely at their allocated ts, but the fleet-visible snapshot steps epoch-to-epoch (e.g. every 5–20ms, or every N commits), each step a single cheap min-computation + one notify. This bounds frontier-maintenance cost independently of write throughput, gives subscriptions stable snapshot points that never expose a partially-stitched cross-shard state (a subscription spanning shards re-runs at an epoch boundary where *every* shard's frontier has passed the tick — cross-shard *reads* stay consistent even though cross-shard *writes* don't exist), and matches the reactive UX (a UI doesn't need sub-10ms visibility granularity; it needs never-wrong snapshots). Rank 5 because it's an optimization/robustness layer over mechanism 1 rather than independently load-bearing — but it's the piece that keeps the design "no compromise on performance" at high shard counts, and Calvin/VoltDB demonstrate the latency cost is small and bounded.

**Explicitly rejected for Stackbase:** Spanner commit-wait (requires bounded-uncertainty clock hardware; violates deploy-anywhere), full HLC adoption (unnecessary while a shared Postgres can allocate the single ts line; would break the one-bigint invariant every subsystem assumes), full Calvin determinism (mutation read sets are dynamic TS — not knowable pre-execution), and any external coordination service (etcd/ZooKeeper/Redis — TiDB needs etcd for its TSO window, but Postgres itself substitutes as shown by mechanisms 2 and 4).

**Sources (consolidated):** [PingCAP TSO](https://www.pingcap.com/blog/how-an-open-source-distributed-newsql-database-delivers-time-services/) · [TiKV TSO deep dive](https://tikv.org/deep-dive/distributed-transaction/timestamp-oracle/) · [TiDB TSO docs](https://docs.pingcap.com/tidb/stable/tso/) · [CRDB follower reads](https://www.cockroachlabs.com/docs/stable/follower-reads) · [CRDB closed-ts blog](https://www.cockroachlabs.com/blog/follower-reads-stale-data/) · [CRDB follower-reads RFCs](https://github.com/cockroachdb/cockroach/blob/master/docs/RFCS/20180603_follower_reads.md) · [Spanner paper](https://research.google.com/pubs/archive/39966.pdf) · [Spanner TrueTime docs](https://docs.cloud.google.com/spanner/docs/true-time-external-consistency) · [FDB architecture](https://apple.github.io/foundationdb/architecture.html) · [FDB paper](https://www.foundationdb.org/files/fdb-paper.pdf) · [uvdn7 FDB notes](https://uvdn7.github.io/notes-on-the-foundationdb-paper/) · [FDB critique](https://medium.com/@jingyuzhou/a-critique-on-foundationdb-transaction-system-8b640c06f6cd) · [Calvin (Murat)](https://muratbuffalo.blogspot.com/2022/04/calvin-fast-distributed-transactions.html) · [Calvin (morning paper)](https://blog.acolyer.org/2019/03/29/calvin-fast-distributed-transactions-for-partitioned-database-systems/) · [VoltDB overview](https://www.voltactivedata.com/wp-content/uploads/2017/03/hv-white-paper-voltdb-technical-overview.pdf) · [Kafka HWM](https://blog.2minutestreaming.com/p/kafka-high-watermark-offset) · [Confluent transactions/LSO](https://developer.confluent.io/courses/architecture/transactions/) · [Neon walservice](https://github.com/neondatabase/neon/blob/main/docs/walservice.md) · [Vanlightly on Neon](https://jack-vanlightly.com/analyses/2023/11/15/neon-serverless-postgresql-asds-chapter-3) · [YB transactional I/O](https://docs.yugabyte.com/stable/architecture/transactions/transactional-io-path/) · [Vitess vindexes](https://vitess.io/docs/22.0/reference/features/vindexes/) · [Citus distribution column](https://docs.citusdata.com/en/stable/sharding/data_modeling.html) · [How Convex Works](https://stack.convex.dev/how-convex-works) · [Convex Funrun](https://stack.convex.dev/horizontally-scaling-functions) · [Sequin out-of-order commits](https://blog.sequinstream.com/postgres-sequences-can-commit-out-of-order/) · [event-driven.io outbox ordering](https://event-driven.io/en/ordering_in_postgres_outbox/)