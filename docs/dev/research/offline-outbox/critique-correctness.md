# Critique — Correctness Lens

Adversarial critic in the durable-offline-outbox workflow. Mandate: falsify, not improve. Every
mechanism below was traced through the ACTUAL machinery on this branch (`scheduler-component`,
read 2025-11-04), not through the positions' summaries of it. Code claims carry `file:line`;
reference-clone claims cite `.reference/<repo>/<path>:<line>`; uncertainty is flagged. No
reference code copied — studied and described.

**Citation-integrity note first**: the positions cite Lunora as `.reference/lunora/shard-do.ts`,
`.reference/lunora/durable/src/shard-do.ts`, and `.reference/lunora/client/src/...` — the actual
clone paths are `.reference/lunora/packages/do/src/shard-do.ts` etc. The path prefixes drift
between and within papers; the LINE NUMBERS check out where I spot-verified (watermark advance
inside the handler transaction, strict rollback: `.reference/lunora/packages/do/src/shard-do.ts:3535-3556`
— verbatim as characterized; Zero's atomic LMID increment-and-abort:
`.reference/mono/packages/zero-cache/src/services/mutagen/mutagen.ts:440-460`; Replicache's
missing-mutator no-op stub: `.reference/mono/packages/replicache/src/db/rebase.ts:43-59`). The
substance survives; the spec phase should normalize paths.

---

## 1. Findings against the SHARED substrate (all three positions inherit these)

### 1.1 A guard abort under group commit rejects the WHOLE batch — innocent-unit collateral no position prices

All three positions build their exactly-once story on "the conditional advance / PK-collision
INSERT aborts the loser's transaction, which then re-reads the winner" (A §3.2, B §2.4, C §2.2 —
all citing Fleet B3's loser-reads-winner, `packages/cli/src/http-handler.ts:230-241`). None of
them read the group-commit failure contract:

- The committer loop's own doc: "A flush error rejects every unit of the batch and discards it"
  (`packages/transactor/src/shard-writer.ts:585-586`), implemented at `:619-624` — `for (const u
  of batch.units) u.reject(flushErr)`. One transaction, N units, one abort → N rejections.
