# `@stackbase/scheduler` — Durable Scheduler Component — design

**Status:** approved (brainstorming) — 2025-06-22
**Slice:** build-order #5 ("Actions + scheduled functions/crons"), **scheduler half**. The action *execution* runtime is a sibling slice; this slice builds the durable scheduler + crons and schedules **mutations + internal functions**. Actions light up for free once the sibling lands.
**Predecessor context:** The component system (`defineComponent`/`composeComponents`) gives a component namespaced tables (`scheduler/…`), module functions (`scheduler:fn`), a `ctx.scheduler` context facade, `requires`, and a **one-time `boot` hook** — but **no recurring/runtime-level driver seam** (this slice adds it). The engine has **range-precise reactive invalidation** (shipped in the effectivePermissions + dashboard slices) — a write only re-runs subscriptions whose read-set its range intersects. The runtime already injects a testable clock (`now?: () => number`). The `action` function type exists but the inline executor throws on it (`"M5 scope"`) — hence actions are out of this slice. Convex API compatibility ("paste-and-run") is a locked project principle.

**Backing research (read for detail):** `components/scheduler/docs/features.md` (the full capability catalog + priority matrix) and `components/scheduler/docs/architecture-notes.md` (the source-dive mechanisms, with `.reference/scheduling-research/*` citations). This spec is the buildable subset.

---

## 1. Goal

A **durable, scalable, Convex-compatible** scheduler component: one-off delayed execution + recurring crons, with a robust runner that survives crashes, retries failures, never double-runs a job, and stays contention-free under load — driven by our own reactive engine (no polling). Convex DX on top; a modern DB-adapter-backed engine beneath; the primitives `@stackbase/workflow` will need pre-wired.

**Success is measured by:** a real Convex `crons.ts` + a mutation calling `ctx.scheduler.runAfter/runAt/cancel` runs on Stackbase **with no code change** (modulo the `_generated` import path); jobs survive a mid-flight crash and resume; 1000 simultaneously-enqueued jobs run bounded-concurrently without OCC-contention collapse.

---

## 2. Locked decisions (from brainstorming)

1. **A component, not core** — `@stackbase/scheduler`, **shipped in the default project template** so `ctx.scheduler` is always present (Convex-parity DX) while staying a swappable component. `@stackbase/workflow` is a **separate later component** that will `requires: ["scheduler"]`.
2. **This slice schedules mutations + internal functions only.** Scheduling an *action* needs the action runtime (sibling slice); once it exists, the driver runs actions with zero scheduler changes.
3. **Event-driven driver, not a polling heartbeat** — reactive invalidation on the dispatch index + an earliest-`nextTs` timer; a slow safety sweep only backstops lease reclaim.
4. **Convex API parity is a hard acceptance criterion**, not a nicety.
5. **Absorb the source-dive net-new patterns** (§ below): contention-free bookkeeping, infra-kill lease reclaim, dual-job crons, catch-up policy, cascading cancel, args spill, `onComplete`/`context`, app-version pinning, honest delivery contract.
6. **Deferred:** full flow-control beyond a concurrency cap (throttle/rate-limit/debounce/priority) → Phase 2; durable multi-step `workflow` → later slice (primitives baked in now); action execution → sibling; `rate-limiter`/`action-cache` remain separate components.

---

## 3. The new engine seam: the recurring **driver** hook

Today a component contributes a **one-time** `boot`. This slice adds a **recurring, runtime-level driver** — the generic parallel to `boot`, the one genuinely-new engine primitive.

- `defineComponent` gains an optional `driver?: (ctx: DriverContext) => void` (or a returned `Driver` object). Called once after boot, it sets up its own wakeups; it is **not** a fixed-interval tick.
- `DriverContext` (provided by the runtime, privileged/namespaced) exposes exactly what a driver needs and nothing more:
  - `runFunction(path, args, opts): Promise<Result>` — invoke a registered function outside a request (this slice: mutations/internal; actions later).
  - `onCommit(rangePredicate, cb)` — wake `cb` when a committed write-set intersects a range (reuses the range-precise fan-out the sync tier already uses). This is the **reactive** wake.
  - `setTimer(atMs, cb)` / `clearTimer` — the **timer** wake for future `nextTs`.
  - `db` — a privileged reader/writer in the component's namespace (for the loop's claim/complete transactions).
  - `now()` — the injected testable clock.
- The runtime owns the driver lifecycle (start after boot, stop on shutdown). The scheduler component owns all *semantics*; the engine stays scheduler-agnostic (this seam is reusable — future TTL sweeps, the action retrier, etc.).

