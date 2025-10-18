# Fleet B5 — Design record: offline reshard + object-storage substrate

**Status:** DESIGN-DOC ONLY (per the [verdict](./verdict.md)'s §d slice plan: "B5 — Design-doc
level (not committed code)"). Nothing here is built. This is the closing design record of the
write-sharding arc — B1→B4 shipped/assessed, this is the last item. It exists to (a) specify the
one operational tool the shipped protocol still needs (offline reshard) and (b) capture, while the
mechanisms are fresh, the object-storage substrate the verdict's micro-novelty was designed to
survive onto — so that protocol decisions already made stay portable rather than being
rediscovered under pressure later.

Grounded against the shipped tree (`ee/packages/fleet/`, `packages/id-codec/`,
`packages/docstore-*/`, `packages/runtime-embedded/`, `packages/executor/`) at commit `400cea3`.

---

## Part 1 — The offline reshard tool

### The structural fact that defines the whole tool

**`documents.shard_id` and `indexes.shard_id` are write-only decoration. Nothing reads them for
correctness.** This is not an aspiration; it is verifiable in the tree:

- The two columns are written only in the INSERT column lists —
  `packages/docstore-postgres/src/postgres-docstore.ts:213` (documents) and `:241` (indexes),
  `packages/docstore-sqlite/src/sqlite-docstore.ts:115`/`:118`. They exist as additive columns
  (`schema.ts:33-34` on PG, `sqlite-docstore.ts:91-99` on SQLite) with a `'default'` default.
- **Every `WHERE shard_id` predicate in the codebase is on `shard_leases`** — the lease/fence/
  frontier row — never on `documents` or `indexes` (`lease.ts:373,488,513,583,770`;
  `replica-tailer.ts:80`). No read path, no routing path, no invalidation path filters the MVCC
  log by `shard_id`.
- Routing **always recomputes** the owner from the key value: `shardIdForKeyValue(keyValue,
  numShards)` at the `WriteRouter` chokepoint (`runtime.ts:729`, `:738`) and again, independently,
  in the always-on kernel ownership guard (`kernel.ts:150`, `:260`). The stamped column is never
  consulted to decide where a row lives.

So shards are **logical commit-serialization lanes** — a per-shard mutex, OCC ring, commit
connection, and one `shard_leases` row (lease = fence = frontier) — layered over **one shared
store**. They are not physical data partitions. The `shard_id` stamp is an observability/debugging
breadcrumb (which lane committed this row), nothing more.

### The consequence, walked honestly: resharding is not a data migration

If nothing reads `documents.shard_id` for correctness, then changing `N → M` **moves no rows**. A
document's owning lane is a pure function `shardIdForKeyValue(key, N)`; when `N` becomes `M`, the
function's output changes for some keys, and that is the *entire* effect. There is no copy, no
rewrite, no re-stamp, no downtime proportional to data size. The historical MVCC log is completely
untouched. What changes is purely which lane *future* commits for a given key serialize through.

This makes the tool small — but it is not trivial, because the frontier bookkeeping (`min` over
`shard_leases`, the count gate) and the persist-once shard count are both sensitive to the row set
changing.

### `stackbase fleet reshard --shards M` (working name)

#### Preconditions — the fleet must be fully stopped

Resharding changes `N`, and `N` is read identically at every tier and every node
(`shardIdForKeyValue(key, numShards)`). If two nodes disagreed on `N` even briefly, the
one-doc-one-ring invariant breaks: the same key would route to different lanes on different nodes,
admitting concurrent writers to the same document. Therefore the tool **refuses to run against a
live fleet**:

- Verify **zero unexpired `shard_leases` rows** (`expires_at >= now()`) — no node currently owns
  any lane.
- Verify **zero unexpired `fleet_nodes` presence rows** (`heartbeatPresence` heartbeats these;
  `lease.ts:302-311`) — no node is alive at all.
- If either check is non-empty, refuse with an instructive error naming the live node(s). This is
  a hard gate, not a `--force`-able one: an online reshard is a different, much harder project
  (it needs the epoch-fence to straddle a shard-count change, which the shipped protocol has no
  vocabulary for) and is explicitly out of scope.

Operationally this means: scale the fleet to zero, run the tool against the store, scale back up.
The store (Postgres) stays up throughout — only the engine nodes stop.

#### Back-compat anchor: the persist-once `fleet:numShards` global is the single source of truth

Today the shard count reaches a node as a plain parameter (`prepareFleetNode`'s `numShards`,
defaulting to `DEFAULT_NUM_SHARDS = 8` at `node.ts:69`), with the persist-once/`STACKBASE_FLEET_
SHARDS`/mismatch-fail-fast story owned by T5 and stamped as a `persistence_globals` key
(`fleet:numShards`, sibling to the `fleet:deploymentId` stamp at `node.ts:317`). The reshard tool
treats **that global as the authority**: nodes fail fast on boot if their configured `N`
disagrees with the stamped `fleet:numShards`, so the reshard is the one and only sanctioned way to
change it. The tool's write of the new count is what makes the change legitimate fleet-wide; a
node that boots with a stale env value is rejected rather than silently forming a split ring.

#### The operation

Inside one store transaction (Postgres, the fleet store):

1. **Update the global.** `fleet:numShards := M` in `persistence_globals`. This is the linearization
   point — after it commits, `M` is the authoritative count and any node that boots reads it.
2. **Create the shard rows for the new lanes.** For each `shard_id` in `shardIdList(M)` that does
   not already exist, INSERT a `shard_leases` row seeded via the **shared `frontierSeedExpr`**
   (`lease.ts:289-291`): `documentsExist ? (SELECT COALESCE(MAX(ts),0) FROM documents) : 0`. This
   is the **F1-class requirement** (the Fenced Frontier B1 whole-branch-review blocker,
   `lease.ts:678`): a new lane's row must be born at the store's true high-water mark, never
   momentarily visible at `frontier_ts = 0`, or a concurrently-observing replica could compute a
   `min` that regresses `F` and expose a torn prefix. On a reshard of a store with history,
   `documentsExist` is true, so every new row is seeded to `MAX(ts)` — dense with the existing
   frontier from birth. The tool reuses the exact `frontierSeedExpr` fragment; it does not
   re-derive the seed, so there is one place this reasoning lives.
3. **Delete surplus rows.** For each existing `shard_leases` row whose `shard_id` is not in
   `shardIdList(M)` (the case `M < N`, shrinking), DELETE it. **This is the delicate step** — see
   the next subsection.

Ordering note: grow-then-shrink is safe in either statement order *within the transaction* because
the whole thing is atomic and the fleet is stopped (no concurrent `min`/count reader exists). The
transaction boundary is belt-and-braces, not a concurrency requirement.

#### Why deleting surplus rows is safe — the count-gate and `min`-F argument

The replica tailer's readiness/visibility gate reads exactly two aggregates over `shard_leases`
(`replica-tailer.ts:246-248`):

```sql
SELECT COALESCE(MIN(frontier_ts), 0) AS min_frontier, COUNT(*) AS n FROM shard_leases
```

and treats `count(*) < numShards` as `F = 0`-equivalent / not-ready (`replica-tailer.ts:234-239`).
Deleting rows changes both aggregates, so the argument must be explicit:

- **After the reshard, `count(*) = M` and every node's `numShards = M`** (from the updated
  global). The count gate `count(*) < numShards` is satisfied by construction — the tool leaves
  *exactly* `M` rows. There is no window where a booted node sees `count(*) = N` (old) against
  `numShards = M` (new), because the fleet is stopped during the operation and the global + row
  set commit atomically together.
