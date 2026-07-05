# `@helipod/workflow` — Feature Catalog

*What a durable-workflow component should do, drawn from a source-dive of Convex's `@convex-dev/workflow`, DBOS Transact, Cloudflare Workflows (via Lunora), and the market (Temporal, Restate, Inngest, Trigger.dev). Research in `.reference/workflow-research/*` + `.reference/scheduling-research/{workflow-source,dbos-source}.md`. This is the pre-design catalog — the buildable subset is decided in the spec.*

## What this component is

A **durable, multi-step orchestration layer** on top of `@helipod/scheduler`. A workflow is an ordinary async function whose progress **survives crashes, restarts, and redeploys**: each step's result is persisted, so a 20-step order-fulfillment flow that dies at step 14 resumes at step 14, never re-running steps 1–13's side effects. It is the Convex-parity capstone that makes the scheduler + actions investment compound — the thing you reach for when "schedule one function" isn't enough and you need *a sequence with memory*.

**The one concept to get right (the whole component rests on it): durable execution via deterministic replay.** The workflow handler is re-run from the top on every advance. Each `step.*()` call consults a persisted **journal**: if this step already completed, it returns the recorded value *without re-executing*; if it's new, it's dispatched (via the scheduler) and the handler suspends. So the function replays deterministically, and the journal is the source of truth for "where are we." Get the journal + replay + the OCC advance-guard right and everything else follows. (See `architecture-notes.md` for why the **replay** model — not DBOS's checkpoint model — is the right fit for Helipod's OCC/deterministic core.)

---

## 1. Core durable execution (MUST)

| # | Feature | Notes / prior art |
|---|---|---|
| 1.1 | **Durable step journal** — every completed step's `{name, kind, args, result}` persisted; replay returns memoized results | Convex `steps` table; DBOS `operation_outputs`. Journal row is the unit of durability. |
| 1.2 | **Deterministic replay advance** — handler re-runs top-to-top on each poll; completed steps short-circuit from the journal; the first incomplete step dispatches then suspends | Convex `StepExecutor.run` (`step.ts:84-112`). No separate scanner — advance is scheduler-`onComplete`-driven. |
| 1.3 | **Crash/restart resumption** — an interrupted workflow resumes from its last journaled step with no lost or double-executed steps | DBOS recovery (`system_database.ts`); Convex re-poll. |
| 1.4 | **OCC advance guard (generationNumber)** — a monotonic guard prevents double-advance / concurrent polls / stale writers after cancel-restart | Convex `generationNumber` (`workflow.ts`); lock-free, stale writers self-discard. |
| 1.5 | **Transactional step enqueue** — a step's journal row + its dispatch commit in one transaction (rides the scheduler's transactional enqueue) | Reuses `@helipod/scheduler`'s in-txn enqueue. |
| 1.6 | **Exactly-once mutation steps / at-most-once action steps** — inherits the scheduler's delivery contract per step kind | Helipod gets mutation-exactly-once *free* from the OCC transactor — no journal-write trick (unlike DBOS's datasource abstraction). |

## 2. Step primitives — the authoring surface (MUST unless noted)

| # | Feature | Notes |
|---|---|---|
| 2.1 | `step.runMutation(ref, args)` → result | A mutation step; deterministic, transactional. |
| 2.2 | `step.runQuery(ref, args)` → result | A query step (read a consistent snapshot into the journal). |
| 2.3 | `step.runAction(ref, args)` → result | An action step — external side effects. **Unlocked by the just-shipped action runtime (`807ec7b`)**; the research's "one real gap" is now closed. |
| 2.4 | `step.sleep(ms)` / `step.sleepUntil(ts)` | Durable timer — a delayed no-op step; zero cost while parked. Convex `step.sleep` (`workflowContext.ts:174-186`). |
| 2.5 | Per-step retry/backoff options `{ maxAttempts, initialBackoffMs, base }` | Reuses the scheduler's retry/backoff. Action steps especially. |
| 2.6 | `step.runAfter/runAt` (delayed step dispatch) | Reuses scheduler `runAfter`/`runAt`. |
| 2.7 | Step name/args validation on replay (journal-mismatch detection) | Convex throws `"Journal entry mismatch"` — the entire determinism-violation surface. (SHOULD) |

## 3. Control flow — the "best in market" additions (SHOULD / COULD)

