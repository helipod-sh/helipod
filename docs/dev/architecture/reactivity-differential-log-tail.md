# Reactivity v2 — Differential Log-Tail Reactivity (DLR)

> **Status:** design (not yet built). Synthesized 2025-10-01 from a 4-architect / 3-judge
> adversarial design debate, itself grounded in the five code-verified system studies
> (`spacetimedb-internals.md`, `rxdb.md` + `rxdb-internals.md`, `electric.md`, `zero.md`)
> and the measured benchmark facts (`benchmarks/`, `convex-comparison.md`,
> `overhead-ladder.md`, `multinode-throughput.md`).
>
> This is the **North Star for the reactive-path rework**. It supersedes the earlier
> "staged unified-IVM" sketch: the debate surfaced a decisive fact that makes a full
> client+server IVM engine the *wrong core* for Stackbase (see §2). Individual pieces
> here map to items in `benchmarks/docs/performance-backlog.md` (#1, #10, #11, #12, #13,
> #15, #18).

---

## 1. The problem, in measured terms

Three facts from our own benchmarks define the target. Every design decision below is
justified against one of them; anything that doesn't move one of these is out of scope.

1. **The reactive path is I/O-bound, not CPU-bound.** Event-loop utilization sits at
   **0.13–0.37** on Postgres. Engine overhead over a raw store commit is only **+21%**.
   → *The lever is doing less I/O per commit, not faster compute.* (This is why Bun
   Workers and a Rust core were both rejected — measured, not asserted.)
2. **The subscription matcher is O(N).** `findAffectedByRanges` linearly scans every live
   subscription per commit — measured **0.3 ms → 9 ms** as subscriptions grow 100 → 10 000,
   *even when only one matches.* → *The one super-linear cost; fixable with an index.*
3. **We re-run affected queries and re-send full results.** A one-row change in a
   1000-row subscribed list re-scans the store and re-serializes 1000 rows.
   → *Both the store reads and the wire bytes are almost entirely waste.*

A fourth, forward-looking fact from the fleet work: multi-node throughput tops out at
**~1.75× at 3 nodes** because all nodes share one Postgres. Reactivity must **scale with
shards**, not with the shared store, or it inherits that ceiling.

## 2. The decisive constraint: queries are imperative TypeScript

Stackbase queries are **arbitrary imperative TypeScript handlers**, not a declarative
relational language. A handler may `db.get` in a loop, post-filter with `.filter(js)`,
branch on runtime values, and compute aggregates in-line.

This single fact disqualifies the two "elegant" architectures the debate considered:

- A **full client+server IVM engine** (the Zero model) assumes a query "compiles to an
  operator DAG." For imperative TS that compilation *does not exist*, and there is no
  fallback for an un-compilable query. Worse, its correctness rests on operators being
  **bit-identical client and server**, or optimistic rebase silently corrupts state.
- A **CDN "Shape" read tier** (the Electric model) assumes a query reduces to a
  **membership filter**. Our recorded read-*ranges* only *over-approximate* an
  imperatively-filtered result, so a cached chunk is not the query's actual result set.

The correct posture is therefore: **incrementally diff what we can prove, and always be
able to fall back to just re-running the query.** The re-run path is the ground-truth
oracle that never goes away. This is the backbone of the design.

## 3. What only Stackbase has

The design leans on three assets that the five studied systems each had to *manufacture*
and we already own:

- **A durable, totally-ordered, timestamped change stream** — the per-shard append-only
  MVCC log `{ts, id, value, prev_ts}`. Zero builds a CVR ledger, Electric mines the
  Postgres WAL, SpacetimeDB fuses an in-memory DB — all to get what our log already is.
- **Recorded read/write *ranges* per operation** — already tracked for range-precise
  invalidation. These *are* a standing predicate index; we just need to index *by* them.
- **Single-writer-per-shard total order** — each shard's commit-`ts` is a clean monotonic
  offset, so no global clock is needed for multi-shard consistency.

The MVCC log stays **Stackbase's own change source** across SQLite *and* Postgres — the
store seam is never allowed to leak (no WAL coupling, no logical replication). This
preserves the locked pluggable-store decision.

## 4. Architecture

Eight components, in the seams we already have. Server-authoritative throughout: the
server transaction is truth; the client is a speculative fast-path.

### 4.1 Interval-indexed matcher — `packages/sync`  *(backlog #1; kills fact #2)*

Replace the flat subscription list behind `findAffectedByRanges` with a **per-shard
interval index**: `tableId → IntervalTree(keyRange → subId)`, built from the read-ranges
subscriptions already register. On commit we already hold the write-set as
`(tableId, keyRange)` spans; querying the tree yields candidate subs in **O(log N + k)**
(k = actual matches). Point/equality reads degenerate to a hash bucket.

~300 lines behind the *same* `findAffected` signature. **No protocol change, no client
change.** Flattens the 9 ms/10k-sub tail back toward its 0.3 ms floor. **Ship first.**

### 4.2 CommitDiffer + `DIFFABLE | RERUN` classifier — `packages/sync`  *(backlog #10; attacks facts #1, #3)*

The transactor already holds every mutated row's before/after image
(`{id, value, prev_ts}`) plus the write-set ranges — **for free, in memory**. For
subscriptions we can *prove* are row-diffable, we derive the result delta directly from
those in-hand entries with **zero additional store reads**:

- `prev_ts == null` → insert · tombstone value → delete · else → update.
- The subscription's recorded read-range decides whether the row **enters**, **exits**, or
  **updates-within** the result.

Classification happens **once at subscribe time** (analyze the recorded read-set shape),
so per-commit cost is a branch, not re-analysis:

| Class | Query shapes | Handling |
|---|---|---|
| **DIFFABLE** | by-id `db.get`; single index-range `collect()`/pagination with known boundary keys | row diff from in-hand write entries, **no store I/O** |
| **RERUN** | `.filter(js)`; joins via `db.get` in the handler; unbounded aggregates; order-by-limit where the write lands at/near the top-N boundary | fall back to the **existing re-run path** (the oracle) |

RERUN subs keep today's behavior exactly, so the component is **strictly additive and safe
by construction** — we never claim to diff what we can't prove. Realistically the majority
of chat/feed/dashboard live queries are by-id or single-index-range: the diffable set.

### 4.3 The drift XOR checksum — the universal safety net  *(the most important primitive)*

A rolling **`XOR(id ⊕ ts)`** over each subscription's result set (computed from the `ts`
we already carry — near-free) rides every diff. Client and server compare; a mismatch
triggers a **scoped resync of exactly that query's ranges** (via §4.5), never a global
refetch.

