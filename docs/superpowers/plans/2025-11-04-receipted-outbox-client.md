# Receipted Outbox Plan B — The Client Outbox

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Offline-created mutations survive reload and crash in IndexedDB, drain FIFO on reconnect through Plan A's receipts (exactly-once by construction), with the registry rebuilding optimistic layers, poison-proof progress, multi-tab safety, observability — proven by the flagship offline→reload→reconnect→exactly-once E2E pair on both SQLite and the sharded fleet, plus the four-axis benchmark.

**Architecture:** Spec = `docs/superpowers/specs/2025-11-04-receipted-outbox-design.md` (post-review 3850b31) — the §(k) decisions 5-9 are Plan B's; AUTHORITY = `docs/dev/research/offline-outbox/verdict.md` §(d) (the client architecture VERBATIM: persistence, identity, enqueue, S4 swap, reload/rendering, drain, observability) + §(g) (the sixteen hazards, each pinned where testable). Plan A is MERGED (a52b7dc): the wire (Mutation{clientId,seq}, MutationBatch per-unit frames, Connect/ConnectAck{known, results, deploymentId}), owner classification (replayed/valueMissing/STALE_CLIENT/coded failures), stop-on-transient chunks (the remainder gets NO responses — the drain re-sends), receipts with values.

**Tech Stack:** TypeScript (packages/client + a react surface); fake-indexeddb for units; real-server E2Es; Web Locks + BroadcastChannel (feature-probed).

## Global Constraints

