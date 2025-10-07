# Fleet B3 — Hybrid Nodes + Effectively-Once Forwarding

**Status:** approved design (brainstormed 2025-10-01)
**Protocol basis:** `docs/dev/research/write-sharding/verdict.md` §d (B3) + the B2b follow-up ledger
**Builds on:** B2b (main `6a1b13a`): multi-node shard distribution, multi-writer opt-in
(STACKBASE_FLEET_MULTI_WRITER), per-shard relinquish, rendezvous balancer, the derive-only
writer invalidation listener, forwarded typed errors + commitTs threading.

## Goal

Remove the two blockers between multi-writer and production defaults: (1) **hybrid nodes** —
writer nodes serve queries/subscriptions from their local file-backed replica at F while
committing to the primary, restoring slice-2's read-offload in multi-writer mode (today all
reads on all ≤N nodes hit the primary — the documented ops cliff); (2) **effectively-once
forwarding** — a transport failure after the owner committed no longer risks double-execution
on retry (documented at-least-once since B1). Plus the ledger's polish follow-ups.

## Non-goals

A single-shard fast path (**assessed, not built**: fleet's per-commit overhead is one UPDATE
inside an already-multi-statement commit transaction; non-fleet pays zero — there is nothing
hot to skip; recorded in the research notes) · replica-served reads on the SINGLE-writer
topology's writer (unchanged — it reads the primary as shipped; hybrid is a multi-writer
behavior) · cross-request read-consistency guarantees beyond the shipped model · result
replay for oversized mutation values (capped; flagged instead — below).

## Design

### D1. Hybrid nodes — the replica read path on multi-writer writers

**Architecture: a hybrid node is a sync node and a writer node glued at the top.** In
multi-writer mode, a writer-ish node KEEPS its replica + real ReplicaTailer running (B2b
stopped the tailer at promotion and compensated with the invalidateOnly listener — both that
stop and the promotion-handoff seed vanish: the tailer simply never stops), and adds the
writer half beside it:

- **Mutations:** the shipped `ShardedTransactor` over the PRIMARY (pool, per-shard guards,
  OCC) — byte-identical to B2b.
- **Queries/subscriptions:** a replica-backed read path. New seam:
  `ExecutorDeps.queryTransactor?: Transactor` — `run()` picks it for `fn.type === "query"`
  (mutations/actions unaffected). **Three spec-review requirements make this correct rather
  than corrupting:**
  1. **A SEPARATE query-path oracle, advanced ONLY by the tailer's post-apply sink** (the
     sync-node invariant that bounds query snapshotTs ≤ replica wm — today `snapshotTs =
     oracle.getLastCommittedTimestamp()` and the sync node's oracle is fed exclusively
     post-apply). The write transactor's oracle advances with its own primary commits as
     shipped; **own local commits must NEVER advance the query oracle** — if they share an
     oracle, a query snapshots ABOVE wm and reads holes. `runtime.observeTimestamp` (which
     today targets the single transactor) routes tailer-driven observations to the query
     oracle on hybrids; the fleet sink wiring is explicit in the plan.
  2. **QueryRuntime is selected by fn.type IN LOCKSTEP with the transactor** — the kernel's
     scans run through `kctx.queryRuntime` (kernel collect/paginate), which is set
     unconditionally today. Mutations MUST keep the primary-backed QueryRuntime (their
     `ctx.txn.get` point reads follow the transactor to the primary — a replica-backed
     QueryRuntime would give one mutation split-brain reads: scans from the lagging replica
     at a primary snapshotTs, point reads from the primary). Only queries get the
     replica-backed QueryRuntime. `ExecutorDeps.queryPath?: { transactor, queryRuntime }` —
     one seam, both selected together, impossible to wire halfway.
  3. **startTs seeding is per-store:** the write transactor seeds from the PRIMARY's
     maxTimestamp (as shipped); the query transactor seeds from the REPLICA's (its oracle
     then rides the tailer).
  The replica-backed transactor itself reuses the sync-node construction (SingleWriter over
  the SwitchableDocStore-wrapped replica — queries never commit).
- **Boot order (multi-writer writer-ish):** open/recover the replica + start the tailer
  (sync-node machinery) FIRST, then arm the writer half (pool/guards/balancer). Promotion
  sync→writer-ish no longer stops the tailer — it only ADDS the writer half. The
  invalidateOnly listener is superseded on hybrids (not started); the mode remains in the
  codebase for the shipped tests but production multi-writer uses the real tailer.