This is what makes incremental diffing *safe to ship*: **a classifier bug degrades to one
resync, never to wrong data.** All three judges independently named this the decisive
primitive — it converts a whole class of latent correctness bugs into a bounded
performance cost.

> **Honest caveat:** XOR is a *weak* checksum — two compensating changes can collide and
> mask a divergence. Pair it with a **periodic full-resync anchor** (e.g. every K diffs or
> T seconds, ship the authoritative checksum from a real re-run) so drift cannot persist
> indefinitely. This anchor is cheap and non-negotiable.

### 4.4 Unified diff-*apply* + one `Change` type  *(A's narrow, safe insight — NOT full IVM)*

One internal currency:

```ts
type Change =
  | { t: "add";    key: Key; row: Row }
  | { t: "remove"; key: Key; row: Row }
  | { t: "edit";   key: Key; old: Row; new: Row };
```

sourced directly from the MVCC before/after images, and **one shared `apply(Change[])`
code path** used by both server and client to materialize a diff. This borrows Zero's
shared *apply* — so the two sides can't drift in *how* a diff is applied — while
**rejecting** Zero's shared *query engine*, which imperative TS makes impossible. Adopt the
safe half, drop the dangerous half.

### 4.5 Log-`ts` as a stateless checkpoint — no durable CVR  *(backlog #18, done our way; protects fact #1)*