- The verdict §(d) rules VERBATIM: one clientId per tab-session (minted at construction, persisted); seqs serial in-memory, monotone, hydrated entries drain under their RECORDED (clientId, seq); **the send never waits for the append** (write-behind); **park eligibility requires durability** (an inflight entry whose append hasn't committed rejects `MutationUndeliveredError` as today); **no layer crosses a session** (unchanged); **the S4 park swap arms ONLY after a ConnectAck proves dedup** (old server = today's fail-fast, byte-for-byte); **while the queue is non-empty new mutations enqueue behind it** (direct-send only when empty); drain = Web Locks leader (`stackbase:outbox:<origin>:<deployment>`), FIFO by the persisted `order` column, ONE unacked `MutationBatch` chunk (50) in flight; overflow (1000) **rejects the NEW enqueue** coded; `retry()` = a FRESH seq, never reuse; `navigator.onLine` never consulted (wake = enqueue, reconnect-after-baseline, interval nudge); poison default skip-and-record with `poisonPolicy: "pause"` option; coded verdicts = terminal, codeless = backoff-retry; encodability triage at enqueue (terminal-fail before occupying a seq); identity gate at flush (`OFFLINE_IDENTITY_CHANGED` terminal, fingerprint = SHA-256 of the SetAuth token, computed+cached at SetAuth, stamped synchronously).
- The spec's decisions 5-9: **the drain awaits baseline adoption (a NEW await** — resync is fire-and-forget today, client.ts:338-342); cross-session `applied` verdicts drop layers immediately post-baseline (`onVerdictAfterBaseline` as an S3 reconcile event; `versionCoversCommit` byte-identical); registry `optimisticUpdates: Partial<Record<UdfPathOf<Api>, Fn>>` (codegen union; hydrate-only; call-site wins live; miss = one warn); IDB = ONE database `stackbase-outbox`, store `entries` keyed `[clientId, seq]` + `order`/`status` indexes, `meta` keyed BY clientId {nextSeq, deployment}, `outboxVersion` stamp (mismatch = drop-with-verdict at hydrate); write-behind flushes per microtask batch.
- `known: false` → `onClientReset`: fresh clientId; `unsent` re-enqueue (never applied — safe); parked entries reject LOUDLY. `valueMissing` tolerated everywhere (the crash window). The E4 hazards each get their pinned test where testable (the plan's tasks name them).
- Honest boundaries (docs verbatim): offline-after-reload RENDERING is app-effort (the pending-tray recipe + optional undefined-tolerant updaters); Safari 7-day + eviction honesty (`navigator.storage.persist()` requested, advisory only); bounded offline.
- No-config byte-identity: a client without `outbox` config = memory default = today's behavior exactly (ALL existing suites green unmodified). Node/vitest; full gate; trailer:
  `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>` + `Claude-Session: https://claude.ai/code/session_015RKShEWjRcmbQVJ8ooUPP6`

**Verified ground truth:** Plan A's wire + handler semantics (see its E2E, packages/cli/test/outbox-server-e2e.test.ts — the raw shapes to consume); the shipped client: S1 mutation-log.ts (PendingMutation + seed persist-worthy; touched/update reconstruct), S4 delivery-policy.ts (the close rules to swap), S3 reconcile.ts (`versionCoversCommit` untouched; the one-pass discipline), client.ts (mutation() sync at :163-194; requestId per-instance counter :168; the reopen sequence :327-344 — SetAuth → resync() FIRE-AND-FORGET → flush; the transport queue cleared at close when reconnecting), react.tsx hooks, the loopback + real-WS test harnesses (gated-ledger.test.ts, optimistic-e2e.test.ts patterns). The client has NO storage API anywhere (the seam is genuinely first). fake-indexeddb is the unit-level IDB (add as a devDep; probe-and-fallback covers Node runtime = memory).

**DAG:** T1 → T2 → T3 → T4 → T5 → T6 → T7 (serial — all center on packages/client; reviews may overlap the next dispatch).

---

### Task 1: The `OutboxStorage` seam + IDB adapter + identity

**Files:** Create `packages/client/src/outbox-storage.ts` (the seam: `OutboxStorage` interface — append/updateStatus/dequeue/loadAll/meta get+set; `memoryOutbox()` default; `indexedDBOutbox()` probe-and-fallback), `packages/client/src/outbox-idb.ts` (the schema per the constraints; write-behind microtask batching; `navigator.storage.persist()` fire-and-forget). Client construction: `outbox?: OutboxStorage` config; clientId minted-or-loaded from meta; nextSeq loaded, then in-memory serial. Tests: fake-indexeddb (schema, [clientId,seq] keys, order/status indexes, meta-per-clientId, outboxVersion stamp + hydrate-drop-with-verdict, write-behind batching (N appends → ≤ per-microtask txns), probe-fallback, persist() requested advisory-only (hazard 3)); co-eviction structure (one DB — hazard 1 pinned structurally).
- [ ] **Steps 1–5:** TDD → implement → client suite + existing unmodified → full gate → commit `feat(client): the OutboxStorage seam — IDB adapter, per-tab identity, write-behind`.

---

### Task 2: Enqueue + park (the S4 swap)

**Files:** Modify mutation-log.ts (entries gain clientId/seq/order/identityFingerprint/enqueuedAt; the Mutation wire message carries clientId+seq when the outbox is armed), client.ts (enqueue-behind-non-empty-queue vs direct-send-when-empty — BOTH carry (clientId, seq) for park-safety; write-behind append, the send NEVER awaiting it; overflow-rejects-new (1000, coded); encodability triage at enqueue; the fingerprint cache at setAuth), delivery-policy.ts (the park swap: at close, `inflight`-with-durable-append → `parked` (layer drops — unchanged rule); non-durable → `MutationUndeliveredError` as today; ARMED only post-ConnectAck (a capability flag T3 sets — until then today's behavior byte-for-byte)). Tests: park-requires-durability (a stalled append at close rejects; a committed one parks); enqueue-behind-queue FIFO across the boundary; overflow rejects the NEW with the old intact; direct-send carries the pair; no-outbox-config = byte-identical (spy: no appends, no pair on the wire).
- [ ] **Steps 1–5:** TDD → implement → client + sync suites → full gate → commit `feat(client): durable enqueue + the ConnectAck-armed park swap`.

---

### Task 3: The handshake + drop-on-verdict-after-baseline + onClientReset

**Files:** Modify client.ts (on reopen with an armed outbox: send `Connect{clientId, held, ackedThrough}`; process `ConnectAck` — the capability flag arms the park swap; verdict results settle held entries (applied → resolve-equivalents + the drop rule; failed → coded terminal; stale → STALE_CLIENT terminal; unknown → remain for the drain); **the NEW baseline await** — the drain (T4) and the drop rule fire only after the first post-Connect Transition adopts), reconcile.ts (+`onVerdictAfterBaseline(entry)` — a cross-session `applied` verdict drops its layer in the same one-pass discipline; `versionCoversCommit` untouched — assert byte-identical), the reset path (`known:false` → fresh clientId + meta rewrite; unsent re-enqueued under NEW seqs; parked reject loudly; `onClientReset` callback). Tests: the handshake shapes; each verdict settlement; the baseline await ordering (no drain frame before adoption — spy); the drop rule's no-flicker (frames collected); reset semantics; deploymentId surfaced (hazard 15's client half).
- [ ] **Steps 1–5:** TDD → implement → client suite → full gate → commit `feat(client): the Connect handshake, verdict settlement, baseline-gated drop rule`.

---

### Task 4: The drain

**Files:** Create `packages/client/src/outbox-drain.ts` (the Web Locks leader — probe, fallback single-tab; hydrate → FIFO by order → `MutationBatch` chunks (50) → ONE unacked chunk; per-unit resolution: applied/replayed → settle+dequeue (+the drop rule via T3); coded failure → terminal settle (poison skip-and-record — the SERVER recorded; the client settles + continues; `poisonPolicy: "pause"` halts the drain + surfaces); codeless → backoff (computeBackoff-mirror) + re-send from the failed unit; the TRANSIENT-STOP chunk contract: units after a stopped unit got NO responses → they remain queued and re-send next chunk (Plan A's semantics — verify against its E2E); identity gate per entry at flush; wake on enqueue/reconnect-after-baseline/interval nudge (never navigator.onLine — hazard 13); mid-drain lock loss → stop cleanly (records make the successor safe — hazard 7)), client.ts wiring. Tests: FIFO across hydrate; chunking + one-unacked; every per-unit outcome; poison continue vs pause; transient-stop re-send; the identity gate; leader handoff (locks faked); retry()=fresh-seq.
- [ ] **Steps 1–5:** TDD → implement → client suite → full gate → commit `feat(client): the outbox drain — leader, chunks, verdict settlement, poison policy`.

---

### Task 5: The registry + R9 accessors

**Files:** Modify client construction (`optimisticUpdates` registry — hydrate-only, call-site-wins-live, one-warn-per-miss; hydrated entries rebuild layers over the post-baseline base via the normal recompose (the seed persists — identical placeholders)), create the accessors (`client.pendingMutations()`; `usePendingMutations()` reactive over the durable store with a BroadcastChannel nudge (probe-fallback); `onMutationFailed` refiring from durable records on resume; failed entries persist until dismissed/`retry()`; the dev-mode loud `console.error` default for unhandled terminals; queue age/size advisory (hazard 2's client half)), codegen (`UdfPathOf` union emission). Tests: registry precedence + miss-warn + hydrated-layer determinism (same placeholders across reload — the seed); accessors reactive incl. cross-tab nudge (BroadcastChannel faked); the refire semantics (hadAwaiter-style — no double-fire for promise-settled failures); dev-loud default; the pending-tray recipe compiles (a docs fixture).
- [ ] **Steps 1–5:** TDD → implement → client + codegen suites → full gate → commit `feat(client): the updater registry + pending-mutation observability`.

---

### Task 6: The flagship E2E pair + the benchmark

**Files:** `packages/cli/test/outbox-e2e.test.ts` (+ the four-axis benchmark additions to the harness)

- [ ] **Step 1:** THE FLAGSHIP PAIR (the same app both substrates): offline-queue (armed client, transport killed) → K mutations enqueued durably → **reload** (a NEW client instance over the same fake-IDB/persisted state — the real-browser reload analog; document the fidelity boundary) → reconnect → Connect/ConnectAck → baseline → drain → **exactly-once** (rows exactly K, receipts exactly K, in order; the registry rebuilt layers pre-drain-visible) — on (a) the single-binary/SQLite dev server and (b) Postgres + fleet + 8 shards (the Docker harness; a resend mid-drain via the fleet path). Plus: kill-after-commit THROUGH THE REAL CLIENT (the server dies post-commit pre-response; the client parks; reconnect → replay-ack settles, no double); mid-drain leader kill (a second client takes the lock and completes — records absorb the overlap); multi-tab (two clients, separate clientIds, one leader drains both queues' entries under recorded ids — hazard 6/7); STALE_CLIENT surfaced through onMutationFailed; old-server compat (Plan-A-less server sim → no ConnectAck → fail-fast byte-compat).
- [ ] **Step 2:** The four-axis benchmark (§(h)): (a) online p50/p99 delta adapter-on-vs-off (target ~0); (b) online concurrent throughput adapter-on; (c) 500-drain time-to-empty + longest main-thread block (target seconds, riding MutationBatch); (d) IDB txns/mutation. Numbers recorded in docs/dev/research/offline-outbox/benchmark.md. Green ×2; full monorepo gate.
- [ ] Commit `test(cli): the Receipted Outbox flagship E2E pair + the four-axis benchmark`.

---

### Task 7: Docs + finish

**Files:** `docs/enduser/offline.md` (the spec's Docs section verbatim: the model, the conflict taxonomy AC8.1, the boundaries (reload rendering app-effort + the pending-tray recipe, Safari/eviction honesty, bounded offline), poisonPolicy, external-executor coexistence + the `{ idempotency }` pass-through, onClientReset), CLAUDE.md what-works (durable offline sync SHIPPED), the deferred table (§(i)) recorded as the follow-on queue, the memory-file update cue for the controller.
- [ ] Docs → full gate → commit `docs(client): durable offline sync guide — the Receipted Outbox`.

## Execution notes

- Serial DAG (all in packages/client). Models: T1 sonnet, T2 sonnet, T3 opus (the baseline-gated drop rule is the reconciliation-critical piece), T4 opus (the drain's state machine), T5 sonnet, T6 opus (the flagship), T7 sonnet. The soul constraint: no-outbox-config byte-identity — existing suites green unmodified, always.