- **Invalidation:** the tailer's apply loop (foreign commits) + the local fan-out (own
  commits) — the same two sources a sync node + writer already have, now on one node.
  Own commits also arrive via the tailer later: idempotent double-invalidation, the
  already-accepted pattern.
- **Single-writer topology and non-fleet: UNCHANGED** (no replica on the single writer; sync
  nodes as shipped; dev/Tier-0 untouched). No new knob: hybrid IS multi-writer's behavior.

### D2. RYOW on a hybrid

- **Forwarded writes:** the shipped `waitFor` machinery — the node has a real tailer again,
  `forwarder.attachTailer` works as on any sync node.
- **Own local commits (new gate):** a locally-committed mutation's fan-out triggers
  subscription re-runs that read the REPLICA — which may not have applied the commit yet.
  **The core seam (spec-review edit):** the runtime's serial fan-out `drain()` gains an
  injected `beforeNotify?(commitTs): Promise<void>` hook (runtime stays fleet-ignorant);
  the hybrid node wires it to `tailer.waitFor(commitTs)`. It serializes the drain — bounded
  by one NOTIFY round-trip steady-state, and by the progress-aware wait when the replica
  lags (during which re-runs are queued, not stale). This removes the briefly-stale re-run
  rather than relying on client ts-gating to suppress it.
- The mutation RESPONSE itself (value + commitTs) is unchanged — only subscription re-run
  timing gates.

### D3. Effectively-once forwarding — the idempotency key

- **Opaque meta channel (core stays lease-ignorant):** `RunOptions.commitMeta?:
  Record<string, string>` → `RunInTransactionOptions.commitMeta` → `commitWrite(entries,
  indexUpdates, shardId, opts?: { meta? })` → the commit guard's signature gains the meta
  (`(q, commitTs, shardId, meta?)`). Core threads bytes it never interprets; the SQLite
  store ignores it (non-fleet pays nothing).