| # | Feature | Priority | Notes |
|---|---|---|---|
| 3.1 | **`step.waitForEvent(name, timeout?)` + `ctx.sendEvent(runId, name, payload)`** — durable pause until an external signal | **SHOULD (top gap)** | The single highest-leverage feature NO Convex-workflow/DBOS has; CF/Temporal/Restate/Inngest/Trigger all do. Enables human-in-the-loop approvals, webhook callbacks, cross-workflow coordination. Buildable on our commit-fan-out wake: park a run on a waitpoint row, resolve via a mutation the driver wakes for. |
| 3.2 | **Fan-out / fan-in — parallel steps with a bounded join** (`Promise.all`-style over `step.*`) | **SHOULD** | Convex/DBOS leave this to manual orchestration. Our journal makes `await Promise.all([step.a(), step.b()])` natural — each branch is an independent journaled step; the handler suspends until all are journaled. Bounded parallelism knob. |
| 3.3 | **Saga / compensation** — declarative rollback handler per step, run in reverse on failure | **COULD (differentiator)** | Lunora/CF's two-tier model is *more* complete than Temporal/Restate's manual try/catch. Natural fit for order/payment flows. Candidate for a v1.1 once core replay ships. |
| 3.4 | Sub-workflows / child workflows (`step.runWorkflow(ref, args)`) | COULD | A workflow as a step of another. `requires`-style composition. |
| 3.5 | Continue-as-new | WON'T (v1) | Convex-style replay has no unbounded event-history to bound (unlike Temporal), so the pressure this relieves mostly doesn't exist here. Revisit only if journal size becomes a real limit. |

## 4. Lifecycle & management (MUST core, SHOULD rest)

| # | Feature | Notes |
|---|---|---|
| 4.1 | `workflow.start(ref, args) → runId` (kickoff) | Convex `workflow.start`. |
| 4.2 | `workflow.status(runId)` → `{ state, result?, error? }` — reactive-queryable | Because workflow state lives in tables, a `useQuery` on status is **live** for free (our reactive tier). A real DX edge. |
| 4.3 | `workflow.cancel(runId)` — bumps generationNumber, cancels in-flight steps (cascading via scheduler) | Convex `cancel` (`workflow.ts:348-362`); reuses scheduler cascading cancel. |
| 4.4 | Workflow-level `onComplete(result)` callback | Reuses the scheduler's `onComplete`/`context` round-trip (the primitive built *for* this). |
| 4.5 | `workflow.restart(runId)` | Convex `restart`; SHOULD. |
| 4.6 | `onCompleteFailures` handling — a failed onComplete is itself durable/retried | Convex `onCompleteFailures` table; SHOULD. |
| 4.7 | Cleanup/GC of completed workflow journals (a reaper) | Mirrors the scheduler's tracked jobs-reaper follow-up; SHOULD. |

## 5. Determinism & safety (MUST)

| # | Feature | Notes |
|---|---|---|
| 5.1 | **Deterministic handler contract** — the workflow body may call only `step.*`/`ctx.*`; no direct DB, network, `Date`, `Math.random` | The body is deterministic glue; side effects live in the steps (which the body dispatches). Mirrors the query/mutation determinism discipline. |
| 5.2 | Frozen/seeded environment inside the handler (`Date`/`Math.random` shimmed from the runId) | Convex environment shims (`environment.ts`). Our executor already has seeded RNG + fixed clock per run — reuse. |
| 5.3 | Zero cross-poll JS state — anything not journaled vanishes between advances (mechanical, not a rule) | The strongest guarantee: state you didn't persist can't survive, so it can't cause subtle replay bugs. |

## 6. Observability (SHOULD / COULD)

| # | Feature | Notes |
|---|---|---|
| 6.1 | Step timeline / journal inspection (per run: steps, states, timings, errors) | Feeds the dashboard. The journal *is* the trace. |
| 6.2 | Live workflow status in the dashboard | Reuses the admin sync subscription (dashboard is live). |
| 6.3 | Replay-debugging (re-run a workflow against its journal) | Temporal's best-in-class feature; COULD, later. |

---

## Priority matrix (for the buildable-subset decision)

- **MUST (v1 core):** §1 all; §2.1–2.6; §4.1–4.4; §5 all. This is "Convex-workflow parity on the Helipod engine" — durable multi-step (mutation/query/action steps), sleep, retries, start/status/cancel/onComplete, deterministic replay with OCC guard.
- **SHOULD (v1 if scope allows, else fast-follow):** §2.7 journal-mismatch validation; §3.1 `waitForEvent` (the top market gap); §3.2 fan-out/fan-in; §4.5–4.7; §6.1–6.2.
- **COULD (v1.1+):** §3.3 saga/compensation (differentiator); §3.4 sub-workflows; §6.3 replay-debugging.
- **WON'T (v1):** §3.5 continue-as-new; Temporal-style in-place versioning of in-flight workflows (drain-on-old-version is what most of the field does); the full Inngest throttle/rate-limit/batch matrix (a single concurrency-by-key knob covers the 80%).

## Non-goals (explicitly out of scope)

- **In-place versioning/migration of long-running in-flight workflows** (Temporal `GetVersion`/patching). Bloat at Helipod's scale; in-flight instances drain on their original code version.
- **The full throttle / rate-limit / batch / CEL-keyed virtual-queue matrix** (Inngest). Queue-ops sophistication for high-volume multi-tenant SaaS; one concurrency-limit-by-key knob is the lean 80%.
- **A separate workflow runtime/interpreter** — the workflow runs on the *same* executor as queries/mutations (deterministic replay reuses the OCC discipline). No CRIU/process-snapshot (Trigger.dev), no DO-per-instance (CF/Lunora).
- **Its own scheduler** — the workflow layer touches *only* `@helipod/scheduler`'s public surface (`requires: ["scheduler"]`); it never re-implements dispatch, retries, or timers.