- **`min(frontier_ts)` cannot regress across the reshard.** Every retained row keeps its
  `frontier_ts` (untouched); every new row is seeded `≥ MAX(ts)`; deleting rows can only *raise or
  hold* a `min` (removing a member never lowers the minimum of the remaining set). So `F_after =
  min(retained ∪ new) ≥ F_before`. `F` is monotonic across the reshard, which is what the tailer's
  D5 non-regression assertion demands (`replica-tailer.ts:241-244`).

**A pre-reshard replica whose watermark predates the reshard resumes cleanly.** Consider a sync
node that was up before the fleet stopped, with a persisted `wm = W ≤ F_before`. It restarts after
the reshard. Its first `readFrontier()` now sees the `M`-row set. The new rows are all seeded
`≥ MAX(ts) ≥ F_before ≥ W`, and the retained rows are unchanged, so `F_after ≥ F_before ≥ W`. The
tailer pulls `(W, F_after]` from the shared log (`replica-tailer.ts`, verbatim MVCC apply) — the
same dense byte stream it would have pulled with or without the reshard, because **the log itself
never changed**. The `prev_ts` density assertions hold because the chain is the identical physical
chain. The replica does not know or care that resharding happened; it only ever consumed the
`documents`/`indexes` log and the `min`/count aggregates, both of which remain consistent. (The
tailer never replicates `persistence_globals` — `node.ts:314` — so the shard-count change reaches
it only via its own boot config, exactly as intended.)

