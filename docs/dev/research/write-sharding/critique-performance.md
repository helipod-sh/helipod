# Adversarial Review — Lens: PERFORMANCE & SCALABILITY

Reviewer stance: I only care about four numbers. (1) Latency added to one uncontended mutation, end-to-end as the user perceives it (ack + their own subscription push — the DX number). (2) The throughput curve, honestly drawn, including where it flattens. (3) Coordination/bookkeeping cost as shard count and node count grow. (4) Blast radius of one slow participant. Everything else is someone else's lens.

One cross-cutting finding first, because all three designs share it and none foregrounds it: **the full-copy replica model makes read capacity per node *decrease* as write throughput increases.** Every sync node tails and applies every shard's writes and re-evaluates every invalidated subscription. A design that delivers 10× write throughput hands every sync node 10× apply work and ~10× invalidation-triggered re-run work before it serves a single query. C at least names "tailer apply rate" as a ceiling; A and B bury it. At the throughputs these designs advertise, the sync-node apply loop is plausibly the *second* wall after Postgres, and no design shards the replica. Hold that against all three equally.

---

## Design A — Central-Order / Parallel-Execute

### (a) Strongest attack: the min-frontier is a ~200 ms tax on every reactive push, in the *steady state*, not the edge case

The mechanism: every global reader — every subscription re-run, every `StateVersion` advance, every scalar RYOW wait — reads at `F = min over live shards of frontier_ts`. An idle shard's frontier advances only on the heartbeat bump, H = 200 ms. Real applications **always** have idle shards (that is what "idle" means at 3 a.m., or for the 7 of 8 shards your traffic isn't hitting this second). Therefore F lags real time by ~E[max of NUM_SHARDS heartbeat phases] ≈ H in the steady state — call it 150–200 ms at the default.

Concretely: user sends a chat message → mutation commits in ~5 ms → the message appears in their own live query only when F passes commitTs → **~180 ms of pure protocol-imposed latency on the single most DX-critical interaction in the product**, versus single-digit ms on the shipped fleet (NOTIFY-driven watermark). The design's own §9 says "Visibility latency: busy shards, ms" — this is simply wrong as stated, because F is a min over *all* shards, and the busy shard's per-commit frontier advancement is irrelevant while any shard idles. The slice-3 per-shard wait rescues the mutation *ack*; it explicitly does **not** rescue the subscription push (§5, admitted), and the push is what the user sees.

You can shrink H, but heartbeat cost is O(NUM_SHARDS / H) *transactions per second* against the same Postgres everyone commits through: 8 shards @ 20 ms = 400 txn/s of pure overhead; 64 shards @ 20 ms = 3,200 txn/s — a meaningful bite out of the very fsync budget §9 names as the ceiling. At the brief's 1000-shard probe, A's bookkeeping is the worst of the three: O(shards) heartbeat writes plus a min over 1000 rows, versus C's O(nodes) and B's zero.

