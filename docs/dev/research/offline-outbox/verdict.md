# VERDICT — durable offline outbox

All load-bearing code claims in the three critiques re-verified against the tree before judging
(2025-11-04, branch `scheduler-component`): a resubscribe Transition bumps `querySet` and **keeps
`ts`** (`packages/sync/src/handler.ts:262-266`), and `pendingFrontiers` is armed only for a
*forwarded* commit made on this session (`handler.ts:288-294`) — the scope critique's §0 gate fact
is real; worse than any position stated, `sweepPendingFrontiers` runs only from `doNotifyWrites`
(`handler.ts:375,406-414`), so even an armed frontier never fires on a quiet app. A group-commit
flush error rejects **every** unit of the batch (`packages/transactor/src/shard-writer.ts:585-586,
619-625`) and a guard throw is non-OCC so it propagates raw to innocent co-batched callers
(`shard-writer.ts:469`; guard errors deliberately rethrown unwrapped,
`packages/cli/src/http-handler.ts:79-81`) — correctness finding 1.1 is real and is a latent fleet-B3
bug today. A zero-staged-writes transaction returns `{committed:false}` before the store is touched
(`shard-writer.ts:317-321`, grouped `:436-440`) and the Postgres guard is skipped for an empty batch
(`packages/docstore-postgres/src/postgres-docstore.ts:301-303`) — the skip-and-bump poison advance
cannot ride the existing commit path. SQLite accepts commit `meta` and ignores it ("SQLite has no
commit guard to hand it to", `packages/docstore-sqlite/src/sqlite-docstore.ts:155-166`); the
Postgres guard is a **single slot** (`postgres-docstore.ts:75-97`) that fleet already occupies at
boot (`ee/packages/fleet/src/node.ts:916`). Inbound frames are fire-and-forget on both server paths
(`packages/cli/src/server.ts:293,431`) — C's pipelined window is unsound as written.
`SyncUdfExecutor` has no read path for classification (`handler.ts:45-58`). The client uses no
storage API anywhere (grep of `packages/client/src`), mints `requestId` from a per-instance counter
(`packages/client/src/client.ts:168`), parks nothing today (`delivery-policy.ts:40-59`), and the
10s gate-timeout valve exists (`packages/client/src/reconcile.ts:35`). The table-number registry is
in-memory and self-labeled interim ("durable registry arrives in M2",
`packages/id-codec/src/table-registry.ts:1-5`) — the scope critique's B2 freeze warning is real.
Lunora's watermark-atomic-with-transaction claim verified at the normalized path
(`.reference/lunora/packages/do/src/shard-do.ts:3535-3556` — the positions' `.reference/lunora/...`
prefixes drift; line contents check out). The critiques argued about real code. Verdict follows.

---

# The Receipted Outbox: B's record family repaired with a floor, inside C's skeleton, on A's client-identity model — plus four repairs the critiques made mandatory

## (a) Verdict and rationale

**No position wins as written; the synthesis is decided.** Take from each exactly this:

- **From B (else rejected): the record family.** Per-seq, exact-match verdict records
  `(identity, clientId, seq) → {verdict, commitTs, value?}` — because it is the only family that
  (1) preserves **online-path concurrency** (a watermark's conditional advance forces per-client
  total order onto every live send — the regression scope §4.1 proved invisible to E5's own ACs),
  (2) needs **no server gap-rejection**, which dissolves three verified failure classes at once:
  the stale-replica `OUT_OF_ORDER` livelock (correctness 1.2 — fleet followers read lagging
  embedded replicas *today*), A's skip-renumber lost-write crash window (correctness 2.1a — with
  no density requirement there is nothing to renumber), and C's pipelined-window rewind storms
  (correctness 2.3a); and (3) is order-agnostic, so the same records serve external retriers
  (TanStack DB executors) that a FIFO watermark 409s — B's accidental best card (DX §8), claimed
  deliberately. B's fatal prune-on-ack double-apply hole (correctness 2.2a) is repaired by the one
  thing the critique said it needed: a **per-`(identity, clientId)` floor row** below which a
  presented seq is answered with a loud terminal `STALE_CLIENT` verdict — never silently
  re-executed (A3's swept-watermark indictment answered), never silently swallowed. Everything
  else of B is rejected: the registry-as-primary docs churn, placeholder-arg rewriting
  (permanently, with C — the PowerSync×Convex #1-DX-cost machinery serving a class B itself argued
  is empty), `ConnectAck.tableNumbers` (couples client caches to an explicitly-interim registry,
  scope B2), and client-supplied ids in this slice (§(i)).
- **From A: the client-identity model and the fact discipline.** One **clientId per tab-session**,
  seqs minted serially in-memory per tab — the `(clientId, seq) → payload` binding is
  written-once-by-one-context **by construction** (the correctness critique's §3 invariant,
  satisfied without Web Locks, without IDB-transaction seq allocation, without C's hidden
  cross-tab mutation relay). A's A1 cross-reload-FIFO fork is resolved by an ordering rule A never
  stated: drain order is the shared queue's persisted order column, not seq numerics, and **a new
  mutation enqueues behind a non-empty queue** (direct-send only when the queue is empty). Also
  from A: the guard-chain pricing (the only position that saw the single-slot collision), the
  overflow-reject-the-NEW-enqueue call, and the insistence that ack-lost entries must not
  double-render (its mechanism analysis was confirmed against the handler; its product conclusion
  — no cross-reload rendering at all — was not).
- **From C: everything structural.** The irreversibility cut line as the decision frame; one wire
  contract with `Connect`/`ConnectAck` activated (feature detection — closing A's version-skew
  double-apply, DX §2); the registry-by-`udfPath` with the precedence rule C forgot (call-site
  closure wins for the live call; the registry is consulted at hydrate only); the terminal
  `known:false → onClientReset` state; verdict-replay for failed seqs; the deferral of
  client-supplied ids (verified genuinely reversible — ids travel inside `args`, scope C4); and
  the two-jobs-two-fields split (`requestId` stays session correlation; `(clientId, seq)` is the
  durable identity).
- **Four mandatory repairs no position priced** (all confirmed against the tree): (1) the
  cross-reload gate fix — decided in §(f) as a *client-side* rule, not new server gate semantics;
  (2) the guard-abort batch-collateral fix in the group committer (also fixes a latent shipped
  fleet-B3 bug); (3) the classification-placement rule — dedup reads run where the commit runs,
  never on a follower replica; (4) `MutationBatch` in-slice, decided by arithmetic (a 500-drain at
  one RTT each is 25–50s on a 50–100ms link — scope A4; the AC is unmeetable without batching).

Why this composition and not a position: the critiques' rankings (correctness A>C>B, DX C>B>A,
scope A>C>B) are not contradictory — they each measured one corner of the trade scope §4.1 named.
A's corner (total order) buys correctness by serializing the product; B's corner (concurrency)
buys the product by leaking correctness at the prune boundary; C's corner hides a relay runtime.
E4 §1.9's unevaluated fourth corner (Lunora's two coexisting schemes) is the tell: Lunora needed
two schemes because its watermark demands order. **Exact-match records demand nothing — one scheme
serves both roles** (concurrent live sends and external retriers get order-agnostic dedup; the
offline drain gets FIFO as a client obligation, which E5 AC3.2 explicitly permits). That
unification is the verdict's core move.