#### Post-conditions and verification

The tool ends with a verification pass (read-only, after the mutating transaction commits):

- **Shard row set:** `count(*) = M` and the `shard_id` set equals `shardIdList(M)`.
- **Frontier floor:** `min(frontier_ts) ≥ MAX(ts)` over `documents` — every lane is dense with the
  log's high-water mark (the F1 invariant, re-checked).
- **Dense-chain SQL:** the standard per-shard `prev_ts` chain check the arc already uses (each
  `documents` row's `prev_ts` points at the prior version's `ts`; no gaps) — unchanged by the
  reshard, asserted to confirm the log was genuinely untouched.
- **Smoke commit per lane:** optionally, bring up a single writer node with `numShards = M`, fire
  one trivial mutation whose key routes to each of the `M` lanes (a spread of synthetic keys
  chosen so `shardIdForKeyValue(key, M)` covers `shardIdList(M)`), and confirm each commits and
  fences its own lane's `frontier_ts` forward. This proves the new lanes are writable and their
  rings/leases initialize, before real traffic arrives.

### Interplay with the other guards and durable state

- **Scheduled jobs / crons.** The scheduler rides the **default shard** — its jobs are
  unsharded-by-default and its drivers "follow the default shard" (`node.ts:972-1023`,
  `:1000`). The default lane (`shardIdList` always includes it, for any `N ≥ 1`) is never deleted
  by a reshard (`M ≥ 1`), so pending scheduler rows and their `generationNumber` OCC guards are
  untouched and keep committing on the default lane exactly as before. **Unaffected.**
- **Workflow journals.** Same story — workflow state co-commits on its caller's shard and the
  workflow/cron/reaper drivers are in the same default-shard driver set (`node.ts:974`,
  `:1023`). A durable workflow journal carries no shard-count-derived state; its `steps`/`events`
  rows are ordinary `documents` rows in the log, replayed deterministically regardless of `N`.
  **Unaffected.**
- **In-flight anything.** There is none — the fleet is stopped (precondition). This is *why* the
  stopped-fleet gate is non-negotiable: it makes every "what about work crossing the reshard"
  question vacuous.

### Historical chains: nothing changes, and why that is correct

**A reshard changes no historical data and creates no anomaly, because the one-doc-one-ring
invariant governs only *concurrent* forks of a single document — not a document's owner across
disjoint time.** The invariant that matters for correctness is: at any instant, at most one writer
may hold the lane a given live document routes to, so two mutations to the same document can never
commit concurrently on different lanes. Before the reshard, key `k` routed to lane
`shardIdForKeyValue(k, N)`; after, to `shardIdForKeyValue(k, M)`. These two epochs **do not
overlap in time** — the fleet was fully stopped between them (no lease, no writer, no in-flight
commit spans the boundary). So there is never an instant at which `k`'s document is writable on
both its old and new lane. A document's owning lane changing between two non-overlapping epochs is
therefore as safe as any other configuration change applied to a quiesced system: every version in
`k`'s history was committed under whatever `N` was authoritative at the time, the versions form
one dense `prev_ts` chain in the shared log (owner-lane-agnostic), and any future write to `k`
serializes correctly on its new lane against that same chain. The MVCC log has no notion of "this
version belongs to lane X"; it only has `(ts, id, value, prev_ts)`.

### Edge: mid-life key values whose slot changes

A key `k` alive across the reshard may satisfy `shardIdForKeyValue(k, N) ≠ shardIdForKeyValue(k,
M)` — its lane moves. This is fine, and consistency holds, for one reason: **`N` (now `M`) changes
only via this offline tool.** After the reshard, *every* routing computation everywhere — the
`WriteRouter` forward (`runtime.ts:729/738`), the kernel ownership guard (`kernel.ts:150/260`),
and the pinned-scan rule that resolves which lane an indexed scan's equality key belongs to
(`kernel.ts:260`, `shardIdForKeyValue(jsonToConvex(eq.value), ctx.numShards)`) — uses the same
`M`, because they all read the same persist-once global. There is no node, no tier, and no code
path that uses a different `N`. The recompute is deterministic and total, so `k`'s new lane is
agreed on universally the instant the fleet comes back up. The only thing that could break this is
two live values of `N` coexisting — which is precisely what the stopped-fleet precondition and the
`fleet:numShards` mismatch-fail-fast guard prevent.

