# Critique — scope & irreversibility lens

Critic agent (scope + irreversibility) for the durable-offline-outbox adversarial workflow.
Mandate: falsify, not improve. Questions asked of each position: which decisions freeze at
publish (the wire seq format, the watermark/dedup table shape, the id-codec surface, the
response semantics for a resent seq) versus which are genuinely additive later; each position's
honest slice count against this repo's demonstrated sizes; where a position hides a runtime or
a rebuild behind a one-line claim; and whether the performance story survives arithmetic, not
just assertion.

Calibration: this repo ships large slices (workflow+saga in two, file storage with two blob
adapters + reaper + MinIO gate in one, B1+B2a in two), so all three positions "fit one slice"
by raw LOC — that argument is theater here exactly as it was in the client-sync round. The real
differentiators: (a) the shared server bill (watermark/dedup + guard on both docstores + wire +
classification + fleet threading) is **identical across all three** and is already the
riskiest composition in this corpus (client + wire + sync handler + transactor + both docstores
+ shards + fleet — the exact shape whose composed-path blockers every whole-branch review in
this project's memory caught late); (b) what each position adds *on top* of that bill; (c) what
each freezes forever.

Code claims verified against branch `scheduler-component` this session:
`packages/docstore-sqlite/src/sqlite-docstore.ts:155-166` (commitWrite accepts `meta` and
ignores it — "SQLite has no commit guard to hand it to"), `packages/docstore-postgres/src/
postgres-docstore.ts:75-97` (`setCommitGuard` is a **single slot**; batch-shaped guard invoked
once per commit transaction at `:303`), `packages/transactor/src/sharded-transactor.ts:62-77`
(one `DocStore` behind all rings), `packages/executor/src/kernel.ts:321-340` (`handleDbInsert`
mints unconditionally, `newDocumentId(tableNumber)` at `:328`), `packages/executor/src/
executor.ts:268-280` (ring routing by declared shard-key value), `packages/id-codec/src/
table-registry.ts:1-5,37-48` (in-memory counter registry; "The DocStore-backed durable registry
arrives in M2"; reserved numbers pinned by `preassign`), zero `tableNumber` hits in
`packages/codegen/src` (B's claim confirmed), `packages/sync/src/handler.ts:137` (session
starts at `INITIAL_VERSION`), `:196-198` (Connect no-op), `:262-266` (a resubscribe Transition
bumps `querySet` and **keeps `ts`**), `:269-300` (`handleMutation`: response → `pendingFrontiers`
only for `forwarded` commits made by *this* session), `packages/sync/src/protocol.ts:44-51`,
`packages/client/src/mutation-log.ts:14-33`. Reference-clone claims below are carried from
E2/E4 with their citations; I did not independently re-open the clones.

---

## 0. The verified fact all three dance around (read this first)

A fresh session's `version.ts` starts at `INITIAL_VERSION` and is **never advanced by
resubscribing** — `doModifyQuerySet` sets `end = { querySet: start.querySet + 1, ts: start.ts }`
(`handler.ts:262-266`). It advances only when a **new commit** fans out to a subscribed query,
or via the origin-frontier path, which is armed only inside `handleMutation` for a forwarded
commit made *on this session* (`handler.ts:288-294`). A replay-ack executes nothing, commits
nothing, fans out nothing, and arms no frontier. Therefore: **any optimistic layer rebuilt after
reload for an entry that had already committed can never satisfy
`versionCoversCommit(originalCommitTs)` on a quiet deployment** — the baseline already contains
the effect, the layer double-renders on top of it, and no event ever drops it. This is the G4
class (e3 §4.7's caveat) composed with reload, and it is not hypothetical — it is the shipped
handler's arithmetic. Every position's stance on cross-reload rendering must be read against
this fact; §§1-3 do.

## 1. Position A — the smallest genuine slice, but three of its proudest deletions are trades it never prices

### A1. "Hazard 8 dissolved structurally" is bought with an unresolved fork: cross-reload ordering OR online serialization — A never picks

A's flagship structural move (§2.3, hazard 8): per-tab `clientId`, hydrated entries drain under
recorded ids, "no reseed-from-echo protocol exists to get wrong." But A also says "Live tabs
send their own mutations directly" while "the leader additionally drains persisted entries from
dead sessions." Compose with reload: offline, enqueue m1..m3 (clientId K1); reload mints K2;
still offline, enqueue m4 (K2); reconnect. If the live tab's m4 "sends directly" while the
leader drains K1's m1..m3, the two streams are unordered — m4 (delete the doc) can commit
before m1 (rename it). If instead everything serializes through the one drain loop (A §2.1's
autoincrement-PK-as-replay-order reading), then every online mutation with the adapter enabled
is head-of-line-serialized at one RTT each — the R10 "no online-path tax" headline broken
instead. A's §2.2/§2.3 are genuinely ambiguous between the two readings, and each reading
falsifies a different AC (AC3.1×AC1.1 composition, or AC10.1's spirit). The reseed protocol A
deletes (Lunora `define-mutators.ts:115-119`, per e4 §1.5) is exactly the machinery that makes
one durable client identity span the reload — the boundary this slice exists to survive. Fixing
this later means adopting persisted-clientId + reseed, i.e. re-importing what A markets as
deleted: the hidden rebuild this lens was asked to find.

### A2. `skip()` needs renumbering machinery A never mentions

A assigns `clientSeq` at enqueue and persists it per entry (§2.1, §6: the mint-site swap at
`client.ts:168`). A's poison answer: failures never advance the watermark, so on `skip()` "the
seq is reclaimed by the next entry" (§5.2). But the next entry carries a *persisted* seq of
`failed.seq + 1`; the server expects `failed.seq` → `OUT_OF_ORDER`. "Reclaimed" therefore means
re-stamping every subsequent persisted entry — an atomic multi-record IndexedDB rewrite with
its own crash windows (renumber m3, crash before m4 → permanent self-inflicted gap). C's
send-time seq assignment and B's exact-match records both avoid this class by construction.
A's "no server-side skip machinery at all — the minimum earning its name" (§5.2) hides a
client-side renumbering subsystem that neither of its rivals needs. Unpriced.

### A3. No `Connect` = no terminal state, and A's own attack on fleet's TTL applies to A at 30 days

A keeps `Connect` untouched (§4) and sweeps watermark rows at 30 days idle, arguing the window
"comfortably outlives any queue that can still exist client-side" (hazard 2). A's own evidence
corpus falsifies the premise: installed/home-screen PWAs are exempt from Safari's 7-day cap
(e4 §2.2), and Chrome with `persist()` granted evicts by pressure, not calendar — a parked
queue can outlive 30 days. What happens then: the swept row means a parked seq-1 entry
classifies `next` and **silently re-executes** (double-apply of a write that committed weeks
ago); a parked seq>1 entry trips `OUT_OF_ORDER` — the code A's own §3.1 says "the FIFO client
never trips." A attacked fleet's 1h TTL with "a swept row silently re-executes … documents
exactly that boundary" (§3.1, quoting `lease.ts:84-87`); the same sentence indicts A's design
at 30d, and A ships **no way to distinguish swept-client from fresh-client** — the
disambiguation is exactly the `known:false` / `ConnectAck` terminal state C ships (Replicache
mechanism #10, `client-groups.ts:231-250` per e2 §5) and B ships via the deployment stamp.
Adding `ConnectAck` later is additive on the wire, yes — but the *semantics of a resend against
a swept watermark* are part of the frozen contract, and A freezes them as "sometimes silently
re-execute." That is an irreversibility defect, not a deferral.

### A4. The arithmetic dodges: "one new engine seam" and "the benchmark decides MutationBatch"

- A's thesis line — "the single genuinely new engine seam … is a symmetric `setCommitGuard`" —
  is contradicted by A's own §3.2/§7: the guard-chain generalization (both docstores), the
  typed-abort discipline so the OCC replay loop doesn't retry a guard abort, the sync-path
  loser-reads-winner port (B3's 23505 pattern exists in the HTTP handler, not in
  `handleMutation`), classification in the handler, `/api/run` + fleet threading, and a core
  reaper driver. Credit where due: A *prices* each of these — the only position that names the
  single-slot guard collision at all (§3.2; verified: `postgres-docstore.ts:75-97` holds one
  guard, fleet installs its own at boot per `node.ts:916`). But then the headline arithmetic is
  marketing, same species as C's "exactly two server changes" in the client-sync round.
- The 500-mutation drain (AC10.2) at one RTT per mutation is 25-50s on a 50-100ms link. That is
  not a measurement question — it is multiplication, available now. A's "in-slice if the R10
  benchmark demands it" defers a decision whose outcome is already computable; Lunora — A's own
  precedent for accepting the RTT cost — ships `/_lunora/rpc-batch` **in the product**
  (`lunora-client.ts:4187-4217` per e4 §1.6), not as a follow-on. A's honest slice includes
  `MutationBatch` or owns 30-second drains out loud.

### A5. The decorative registry, and smaller freezes

A ships the registry-by-`udfPath` as API while its §2.3 rule ("no optimistic layer crosses a
reload") guarantees the registry does nothing for hydrated entries in v1 — frozen public
surface whose v1 semantics differ from its eventual purpose, the YAGNI-dressed-as-foresight
pattern. Also: "O(1) per client" (AC2.5) is definitional sleight under per-tab clientIds — the
table is O(tab-sessions per 30d) per identity, fine in practice, but the head-to-head the spec
mandated should say so. And A's future resume story ("Connect {clientId} echoing last_seq",
§5.3) is structurally awkward under per-tab ids: the frontier lives scattered across every
prior session's row, so the follow-on must enumerate recorded clientIds — the per-tab choice
leaks cost into the very seam A reserves.

### A6. What A gets right on this lens

The only position whose §0 fact-base survived my re-verification intact; the only one to price
guard chaining and the typed-abort risk; and — decisive — the only one that names the §0 gate
fact and *designs around it* (hydrated entries drain layerless) instead of asserting it away.
A's wire freeze is the smallest of the three. A is choosable, but only with amendments: resolve
A1's fork explicitly, price A2, ship a terminal-state answer or re-argue A3, and decide
MutationBatch by arithmetic now.

---

## 2. Position B — the largest permanent surface for the least-evidenced demand, and its headline invariant is falsified by the shipped handler

### B1. "Resume introduces zero new gate semantics" is false on a quiet app — the §0 fact

B §2.1 step 5: handshake-acked entries become `completed{originalCommitTs}`, rebuild their
layers over the fresh baseline, and "drop through the existing, unchanged gate." Per §0: the
fresh session's `version.ts` never reaches `originalCommitTs` unless some *new* commit fans out
to a subscribed query — on a quiet deployment, never. The rebuilt layer double-renders over a
baseline that already contains the committed effect, indefinitely. B's only caveat (fleet lag /
G4 frontiers) covers a different case — `pendingFrontiers` is armed only by `handleMutation`
for this session's own forwarded commits (`handler.ts:288-294`); a handshake ack arms nothing.
The fix is knowable — seed the gate from a `ConnectAck` frontier echo — but that is precisely a
**new gate semantic** (the lmid-shape revisit verdict.md:154 scheduled), so B's quiet win
becomes B's hidden server change. The claim as written is CONFIRMED false against
`handler.ts:262-266` + `:288-294`.

### B2. The frozen-surface bill, itemized — B freezes three contracts A and C never touch

1. **`ConnectAck.tableNumbers`** couples every client's durable cache to the table-number
   registry — which is an in-memory counter whose own doc comment says "The DocStore-backed
   durable registry arrives in M2" (`table-registry.ts:1-5`). B's "a cached number is never
   wrong" leans on the *deploy-gate* (additive-only, rejects renumbering), which governs
   `stackbase deploy` — not dev restarts, not the future durable-registry work. Shipping
   numbers into browsers' IndexedDB converts an engine-internal allocation scheme into wire
   protocol with unbounded client lifetime: the M2 registry, and any future renumbering
   affordance, inherit a compatibility constraint with caches B put in the field. Nobody priced
   that freeze — including B.
2. **The id-derivation function** (`hash(seed.entropy, table, ordinal)` → 16 internal bytes) is,
   by B's own open question 1, "specified, tested for distribution, and **frozen**." A frozen
   cryptographic derivation in the id-codec is a forever contract bought in the same slice as a
   wire protocol and a dedup table — three permanent contracts, one review.
3. **Per-seq record semantics** (gap arrivals allowed, `skipped` records, handshake-pruned
   retention) vs A/C's watermark row are *not interconvertible post-ship* — switching families
   later migrates live dedup state and changes observable resend behavior. See §4.1: the corpus
   never prices this fork as the product fork it is.

### B3. B ships both chain mechanisms, including the one it argues should be empty

B's §2.3 ships placeholder-arg rewriting — JSON-path `idRefs` detection, an ack-time rewrite
pass, re-persist-before-dependent-send crash discipline (AC4.3ii) — as the "bounded fallback"
*alongside* client ids, while arguing the fallback's user class is empty because ids are the
blessed path. That is the PowerSync×Convex #1-DX-cost machinery (e3 §2.4/e5 R4), with its own
test matrix, shipped to serve a class the same paper claims not to exist. Under a scope lens
this is self-refuting: either the class is empty (don't ship the machinery) or it isn't (then
the "ids make it empty" argument fails). Pick one; shipping both is the slice buying insurance
with review budget.

### B4. Retention and ordering both become client obligations, quietly

B's per-seq family drops server gap-rejection ("ordering becomes a client drain obligation" —
disclosed, credit) *and* makes the primary retention path the `ackedThrough` handshake prune —
so the handshake is not an optimization but the memory-bound mechanism. A client that never
sends `Connect` (old client with new server after a partial rollout, or a non-outbox client
that still sends clientId'd frames) leaves rows for the TTL sweep only. Neither dependency is
in B's §4.1 slice list as a *risk*; both are single points the flagship E2E must exercise.
Meanwhile B, like C, never mentions the single-slot guard collision (§0 of the server bill):
on B's own flagship leg (b) — Postgres + fleet — fleet's epoch-fence guard already occupies
`setCommitGuard` (`node.ts:916` per e1 §2.1); without the chain generalization only A prices,
B's E2E cannot run as written.

### B5. Where B lands the hit the other two must answer (credit, and it is substantial)

B is the only position that preserves **online-path concurrency** under the adapter: exact-match
per-seq records dedup a resend without imposing per-client total order, so a burst of live
mutations stays concurrent exactly as today, and the FIFO cost is paid only while draining.
A and C cannot claim this — under a watermark, every send must carry the next seq or parked
entries lose resend-safety, so enabling the adapter serializes each client's online commits
(A: one unacked head = one RTT each, or the A1 fork; C: pipelined frames, but commits still
apply serially per client). This is Lunora's two-scheme lesson (e4 headline + §1.9: "the
plain-mutation path should stay concurrent, with ordering opt-in") — which **all three
positions dropped**; B alone rediscovered half of it, then buried it under the sharding
argument. Note also that A's and C's six-axis dismissal of B's record family is a strawman
transfer: E1 §2.2's axes indict *random-key* dedup (no identity, no order, no resume token);
B's `(identity, clientId, seq)` rows have identity, order-by-key, client-scoped lifetime, and a
resume token. The head-to-head the spec mandated (spec:124-125) has three contenders, not two,
and no paper in this corpus actually ran the third row honestly.

---

## 3. Position C — the right cut line, hiding one runtime, one rider, and its flagship's own blocker

### C1. "Single-context seq minting by construction" smuggles in a cross-tab mutation relay

C persists **one clientId per origin+deployment** (§3.1) and answers E4 §2.3's storm hazard
with "seq assignment at first send, **by the drainer**" (§3.4) — i.e. every mutation from every
tab is sent by the Web-Locks leader. Walk a follower tab's mutation: it enqueues to the shared
store; the leader sends it on the *leader's* WebSocket; the `MutationResponse` — promise
resolution, commitTs, failure verdict — arrives on the leader's session. C never specifies how
the follower's `mutation()` promise resolves (a BroadcastChannel response-relay protocol), nor
how the follower's per-tab optimistic layer drops: the origin-frontier tags the **leader's**
session (`handler.ts:277`, G4), so a commit that doesn't invalidate the follower's
subscriptions never advances the follower's `version.ts` — follower-layer starvation, the §0
class again, now on the *live* path. This is precisely the SharedWorker-RPCs-the-upload-back
topology C itself rejected as "problems we don't have" (§3.4, citing e3 §4.5). The alternative
horn — tabs send their own — reintroduces the shared-clientId seq-storm C quotes E4 to avoid.
Either horn is real work; neither is in C's slice list. Hidden runtime, CONFIRMED as an
unpriced sub-system (the failure walk is mine; C's text simply never routes the response).

### C2. The pipelined window is an optimization riding slice 1 — by C's own logic it should be cut

C indicts B for bundling and then bundles a W=32 pipelined drain with gap-reject rewind — a
state machine whose entire justification is drain throughput (AC10.2), whose safety depends on
a check-before-build flag C itself raises (per-session serial frame processing), and whose
degraded mode (W=1) is exactly Lunora's shipped strict chain. An optimization with a
one-parameter fallback and an unverified precondition is the definition of a fast-follow.
Cutting it also deletes C's only structural edge over A's drain. (To be fair: C is the only
position whose v1 numbers *can* pass its own 500-drain AC — A's and B's sequential v1s
predictably miss it, §1.A4/§4.5 — but "ship the optimization because the AC demands it" is an
argument for putting `MutationBatch`-or-window in the *shared* bill, not for C's particular
rider.)

### C3. Two more unpriced items, one shared blocker

- **Zero-document commits** for the skip-and-bump poison advance (§2.5) — C flags it honestly
  as check-before-build, but note what it is: a transactor affordance (a commit whose write-set
  is empty but whose guard unit carries a verdict). Verified against
  `postgres-docstore.ts:301-303`: the guard is **skipped for an empty batch** ("Skipped for an
  empty batch — nothing to commit, nothing to fence"), so the affordance is a real commit-path
  change on both stores, not a flag read. A's design needs no such affordance (failures never
  advance); that asymmetry belongs in C's own honest-weaknesses list and isn't there.
- **The single-slot guard collision** (§2's shared bill): C's §2.2 "promote `setCommitGuard` to
  the interface" never mentions that fleet already installs a guard on Postgres at boot — on
  C's flagship leg (b), watermark guard and epoch-fence guard contend for one slot. Same miss
  as B; only A prices the chain.
- **Parked-entry rebuilds hit §0.** C's registry rebuilds layers for every restored registered
  entry (§3.2), including `parked` ones whose commit pre-dates the reload; those replay-ack —
  no commit, no fan-out, no frontier — and the rebuilt layer never drops on a quiet app.
  Narrower than B's exposure (C's unsent entries re-commit fresh and gate soundly via the
  drainer-as-origin-session), but real, and unflagged in the paper that indicts Electric's
  Pattern-3 ghost for the mirror-image half-truth.

### C4. What survives (credit)

The irreversibility table (§1) is the correct decision frame for this slice, and its central
call is verified sound: because ids travel inside `args` (school C's own doctrine, e2 §1.1),
deferring client-supplied ids costs zero protocol, zero record migration, zero watermark
change — the deferral genuinely is reversible in a way B's shipped id-acceptance surface
(forgery rules, frozen derivation) is not. C's `requestId`-vs-`(clientId, clientSeq)`
two-jobs-two-fields split is the right freeze. C ships the terminal state (`known:false` →
`onClientReset`) that A lacks. And C's shard resolution (one physical store, guard-state
outside MVCC, per-ring watermarks provably misclassify) is the only one of the three that
holds up against `sharded-transactor.ts:62-77` without new invariants — B2b honestly deferred
because the wire is topology-agnostic.

---

## 4. Cross-cutting findings

1. **The three positions occupy the three corners of one trade nobody names.** Once the adapter
   is on: A buys per-client total order + O(1) retention + gap-reject, and pays with online
   serialization (or the A1 ambiguity); B buys online concurrency + reload-proof dedup, and
   pays with client-obligation ordering + handshake-dependent retention; C buys order + a
   faster drain, and pays with the relay runtime. E4 §1.9 recommended the fourth corner —
   Lunora's actual shipped shape, TWO schemes (unordered dedup for live sends, watermark for
   the ordered drain) — and no position evaluated it. The synthesis should, before freezing
   either record family.
2. **The §0 gate fact needs a server answer in-slice, whoever wins.** Replay-acked/handshake-
   acked entries have no drop trigger on a quiet app (verified, `handler.ts:262-266,288-294`).
   A avoids by cutting the feature (and freezes a decorative registry); B asserts it away
   (falsified); C half-avoids (parked case open). The honest options — seed `maxObservedTs`
   from a `ConnectAck`/replay-ack frontier echo, or an empty ts-advancing Transition on replay
   — are each a *gate semantic change* the verdict already scheduled as the lmid revisit
   (verdict.md:154). Whichever position wins, the spec must choose one explicitly; the corpus
   currently leaves the most user-visible offline behavior (do my reloaded edits render?)
   undecided or unsound.
3. **Resend-of-a-failed-seq semantics diverge three ways and are frozen at publish**: A
   re-executes (failures never consumed a seq — harmless-by-transactionality but
   verdict-unstable), B replays a recorded `skipped` verdict, C replays the recorded failure
   from `last_verdict`. Three different observable contracts for the same client behavior;
   no paper flags the disagreement. Same class as the client-sync round's promise-timing
   split — the synthesis must decide it out loud.
4. **Multi-tab send topology is under-specified in all three.** Who sends a live follower-tab
   mutation, on whose session, how the promise and the per-tab gate compose — A's per-tab ids
   dodge the relay but break cross-reload order (A1); B needs cross-tab-atomic seq allocation
   it never specifies (shared clientId + per-tab minting = PK collisions where the *loser is a
   different mutation* — a wrong-result replay-ack, worse than a duplicate); C hides the relay
   (C1). This is the composed-path review's likeliest late catch; the spec should draw the
   topology diagram before any code.
5. **The benchmark shape is wrong in the bar itself.** E5's AC10 protects enqueue latency and
   drain throughput but never measures (a) online mutation-latency delta with durability on —
   B's and C's durable-then-wire discipline puts an IndexedDB commit (~5-25ms, worse on
   low-end mobile) in every online send path, unpriced by both; A's write-behind avoids it and
   alone states the crash-window trade; (b) online *concurrent-mutation throughput* under the
   adapter — the serialization regression of §4.1, invisible to every listed AC; (c) IDB
   transaction count per mutation (≥3: append, seq/status, dequeue — ×500 on a drain, against
   AC10.2's frame budget). A 500-drain wire benchmark all three can game misses the axis where
   the actual regression lives.
6. **Frozen-surface scorecard** (publish-is-forever lens): A freezes the smallest wire (no
   Connect change) but freezes silent-reexecute-after-sweep semantics and a decorative registry
   API; C freezes the watermark contract *complete* (reseed + terminal state + verdict replay)
   plus one cuttable accessor family; B freezes the watermark-equivalent contract *plus*
   `ConnectAck.tableNumbers` (coupling client caches to an explicitly-interim registry), *plus*
   a cryptographic id derivation, *plus* the per-seq family's retention/ordering semantics. If
   offline demand never materializes (Zero's precedent — the field's most-scarred team keeps
   this outcome live, e2 §8), A and C carry small dead surface; B carries three permanent
   engine contracts.

---

## 5. Ranking (this lens only)

1. **A** — the smallest genuine slice with the only fact-base that survived re-verification
   (guard-slot collision, typed-abort risk, the §0 gate hazard — all named only here); choosable
   *only* with amendments: resolve the A1 order-vs-serialization fork, price skip-renumbering,
   ship a terminal-state answer for the swept-watermark case its own TTL critique indicts, and
   decide MutationBatch by arithmetic now. If the correctness critic weighs A1's cross-reload
   FIFO break as disqualifying rather than amendable, A drops below C.
2. **C** — the right irreversibility frame and the only complete frozen watermark contract
   (reseed, terminal state, verdict replay), with a verified-sound id deferral; dinged for the
   hidden cross-tab relay runtime its single-drainer choice forces, an uncut pipelining rider,
   an unflagged transactor affordance, the parked-entry §0 hole, and missing the guard-slot
   collision that blocks its own flagship E2E leg as written.
3. **B** — its headline invariant ("zero new gate semantics") is falsified by the shipped
   handler, it ships both chain mechanisms including the one it argues is unnecessary, and it
   freezes the largest permanent surface (tableNumbers-in-clients, a frozen id derivation, the
   per-seq family) for the least-evidenced requirement in the catalog — yet it is the only
   position that refuses to serialize the online path, and §4.1's trade plus the honest third
   row of the record-family head-to-head must be taken from it into the synthesis even as the
   position loses.
