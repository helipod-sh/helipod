# The Receipted Outbox — Durable Offline Sync

**Status:** approved design (brainstormed 2025-11-04; user delegated design calls)
**Design authority:** `docs/dev/research/offline-outbox/verdict.md` (ed9abfd) — sections (b)-(j)
are the requirements text VERBATIM (the record family, the governing invariant, the server
contract, the client architecture, the wire table, the E5/E4 answers, the deferral table). This
spec: scopes it into one slice with two phases, and FIXES the verdict's §(k) open questions 1-10.
Where this spec and the verdict differ, the verdict governs; deviations need a documented decision.

## Goal

Offline-created mutations survive reload and crash, drain exactly-once-in-effect on reconnect
(per-seq verdict receipts written atomically with the commit; a per-client floor converts
"forgotten" into loud `STALE_CLIENT`, never re-execution), in order, with poison-proof progress,
multi-tab safety by construction, and observability — over the server-authoritative, deploy-
anywhere, fleet-sharded engine no competitor can follow onto (verdict §(j), qualifiers welded on).

## Scope: one slice, two phases

**Phase 1 (server + wire, independently valuable):** the two tables + floor + guard chain +
SQLite guard + the batch-collateral fix (A LIVE SHIPPED BUG under group-commit + B3) +
`recordClientVerdict` + classification-at-owner + the reaper + all wire changes. Ships alone as a
working increment: external retriers get the idempotency surface; the live bug dies.
**Phase 2 (client):** the `OutboxStorage` seam + IDB + identity + park/drain + registry +
drop-on-verdict + R9 accessors (incl. **the dev-mode loud `console.error` default for terminal
failures with no registered handler** — explicit per spec-review) + docs + the flagship E2E pair
+ the four-axis benchmark.
**Execution shape (spec-review): TWO PLANS, cut at the phase gate** — 11 tasks + a hard internal
gate exceeds the demonstrated ~8-task envelope, and phase 1 ships alone by design. Plan A =
server + wire (this spec's phase 1); Plan B = client (phase 2), written after Plan A merges.

## The §(k) open questions — FIXED (the spec's added value; all else is the verdict by reference)

1. **MutationBatch responses = per-unit `MutationResponse` frames** (reuse the shipped shape,
   undroppable path, and client handling verbatim — no new frame parser); server applies entries
   sequentially, emitting each unit's response as it settles. Chunk size default **50**,
   re-measured at the AC10.3 benchmark against the backpressure caps.
2. **Guard interface:** the single-slot `setCommitGuard` becomes **`addCommitGuard(guard):
   () => void`** (composition: registration order, any throw aborts the txn) on BOTH stores; the
   shared type is `(q, units: CommitGuardUnit[], shardId) => void | Promise<void>` — SQLite runs
   guards synchronously inside its one-transaction commit (a returned Promise there is a
   documented error → dev-throw); Postgres awaits. **THE MIGRATION IS NOT MECHANICAL
   (spec-review catch — phase 1 would otherwise REGRESS FLEET): `armWriter` re-arms on EVERY
   promotion (node.ts:1475/1609/1643); with append semantics each promotion would stack a
   duplicate epoch-fence guard → duplicate fleet_idempotency INSERTs at the same ts →
   self-PK-collision → every forwarded commit aborts.** Fleet must capture the returned
   unregister handle and call it before re-adding (or register exactly once at first arm).
   **The typed `CommitGuardRejection`** carries `{unitIndex, code, detail}`; the group committer
   catches it, rejects ONLY that unit, and re-flushes the remainder (store rolled back = nothing
   landed = re-flush safe; ts re-assign fresh — they were allocated inside the rolled-back txn),
   bounded at **3 split-retries** then rejects the chunk retryably. **The conversion cascades
   (spec-review): the existing fleet idempotency guard must THROW the typed rejection (it knows
   the unit index it loops at, node.ts:964-971), and http-handler.ts:83's raw-23505
   `isFleetIdempotencyConflict` detection migrates to the typed error — the T1 spike covers
   both.**
3. **Floor over gaps:** `pruned_through_seq` advances to the highest seq the prune COVERS
   (records deleted OR holes skipped); any presented `seq ≤ floor` without a record →
   `STALE_CLIENT` — including never-arrived holes (loud-over-silent per the §(b) invariant: a
   hole below the floor is indistinguishable from a pruned record, and re-execution is the one
   forbidden outcome). **`Connect.ackedThrough` = the highest CONTIGUOUS SETTLED-PREFIX seq per
   clientId (spec-review pin — structural under the FIFO one-unacked-chunk drain: a client can
   never ack past an unsettled seq, so prune can never race an in-flight resend).** The boundary
   test matrix: {record-hit, hole-below, exactly-floor, floor+1-miss (runs),
   fresh-client-no-floor (runs)}.
4. **Classification plumbing:** phase 1 opens with a SPIKE task (the plan's T1) shaping
   `SyncUdfExecutor.runMutation`'s dedup option + the fleet-forward meta extension against B3's
   channel — spike output = the exact signatures the later tasks implement.
5. **Drain-after-baseline enforcement point (spec-review-corrected): a NEW await** — today
   `resync()` is fire-and-forget and the unsent flush runs synchronously after it
   (client.ts:338-342); nothing awaits the baseline today. The drain gains an explicit await on
   baseline-Transition ADOPTION (the first post-Connect Transition applied through S3); the
   drop-on-verdict rule executes as an S3 reconcile event (`onVerdictAfterBaseline(entry)`) so
   the one-pass no-flicker discipline holds.
6. **Registry typing:** `optimisticUpdates: Partial<Record<UdfPathOf<Api>, OptimisticUpdateFn>>`
   via a codegen-emitted `UdfPathOf` union; hydrate-time miss → `console.warn` once per udfPath
   (the entry drains fine — only rendering is skipped).
7. **`identityFingerprint` = SHA-256 of the last SetAuth token string** (empty-string token →
   `"anon"`); no identity resolution dependency; the flush gate compares fingerprints, and the
   reopen ordering (SetAuth first) is already shipped. **Computation timing (spec-review):
   SubtleCrypto is async while enqueue is sync (client.ts:167-192) — the digest is computed and
   CACHED at SetAuth time; enqueue stamps the cached value synchronously.**
8. **IDB:** its own database `stackbase-outbox` (per origin; deployment discriminates via a
   keyed field, not separate DBs — Lunora's VersionError lesson says fewer DBs, stable version),
   schema v1, one object store `entries` keyed `[clientId, seq]` + indexes on `order` and
   `status`, plus a `meta` store **keyed BY clientId (spec-review fix — a single row breaks the
   same-origin multi-deployment case, e.g. the dashboard)** holding {nextSeq, deployment};
   write-behind flushes per microtask batch.
9. **Record value cache lifetime: hold to TTL** (values are ≤64KB, rows prune at 30d/ack anyway;
   early-clear complexity buys nothing measured).
10. **Online-send receipt cost: measured, not optimized** — benchmark axes (a)/(b) decide; the
    conditional "receipt only when park-risk" optimization is REJECTED unless the numbers demand
    it (it splits the §(b) invariant into two regimes).

## Binding constraints restated (the plan's Global Constraints inherit these)

- The wire table verbatim from verdict §(e) — all additive; absent `clientId/seq` = today's path
  bit-for-bit; `Connect` activates from the reserved no-op; **no `tableNumbers` on ConnectAck**;
  **PLUS `deploymentId` on ConnectAck (spec-review fix — verdict §(g) hazard 15 mandates the
  same-timeline proof; §(e)'s table omitted it — the §(g) requirement governs).**
- The §(d) client rules verbatim: per-tab clientId; seqs serial in-memory; write-behind append
  (the send NEVER waits); **park eligibility requires durability**; enqueue-behind-non-empty-
  queue; layers never cross a session; the S4 park swap arms ONLY after ConnectAck proves dedup;
  Web Locks leader = efficiency, records = safety; overflow rejects the NEW enqueue (default
  1000); retry() = fresh seq, never reuse; `navigator.onLine` never consulted.
- Poison: default skip-and-record; `poisonPolicy: "pause"` option; coded-vs-codeless retry split;
  encodability triage at enqueue.
- Retention: ack-prune + 30d TTL via the reaper seam; floors ≥ 1 year; `known:false` →
  `onClientReset`.
- The honest boundaries verbatim (§(d)/(i)): offline-after-reload RENDERING is app-effort
  (pending-tray recipe + optional undefined-tolerant updaters — documented, not magic); the
  persisted query baseline is a NON-GOAL; bounded offline (days, platform-limited).
- Tests: the flagship E2E pair (same app: offline-queue → reload → reconnect → exactly-once
  drain on (a) single-binary SQLite and (b) Postgres + fleet + 8 shards) + kill-after-commit
  resend + mid-drain leader kill + the four-axis benchmark (§(h)) + the STALE_CLIENT matrix +
  the E4 hazards each pinned where testable.
- No-adapter/no-flag byte-identity: a client without outbox config behaves exactly as today
  (memory default, fail-fast S4 until ConnectAck-armed anyway); a server speaking to an old
  client is bit-for-bit today's path.

## Error handling (verdict §(c)/(d)/(g) rows govern; the plan copies the tables)

## Docs

`docs/enduser/offline.md`: the model (queue → drain → receipts), the conflict taxonomy (AC8.1 —
succeed / no-op-by-own-logic / terminal; no merge, no CRDT), the boundaries (reload rendering,
Safari 7-day, eviction honesty), the pending-tray recipe, `poisonPolicy`, the external-executor
coexistence paragraph + the `{ idempotency: {clientId, seq} }` pass-through, `onClientReset`.
CLAUDE.md; the deferred table (§(i)) recorded verbatim as the follow-on queue.