### Why jump-hash's minimal-movement property is irrelevant today

Routing uses jump consistent hash (`packages/id-codec/src/jump-hash.ts`), whose defining property
is that changing the bucket count `N → M` remaps the minimal fraction of keys (`|N-M|/max(N,M)`).
The verdict chose it deliberately ("jump-hash chosen to minimize future movement", verdict §c
question 1). **Today that property buys nothing measurable** — because resharding moves no data
(the structural fact above), it does not matter how many *keys* change lanes; a lane change is
free (a future routing recompute, zero bytes moved). A plain `hash(key) mod N` would reshard
equally cheaply in the shipped protocol. Jump-hash's minimal-movement is a **latent** asset. It
becomes load-bearing only in Part 2, where lanes acquire *physical* per-shard segment logs and
"key `k` changed lanes" would mean "`k`'s future writes append to a different physical object
stream" — at which point minimizing the fraction of keys that switch physical streams (and the
associated working-set/segment-locality churn) is a real cost saved. We pay for the good hash
function now so that the object-storage tier inherits cheap resharding for free.

---

## Part 2 — The object-storage substrate (design sketch)

### The portability thesis

The verdict's genuinely-novel micro-mechanism is the identity **lease = fence = frontier as one
atomic row-update inside the commit, with min-eviction serialized by that row's own lock**
(verdict §b, "What makes this UNIQUE"). The claim made there — and the reason B5 is a design doc
and not just a tool — is that this identity *ports off Postgres*: the same three-things-as-one-atom
maps onto a **CAS-updated manifest object per shard on S3-class storage**. Postgres row-locking is
one implementation of "serialize the frontier update against concurrent commits"; a conditional
PUT (`If-Match`/ETag) is another. Where the shipped fleet folds sequencing into the database the
commits already flow through, the object-storage tier folds it into a manifest the commits already
rewrite.

### The shape

Per shard, on the object store:

- **Log segments** — immutable objects, each an appended batch of committed rows (the MVCC log,
  chunked). `s{shard}/seg/{seqno}` or similar. Never mutated after write; GC'd below the
  watermark. Segments carry a monotone sequence number that plays the density role `prev_ts`
  plays today.
- **A manifest** — one small mutable object per shard, `s{shard}/manifest`, holding
  `{ epoch, frontier_ts, segments: [...seqnos], writer_url }`. This object *is* the lease, the
  fence, and the frontier — the direct analog of one `shard_leases` row.

A commit is: write the new segment object(s) (immutable, idempotent by key), then **CAS the
manifest** (`If-Match: <etag>`) to append the new segment seqnos and advance `frontier_ts` and
carry the current `epoch`. The CAS is the commit's linearization point, exactly as the guard
`UPDATE ... WHERE epoch = $myEpoch` is today (`lease.ts:373`). A failed CAS (etag moved) means a
fence happened underneath the writer — the object-storage `FencedError`, and the writer
self-demotes, identical to the shipped `FencedError` path.

**Fencing-first eviction becomes: CAS the epoch.** A node observing an expired lease does a
conditional PUT that bumps `epoch` and (per F1) `GREATEST`-raises `frontier_ts`. Because CAS is a
compare-and-swap on the *same object* the in-flight committer is trying to CAS, exactly one of
{committer lands first, then fencer's next CAS sees the new etag and re-reads / the committer's
segment is counted} or {fencer lands first, committer's CAS fails on the stale etag and its whole
commit aborts} occurs — the same one-winner guarantee the Postgres row lock provides today, now
provided by the object store's conditional-write primitive. The min-eviction serialization the
verdict calls the novel piece is preserved *because the manifest is the single object all three
operations contend on.*

**`F = min(frontier_ts) over all manifests`** — a `LIST` of the shard prefix plus `N` manifest
`GET`s, and the manifests are small and cacheable (etag-conditional GETs are cheap when unchanged).
This is the direct analog of `SELECT MIN(frontier_ts) ... FROM shard_leases`
(`replica-tailer.ts:248`), just fanned out over objects instead of rows. The `count(*) = N` gate
maps to "`N` manifests present under the prefix."