> The driver is **not** a client subscription. It taps the same commit fan-out + a timer. The scheduler's *logic* lives in the component; the engine provides only the generic wake primitives.

---

## 4. Data model (`scheduler/*` tables)

All namespaced `scheduler/…`; all inspectable **for free** by the live data browser we shipped.

- **`jobs`** — the dispatch row, kept narrow:
  `{ _id, fnPath, kind: "mutation"|"action", state, nextTs, attempts, maxFailures, lease: {holder, expiresAt} | null, idempotencyKey | null, appVersion, name | null, hasArgs: bool, onComplete: fnPath | null, completedTs | null }`
  - `state ∈ pending | inProgress | success | failed | canceled`.
  - Indexes: **`by_next_ts [state, nextTs]`** (dispatch — pending, ascending due time), **`by_completed_ts [completedTs]`** (retention/GC), **`by_idempotency [idempotencyKey]`** (dedup, partial: non-null only).
- **`job_args`** — `{ jobId, args, context }` — payloads spilled off the dispatch row (narrow index rows; large args + the opaque `context` blob live here). Loaded only when a job actually runs.
- **`crons`** — the cadence registry: `{ _id, name (unique), spec (cron/interval), tz, catchUp, lastScheduledTs, workFnPath, workArgs, cadenceJobId }` (dual-job: this cadence entry drives a separate work `jobs` row).
- **`signals`** — append-only loop inbox: `{ segment, kind: "enqueue"|"complete"|"cancel", jobId, ... }` bucketed by a time `segment` so enqueue/complete/cancel writers never conflict with each other or the loop (the contention-free pattern, §7).

---

## 5. Public API

### 5.1 Convex-parity surface (client-facing, must paste-and-run)
```ts
// inside a mutation (transactional enqueue) — signature-identical to Convex
const id = await ctx.scheduler.runAfter(delayMs, fnRef, args);   // → jobId
await ctx.scheduler.runAt(timestampMs | Date, fnRef, args);      // → jobId
await ctx.scheduler.cancel(id);                                  // idempotent
```
`ctx.scheduler` is the scheduler component's context facade. `runAfter`/`runAt` write a `pending` `jobs` row (+ `job_args`) **inside the calling mutation's OCC transaction** → transactional enqueue (roll back the mutation → the job un-schedules) for free. `fnRef` is a typed `api.*`/`internal.*` reference (codegen).

### 5.2 Cron surface (declarative `crons.ts`, must paste-and-run)
```ts
import { cronJobs } from "./_generated/server";
const crons = cronJobs();
crons.interval("cleanup", { minutes: 5 }, internal.maintenance.purge, {});
crons.cron("nightly", "0 3 * * *", internal.reports.build, {}, { tz: "America/New_York" });
crons.daily("digest", { hourUTC: 8, minuteUTC: 0 }, internal.email.digest, {});
// hourly / weekly / monthly as Convex defines them
export default crons;
```
Codegen must expose `cronJobs()` (and `internal.*` refs) so the file resolves unchanged. `tz` (IANA, via `cron-parser`) and `catchUp` are **Stackbase extensions** — additive, absent on Convex, so parity holds.

### 5.3 Extension primitives (NOT client-facing — for `workflow` later)
An internal enqueue surface the `workflow` component will consume; baked in now so it drops on cleanly:
```ts
scheduler.enqueue(fnRef, args, {
  runAfter? | runAt?, retry?, name?,
  onComplete?: mutationRef,     // called with { jobId, context, result: {kind, value?|error?} }
  context?: JSONValue,          // opaque blob round-tripped verbatim (workflow stores {workflowId, generationNumber})
});
```
`onComplete` **must be a mutation** (so "record result + re-advance" commits atomically). `context` is stored in `job_args` and passed back untouched. `runAfter: 0` must be cheap + deduped (fires every workflow step boundary).

---

## 6. The driver algorithm

A **single-owner loop** (Convex/workpool pattern), woken reactively + by timer, never contending on shared state:

1. **Wake** — `onCommit` fires when a mutation writes a `pending` row into the `by_next_ts` range (an enqueue), OR the earliest-`nextTs` timer fires, OR the safety sweep ticks.
2. **Single owner** — one loop iteration at a time, guarded by a `generation` value on a loop-state singleton the loop exclusively owns; a second wake while running is coalesced (a `saturated`/`kicked` flag makes redundant wakes O(1) no-ops).
3. **Claim** — read due `pending` jobs (`state=pending AND nextTs<=now`) via a **snapshot read** (no OCC read-dependency, so concurrent enqueues can't force a retry), up to a **batch cap (~64)** and a **concurrency cap (~8 in-flight)**. Claim each by transitioning `pending→inProgress` (actions) / staging the run (mutations) with a **lease** `{holder, expiresAt}`; the transition re-reads + exact-matches the row (Tier-0 OCC double-exec guard; Tier-2 = `SELECT … FOR UPDATE SKIP LOCKED` + CAS at the Postgres adapter).
4. **Run** — `runFunction(fnPath, args)` outside the loop transaction; on return, write a **`complete` signal** (append-only, no contention) with the result.
5. **Complete** — the loop drains `complete` signals: set terminal state (`success`/`failed`), null `nextTs`, set `completedTs`, release lease, fire `onComplete` (if any) as a scheduled mutation. On failure with attempts left → reschedule with backoff (§8).
6. **Re-arm** — set the timer to the new earliest `pending.nextTs`; park (zero idle cost).

Idle cost ≈ 0 (parked on a timer). Dispatch latency ≈ 0 for due-now enqueues (reactive wake).

---

## 7. Contention-free bookkeeping (the scalability core)

Under single-writer OCC, naive shared counters melt under load. Adopt workpool's architecture wholesale:
- The loop-state singleton is written **only** by the loop (generation-guarded).
- `enqueue`/`complete`/`cancel` write **append-only `signals`** bucketed by time `segment` → writers never conflict.
- The loop reads signals via **snapshot query** (no read-dependency); takes a real dependency only on the "confirm empty → park" path (which is also its reactive wake).
- Any hot counter (the in-flight concurrency count) uses **Power-of-Two-Choices sharding** (rate-limiter pattern) if it would otherwise be a hotspot.
- Args + `context` **spill to `job_args`** so dispatch-index rows stay narrow.

---

## 8. Reliability & delivery semantics

- **Delivery contract (honest, documented):** scheduled **mutation = exactly-once-ish** (the `pending→terminal` transition rides the same OCC txn as its work); scheduled **action = at-most-once** (`inProgress` committed *before* execution; a crash mid-action → `failed`, never re-run). (Actions execute in the sibling slice; the state machine is built for them now.)
- **Retries/backoff:** on a **system/infra** failure, reschedule `nextTs = now + initialBackoffMs · base^(attempts+1)` (`initialBackoffMs=250, base=2`) with 50–100% jitter, up to `maxFailures` (default 4) → terminal **`failed`** (dead-letter: inspectable + manually replayable). A **mutation OCC/throughput conflict** retries within the invocation (not counted as a failure). A **user error** fails per the function's own semantics.
- **Infra-kill lease reclaim:** a job left `inProgress` with an **expired lease** (worker OOM/crash) is reclaimed by the safety sweep → rescheduled (mutation) or failed (action, at-most-once). This is mid-flight recovery, beyond boot recovery.
- **Cascading cancel:** canceling a job cancels jobs it (transitively) scheduled that are still `pending`; a child enqueued under a canceled parent is born `canceled`.
- **App-version pinning:** a job records the `appVersion` that enqueued it; a rolling deploy does not run a job on a mismatched code version (protects in-flight work + future workflow replay). Behavior on mismatch (wait vs re-home) is a plan detail; the field is reserved now.

---

## 9. Crons

- **`cron-parser`** (6-field) with **IANA `tz`** (beats Convex core's UTC-only).
- **Dual-job decoupling:** each cron = a cadence entry (`crons` row + its `cadenceJobId`) that reschedules itself + spawns a separate work `jobs` row per fire → a slow/failing work job never drifts the clock.
- **Clock-anchored next-run:** compute the next occurrence from `lastScheduledTs` (the cadence anchor), not `now()` → no drift.
- **Catch-up policy** (`catchUp: "skip" | "fireOnce" | "fireAll"`, default `skip`): on downtime, skip missed occurrences (default; log a `SkippingPastScheduledRuns`-style entry), fire once, or fire all. Convex silently skips; we make it explicit.
- **Deterministic occurrence identity** `{cronName}:{scheduledTs}` + insert-or-noop → N instances race to exactly one fire.

---

## 10. Multi-instance & clock

- **Tier 0 (single node):** the single-writer OCC transactor serializes claims; the loop-state generation guard ensures one driver.
- **Tier 2 (Postgres, future):** claim via `SELECT … FOR UPDATE SKIP LOCKED ORDER BY nextTs` + CAS `pending→inProgress`; deterministic cron IDs dedupe fires across instances. The `DatabaseAdapter` owns the DB client, so this is an adapter-level addition, not engine leakage.
- **Testable clock:** the driver's `now()` is the runtime's injected clock; tests advance it deterministically (no real sleeps), asserting jobs fire at the right virtual time.

---

## 11. Observability

`scheduler/jobs` (+ `job_args`, `crons`) are ordinary tables → the **live data browser inspects scheduled/running/failed jobs for free** (state, attempts, nextTs, lastError). The status model (`pending/inProgress/success/failed/canceled`) + `completedTs` retention index support listing recent + in-flight jobs. Rich dashboard affordances (manual retry/cancel/replay buttons) are incremental follow-ups, not this slice.

---

## 12. Testing

- **Convex-parity acceptance (headline):** a verbatim Convex-style `crons.ts` + a mutation calling `ctx.scheduler.runAfter/runAt/cancel` compiles and runs; jobs fire; parity holds (only the `_generated` import path differs).
- **Transactional enqueue:** enqueue inside a mutation that then throws → the job is NOT scheduled (rolled back).
- **Driver dispatch:** an enqueued due-now job runs **without polling** (reactive wake); a future job runs when the virtual clock reaches `nextTs` (timer); assert dispatch latency ≈ 0 in virtual time.
- **State machine + double-exec:** a claimed job never runs twice; concurrent claims (two loop iterations / two instances via a simulated adapter) don't double-run.
- **Retries/backoff + dead-letter:** a failing job retries with backoff up to `maxFailures` → terminal `failed`; a mutation OCC conflict retries without counting as failure.
- **Infra-kill reclaim:** a job left `inProgress` with an expired lease is reclaimed by the sweep.
- **Crons:** interval + cron + timezone fire at the right virtual times; **clock-anchored** (a slow work job doesn't drift the schedule); catch-up `skip`/`fireOnce` behave per policy; deterministic occurrence dedup.
- **Cascading cancel:** cancel a parent → its pending children are canceled.
- **Contention:** 1000 simultaneous enqueues run bounded-concurrently; the loop does not livelock/retry-storm (assert the signal tables + snapshot reads keep enqueue O(1) and the loop progressing).
- **Workflow-readiness:** `enqueue` with `onComplete` + `context` round-trips the opaque `context` verbatim and calls `onComplete` (mutation) with `{jobId, context, result}`; `runAfter:0` re-enqueue is cheap.
- **E2E through the shipped server:** a scheduled mutation fires end-to-end via `stackbase dev` (the "test through the shipped entrypoint" lesson).
- **Regression:** component/runtime/sync/dashboard suites green; boot + existing subscriptions unaffected.

---

## 13. File structure

**New**
- `components/scheduler/` — the component: `src/schema.ts` (`jobs`/`job_args`/`crons`/`signals`), `src/scheduler.ts` (`ctx.scheduler` facade: `runAfter/runAt/cancel` + internal `enqueue`), `src/driver.ts` (the loop: claim/run/complete/re-arm, contention-free bookkeeping), `src/crons.ts` (`cronJobs()` registry, `cron-parser`, dual-job/catch-up), `src/index.ts` (`defineComponent({ name:"scheduler", schema, context, driver, … })`), `test/*`.
- `.reference`-derived design already in `components/scheduler/docs/{features.md, architecture-notes.md}`.

**Modify**
- `packages/component/src/define-component.ts` + `compose.ts` — add the `driver?` seam + `Driver`/`DriverContext` types.
- `packages/runtime-embedded/src/runtime.ts` — driver lifecycle (start after boot / stop on shutdown), wire `DriverContext` (`runFunction`, `onCommit` off the commit fan-out, `setTimer`, `db`, `now`).
- `packages/codegen/*` — expose `cronJobs()` + `internal.*` refs so `crons.ts` resolves unchanged.
- default project template — include `@stackbase/scheduler` so `ctx.scheduler` is present out of the box.
- `CLAUDE.md` — note the scheduler component + the new driver seam once shipped.

---

## 14. Out of scope (later slices / components)

- **Action execution** (run `action` outside the txn, network) — sibling slice; the scheduler runs actions unchanged once it lands.
- **Durable multi-step `workflow`** — later component (`requires: ["scheduler"]`); this slice pre-wires `onComplete`/`context`/`runAfter:0`.
- **Full flow-control** — per-key concurrency, throttle, rate-limit, debounce, batch, priority, virtual queues, fairness (features.md §4) → Phase 2. This slice ships only a global concurrency cap.
- **Event-driven triggers / signals / `waitForEvent`** (features.md §6) → with workflow.
- **`rate-limiter` / `action-cache`** — stay separate general-purpose components (the scheduler borrows rate-limiter's sharding *pattern*, not the component).
- **Tier-2 distributed driver election / partitioning** — the Postgres `SKIP LOCKED` claim is specified; leader election + partitioned timer wheels are a Tier-2 slice.