## (b) The governing invariant (adopted from the correctness critique, verbatim in spirit)

**The map `(identity, clientId, seq) → payload` is written exactly once, and the server's dedup
state must outlive — or loudly disown — every client that could still resend that seq.** Every
silent-lost-write the critiques found (C's seq fork, A's renumber window, B's prune-then-resend)
violates it in one place. The design derives from it: per-tab clientId makes the binding
single-writer by construction; records atomic with commit make the effect exactly-once; the floor
makes pruning safe by converting "forgotten" into "loudly disowned" (`STALE_CLIENT`), never into
re-execution. Corollary recovery rule (also the critique's): under exact-match records a seq with
no record and no floor coverage provably never applied — always safe to run; there is no gap-wedge
state anywhere in this design.

## (c) The server contract, precisely

**Storage — two internal tables, core, free-tier, both docstores** (same category as
`persistence_globals`; NOT `fleet_idempotency`, which fails E1 §2.2's six axes and is `ee/`):

```
client_mutations(identity, client_id, seq) PK
  → { verdict: "applied" | "failed", commit_ts, value_json? (64KB cap), error_code?, created_at }
client_floors(identity, client_id) PK
  → { pruned_through_seq, updated_at }
```

Identity-scoped keys because `clientId` is client-supplied and unauthenticated (Lunora's forgery
rationale, `.reference/lunora/packages/do/src/ctx-db-client-watermark.ts:6-12`; anonymous clients
key as `("", clientId)`).

**Atomicity.** An `applied` record is written by the commit guard inside the same store transaction
as the mutation's effects — the channel is shipped end-to-end (`RunOptions.commitMeta` →
transactor `{meta}` at `shard-writer.ts:355/:548` → `CommitGuardUnit[]`,
`packages/docstore/src/types.ts:86-96`; B3 proves the semantics,
`ee/packages/fleet/src/node.ts:955-971`). Two priced work items: (1) **SQLite gains
`setCommitGuard`** — its commit is one synchronous transaction (`sqlite-docstore.ts:169-186`), so
the guard contract forks sync/async at the interface (correctness 1.5: this is the real work, not
a "symmetric seam" one-liner); (2) **the single guard slot becomes a chain/dispatcher** on both
stores — fleet's epoch fence already occupies the slot at boot (`node.ts:916`); without the chain
the flagship Postgres+fleet E2E cannot run (the collision only A priced).

**A `failed` record needs no atomicity** — there are no effects to be atomic with (the transaction
aborted; zero-doc commits never reach the store, `shard-writer.ts:317-321`). It is written by a
new, small, standalone store API (`recordClientVerdict`, both stores, its own tiny transaction)
after the terminal failure. This dissolves the zero-document-commit affordance C hoped away and B
never flagged (correctness 1.4): no transactor change, no privileged commit path. Crash between
fail and record: the resend re-executes and (deterministically) fails again — the residual
verdict-instability window is a store-write's width and is documented.

**Classification (the fast path; the guard is the enforcement).** On a `Mutation{clientId, seq}`:
record hit `applied` → ack without running: `MutationResponse{success: true, replayed: true,
ts: commit_ts, value | valueMissing}` (the original commitTs keeps the client gate sound — AC2.1;
`valueMissing` is B3's worked answer, `http-handler.ts:92-104`). Hit `failed` → replay the recorded
terminal verdict (the resend-of-a-failed-seq contract, decided: **verdict replay**, C's semantics —
scope §4.3's three-way divergence settled out loud). `seq ≤ pruned_through_seq` with no record →
`STALE_CLIENT` terminal. Miss above floor → run with `commitMeta = {identity, clientId, seq}`.
**Placement rule (repair 3):** the classification read runs where the commit runs — locally on
single-node, at the owning writer on fleet (threaded with the forward exactly as B3's pre-SELECT,
`http-handler.ts:202-204`) — never against a follower's embedded replica. `SyncUdfExecutor.
runMutation` grows an optional dedup parameter and a replay-shaped return; that plumbing is priced,
not assumed (`handler.ts:45-58` has nothing today). A concurrent duplicate that slips past
classification hits the guard's PK collision; the loser re-reads the winner's row and replay-acks
(B3's loser-reads-winner, `http-handler.ts:73-91`).

**The guard-abort collateral fix (repair 2).** Under group commit, one duplicate-key guard abort
today rejects every co-batched innocent unit with the foreign error (`shard-writer.ts:619-625`,
non-OCC propagation `:469`). The committer gains a typed `CommitGuardRejection` carrying the
offending unit; on catching it, the committer rejects only that unit and re-flushes the rest (the
store rolled the whole batch back, so nothing landed — re-flush is safe), bounded-retried. This
fix lands regardless of the outbox: it is a live defect in shipped fleet B3 under
`STACKBASE_GROUP_COMMIT`.

**Ordering.** No server gap-rejection, deliberately (see §(a)). Per-client FIFO is a client drain
obligation: the leader drains the shared queue in persisted order, one unacked head per batch
chunk. E5 AC3.2 offers exactly this choice; we take the branch that survives the shipped replica
topology.

**Sharding and fleet (AC2.3/2.4).** Records and floors are commit-guard state — outside MVCC,
outside one-doc-one-ring (C's argument, verified against one physical `DocStore` behind all rings,
`packages/transactor/src/sharded-transactor.ts:62-77`). Exact-match records have no cross-ring
coupling at all (B's argument — no global row is conditionally advanced). Fleet: the guard runs at
the owning writer's commit point (`node.ts:916` precedent); a resend arriving via any node dedups
there. Multi-node B2b: the wire contract is topology-agnostic; record placement moves with B2b —
deferred with B2b itself, flagged.

**Retention.** Prune records per clientId on `Connect.ackedThrough` and by TTL (30 days), advancing
`pruned_through_seq` in the same transaction; a recurring reaper driver (the `storageReaper` seam)
sweeps. Floor rows are one small row per tab-session and are retained ≥ 1 year; beyond that a
resend can re-execute — the documented far boundary (vanishingly rare per e4's storage realities;
stated, not hidden). Terminal state: `Connect` asserting history the server has neither records
nor floor for → `known: false` → client `onClientReset` (fresh clientId; `unsent` entries re-enqueue
— never applied, safe; parked entries reject loudly). Rows per identity are O(live queue + 30-day
tab-sessions) — the honest cost of per-tab clientIds, priced (scope A5).

**Poison (R5).** Default **skip-and-record**: a deterministic app error (validation, authz, handler
throw — the executor's retryable-classification discipline) writes the `failed` record standalone,
the entry settles terminal, the drain continues (Replicache's "deadlock" word for the alternative;
Zero's error-mode automation). Transient/infra errors record nothing and retry with backoff. A's
pause argument is honored as `poisonPolicy: "pause"` — an option, not the default (DX §3: defaults
are the product; chat/todo/notes are the slice's app shapes). Un-encodable args terminal-fail at
enqueue, before ever occupying a seq.

## (d) The client architecture

**Persistence.** `OutboxStorage` seam in `packages/client` — its first storage API ever (verified) —
following the `DatabaseAdapter`/`BlobStore` discipline: `indexedDBOutbox()` (probe-and-fallback),
in-memory default preserving today's semantics byte-for-byte; durability is opt-in constructor
config. Persisted record: `{clientId, seq, requestId, udfPath, args, seed, order, status,
identityFingerprint, outboxVersion, enqueuedAt}`. The **seed persists** (or placeholder identity
breaks across reload, e1 §1.1); `touched` and the `update` closure do not (recomputed / registry).
`order` is an explicit column — Map insertion order does not survive IDB. clientId and per-tab
next-seq live in the same database (co-eviction keeps identity and queue in lockstep, hazard 1).

**Identity.** One clientId per tab-session (minted at client construction, persisted); seqs minted
serially in-memory per tab, monotone per clientId. No cross-tab minting coordination exists to get
wrong; no reseed protocol; no renumbering ever (no density requirement). Hydrated entries drain
under their **recorded** `(clientId, seq)`.

**Enqueue.** `mutation()` stays synchronous (optimistic apply + listeners unchanged,
`client.ts:163-194`); the IDB append is write-behind and **the wire send does not wait for it** —
safe because a resend requires a durable record, so a crash-lost append can never double-apply
(the promise died in the crash; an orphaned server record TTL-prunes). **Park eligibility requires
durability**: at transport close, an inflight entry whose append committed parks; one that never
became durable rejects with `MutationUndeliveredError` exactly as today. So the online path pays
zero added latency (scope §4.5's axis (a) answered by design) and degrades to today's behavior at
the margins. Offline enqueues are durable long before any drain. Rule: **while the queue is
non-empty, new mutations enqueue behind it** (FIFO preserved across the reload boundary — A1's fork
resolved); when empty, live sends go direct and concurrent, carrying `(clientId, seq)` for
park-safety, exactly as today otherwise.

**S4 swap, feature-detected.** `closeDisposition`: `inflight` → `parked` (layer still drops — the
no-layer-crosses-a-session rule is untouched, `delivery-policy.ts:2-7`) — armed **only after a
`ConnectAck` proves server dedup exists** (DX §2: A's version-skew double-apply is structural
without this). Old server / no adapter → today's fail-fast, byte-for-byte.

**Reload and rendering — the fork, decided.** The registry-by-`udfPath` ships
(`optimisticUpdates: {"messages:send": fn}`, codegen-typed keys; precedence: call-site closure wins
for a live call, registry consulted only at hydrate — DX iv's one sentence). Hydrated registered
entries rebuild layers over the fresh baseline via the normal recompose path; the persisted seed
mints identical placeholders. **The §0 gate fact is closed client-side, with zero new server gate
semantics:** (1) the drain starts only after the reconnect baseline Transition has been adopted
(the reopen sequence already orders SetAuth → resync → flush, `client.ts:327-344`; the drain gains
an explicit await); (2) a **cross-session entry whose verdict says `applied` (handshake or
replay-ack) drops its layer immediately once the baseline is adopted** — sound because the entry's
commit necessarily predates this session's `Connect`, hence predates the baseline's read snapshot,
so the baseline already renders the effect; the drop is flicker-free by the same one-pass rule as
today. `versionCoversCommit` (`reconcile.ts:25-27`) stays byte-identical for same-session entries;
fresh commits from drained entries gate through the existing G4 origin-frontier (the drainer is the
origin session). The 10s valve remains the backstop. This gives B/C's rendering without their
verified stuck-duplicate, and avoids the server-side empty-Transition surgery the correctness
critique priced — my re-verification showed even that repair under-priced (`sweepPendingFrontiers`
is drain-event-driven, `handler.ts:375`; a quiet app never sweeps).
**Honest boundary (from correctness 2.2d):** with no persisted query baseline — explicitly a
non-goal; that is the client-replica product (e2 §2.4) — *offline-after-reload* rendering composes
registered updaters over `undefined`, and the documented `if (list === undefined) return` recipe
renders nothing. Cross-reload optimistic rendering is therefore guaranteed only once reconnected;
offline-after-reload visibility is `usePendingMutations` plus a documented pending-tray recipe and
an optional undefined-tolerant-updater pattern. B's double-entry attack is mitigated by visibility,
not solved by magic — no position could solve it without a replica, and the verdict says so.

**Drain.** Web Locks leader (`stackbase:outbox:<origin>:<deployment>`) hydrates and drains the
shared queue — locks are efficiency; correctness is the records (two drainers double-send, the
exact-match record replay-acks the loser; with per-tab clientIds there is no seq to fork). FIFO by
`order`; sent as **`MutationBatch`** chunks (repair 4 — server applies units sequentially within
one message, per-unit responses; group commit amortizes the flushes; Lunora's `rpc-batch` shape);
one unacked chunk in flight. Identity gate per entry at flush (stamped at enqueue; mismatch →
terminal `OFFLINE_IDENTITY_CHANGED`, loud); encodability triage at enqueue; coded-verdict = terminal
vs codeless = backoff-and-retry; wake on enqueue, on reconnect-after-baseline, and on an interval
nudge that never consults `navigator.onLine`. Overflow: bounded (default 1000), **rejects the new
enqueue** with a coded error (A's call — the new write has a live awaiter; the oldest durable
promise may not).

**Observability (R9, due now).** `client.pendingMutations()` + reactive `usePendingMutations()`
over the durable store (cross-tab via BroadcastChannel nudge); `onMutationFailed` refires from
durable records on resume (Lunora's `hadAwaiter`; Firestore #3661's answer); failed entries persist
until dismissed/retried (`entry.retry()` re-enqueues under a **fresh seq** — the old seq's record
is its verdict; never reuse a seq for a new attempt, per §(b)); queue age/size advisory; and a
**dev-mode `console.error` default for terminal failures with no registered handler** (DX v — all
three positions omitted the five-line courtesy).

## (e) Wire changes — all additive (`parseClientMessage` is bare `JSON.parse`, `protocol.ts:73-75`)

| Message | Change |
|---|---|
| `Mutation` | + `clientId?: string`, `seq?: number`. Absent → today's unconditional path, bit-for-bit (`handler.ts:269-301`) |
| `MutationBatch` (new) | `{entries: [{requestId, clientId, seq, udfPath, args}]}`; server applies sequentially, replies per-unit |
| `MutationResponse` success | + `replayed?: true`, `valueMissing?: true`; `ts` already carries commitTs with its send-site invariant (`handler.ts:172-189`) |
| `MutationResponse` failure | + `code?: string` (terminal verdict codes incl. `STALE_CLIENT`; coded-vs-codeless is the retry policy) |
| `Connect` (activated from the reserved no-op, `handler.ts:196-198`) | `{type, sessionId, clientId?, held?: [{clientId, seq}], ackedThrough?: [{clientId, seq}]}` |
| `ConnectAck` (new) | `{known: boolean, results: [{clientId, seq, verdict: "applied"\|"failed"\|"stale"\|"unknown", commitTs?, value?\|valueMissing?, code?}]}` — the capability proof that arms park-and-resend. **No `tableNumbers`** (rejected — scope B2) |

`requestId` keeps its job (per-session correlation echo); the durable identity is the explicit
pair. Responses stay backpressure-undroppable (`handler.ts:165-172`). A documented pass-through —
`client.mutation(ref, args, { idempotency: {clientId, seq} })` — plus a spec paragraph on external
executors (suppress our outbox under theirs; exact-match records serve out-of-order retriers
because there is no gap-reject) discharges DX vi.

## (f) E5's catalog, answered number by number

- **R1 Durability** — AC1.1 flagship E2E; AC1.2 met (statuses persist; acked entries dequeue on
  ack — a crash between ack and dequeue resends once and the record absorbs it); AC1.3 honesty
  clause verbatim (`persist()` requested, eviction never marketed); AC1.4 seam + memory default.
- **R2 Delivery** — AC2.1 replay-ack with original commitTs, kill-after-commit E2E; AC2.2 guard
  atomic on BOTH docstores (SQLite guard + chain are the priced new work); AC2.3 resolved:
  exact-match records have no cross-ring coupling, guard state outside MVCC; AC2.4 owner-commit
  placement, B3 channel; AC2.5 ack-prune + 30d TTL + floor + 1yr floor retention — and the spec's
  mandated head-to-head is closed with the **third contender** scope B5 said nobody ran:
  identity-keyed per-seq records + floor beat both the pure watermark (online serialization,
  renumber hazard, replica-unsafe gap-reject) and random keys (all six E1 axes).
- **R3 Ordering** — AC3.1 drain FIFO by persisted order; AC3.2 met via the client mechanism the AC
  itself offers (no pipelining past an unacked chunk; batch units apply sequentially server-side);
  AC3.3 mid-drain disconnect E2E (applied prefix replay-acks, remainder applies).
- **R4 Chains** — deferred with C's argument, verified reversible (ids travel in `args`): composite
  intents are the v1 idiom (the mutation IS the transaction — the existing Convex-shaped pattern);
  client-supplied ids are the first follow-on, its own spec (§(i)). Arg-rewriting rejected
  permanently. AC4.1 passes for composite intents; AC4.2/4.3 travel with the follow-on.
- **R5 Poison** — AC5.1 met under default skip-and-record (m1, m3 commit; m2 terminal exactly once;
  its record replays the verdict on resend); AC5.2 coded/codeless split; AC5.3 durable
  `onMutationFailed` refire; AC5.4 the skip is server-recorded — no restart can un-skip; plus the
  dev-mode loud default.
- **R6 Resume** — the handshake ships (verdict classification, terminal state); the subscription
  resume token defers (AC6.3 satisfied constructively: the drain needs only responses, which are
  undroppable). AC6.2's session rules are strengthened, not relaxed (drain-after-baseline).
- **R7 Multi-tab** — AC7.1 Web Locks leader, kill-mid-drain takeover E2E'd, records as the safety;
  AC7.2 shared store + accessors + leader drains dead tabs' entries under recorded ids; AC7.3
  layers stay per-tab, scoped out explicitly (the registry makes cross-tab render reachable later).
- **R8 Conflict UX** — AC8.1 taxonomy documented (succeed / no-op by own logic / terminal → R5; no
  merge, no CRDT); AC8.2 failed intent + args + enqueuedAt + server error through R9; AC8.3
  frozen-base speculation documented + pending affordance recipe; AC8.4 age/size advisory before
  the Safari cliff.
- **R9 Observability** — in full, in-slice (§(d)); Zero's two-promise DX evaluated and rejected
  with all three positions' shared reason (the durable record outlives any promise).
- **R10 Performance** — AC10.1 by design (send never waits for the append); AC10.2 met by
  `MutationBatch` (in-slice by arithmetic); AC10.3 drain paces under the backpressure cap
  alongside resubscribe, E2E'd; AC10.4 PK point lookup. Plus the two axes E5 missed (§(h)).
- **R11 Uniqueness** — see §(j).

## (g) E4's sixteen hazards, item by item

1. **Whole-origin eviction** — queue + clientId + next-seq co-evict (one database); drained seqs
   are recorded server-side, undrained ones never arrive; an evicted queue is unreportable
   (nothing survives to report) — documented, `persist()` requested. Both halves.
2. **Safari 7-day wipe** — contract time-bounded in docs; 30d record retention ≥ any queue that
   can still exist; age advisory before the cliff. Client + docs.
3. **`persist()` denied** — advisory only; zero behavior branches on the grant. Client.
4. **`QuotaExceededError`** — persistence failure ≠ mutation failure; `onPersistenceError` + the
   entry stays live in-memory this session (loses park eligibility, honestly). Client.
5. **Private mode / no IDB** — probe → memory fallback, same API. Client.
6. **Two tabs, one queue** — leader is efficiency; exact-match records are the safety; per-tab
   clientIds mean no seq can fork even with no locks at all. Both.
7. **Killed mid-drain** — sent-unacked entries are durable with recorded ids; next leader resumes
   FIFO; resends replay-ack. Both.
8. **Reload resets counters** — dissolved structurally (new tab = new clientId; recorded ids drain
   as-recorded); no reseed protocol exists to get wrong. Client.
9. **Auth change with queued writes** — identity stamped at enqueue, gated at flush, discarded
   loudly; server keys are identity-scoped so a client bug cannot cross users. Both.
10. **Schema/version change** — `outboxVersion` stamp, drop-with-verdict at hydrate; D5 validation
    terminal-fails stale-shaped args into R5 server-side. Both.
11. **Poison writes** — skip-and-record default; encodability triage at enqueue; codeless errors
    back off, never block the FIFO. Both.
12. **Queue overflow** — bounded; rejects the NEW enqueue with a coded error + observer (A's
    divergence from Lunora's evict-oldest, adopted with its argument). Client.
13. **`navigator.onLine` lies** — never consulted; reconnect wake + interval nudge; transport
    backoff already jittered (`transport.ts:71-75`). Client.
14. **No Background Sync off Chromium** — portable contract is drain-on-next-visit; SW drain is a
    named follow-on (queue format + auth must be SW-readable if built). Client.
15. **Server timeline resets** — records/floors share the store, hence share fate through
    PITR/restore (resends re-execute against the restored world — correct); `known:false` →
    `onClientReset` for swept/foreign state; deployment-id stamp on `ConnectAck` hardens
    same-timeline proof. Both.
16. **Ack received, sync stream behind** — dequeue-on-ack vs layer-drop are decoupled;
    same-session layers gate on the unchanged ts-gate + G4 origin frontier; cross-session layers
    drop on verdict-after-baseline (§(d)) — the case the shipped frontier machinery structurally
    cannot cover (verified: `handler.ts:288-294,375`). Client, on shipped rails.

## (h) Performance proof (the benchmark record, run against the real server)

Four axes — E5's two plus the two the scope critique proved missing (§4.5): (a) **online mutation
p50/p99 delta** with the adapter on vs off (design target ~0 — the send never awaits the append;
measured, not asserted); (b) **online concurrent-mutation throughput** with the adapter on (no
per-client serialization by design — the axis that would have caught the watermark regression);
(c) **500-mutation drain**: time-to-empty (target seconds, not the 25–50s sequential arithmetic),
longest main-thread block (frame budget), riding `MutationBatch` + group commit; (d) **IDB
transactions per mutation** (append / status / dequeue — batched per chunk on the drain). Plus the
AC10.3 composition: drain + full resubscribe on one connection under the backpressure caps.

## (i) The slice vs named follow-ons, with the honest cost of each deferral

**The slice**: the two tables + floor semantics + SQLite guard + guard chain + guard-abort
split-retry + `recordClientVerdict` + classification-at-owner plumbing + reaper · wire fields +
`Connect`/`ConnectAck` + `MutationBatch` · `OutboxStorage` seam + IDB adapter + per-tab
clientId/seq + write-behind + park-requires-durable + enqueue-behind-queue · S4 park swap
(feature-detected) · registry + precedence rule + drop-on-verdict-after-baseline · leader drain +
identity gate + triage + coded/codeless + overflow-reject-new · R9 accessors + durable refire +
dev-mode loud default · docs (taxonomy, boundaries, external-executor coexistence, idempotency
pass-through) · the flagship E2E pair: same app, offline-queue → reload → reconnect → exactly-once
drain on (a) single-binary SQLite and (b) Postgres + fleet + 8 shards, plus kill-after-commit
resend, mid-drain leader kill, and the four-axis benchmark.

| Deferred | Receiving seam | Honest cost |
|---|---|---|
| Client-supplied ids (R4 full) | ids-in-`args`; id-codec spec of its own (forgery, table validation, tableNumber delivery — NOT via ConnectAck caching) | Offline cross-mutation create-then-edit impossible in v1; composite intents are the documented idiom; the interaction cliff (args from rendered pending rows) stands until it ships — the follow-on's stated motivation (DX §5) |
| Subscription resume token (R6) | additive `Connect` field | Reconnect re-sends full results — "fine at today's scale" still holds; drains multiply reconnects, so re-measure after launch |
| Background Sync SW drain | drain-trigger seam | No drain-after-tab-close off a visit; Chromium-only enhancement |
| Cross-tab live optimistic render | registry + shared store | Another tab's pending writes appear as accessor status, not rendered rows |
| Node/Bun fs outbox adapter | `OutboxStorage` | Non-browser clients keep memory-only queues |
| Persisted query baseline | **none — declared a non-goal, not a deferral** | Offline-after-reload rendering stays app-effort (§(d)); fixing it is the client-replica product, a different bet the field's most-scarred team (Zero) declined |

Nothing in the deferred column reopens the record family, the wire, or the reconcile algorithm.

## (j) The uniqueness claim, assessed honestly

The claim that survives, with its qualifiers welded on: **the first durable, bounded-offline
intent outbox with exactly-once effects over a server-authoritative reactive-query backend that is
deploy-anywhere and write-sharded** — and, uniquely after this verdict, one whose dedup records
double as an order-agnostic idempotency surface for external queue layers. Qualifiers that are part
of the sentence, not footnotes: bounded offline (days, platform-limited), browser durability
best-effort (e4 Part 2), offline-after-reload rendering app-assisted (no client replica). Every
neighbor concedes a leg (E5 R11's grid stands: Lunora CF-locked; Zero ships no offline writes;
Electric no write path; PowerSync replica-bound; Convex in-memory-only). AC11.2's pair E2E is the
proof no neighbor can run. Lunora remains the pacing competitor (AC11.3); if it ships GA first the
sentence changes, not the requirements.

## (k) Open questions the implementation spec must fix

1. **`MutationBatch` response shape** (per-unit `MutationResponse`s vs one batched frame) and chunk
   size vs the backpressure caps (AC10.3 measurement decides).
2. **Guard interface fork**: sync (SQLite) vs async (Postgres) `setCommitGuard` signatures, and the
   chain/dispatcher shape both stores share; the typed `CommitGuardRejection` + committer
   split-retry loop's bound.
3. **Floor-advance semantics with seq gaps** (skipped client-side entries leave holes): exact rule
   for `pruned_through_seq` over absent records; the `STALE_CLIENT` boundary test matrix.
4. **Classification plumbing depth**: the `SyncUdfExecutor.runMutation` dedup option's exact shape,
   and the fleet-forward meta threading (B3's channel, extended) — spike before estimating.
5. **Drain-after-baseline enforcement point** (first Transition applied vs resync completion) and
   the drop-on-verdict rule's exact reconcile event.
6. **Registry typing** via codegen (`api`-keyed map) and the hydrate-time miss policy log level.
7. **`identityFingerprint` definition** (token hash vs resolved identity string) and its relation
   to `SetAuth` replay ordering.
8. **IDB schema/versioning** for the outbox database (separate DB from any future cache — Lunora's
   VersionError lesson, `.reference/lunora` persistence notes) and the write-behind flush batching.
9. **Record value-cache lifetime** (clear early vs hold to TTL — values serve live-session resends
   only, promises don't survive reloads).
10. **Online-send record write** cost check: live sends with an empty queue also carry seqs and
    write guard receipts — confirm the guard write is negligible on the hot path (benchmark axis
    (a)/(b) covers it; if not, a "receipt only when parked-risk" optimization exists but
    complicates the invariant — decide with numbers).

**Bottom line:** ship B's per-seq verdict records repaired with a floor, on A's per-tab client
identity, inside C's wire-and-skeleton — order-agnostic dedup for the concurrent online path and
external retriers, client-FIFO for the drain, skip-and-record poison via a standalone verdict
write, cross-reload layers dropped on verdict-after-baseline rather than a gate that provably
never fires — and pay up front for the four repairs the critiques proved the shipped tree demands:
the guard chain, the batch-collateral fix, owner-side classification, and batched drains. The
watermark was the field's consensus and the corpus's favorite; the shipped code — fire-and-forget
frames, lagging replicas, a single guard slot, and a session version that resubscribes never
advance — is why it loses here.