The per-shard commit-`ts` **is** the resume token. The client holds `{shardId → lastTs}`.
Catch-up / reconnect / scoped resync = **`readLogSince(shard, fromTs, ranges)`** — replay
the intersected log tail, apply as `Change[]`, advance the fence.

**There is no server-side per-client CVR table.** This is deliberate and, per the
performance judge, the single most important choice in the whole design: a durable CVR is
**write amplification on every commit**, landing on the *single-writer-per-shard critical
path* — the exact throughput ceiling. The log already *is* the ledger, per client, by
construction. Server memory per subscription is just its interval keys + current fence.

**Store-seam cost:** one new method, `readLogSince(shard, fromTs, ranges) → entries`,
implemented on both adapters as a `ts`-indexed, range-filtered scan of the existing log
(SQLite `WHERE ts > ? …`; Postgres the `DISTINCT ON` we already have). Its semantics
**must be byte-identical SQLite vs Postgres** — a real, bounded obligation, discharged by
extending the existing docstore conformance suite. No fused DB, no WAL dependency;
pluggability preserved.

### 4.6 Client MaterializedCache + light optimistic — `packages/client`  *(backlog #12, #13)*

Per live query: an `id → row` map plus a per-shard `asOf` fence. Diffs apply **behind a
version fence** (`pokeStart{vector} … pokeEnd`) so a partially-applied multi-shard update
never renders a torn state. `useQuery` reads the map; a re-render is a local map diff.