- A guard throw is NOT an `OccConflictError`, so it "propagates, never batched-retried"
  (`shard-writer.ts:469`) — every innocent co-batched unit's caller receives the FOREIGN error
  raw ("`DocStore.commitWrite`/`ShardWriter.commit`/`InlineUdfExecutor.run` all rethrow a guard's
  failure unchanged", `http-handler.ts:78-81`).
- This blast radius exists TODAY in fleet B3 (`ee/packages/fleet/src/node.ts:958-959`: "aborting
  the WHOLE batch") — tolerable there because forwarded-write duplicate races are rare and only
  `/_fleet/run` carries keys. The outbox changes the base rate: parked resends racing live sends,
  multi-tab double drains, and reconnect storms make duplicate-in-commit a ROUTINE event, and
  each guard abort now fails a batch shared with unrelated clients. The innocent caller sees
  `MutationResponse {success:false, error:"duplicate key ... client_watermarks"}` for a mutation
  that had nothing to do with any outbox.

The fix space is real work: either a per-unit failure channel on `commitWriteBatch` (interface
change — today it returns `bigint[]` or throws, `packages/docstore/src/types.ts` + both stores),
or a typed guard error + committer split-and-retry of innocent units, or same-client
pre-serialization before staging. A's one honest sentence ("the abort must be typed so the
OCC-replay loop doesn't retry it", §3.2) sees a different, smaller problem. **Unpriced in all
three.** Note this also indicts B3's shipped fleet path under `STACKBASE_GROUP_COMMIT` — a
latent collateral bug the outbox would amplify; worth a fix regardless of which position wins.

### 1.2 Where does classification READ? The fleet-replica walk nobody does

All three run Lunora's three-way classify (or B's record lookup) BEFORE the handler. None says
what store that pre-run read hits on a fleet node. This is not hypothetical B2b: fleet slice 2
shipped **embedded replicas with verbatim log apply** (memory: fleet slices 1+2), and
`ShardedTransactor.observeTimestamp`'s own comment describes the lagging-follower reality
(`packages/transactor/src/sharded-transactor.ts:110-118`).

Walk the prompt's scenario — a duplicate drain hitting a different owner post-rebalance: client
drains seq 5 via node N1 → forwarded to owner O1 → commits, watermark row now `last_seq=5`. Ack
lost, N1 dies. Client reconnects to N2 (whose replica has not yet tailed O1's commit), resends
seq 5:

- N2's replica shows `last_seq=4` → classify "next" → forward to the CURRENT owner O2 → O2's
  guard `WHERE last_seq = 4` finds the authoritative row at 5 → zero rows → abort. Correct
  outcome — but only if the loser's re-read hits the **authoritative** store. B3's pattern works
  because `idempotencyLookup` goes through `LeaseManager` on the primary
  (`http-handler.ts:60-65`); the sync tier has NO such read path today — `SyncUdfExecutor` is
  `runQuery/runMutation/runAdminQuery/runAction` only (`packages/sync/src/handler.ts:45-58`).
  The authoritative-read plumbing is new, unpriced machinery in every position.
- Worse: the client next sends seq 6 (fresh work). N2's stale replica says watermark 4 →
  `6 > 4+1` → **spurious `OUT_OF_ORDER` reject**. The client rewinds to `expectedSeq=5`, resends
  5 → stale classify "next" → run → guard abort (with 1.1's batch collateral) → re-read → replay
  ack → send 6 → stale replica STILL says 4 → reject again. A reject/rewind livelock bounded
  only by replica catch-up. The structural point: **a gap rejection is never guard-verified** —
  no commit happens, so the store's conditional advance never gets to veto a wrong classify. Gap
  rejection is therefore only sound when computed from authoritative state. A and C both promote
  `OUT_OF_ORDER` to a server CONTRACT (A §3, AC3.2; C §2.2) without stating this placement
  constraint. B dropped gap rejection for sharding reasons and is accidentally immune — the one
  correctness point in B's column here.

### 1.3 The cross-reload replay-ack has no frontier — rebuilt layers double-render until a timeout valve

Verified against the handler, this falsifies B's central "zero new gate semantics" claim and
dents C:

- A resubscribe baseline Transition carries `endVersion = {querySet: start.querySet+1, ts:
  start.ts}` — **ts does not advance** (`packages/sync/src/handler.ts:263-266`; same for SetAuth
  replay, `:436-438`). A fresh session starts at `INITIAL_VERSION`, so after reload+reconnect
  the client's `maxObservedTs` is 0 even though the adopted baseline VALUES include the old
  commit.
- A replay-ack (dedup hit) short-circuits before `runMutation` → no commit → no `notifyWrites`
  → `advanceOriginFrontier` never runs (it is only reached from `doNotifyWrites`,
  `handler.ts:368`) and `pendingFrontiers` is populated only for FORWARDED mutations
  (`handler.ts:288-294`). Nothing ever advances the fresh session's `version.ts` past the
  original commitTs on account of that old commit.
- So any design that rebuilds an optimistic layer for a parked-but-actually-committed entry and
  gates it on `versionCoversCommit(maxObservedTs, originalCommitTs)`
  (`packages/client/src/reconcile.ts:25-27`) leaves that layer up — the user sees the row TWICE
  (baseline copy + optimistic copy) — until either an unrelated foreign commit happens to fan
  out, or the 10-second gate-timeout valve fires (`reconcile.ts:35`,
  `DEFAULT_GATE_TIMEOUT_MS = 10_000`). On a quiet deployment that is a 10-second guaranteed
  double-render per replayed entry.

Verdicts: **B §2.1 step 5 is falsified as written** — "the baseline itself covers" is not true
of our version bookkeeping; handshake-acked entries do NOT drop through the unchanged gate, and
the G4 frontier B waves at covers forwarded live mutations, not pre-reload commits. **C §3.3's
"compose unchanged" hits the same hole**; C's §3.4 note that "the drainer IS the origin session"
only helps for entries that actually RE-RUN this session, not replay-acked ones. **A §2.3 is
CONFIRMED against the code** — A's refusal to rebuild layers cross-reload ("a replay-ack
generates no fan-out... no sound drop trigger") is exactly right, and it is why A alone can
claim `versionCoversCommit` byte-identical. The honest fix for B/C is new server surface: the
replay-ack path must also emit an empty ts-advancing Transition (sound, because the baseline
resubscribe ran server-side at a snapshot ≥ the commit), or the baseline Transition must carry
its snapshot ts — either is a version-semantics change to the handler that neither paper priced.

### 1.4 The skip-and-bump poison advance cannot ride the existing commit path at all

C flagged "whether the transactor accepts a zero-document commit" as check-before-build (§2.5,
§9). Checked: it resolves **negative**. A transaction with zero staged writes returns
`{committed: false}` before the store is ever touched — single path `shard-writer.ts:318-321`,
grouped path `:437-440`. No `commitWrite`, no guard, `commitMeta` silently dropped. A FAILED
mutation additionally aborted its own transaction, so there is nothing to commit anyway. So:

- C's watermark-advance-on-terminal-failure needs a new privileged internal write path (a
  synthetic system-row commit, or a store-level advance API) — genuinely new engine surface,
  not the "small affordance" hoped for.
- B's "recorded as its own durable commit through the transactor" (§2.4 poison) has the
  identical problem, unflagged.
- A's client-side poison (never advance on failure) is the only design that avoids this
  server-side — but it buys the renumber hazard (§2.1 below).

### 1.5 The "symmetric" SQLite guard is not symmetric

`SqliteDocStore.commitWriteBatch` runs its units inside a **synchronous** transaction callback
(`packages/docstore-sqlite/src/sqlite-docstore.ts:177`, `this.db.transaction(() => {...})`);
the Postgres guard is `async` over a `PgQuerier`
(`packages/docstore-postgres/src/postgres-docstore.ts:75-77`). "Promote `setCommitGuard` to the
interface" (C §2.2) or "a symmetric seam" (A §0) therefore means a forked sync/async guard
contract or reworking the SQLite transaction wrapper — small, but every position calls it
trivial and it is the one place the slice touches BOTH stores' atomicity domains. The watermark
UPSERT itself is sync-friendly; the interface shape is the work.

---

## 2. Position-specific falsifications

### 2.1 Position A

**(a) `skip()` hides a durable renumber with a lost-write crash window.** A persists `clientSeq`
per entry at enqueue (§1, §2.1) and reclaims a failed head's seq: "the seq is reclaimed by the
next entry, since failures never advanced the watermark" (§5.2). Walk it: entries 3..9 persisted
with seqs 3..9; entry 3 terminal-fails at head (watermark = 2); `skip()` → entry 4 must now be
sent as seq **3**, i.e. entries 4..9 must be durably renumbered 3..8 (otherwise the very next
send is `seq 4 > 2+1` → `OUT_OF_ORDER` → self-wedge). Renumbering is SAFE only because strict
FIFO guarantees 4..9 were never sent — true under A — but it must be ONE atomic IndexedDB
transaction: a crash mid-renumber leaves two entries carrying seq 3, and after the first commits
(watermark → 3) the second is classified `seq ≤ watermark` → **silently replay-acked with the
first entry's result** → a lost write reported as success. A never states the renumber, let
alone its atomicity requirement. Same machinery fires on every terminal failure under
`poisonPolicy:"skip"`. Fixable in one IDB transaction; must be in the spec.

**(b) "The row never sees concurrent writers" (§3.3) is overstated by A's own §2.3.** The
leader-drains-dead-sessions + not-actually-dead-tab-resends scenario A itself blesses produces
two concurrent same-seq classify-"next" sends — concurrent guard writers to one row. A treats
this as benign (loser replay-acks), which is true in isolation, but under group commit the loser
IS a batch (§1.1). Rare × batch-collateral is still a composed-path bug class this project's
history says the final review will catch — better priced now.

**(c) Partial-queue-loss wedge, recovery unstated.** IDB corruption / partial eviction leaving
seqs 3,5,7 with 4,6 gone: drain commits 3, sends 5 → `OUT_OF_ORDER expectedSeq=4` forever —
durable pause with an unsatisfiable head. The recovery RULE is derivable from A's own invariant
and worth stating: the conditional advance admits only `watermark+1`, so any entry with
`seq > watermark+1` **provably never applied** and can be safely re-minted under a fresh
clientId/seq. Nobody wrote it down; without it, A's "no silent wedge" (AC5.4) is met by a loud
wedge with no exit.

Otherwise A survives this lens best: per-tab clientId + enqueue-time seq assignment makes the
`(clientId, seq) → payload` binding written-once-by-one-context **by construction** (see §3),
FIFO one-unacked-head keeps same-client concurrency out of the commit path, and no-cross-reload-
layers dodges 1.3 entirely. A's §3.4 conservative-ts argument checks out against
`versionCoversCommit` and store-monotone ts.

### 2.2 Position B

**(a) Prune-on-ack contradicts B's own correctness anchor — a double-apply hole.** B's doctrine:
"the lock is an efficiency mechanism only — correctness rests entirely on the server dedup
records" (§2.1). B's retention: "the `Connect` handshake's `ackedThrough` prunes records the
client has fully gated" (§2.4). Compose them: leader tab acks through seq 41, server prunes
records ≤ 41; a not-dead tab (exactly the actor B's doctrine defends against) resends seq 40
from its stale hydrated view → record MISS → the server **re-executes** → double apply. After
the prune, correctness rests entirely on no client ever resending — the assumption B explicitly
refused to make. The repair is a per-client floor ("never run seq ≤ X") persisted server-side —
which is a watermark row, the exact object B rejected for sharding reasons. B cannot have
prune-on-ack, locks-are-optional, and no-watermark simultaneously; pick two.

**(b) No gap floor + partial queue loss = silent premise-violating skips.** B disclosed
"ordering becomes a client drain obligation" for the concurrency case, but under partial IDB
loss the client cannot honor an obligation it lost: survivors (seq 5,7) drain with 4,6 gone —
no `OUT_OF_ORDER` exists to stop them — and m5 executes against a world missing m4. Where A/C
wedge visibly (recoverable, §2.1c), B proceeds silently. For a correctness lens, silent is
worse.

**(c) "Zero new gate semantics" is falsified** — §1.3 above. B's step 5 is the paper's central
elegance claim and it does not survive contact with `handler.ts:263-266`.

**(d) The flagship offline-reload rendering scenario is not achievable with what B ships.** B's
§1 walk (reload mid-offline, five items invisible, user re-enters, ten commit) indicts A — but
the registry alone does not fix step 3, because our client persists NO query baseline (verified:
zero storage APIs anywhere in `packages/client/src` — the only IndexedDB mention is a comment,
`mutation-log.ts:7`; B's own §2.1 concedes "the client uses no persistence API today"). Offline
after reload, every subscription's `serverValue` is `undefined`; recompose's read chain falls
back to exactly that (`packages/client/src/layered-store.ts:118-127`). A rebuilt updater
composes over `undefined` — it can synthesize a pending-only list IF the app wrote an
undefined-tolerant updater, rendering the five pending items and NONE of the user's other data.
Replicache can replay over a real local snapshot because it persists a DAG
(`.reference/mono/packages/replicache/src/replicache-impl.ts` persist machinery); B claims that
school's outcome without shipping its substrate. The deferred-double-entry attack on A is
therefore also an attack on B at reduced strength — B's honest delta over A in the offline-
reload case is "pending items render with no baseline context," not "the UI survives."

**(e) In fairness, verified TRUE:** the insert-with-id kernel claim is honest — mint at one site
(`packages/executor/src/kernel.ts:328`, `newDocumentId(tableNumber)` inside `handleDbInsert`),
existing decode/table validators, and ring routing hashes the shard-key VALUE not the id
(`packages/executor/src/executor.ts:268-280`), so client ids genuinely don't perturb routing.
The OCC-replay determinism bonus (random ids re-minted per replay attempt today) also checks
out. B's cheapest-mechanism claim is its best-supported one; its delivery machinery is its
weakest.

### 2.3 Position C

**(a) The pipelined window is falsified against the shipped frame handling.** C's flag ("whether
`handleMessage` processes a session's frames strictly serially") resolves NEGATIVE:
`ws.on("message", (data) => void runtime.handler.handleMessage(...))` — fire-and-forget, both
Node and Bun paths (`packages/cli/src/server.ts:293`, `:431`), and `handleMutation` runs
mutations concurrently (only `notifyWrites`/MQS serialize on `notifyTail`,
`handler.ts:269-301`, `:325-329`). A 32-deep window = 32 concurrent `runMutation`s racing:
seq k+1's classify runs before seq k commits → spurious `OUT_OF_ORDER` on most of the window →
rewind → effective W=1 with wasted server work; or, where two classifies both pass, concurrent
guard writers → abort → §1.1's batch collateral. Making the window real requires per-client (or
per-session) serial execution server-side — new machinery C did not price, which then couples
same-client throughput back into head-of-line blocking, the cost C's §3.4 claimed to kill.
"Degrades gracefully to W=1" survives, but then C's drain is Lunora's drain and the headline
performance differentiator is gone.

**(b) "Locks are efficiency, never safety" is FALSE for seq minting under one shared clientId.**
C mints ONE clientId per origin and has "the drainer" assign seqs at first send (§3.1, §3.4).
Two simultaneous drainers (the exact lock-misfire case C says must be harmless) can each assign
seq 7 to DIFFERENT entries. The winner commits; the loser's DIFFERENT mutation classifies
`seq ≤ watermark` → replay-acked with the winner's commitTs and value → **a silently lost write
reported as success**. Resend-of-same-entry is lock-independent; seq ASSIGNMENT is not. The fix
exists and should be stated: seq allocation + entry binding as one IndexedDB readwrite
transaction (IDB serializes cross-tab transactions on a store), making the fork impossible
without trusting Web Locks. As written, C's multi-tab doctrine and its seq-assignment design
contradict each other. (B shares the shared-clientId exposure; its §2.1 handshake-reseed treats
reload, not concurrency. A is immune by construction — per-tab clientId, enqueue-time seqs.)

**(c) Cross-reload registry layers hit §1.3** — the replay-acked parked entry's rebuilt layer
has no drop trigger until the 10s valve. C's gate story needs the replay-ack frontier fix as
much as B does.

**(d) Zero-document poison advance resolves negative** — §1.4. C's honesty in flagging it is to
its credit; the answer is still "new engine surface," and it is on C's critical path (its AC5.1
depends on skip-and-bump).

**(e) "All rings share ONE physical DocStore" (§2.3) is a Tier-0 truth used to close a fleet
question.** `ShardedTransactor` holding one `DocStore` (`sharded-transactor.ts:74-77`) is true
in-process; on the shipped fleet, followers read lagging embedded replicas TODAY (§1.2), so
"whichever ring commits writes the global row" is fine for the WRITE but says nothing about
where classify/gap-reject READ — the actual soundness gap. C's "B2b is unbuilt, deferred"
under-scopes: the read half of multi-node already shipped.

---

## 3. The one invariant underneath every hole

Every silent-lost-write found above — C's seq fork (2.3b), A's renumber crash window (2.1a),
B's prune-then-resend (2.2a) — is the same violation: **the map `(clientId, seq) → payload`
must be immutable and written exactly once, and the server's dedup state must outlive every
client that could still resend that seq.** The watermark scheme's replay-ack is an assertion
that "this seq's payload already ran"; the moment two payloads can ever share a seq (fork,
renumber) or a forgotten seq can be re-presented (prune), the replay-ack converts a delivery
mechanism into a write-eating machine that reports success. The spec should state this as THE
invariant and derive the multi-tab, skip, and retention designs from it — none of the three
papers names it, and each violates it in exactly one place.

A corollary worth stating as the recovery rule (A/C): the conditional advance admits only
`watermark+1`, so any entry with `seq > watermark+1` has provably never applied — safe to
re-mint under a fresh identity. That single sentence converts both gap-wedge scenarios (§2.1c,
eviction-mid-queue) from "durable pause forever" into a mechanical recovery.

---

## 4. Ranking

1. **A (Lunora-shaped minimum)** — the only position whose correctness claims mostly SURVIVE
   the code walk: per-tab clientId + enqueue-time seqs satisfy the §3 invariant by construction,
   no-cross-reload-layers is confirmed right against the handler's version bookkeeping (1.3),
   and FIFO keeps same-client concurrency out of the commit path. Its two real holes (skip-
   renumber atomicity, gap-recovery rule) are client-local, fixable without touching the wire.
2. **C (watermark + registry)** — the right server contract, but three load-bearing claims fail
   against the tree as shipped: the pipelined window (its perf headline) is unsound under
   fire-and-forget frame handling, "locks never safety" is false for its own seq minting, and
   the poison advance needs engine surface its check-flag hoped away; the registry half inherits
   1.3. Each fix is known; together they erase most of C's claimed margin over A.
3. **B (Replicache-complete)** — worst under this lens: two doctrine-level self-contradictions
   that mint silent lost writes / double-applies (prune-on-ack vs locks-optional; no gap floor
   under partial loss), a falsified central gate claim ("zero new gate semantics"), and a
   flagship offline-reload scenario its shipped machinery cannot actually render (no persisted
   baseline). Its best-verified piece — cheap client-supplied ids — is severable and does not
   need B's delivery design to come with it.
