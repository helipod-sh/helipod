# Scheduler — Architecture Notes (from source dives)

Grounded in reading the **actual source** of Convex's engine (Rust), `@convex-dev/{workpool,workflow,crons,action-retrier,action-cache,rate-limiter}`, and `dbos-transact-ts`. Full notes: `.reference/scheduling-research/{convex-engine,workpool,workflow,small-components,dbos}-source.md`. This is the "how it really works" companion to `features.md`.

## 0. The big validation

**Convex's production scheduler driver IS the reactive+timer design we chose — and it runs on the exact mechanism we just shipped for the dashboard.** From the Convex Rust engine: the executor holds a **subscription on the `by_next_ts` index range**; any enqueue writes into that range → **range-precise invalidation wakes the driver immediately** (no polling); for future jobs a **timer fires at the earliest `next_ts`**. That is our range-precise reactive invalidation, applied to a jobs table. We are structurally positioned to build this *natively* — most systems fake it with LISTEN/NOTIFY or polling.

## 1. Job state machine (Convex, adopt)

`Pending → (InProgress) → Success | Failed | Canceled`.

- **Mutations skip `InProgress`** — the state transition is staged inside the mutation's own OCC transaction and commits atomically with its work. Exactly-once-ish for scheduled mutations.
- **Actions go through `InProgress`, committed BEFORE execution** → **at-most-once** (a crash mid-action leaves it `Failed`, never re-run). This is the correct, honest contract for external side effects; document it.
- Terminal states null the dispatch key (`next_ts`) and set `completed_ts` → two indexes: `by_next_ts` (dispatch) + `by_completed_ts` (GC/retention).
- **Double-execution guard (Tier 0):** before running, re-read + exact-match the full job row inside the claiming transaction; the single-writer OCC serializes claims. **Tier 2 (Postgres):** `SELECT … FOR UPDATE SKIP LOCKED` + a CAS `status: enqueued→running` (DBOS).

## 2. The scalability core: never contend on the driver's bookkeeping (Workpool, critical)

The #1 lesson: an unbounded scheduler runs 1000 jobs at once → OCC contention, third-party stampedes. Bound parallelism (Convex cap = 8–10). But the **concurrency counter must never be a shared-row hotspot**. Workpool's pattern (adopt wholesale):

- **Single-owner loop.** One driver `main` loop at a time, guarded by a `generation` number; it exclusively owns the loop-state singleton doc. No other writer touches it.
- **Append-only signal tables.** `enqueue` / `complete` / `cancel` write to *separate* append-only tables bucketed by a time `segment` — writers never conflict with each other or the loop.
- **Snapshot reads.** The loop reads those signal tables via a snapshot query (no OCC read-dependency), so concurrent enqueues can't force it to retry; it takes a real read-dependency only on the "confirm empty → park" path (which is also what wakes it).
- **`saturated` flag** in loop status → `enqueue` skips kicking the loop when at capacity (O(1) hot path).
- **Batch cap** (≤64/iteration) bounds transaction wall-time under backlog.
- **Payload spill:** args > ~8KB go to a side table; dispatch-index rows stay narrow (Convex uses a separate `_scheduled_job_args` table for the same reason).

## 3. Reliability patterns

- **Retry/backoff (action-retrier):** `initialBackoffMs=250, base=2, maxFailures=4`, delay `= initialBackoffMs · base^(failures+1)` with 50–100% jitter. Convex engine: system errors reschedule 500ms→2hr exp backoff; **mutation OCC/throughput conflicts retry indefinitely within the invocation**; user JS errors fail permanently (no retry).
- **Infra-kill detection (action-retrier, NET-NEW):** a job marked `running` whose worker OOMs/restarts never calls `finish`. Detect via a **lease/heartbeat**: the running job carries a lease; a recovery sweep reclaims jobs whose lease expired. (Convex polls `_scheduled_functions` ~10s for this.) Our `features.md §7` said "recovery on restart" — this adds mid-flight lease reclaim, not just boot recovery.
- **Dead-letter:** after `maxFailures`, terminal `Failed` (DBOS: `MAX_RECOVERY_ATTEMPTS_EXCEEDED`), inspectable + manually replayable.