**Tailers pull segments `(wm, F]`** — resolve `F` from the manifests, then download the segment
objects covering `(wm, F]` and apply them verbatim, asserting the segment-seqno chain is dense
(the object-storage analog of the `prev_ts` density assertion). A replica becomes, in effect, a
segment-download bootstrap.

### The mapping, mechanism by mechanism

| Shipped fleet mechanism (Postgres)                         | Object-storage analog                                                              |
|------------------------------------------------------------|------------------------------------------------------------------------------------|
| Commit guard `UPDATE ... WHERE epoch = $myEpoch` (`lease.ts:373`) | **Manifest CAS** (`If-Match: etag`); mismatch → `FencedError`                |
| `pg_advisory_lock` single-writer election                  | **CAS the epoch** to claim the manifest; the manifest is the lease                 |
| Fencing-first eviction (row-lock-serialized UPDATE)         | Fencer CAS bumps `epoch`; conditional-write serializes it against the committer's CAS |
| `LISTEN`/`NOTIFY` commit channel (`commit-notifier.ts`)     | Poll the manifests, or S3 event notifications (SNS/SQS/EventBridge) — best-effort wake |
| Per-shard commit-connection pool (concurrent PG sessions)   | **Free** — per-shard writer concurrency is just distinct object prefixes; no shared connection to pool |
| `F = MIN(frontier_ts)` over `shard_leases` (`replica-tailer.ts:248`) | `F = min(frontier_ts)` over manifests — a `LIST` + `N` cacheable `GET`s          |
| `count(*) < numShards → not ready` gate                     | `< N` manifests present under the shard prefix → not ready                          |
| `prev_ts` density chain (`documents`)                       | Segment sequence numbers — dense seqno chain per shard                              |
| Effectively-once idempotency marker (B3, `commitMeta`)      | Idempotency-key window **embedded in the manifest** (recent keys, GC'd with segments) |
| Verbatim log apply into a local replica (`replica-tailer.ts`) | Segment download + verbatim apply; replica = segment bootstrap                    |
| Per-shard group commit (B4, `commitWriteBatch`)             | **Segments *are* batches** — the batch-shaped commit path becomes load-bearing here |

**The B4 irony, stated plainly.** B4's per-shard group commit shipped *dark-off* — the ≥ 2× gate
came back 1.63×/1.04× and the per-shard commit pool had already captured the parallelism
([b4-benchmark.md](./b4-benchmark.md), "THE GATE DECISION"). On Postgres, group commit had almost
nothing left to reclaim. **On object storage it is mandatory, not optional.** An S3 `PUT` costs
~10–100 ms; committing one row per PUT would floor the whole system at ~10–100 ms per commit per
shard — the exact single-shard flat ceiling B4's baseline measured (`~550–600 ops/s regardless of
client count`, [b4-benchmark.md](./b4-benchmark.md) "the single-shard ceiling is flat"), except an
order of magnitude worse and with no per-shard-pool escape because the cost is a network round trip
to the object store, not a local fsync. Batching a shard's queued commits into one segment object
+ one manifest CAS is the *only* way the tier reaches usable throughput. The B4 machinery
(`commitWriteBatch`, the batch-shaped guard, the two-buffer stage-then-flush committer) is dark on
Postgres precisely because it was built one tier too early for where it becomes essential — and it
sits in the tree, correct and tested, waiting. The dark-off assessment banked the code; this tier
is where the bank is drawn on.

### The honest hard parts

1. **Latency floor.** The `PUT`/CAS round trip (~10–100 ms) is the dominant cost and is
   irreducible per-object. Group commit is mandatory (above). Even so, write-to-own-subscription
   latency is bounded below by one manifest CAS + one `F`-recompute round trip — this tier trades
   Postgres's single-digit-ms commit for tens-of-ms, in exchange for zero managed database. The
   flat-ceiling shape B4 measured is exactly the shape that returns, and it is the defining
   performance characteristic of the tier, not a bug to be optimized away.
2. **Read paths.** Replicas become segment-download bootstraps: a cold sync node lists segments and
   pulls `(0, F]` from the object store rather than streaming an MVCC log from a primary. This is
   cheap to scale (object stores fan out reads trivially) but has a cold-start cost proportional to
   log size below `F` — which motivates aggressive watermark GC (below) and partial/segment-scoped
   replicas (the Tier-3 partial-replica seam the verdict already reserves, §c question 5).
3. **The transactor's `prev_ts` `get()`s.** OCC needs to read the current version of a document to
   validate and to write its `prev_ts` — a random-access point read. Object storage is terrible at
   random point reads of historical rows. The tier needs a **hot working set per writer** — an
   LSM-ish in-memory memtable of recently-written/recently-read documents for its lane, flushed
   into segments, so the common case (read-modify-write of a warm document) never round-trips to
   the object store for the current version. This is the single largest piece of new machinery the
   tier needs and the biggest departure from the shipped "the store is the source of truth for
   point reads" assumption. Cold reads of documents not in the working set fault in from segments
   (needing a per-shard segment index — an object-storage LSM, essentially).
4. **Watermark GC of segments.** Segments below the global watermark (the minimum `wm` any live
   consumer still needs) are deletable. This needs a GC process that reads consumer watermarks
   (themselves published where? — probably manifest-adjacent), computes the safe floor, and deletes
   segment objects below it — the object-storage analog of MVCC log compaction, with the added
   wrinkle that deletion is eventually-consistent on many object stores.

### Positioning

This is a **future tier — call it Tier 3** — enabling truly serverless, zero-Postgres deploys: a
Stackbase fleet whose entire durable substrate is an S3 bucket, with writer nodes that are
stateless-plus-working-set and can be spun up/down per shard on demand. **It is not scheduled.**
The verdict's build arc ends at B4; there is no B6 commitment. This design record exists for one
concrete reason: **so the protocol decisions already made today keep the door open**, rather than
being quietly foreclosed by an expedient choice that assumes Postgres forever.

The specific already-made decisions that keep the door open:

- **Scalar, store-allocated `commitTs`** (verdict §b "Timestamp allocation"). Because `ts` is one
  scalar the store hands out, not a structured/vector value, it ports to `nextval`-analog schemes
  (a manifest-held counter, or a lease-granted ts range per writer) without redefining
  `_creationTime` semantics or the client `StateVersion` wire shape. Design C's structured ts
  would have needed a protocol-v2 client upgrade *and* a bespoke object-storage sequencer;
  Design B's frontier vectors would have needed the manifest to hold a vector. The scalar line is
  the portable one.
- **Manifest-shaped frontier rows** — the decision to make lease = fence = frontier *one* row
  (`shard_leases(shard_id PK, epoch, writer_url, expires_at, frontier_ts, prev_ts)`, verdict §b
  "Per-shard failover") is exactly the manifest schema. A design that spread these across three
  tables would have needed three coordinated CAS objects (no atomic multi-object CAS on S3); the
  one-row decision is what makes the one-manifest-CAS mapping clean.
- **Batch-shaped commit guard** (B4's `commitWriteBatch` and batch-shaped guard, shipped dark-off).
  The commit path already accepts a batch of writes under one guard update. On object storage that
  batch *is* the segment. Had the guard only ever been single-write-shaped, the tier would need a
  new batch commit path built from scratch; instead it is already there and tested.
- **Epoch-as-fence, separate from lease expiry** (`lease.ts` D2: epoch bumps on acquisition/fence,
  not on the TTL clock — verdict's opening verification note). This clean separation is what lets
  "fence = CAS the epoch" be a distinct operation from "the lease expired," which the manifest CAS
  needs in order to serialize eviction against commits.
- **The `commitMeta` idempotency channel** (B3 effectively-once forwarding — an opaque
  `commitMeta` threaded through the transactor/docstore seam, interpreted only by the fleet's
  commit guard). Because idempotency keys already travel *with* the commit rather than in a
  side-table, they map onto a manifest-embedded key window with no new plumbing.

Everything else about the tier — the working-set memtable, the segment index, the GC — is genuinely
new and genuinely hard, and none of it is designed here beyond naming it. What *is* claimed is that
the reactive-core protocol (scalar timeline, min-over-manifests frontier, fenced eviction, dense
segment chains, verbatim tailer apply, byte-identical client) survives the substrate swap
unchanged — which is the whole point of having designed the shipped protocol the way the verdict
did.

---

## Arc status

With this design record, the write-sharding arc is **complete**: B1 (fenced frontier at one shard)
→ B2a (N shards live) → B2b (fleet distribution) → B3 (hybrid nodes + effectively-once forwarding)
shipped; B4 (per-shard group commit) assessed and shipped dark-off; B5 (this doc) delivered as
design-only per the verdict's slice plan. The one remaining item — the object-storage substrate — is
a named, deliberately-unscheduled future tier, kept reachable by the protocol decisions above.