- **Fleet writes the row inside the commit txn:** when the meta carries `idempotencyKey`,
  the fleet guard INSERTs `fleet_idempotency(key TEXT PK, commit_ts BIGINT, value_json TEXT
  NULL, oversized BOOL DEFAULT false, created_at TIMESTAMPTZ)` in the same transaction as
  the commit — atomic by construction. (Value is recorded post-run by… no: the VALUE isn't
  known inside the commit txn — the handler knows it after run() returns. Resolution: the
  guard inserts `{key, commit_ts}` atomically; the handler UPDATEs `value_json` best-effort
  AFTER the run completes (a crash between commit and value-update leaves a row with
  commit_ts and NULL value — the replay then returns success + commitTs + `valueMissing:
  true`, which the forwarder surfaces as success-without-value; mutations' return values
  reaching clients are best-effort under this narrow double-crash window, while the WRITE
  itself is exactly-once — state this contract explicitly in docs.)
- **The forwarder mints ONE UUID per logical write** (created before the first attempt,
  reused across its retry); sent in the /_fleet/run body. The receiving handler: SELECT the
  key first — hit → replay `{commitTs, value|valueMissing}` WITHOUT executing; miss → run
  with the meta threaded. Value cap 64KB (larger → `oversized=true`, value NULL, replay
  returns success + commitTs + valueMissing).
- **The concurrent-duplicate race (spec-review edit — decides correctness):** two
  simultaneous retries can BOTH pass the SELECT-miss and BOTH execute the handler body. The
  durable WRITE stays exactly-once — the loser's `fleet_idempotency` INSERT (PK) blocks on
  the winner's uncommitted row and throws `unique_violation` when the winner commits, which
  aborts the loser's ENTIRE commit transaction (guard-inside-txn atomicity). The handler
  MUST catch that unique_violation, re-SELECT the key, and return the replay
  `{commitTs, value|valueMissing}` — NOT surface a generic error (per the shipped forward
  policy, a generic typed error is terminal and would turn the idempotent case into a 500).
  Contract, stated in docs: handler-body EXECUTION is at-least-once under concurrent retry;
  the durable write and its fan-out are exactly-once.
- **Signature ripple (spec-review edit, explicit):** `commitWrite` today has NO opts param —
  the change touches `DocStore.commitWrite` (docstore/types.ts), both store impls (SQLite
  ignores meta), `SingleWriterTransactor`/`ShardWriter.commit`,
  `RunInTransactionOptions.commitMeta`, `RunOptions.commitMeta`, and the guard signature
  `(q, commitTs, shardId, meta?)` (additive 4th param; B2a/B2b guard installers updated
  mechanically).
- **Sweep:** the balancer beat DELETEs rows older than 1h (any writer node; cheap indexed
  delete). Non-forwarded writes carry no meta and pay nothing.

### D4. Polish (ledger follow-ups)

- **Driver start/stop churn:** serialize `startDrivers`/`stopDriversOnly` through an
  in-process promise chain on the fleet node (last-writer-wins ordering — a stop issued
  after a start always lands after it).
- **Concurrent-boot count==N stall:** `setup()` creates all N `shard_leases` rows at DDL
  time; the tailer's count-gate satisfies immediately; concurrent multi-writer boots no
  longer stall. **(Spec-review edit — the seed MUST travel with the move:** setup's row
  INSERT uses the same `documentsTableExists` probe + `(SELECT COALESCE(MAX(ts),0) FROM
  documents)` seed that `tryAcquire`'s INSERT uses — fresh DB → 0 (correct, empty store),
  upgrade with existing data → MAX(ts) (correct). Creating rows at the DDL DEFAULT 0 would
  reintroduce the F1×N fake-ready hole on upgrades — the exact reason B2a-T4 moved creation
  to acquire-time; INSERT-time seeding is what makes the reversal safe, so it is a
  REQUIREMENT of the reversal, not an optimization.)
- **Stall UX audit:** the shipped health fields + pinning-shard warning stay; ADD the same
  operator warning shape for hybrid replica lag (tailer wm falling > ~5s behind F names the
  node's replica, not a shard).

## Error handling summary

| Failure | Behavior |
|---|---|
| Primary paused/unreachable (hybrid) | Reads/subscriptions keep serving from the replica; writes fail visibly (the offload proof) |
| Own-commit re-run before replica applies | Gated on wm ≥ commitTs (D2) — no stale re-run |
| Duplicate forward (retry after commit) | Replayed from fleet_idempotency — no re-execution |
| Crash between commit and value-record | Write exactly-once; replay returns success + commitTs + valueMissing (documented) |
| Idempotency row expired before a very-late retry | Re-execution possible after 1h — documented boundary (retries are seconds-scale) |
| Replica lags > ~5s | Operator warning naming the replica (D4) |

## Testing

- **Unit:** queryTransactor seam (queries read the replica store, mutations the primary —
  two stubs, assert routing by fn.type); hybrid RYOW gate (own commit → re-run waits for
  wm ≥ commitTs); meta threading (RunOptions→commitWrite→guard receives it; SQLite ignores);
  idempotency guard INSERT atomic with commit (PGlite: guard throwing aborts BOTH); replay
  path (hit → no execution — spy; valueMissing shapes; oversized cap); sweep; driver-churn
  serialization (interleaved start/stop storm resolves to the last call's state); setup-time
  rows born seeded (the F1-class regression re-check).
- **E2E ship gate** (extend fleet-e2e; existing scenarios byte-unmodified): multi-writer
  fleet: (1) **the writer-replica offload proof:** a live subscription served BY A WRITER
  NODE keeps updating from its replica while `docker pause` freezes the primary (reads flow;
  a concurrent write fails visibly; unpause → writes resume) — slice 2's proof, on a writer.
  **(Spec-review edit — the writer is on a self-exit countdown under pause:** unlike
  slice-2's sync node, a writer's LeaseMonitor probe hangs on a paused primary and exits
  after ~4 misses (~8s at the shipped 6s test TTL). The scenario MUST bound the pause window
  BELOW the probe-exhaustion budget — run this scenario at a longer TTL (default 15s →
  ~20s budget, pause ≤ ~10s) and assert the node did NOT exit during the pause;)
  (2) RYOW-on-hybrid: local commit + forwarded commit both immediately readable via the
  committing/forwarding node's own subscription; (3) **effectively-once:** force a duplicate
  forward (send the same idempotencyKey twice via a raw /_fleet/run POST) → exactly one row
  in the app table, second response replays the same commitTs; (4) concurrent multi-writer
  boot (two writers + sync booted together, no sequential staging) → converges, count-gate
  never wedges; (5) B2b's multi-writer scenario green unmodified.
- Full monorepo gate; single-writer + non-fleet byte-identity (suites unmodified).

## Docs

`docs/enduser/deploy/fleet.md`: hybrid reads under multi-writer (the ops cliff paragraph
REPLACED — writer nodes now serve reads from their replica; disk note), effectively-once
forwarding (+ the valueMissing/1h-TTL contracts); `write-sharding-research.md`: B3 shipped
(fast path assessed-not-built with the reasoning); B4 (group commit) next.