**Optimistic mutations, the pragmatic 90%:** apply a caller-supplied optimistic patch to an
overlay layer, tag with a `mutationId`, send. On **ack** (the server returns
`lastMutationId` in the poke envelope) drop that overlay entry — authoritative pokes win.
**No mutator replay, no rebase.** In a server-authoritative BaaS the server is truth
anyway, and reconcile-on-ack ties directly into the already-shipped B3 effectively-once
idempotency. Offline: overlays persist (IndexedDB) and flush on reconnect (at-least-once;
the engine's mutation idempotency dedupes). Full offline query *execution* is out of
scope — we sync results, not a client query engine.

### 4.7 Fleet: per-shard interval-index fragments + a consistency vector

Each shard's writer owns the interval-index fragment for ranges rooted in its shard. A
cross-shard subscription registers one fragment per shard; the client merges per-shard
fences into a **consistency vector** — a result is "consistent as of `{shard → ts}`".
Single-writer-per-shard gives each shard a clean total order, so **no global clock is
invented.** Fan-out becomes O(log N) per shard and I/O-free for patchable subs, which is
precisely why the shared-Postgres 1.75× ceiling does **not** cap reactivity: reactive work
scales with shards, not with the shared store.

### 4.8 (Deferred, opt-in) CDN read tier for the high-fan-out anonymous tail  *(backlog #15; C, held)*

For the read-mostly, high-audience tail (many clients, same public data), an **opt-in**
`useQuery({ live: "cached" })` routes to an immutable-offset-log-over-HTTP transport:
offset = commit `ts`; responses `Cache-Control: public, immutable`; a **live-cursor
time-bucket** (~1 s) collapses concurrent waiters onto one origin read so origin cost
becomes **O(distinct queries), not O(readers)**. Built on the *same* MVCC log, so SQLite
gets it too and the store stays pluggable.

This is **not the core and not Stage 1.** It solves an axis we have **not yet measured**
(socket-per-reader fan-out) and imposes a ~1 s latency floor, so it is gated on **real
socket-count evidence**. Correctness caveat from §2: because read-ranges over-approximate
an imperatively-filtered result, cached Shapes are only exact for the declarative/diffable
subset; JS-filtered queries need a client re-filter. Keep it for read-heavy public data,
not the instant-reactive path.

## 5. Why this is the optimal design, per fact

| Measured fact | How DLR attacks it |
|---|---|
| I/O-bound (ELU 0.13–0.37) | DIFFABLE subs do **zero extra store I/O** (diff from in-hand writes); **no CVR write-amplification** on the write path |
| O(N) matcher (9 ms @ 10k) | interval index → **O(log N + k)** |
| Full re-runs + re-sends | **row diffs** — ship the change, not the result set |
| Shared-store multi-node ceiling | **per-shard fragments** + I/O-free patchable fan-out → scales with shards |
| (Rejected levers) | no Rust core, no Bun Workers, no full IVM — measured irrelevant to an I/O-bound path |

The steady-state cost per commit becomes proportional to the **size of the change**, not
the size of the result set and not the number of subscriptions — the asymptotic floor a
reactive system can reach — *and* it reaches that floor without adding a single write to
the critical path and without assuming a query language we don't have.

## 6. Staging (each stage independently shippable and measurable)

1. **Interval-indexed matcher** (§4.1). Biggest measured win, no protocol/client change.
   *Ship first, measure.*
2. **CommitDiffer + classifier + `Change`/diff wire protocol + drift checksum + client
   MaterializedCache** (§4.2–4.4, §4.6-apply). The I/O win. RERUN fallback keeps it safe.
3. **Log-tail catch-up** — `readLogSince`, per-shard fences (§4.5). Cheap reconnect/resync;
   deletes any server-side per-sub result caching.
4. **Light optimistic + offline** (§4.6). DX headline; independent of 1–3.
5. **Fleet fragment indexes + consistency vectors** (§4.7).
6. **(Opt-in, evidence-gated) CDN read tier** (§4.8).

Stages 1–2 move ~90% of the measured needle. Correctness of later stages rests on Stage 1's
index and Stage 2's classifier + checksum being right.

## 7. Explicitly rejected / deferred

- **Full client+server IVM engine** — assumes a declarative query surface Stackbase lacks;
  bit-identical-or-corrupt correctness burden; spends the budget on compute the benchmarks
  proved isn't the bottleneck.
- **Rust core / Bun Workers** — measured irrelevant to an I/O-bound path.
- **Durable server-side CVR** — write amplification on the write ceiling; the log is
  already a per-client ledger.
- **Mutator replay / rebase** — over-engineered for a server-authoritative system;
  reconcile-on-ack gets the 90%.
- **Welding to Postgres logical replication / WAL** — violates the pluggable-store lock;
  the MVCC log is the single change source across SQLite and Postgres.
- **CDN read tier *as the core*** — solves an unmeasured axis and imposes a ~1 s latency
  floor; held as an opt-in, evidence-gated transport.

## 8. Load-bearing risks (own them explicitly)

- **Classifier correctness** is load-bearing — a mis-classified DIFFABLE sub produces a
  wrong diff. *Mitigation:* the drift checksum (§4.3) + periodic full-resync anchor turn it
  into a scoped resync, never wrong data. The re-run path is always the oracle.
- **`readLogSince` cross-store parity** must be provably byte-identical. *Mitigation:*
  extend the docstore conformance suite; treat any divergence as a release blocker.
- **XOR weakness** — compensating changes can collide. *Mitigation:* the periodic
  full-resync anchor is mandatory, not optional.
- **Operator/apply drift** — client and server must materialize a diff identically.
  *Mitigation:* one shared `apply(Change[])` (§4.4), covered by shared tests.

## 9. Provenance

Synthesized from the `reactivity-design-debate` workflow (run `wf_1d9c46cc-b20`): four
architects proposed competing architectures (A: maximal unified IVM; B: minimal-pragmatic;
C: read-scale-CDN; D: first-principles log-tail) and three conflicting-value judges
(performance-purist, pragmatism-effort, correctness-risk) argued and ranked. Rankings:
D>B>A>C, B>D>C>A, D>B>C>A. **DLR = D's log-native spine + B's classify-and-fallback
discipline + D's drift checksum + A's narrow shared-*apply* (not shared query engine); C
held as an opt-in read tier.** Notably, three judges optimizing for opposite values
converged on this same graft — the strongest available signal that the design is robust to
whichever axis one weights.
