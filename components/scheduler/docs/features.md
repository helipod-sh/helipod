# Scheduler — Industry-Standard Feature Catalog (North Star)

**Purpose:** the complete capability surface a *modern, robust* scheduling + durable-execution system should cover, distilled from Convex (scheduler + crons + `@convex-dev/workflow`), Trigger.dev v3/v4, Inngest, and DBOS. This is the **reference of what "done right" looks like** — not a scope commitment. Each slice picks a subset from here; the design must never *preclude* the rest.

Research sources: `.reference/scheduling-research/{convex,trigger-dev,inngest,dbos}.md`.

## The two components (layers)

| Component | Layers | Unit of work |
|---|---|---|
| **`@helipod/scheduler`** (this catalog's ①–④, ⑥–⑨) | one-off scheduling · crons · durable job runner · flow control | **one function invocation** per job, durable + retried |
| **`@helipod/workflow`** (§5, later slice) | multi-step step-journaling durable execution | **many steps**, resumes mid-run; built on `requires: ["scheduler"]` |

**Our structural advantage (design around it):** we own the OCC transaction and a reactive engine. Transactional enqueue, same-transaction step recording (exactly-once DB writes), and *event-driven* (poll-free) dispatch are things every other system fakes on a DB they don't control — for us they're native. The scheduler should be **reactive-driven**, not a polling daemon.

---

## §1. Scheduling primitives

- **One-off delayed** — `runAfter(delayMs, fn, args)`; `runAt(timestampMs, fn, args)`. Imperative, called from inside a mutation/action.
- **Recurring (cron)** — cron expressions (`"0 3 * * *"`), plus ergonomic helpers: `interval(ms)`, `hourly/daily/weekly/monthly`. Declarative registry.
- **Timezone-aware crons** — schedules resolved against a named IANA timezone, DST-correct (not just UTC).
- **Cancellation** — cancel a pending scheduled job by id; cancel a cron occurrence.
- **Reschedule / update** — change the due time or args of a pending job.
- **Structured schedule payload** — a cron/scheduled run receives `{ scheduledTime, lastRun, nextRun, timezone, jobId }`, not a bare call (Trigger.dev) — critical for reasoning about missed/late runs.
- **Catch-up policy** — on downtime, choose: fire every missed occurrence, fire once, or skip to next (missed-run behavior must be explicit).

## §2. Correctness guarantees

- **Transactional enqueue** — scheduling inside a mutation is atomic with the mutation's writes: roll back the mutation → the job un-schedules. (Native for us: the job row is written in the same OCC txn.)
- **Idempotency keys** — a caller-supplied key dedupes duplicate enqueues; a second enqueue with the same key returns the existing job (optionally with TTL on the cached result — Trigger.dev).
- **Deterministic job IDs for crons** — compound key `{cronName}:{scheduledTime}` so N racing instances insert-or-noop; exactly one occurrence fires (DBOS). No distributed lock.
- **Delivery semantics, stated explicitly** — at-least-once by default for side effects; **exactly-once for DB writes** when the effect is a mutation (the write + the job-completion mark commit in one transaction — DBOS's key trick).

## §3. Execution & reliability

- **Retries with backoff** — configurable max attempts, exponential backoff, jitter, backoff ceiling.
- **Layered retry config** — defaults at definition, overridable at enqueue time, overridable per-attempt (Trigger.dev).
- **Timeouts / max duration** — per-job wall-clock limit; timed-out job is failed/retried.
- **Dead-letter** — after max attempts, move to a failed/dead state (inspectable, manually replayable) rather than silent drop.
- **Lifecycle hooks** — `onSuccess` / `onFailure` / `onComplete(result|error)`.
- **Failure isolation** — one job's failure never blocks the runner or other jobs.
- **Poison-pill protection** — a repeatedly-crashing job is quarantined, not retried forever hot.

## §4. Concurrency & flow control  *(Inngest is the reference here)*

- **Concurrency limits** — cap simultaneously-running jobs, globally and **per dynamic key** (`concurrencyKey: job => job.userId`) → per-tenant isolation without pre-registered queues (Trigger.dev/Inngest).
- **Throttle** — smooth execution to N/interval, **enqueuing** excess (preserve work).
- **Rate limit** — hard cap at N/interval, **discarding** excess. (Throttle ≠ rate-limit; both must exist as distinct primitives.)
- **Debounce** — collapse a burst to one run, **with a `timeout` floor** so continuous load still fires (Inngest).
- **Batching** — coalesce many enqueues into one batched invocation (size + max-wait).
- **Priority** — higher-priority jobs dispatch first.
- **Virtual queues / partitioning** — a key expression creates isolated lanes; fairness across tenants (no noisy-neighbor starvation).

## §5. Durable multi-step workflows  *(`@helipod/workflow`, later slice — cataloged for completeness)*

- **Steps with journaling** — `step.run(id, fn)` executes once, result persisted; on resume the body re-runs top-down but completed steps return cached results (Convex/Inngest/DBOS memoize-replay; **not** CRIU process-checkpoint — that's Linux-infra-only and out for us).
- **Determinism model** — code *between* steps must be deterministic; all side effects live inside steps. Documented constraint.
- **`step.sleep(id, duration)` / `sleepUntil`** — park for seconds…months at **zero resource cost** (the continuation is a scheduled job).
- **`step.waitForEvent` / `waitForSignal(name, timeout)`** — park until an external event/signal, with timeout fallback (human-in-the-loop).
- **Sub-workflows** — `invoke` / `triggerAndWait` / `batchTriggerAndWait` child workflows.
- **Generation guard** — a `generationNumber` bumped on restart; stale in-flight callbacks abort on mismatch (Convex) — no distributed locks.
- **Saga / compensation** *(advanced)* — run compensating steps on failure (rollback external effects).
- **Versioning** — in-flight workflows pinned to their code version so a deploy doesn't corrupt replay.

## §6. Event-driven triggers

- **Event → function** — functions subscribe to named events; publishing an event fans out to all matching handlers.
- **`sendEvent` / signals** — publish an event; wake any workflow parked on `waitForEvent`.
- **Fan-out** — one event triggers many jobs; one job schedules many children.
- **Cancel-on-event** — `cancelOn` with a match expression cancels in-flight runs when a business event invalidates them (Inngest).

## §7. Scalability, efficiency & latency  *(explicit user priority — design here first)*

- **Event-driven dispatch, not busy-polling** — an enqueued due-now job wakes the driver **immediately** (in-process signal / our reactive invalidation), and for future jobs the driver sleeps a **timer set to the earliest `dueAt`** — not a fixed poll interval. Near-zero dispatch latency, near-zero idle cost.
- **Reactive-driven driver (our native edge)** — the driver holds a subscription to "pending jobs due ≤ now"; a mutation enqueuing a job writes into that read range → range-precise invalidation wakes the driver with no poll. Time-advance (a future job becoming due) is handled by the earliest-`dueAt` timer. Hybrid = poll-free + latency-free.
- **Multi-instance-safe claiming** — no two workers run the same job: atomic lease/claim (`status: pending→running` guarded by attempt/lease), via our single-writer OCC transactor (Tier 0) and `SELECT … FOR UPDATE SKIP LOCKED`-class semantics through the Postgres adapter (Tier 2 / DBOS).
- **Horizontal scale** — many workers share one durable job table; batch-claim to amortize; work partitioned by key/hash for throughput and fairness.
- **Leader / driver election** *(Tier 2)* — one driver (or partitioned drivers) owns the timer wheel; failover on leader loss.
- **Recovery on restart** — on boot, requeue jobs left `running` by a crashed worker (lease-expiry based); no job lost, none stuck.
- **Backpressure** — bounded in-flight; enqueue stays cheap; the runner pulls at capacity.
- **Efficient indexing** — `(status, dueAt)` index for O(log n) "next due" lookup; no full scans (the dashboard data-browser's `scanCapped` lesson applies).

## §8. Observability & operations

- **Job status model** — `pending → running → succeeded | failed | retrying | cancelled | dead`.
- **History & inspection** — list/query scheduled, in-flight, and completed jobs; per-job attempts, timing, error, result.
- **Per-job / per-step logs** — surfaced in the dashboard (reuses the exec-log sink + the admin sync channel we just shipped).
- **Metrics** — queue depth, dispatch latency, throughput, failure rate, retry counts.
- **Manual ops** — retry / cancel / reschedule / replay a job from the dashboard.
- **Alerting hooks** — on dead-letter / sustained failure.

## §9. Developer experience

- **Typed function references + typed args** — `runAfter(ms, api.email.send, { … })` fully type-checked (codegen).
- **Runs in `helipod dev`** — local, no external broker; the heartbeat/driver is in-process at Tier 0.
- **Testable time** — inject/advance a clock in tests; deterministic scheduling tests (no real sleeps).
- **Cron definition versioning/migration** — changing a cron file safely reconciles registered occurrences.
- **Clear error surfaces** — CLI/SDK messages for bad schedules, non-existent function refs, non-serializable args.

---

## §10. Layer / priority matrix

| Feature area | Component | Priority |
|---|---|---|
| One-off `runAfter`/`runAt` (§1) + transactional enqueue (§2) | scheduler | **MVP** |
| Crons + timezone + catch-up (§1) | scheduler | **MVP** |
| Durable job runner: retries/backoff/timeout/dead-letter/hooks (§3) | scheduler | **MVP** |
| Event-driven + reactive-driven dispatch, multi-instance claiming, recovery (§7) | scheduler | **MVP** (core promise: scalable, latency-free) |
| Idempotency keys, deterministic cron IDs (§2) | scheduler | **MVP** |
| Status model + dashboard inspection (§8) | scheduler | **MVP-ish** (basic status now; rich dashboard incremental) |
| Concurrency + flow control: throttle/rate-limit/debounce/batch/priority/virtual-queues (§4) | scheduler | **Phase 2** |
| Event triggers / signals / fan-out / cancelOn (§6) | scheduler/workflow | **Phase 2** |
| Durable multi-step workflows: steps/journal/sleep/waitForEvent/sub-workflows/generation-guard (§5) | **workflow** | **Later slice** |
| Saga/compensation, versioning, leader election (§5, §7) | workflow / Tier-2 | **Later** |

## §11. Explicit non-goals

- **CRIU / process-checkpoint durability** (Trigger.dev) — Linux-only, privileged-container infra; incompatible with cross-platform single-binary self-hosting. We use journal-replay.
- **A separate orchestrator service / external broker (Kafka/Temporal cluster)** — the durable state lives in *our* DB via the adapter (the DBOS model), not a side-car.
- **Guaranteeing determinism of arbitrary user side effects** — the journal model requires steps to be the effect boundary; we document the constraint, we don't magically remove it.