Second-order attack, same mechanism: heartbeat bumps must serialize with commits under the shard mutex (otherwise a bump above an in-flight commit's ts violates closure), so **one slow commit transaction — a big `collect()`, a PG hiccup — pins F fleet-wide for up to statement_timeout = 5 s.** Every subscription on every shard freezes. Nothing errors. The design admits this (weakness #2) but prices it as "jittery"; operationally it is "the entire product's reactivity stops for seconds because one tenant ran a fat mutation."

Also noted: A does nothing for the throughput ceiling. One PG transaction + fsync per mutation, same as today, same as B; the "per-shard group-commit batching is natural" line in §9 is an unspecified wave at C's actual design.

### (b) Honesty audit: mostly honest, with one material understatement

Weaknesses #1 (PG ceiling) and #2 (min-frontier coupling) are named and real — credit. But the steady-state ~H reactive latency is understated to the point of misdirection: §1.4 frames F-staleness as "idle shards lag by ≤ H" as though idleness were exceptional, and §9's "busy shards, ms" claim is false for any deployment with one idle shard. "Added commit latency ≈ 0" is true of the commit and false of the user-perceived write→push loop. The heartbeat write load's O(shards/H) scaling is never costed.

### (c) Steelman

At the shipped default (8 shards), heartbeat load is noise, H can be dropped to 25–50 ms for ~hundreds of extra txn/s, and A buys the cheapest possible protocol: every scalar surface — StateVersion, RYOW, cursors, action folding — survives byte-for-byte, so the *engineering* cost per unit of write scaling is the lowest of the three. A fair designer would add: nothing stops a later slice from serving single-shard subscriptions at the home shard's frontier (the same split-snapshot trick §2.2 already uses), collapsing the DX tax for the dominant query shape. As written, though, that slice doesn't exist.

---

## Design B — Per-Shard Logs, Frontier Vectors

### (a) Strongest attack: it scales the writers and declines to scale anything else — and the read side quietly pays for the write side's purity

The write path is genuinely unimprovable: in-memory allocation, one piggybacked row UPDATE, no heartbeats (an idle group's stale frontier is *correct*, because there is no global min to keep alive — this is the single sharpest structural insight in any of the three designs). But under my lens the attack surface is everything downstream:

1. **The throughput ceiling does not move one inch.** One PG transaction + fsync per mutation, exactly today's cost. B's "~linear in P" is linear in *writer compute*, terminating at the same Postgres wall as today — and §9 concedes the escape hatch is "spread groups across physical databases," i.e., the design's answer to its ceiling is a slice it hasn't designed. C demonstrably raises the ceiling 5–10× with group commit; B leaves that on the table entirely. For a *write-sharding* design, "we sharded execution but each commit still costs a full fsync round trip" is a real vulnerability: at 8 groups × 2k/s you're at 16k txn/s — at or past a decent PG instance's comfort zone, with zero amortization designed.

2. **The frontier vector is a cost multiplier threaded through the hottest read code in the engine.** Every `index_scan` over a sharded table gains a per-revision `ts ≤ W[row.shard_id]` check; every query captures a P-vector; every full-table-scan subscription tracks P frontiers; cross-group `by_creation_time` pagination becomes a P-way streaming merge. Individually trivial, collectively a persistent branch-and-lookup tax on every read the fleet serves — paid on the read tier, which (see cross-cutting finding) is *also* absorbing P× apply amplification. B's §9 "read-side overhead" paragraph is three lines long; it should be the longest section in the design.

3. **Session monotonic floors block reads on replication lag under non-sticky load balancing.** A session that wrote group g at ts T, then lands on a sync node whose replica of g lags, *waits*. With sticky sessions this is invisible; with a plain round-robin LB in front of the fleet (the deploy-anywhere default!), p99 read latency inherits the lagging replica's catch-up time. Neither costed nor mentioned.

4. **P is a frozen capacity bet with no relief valve** (named, weakness #3) — but note the performance shape of getting it wrong: hot-group skew at P=4 doesn't degrade gracefully, it caps at one writer's throughput while the operator watches, and the fix is an export/import.

### (b) Honesty audit: the most honest of the three

Weakness #1 (consistency downgrade) is a correctness lens's problem, not mine, and it's stated plainly. The performance claims are the most defensible in the pack: ~0 added commit latency is *actually true* here (no min to maintain), per-group failure isolation is real and is the best blast-radius story of the three, and the residuals (PG ceiling, hot key) are named. Understatements: the read-side vector tax and the LB/session-floor interaction above, and — shared sin — replica apply amplification.

### (c) Steelman

"You attack my unraised throughput ceiling, but the shipped bottleneck is writer *compute* (JS execution + OCC + apply at 1–3k/s), not Postgres fsync — I remove the binding constraint and leave the non-binding one, which is exactly right for an incremental slice. Group commit composes with my design later (per-group batching needs no protocol change, unlike A). And my reactive latency is the only one of the three that equals today's: writing group's replication lag, NOTIFY-fast, no tick, no heartbeat, no min. On the one number users feel, I win outright." This steelman is largely correct, which is why B survives.

---

## Design C — Sequenced Epochs

### (a) Strongest attack: it buys the best throughput curve by installing a fleet-wide metronome whose min is over *nodes*, then spends 30–60% of the winnings on the intent journal

Two-part attack.

**Part 1 — the visibility quantum.** All served reads, everywhere, including the writer's own node, happen at `closedEpoch = min over live-lease nodes of promisedEpoch`. A commit becomes visible only after *every node in the fleet* has flushed or heartbeated a promise past its epoch: realistic write→push latency is 1–3 ticks + skew ≈ **20–60 ms, structurally, for every mutation** — and §5's "same order as today's watermark wait" is comparing against the 1 s poll fallback rather than the NOTIFY path that actually serves today's traffic at single-digit ms. Worse, the min-over-nodes has exactly A's coupling failure with a different denominator: one wedged-but-leased node — GC pause, dead NIC, half-alive VM — freezes *the entire fleet's* reads, RYOW, and subscriptions for up to lease TTL, across shards that node doesn't own, while writes keep committing invisibly ("the app froze and nothing is erroring" — their words, and they're right to dread them). Min-over-nodes beats A's min-over-shards on cardinality and on idle cost (O(nodes/tick) bookkeeping is the best 1000-shard story of the three — shard count genuinely absent from the coordination bill), but the blast radius is identical: fleet-wide. B degrades one group; A and C degrade everyone.

**Part 2 — serial execution and the journal tax.** Dropping intra-shard OCC for admission-order serial execution makes one heavy mutation head-of-line-block its shard where today's pipeline would overlap it; with heavy-tailed handler times, serial-server queueing pushes p99 through the roof at moderate utilization on any shard with mixed workloads. The promised fix (speculative pipelining) is future work. Meanwhile the intent journal adds ~30–60% row volume to the log — **a direct tax on the batched-ingest ceiling that is this design's headline advantage**. The 10–30× end-to-end claim should be haircut by the journal before anyone repeats it, and the journal's v1 payoff (exactly-once retry, replay audit) is a correctness/DX good, not a performance one. You don't get to book the throughput win and expense the journal to a different lens.

Also real: slice 0 (structured ts, ts-as-string at every wire edge, `_creationTime` re-semantics) is a fleet-wide latency-neutral but *risk*-maximal migration shipped before any performance value lands — if the knee never gets approached in production, C paid its riskiest cost for nothing.

### (b) Honesty audit: honest on the big three, creative accounting on two numbers

Weaknesses #1 (min-promise HOL), #2 (serial hot shard), #3 (front-loaded migration) are exactly what I'd have led with — genuine credit. Understated: the intent journal's ingest tax is parked in "honorable mentions" while it directly attacks the headline 10–30× figure; and the RYOW/visibility comparison to "today's watermark wait" cherry-picks the poll path over the NOTIFY path. The claim that p50 commit latency "likely improves" under load via group commit is plausible and fair.

### (c) Steelman

"I am the only design that moves the actual wall. A and B both leave one-fsync-per-mutation in place; at scale that is the whole game, and my epoch batch replaces N fsyncs with one. Serial execution *eliminates* OCC retries, so on a genuinely hot contended shard I beat pipelined OCC, not lose to it (VoltDB's entire thesis). My coordination cost is O(nodes) — the only design where 1000 shards costs literally nothing extra. The 10–40 ms quantum is Convex-class latency, users don't perceive it, and the journal is tunable retention." The steelman is strong on throughput and shard-count scaling; it cannot answer the fleet-wide node-min blast radius except with watchdogs.

---

## Ranking (performance & scalability lens only)

**1. Design B — 8/10.** The only design where the DX-critical number — write→own-subscription-push — stays at today's single-digit ms: no tick, no heartbeat, no min to wait behind. Zero idle overhead (the insight that a stale frontier on an independent line is *harmless* deletes the entire liveness-maintenance cost A and C pay). Best blast radius by a mile: one sick group degrades itself, full stop. It loses two points for refusing to touch the throughput ceiling (one fsync per mutation, uncomposed group commit), for the under-costed read-side vector tax on a read tier already eating P× apply amplification, and for P-frozen with no rebalance. Under my lens, B is the design whose stated numbers I'd bet on reproducing in a benchmark.

**2. Design C — 7/10.** The only design that raises the durability ceiling (group commit is real, 5–10× is credible pre-journal) and the only one whose coordination cost is independent of shard count — the best answer to the 1000-shard probe. It pays with a 20–60 ms visibility metronome on every interaction, a fleet-wide freeze whenever any node wedges, serial head-of-line risk on heavy mutations, and an intent journal that eats a third of its own throughput win. C is the right design for the workload Stackbase doesn't have yet and the wrong one for the latency feel that is Stackbase's product; it also front-loads its riskiest migration before any of this pays out.

**3. Design A — 5.5/10.** The cheapest to build and the kindest to the protocol, but under a pure performance lens it takes the worst of both worlds: it neither raises the throughput ceiling (per-commit fsync, like B) nor preserves reactive latency (min-over-shards frontier + 200 ms heartbeat quantum imposes ~180 ms on every push in the steady state, misdescribed in its own §9), its bookkeeping is O(shards/H) writes against the shared bottleneck — the worst 1000-shard scaling here — and one slow commit transaction freezes fleet-wide visibility for up to 5 s. Its genuine virtues (scalar protocol intact, lowest engineering risk) belong to a different reviewer. As a performance artifact, it is B's failure coupling with C's staleness and neither's throughput.