## 4. Crons (crons component, refines features.md §1)

- **`cron-parser` (6-field, IANA timezone)** → we support real timezones (Convex core is UTC-only — we beat it).
- **Dual-job decoupling (NET-NEW):** each cron = a *cadence* job (reschedules itself) + a separate *work* job. A slow/failing work job never drifts the schedule clock.
- **Clock-anchored next-run:** compute next occurrence from the cadence job's `scheduledTime`, **not `Date.now()`** → no drift.
- **Explicit catch-up policy (NET-NEW; others punt):** on downtime, choose `skip` (default, Convex's implicit behavior) | `fire-once` | `fire-all`. Convex silently skips + emits a `SkippingPastScheduledRuns` log per skipped batch — we make it configurable.
- **Deterministic cron occurrence IDs** `{name}:{scheduledTime}` + insert-or-noop → N instances race to exactly one fire (DBOS `ON CONFLICT DO NOTHING`).

## 5. Primitives the SCHEDULER must expose for `workflow` later (workflow source — do NOT preclude)

A workflow advances by **one scheduler enqueue per step boundary** (`runAfter(0, …)`); sleeps = enqueue-at-future-time; `generationNumber` guards staleness. So our scheduler API must include, from day one:

- `enqueue(fnRef, args, { runAfter? | runAt?, onComplete?, context?, name?, retry? })` for **mutation / action / query** targets.
- **`onComplete` callback contract:** a *mutation* receiving `{ workId, context, result: { kind: "success"|"failed"|"canceled", … } }` — must be a mutation so "record result + re-advance" is atomic.
- **`context` opaque passthrough:** the scheduler round-trips a caller blob (workflow stores `{ workflowId, generationNumber }`) without interpreting it.
- **`cancel(id)`** callable inside a mutation; **cascading cancel** (children enqueued under a canceled parent are born canceled — Convex).
- **`runAfter: 0` must be cheap** (fires every step boundary) and idempotent/deduped.

We build scheduler-only now, but these are load-bearing for the later `workflow` slice — bake them in.

## 6. DB-backed durable patterns (DBOS — for the Postgres adapter + later workflow)

- **Same-transaction step recording:** run the effect + write its checkpoint in ONE transaction → crash rolls back both atomically (our OCC gives this natively for mutations).
- **`deduplication_id` unique partial index** on `(queue, dedup_id) WHERE dedup_id IS NOT NULL` → idempotent enqueue.
- **`SELECT … FOR UPDATE SKIP LOCKED ORDER BY priority, created_at`** dequeue + CAS transition — the Tier-2 multi-instance claim.
- **`application_version`-pinned dispatch (NET-NEW):** a rolling deploy can't run a job on mismatched code (protects in-flight work + future workflow replay).
- **`function_id` incremented before any `await`** → deterministic step position without a lock (for workflow).

## 7. Net-new features to fold into `features.md`

1. Infra-kill **lease/heartbeat** reclaim (mid-flight, not just boot). §3/§7.
2. **Append-only-signal + single-owner-loop + snapshot-read** contention-avoidance architecture. §7.
3. **Power-of-Two-Choices sharding** for any hot counter (rate-limiter). §4/§7.
4. **Dual-job cron decoupling** + **clock-anchored next-run**. §1.
5. **Explicit catch-up policy** (skip/fire-once/fire-all) — don't punt. §1.
6. **Cascading cancel**. §2/§8.
7. **Separate args/payload table** (narrow dispatch rows). §7.
8. **`onComplete` + opaque `context` passthrough** — required for workflow. §5.
9. **`application_version`-pinned dispatch** — deploy safety. §7.
10. **Action = at-most-once (InProgress-before-execute); mutation = exactly-once-ish** — the honest delivery contract. §2.

## 8. Explicit non-goals (reconfirmed)

CRIU process-checkpoint (Trigger.dev) — infra-bound, out. Separate orchestrator/broker — durable state lives in our adapter (DBOS model). action-**cache** is a *separate* component (read-through cache), not a scheduler concern — don't conflate with idempotency. rate-**limiter** stays a general-purpose component; the scheduler *uses* its sharded-counter pattern for concurrency but doesn't absorb it.
