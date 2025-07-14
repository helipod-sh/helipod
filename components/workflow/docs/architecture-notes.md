# `@stackbase/workflow` — Architecture Notes

*Source-dive mechanisms + the architectural decision, with citations. Companion to `features.md`. Research: `.reference/workflow-research/{convex-workflow,dbos-workflow,lunora-cloudflare-and-market}.md` and `.reference/scheduling-research/{workflow-source,dbos-source}.md`. Clean-room extraction — mechanisms paraphrased, never copied (`.reference` is FSL-licensed).*

---

## 0. The one decision: deterministic replay, not checkpoint

Three durable-execution models exist in the references:

| Model | How it works | Determinism cost | Exemplar |
|---|---|---|---|
| **Deterministic replay** | Re-run the handler top-to-top each advance; a persisted **journal** short-circuits completed steps | Body must be deterministic; the **syscall ABI makes non-determinism unwriteable** | Convex `@convex-dev/workflow` |
| **Checkpoint** | Re-invoke the handler; a monotonic **`function_id` counter** addresses each step's recorded output; short-circuit if present | Body's step *call order* must be stable; violations caught **reactively** at recovery, or silently wrong if step names coincide | DBOS Transact |
| **DO memoization** | Each instance is a Durable Object that memoizes step results by name; sleep/wait truly hibernate | Per-step memoization; DO is the isolation + persistence unit | Cloudflare Workflows / Lunora |

**Decision: build the deterministic-replay model.** The reasoning is not aesthetic — it's that Stackbase's engine *already is* a deterministic-replay machine:

1. **Exactly-once mutations come free.** DBOS builds an entire pluggable-datasource abstraction (per-ORM `transaction_completion` tables written into the user's schema — `dbos-workflow.md` §2, correcting the older extraction) to get step-level exactly-once. In Stackbase a mutation step already *is* one atomic OCC-committed unit — the journal row and the step's writes commit together in the scheduler's transactional enqueue. No trick needed.
2. **The determinism bug class is already unwriteable.** Convex's syscall ABI never exposes `Date`/`Math.random`/network to deterministic code (`convex-workflow.md` §5); DBOS's `function_id` model *permits* non-deterministic control flow and only catches it reactively during a real production crash-recovery, or fails silently (`dbos-workflow.md` §1). Stackbase already enforces the Convex discipline for queries/mutations (seeded RNG, fixed clock, no network) — the workflow handler slots into the same executor with the same profile.
3. **The advance mechanism is already shipped.** Convex advances a workflow by having a finished step's `onComplete` callback re-enqueue the workflow mutation with the same `generationNumber` (`convex-workflow.md` §4; `pool.ts:176-192`) — *no separate scanner process*. `@stackbase/scheduler` shipped exactly this: `onComplete` + an opaque `context` round-trip (built, per `workflow-source.md §11`, expressly for this layer).

So the replay model isn't just compatible with our engine — our engine makes it *strictly safer to implement here than the checkpoint model would be*. We borrow DBOS's ideas selectively (recovery-attempts cap, idempotency-key dedup) but not its architecture.

---

## 1. Journal data model (the durable state)

Namespaced tables (`workflow/*`), mirroring the scheduler's schema style. From `convex-workflow.md` §3 + `workflow-source.md` §1:

- **`workflows`** — the durable run record: `{ workflowFnPath, args, state: "running"|"completed"|"failed"|"canceled", generationNumber, result?, error?, startedTs, completedTs?, onComplete?, context? }`. Indexed `by_state`.
- **`steps`** (the journal) — one row per step *attempt-completed*: `{ workflowId, stepNumber, name, kind: "mutation"|"query"|"action"|"sleep"|"waitForEvent", args, result?, error?, state, scheduledJobId?, startedTs, completedTs? }`. Indexed `by_workflow [workflowId, stepNumber]`. **This is the replay source of truth.**
- **`events`** (for `waitForEvent`, if built) — `{ workflowId, name, payload?, state: "waiting"|"received" }`. Indexed `by_workflow_name`.
- **`config`** — singleton-ish tuning (max journal size, etc.).

Step arg/result payloads are JSON-safe (same value codec as the scheduler's `job_args`), size-capped.

## 2. The replay loop (step memoization)

From `convex-workflow.md` §1-2 (`step.ts:84-112`, `workflowMutation.ts:198-254`):

1. A **poll** = one invocation of the internal `workflow:_advance` mutation. It loads the run's journal (`steps` ordered by `stepNumber`) into an in-memory ordered array.
2. It runs the user's workflow handler from line 1. Each `step.run*()` call pushes a request onto an internal channel; a `StepExecutor` races the handler:
   - **Cached step:** the next journal entry exists → validate `{name, kind, args}` match (mismatch → `"Journal entry mismatch"` determinism error) → immediately resolve the handler's `await` with the recorded `result`. No re-execution.
   - **New step:** journal exhausted → this is a genuinely new step → write its `steps` row (`state:"pending"`) + dispatch it via `ctx.scheduler.runAfter(0, <stepFn>, args, { onComplete: "workflow:_stepDone", context: { workflowId, stepNumber, generationNumber } })` → the poll **returns with the handler's promise deliberately unresolved for this invocation.** The workflow is now suspended, waiting on that step.
3. When the dispatched step finishes, the scheduler fires `workflow:_stepDone` (its `onComplete`) with the `context`. `_stepDone` records the step's `result` into its `steps` row and re-enqueues `workflow:_advance` → the next poll replays, the now-cached step short-circuits, and execution proceeds to the *next* new step. Repeat until the handler returns → `workflows.state = "completed"`, fire the workflow's own `onComplete`.

**Zero cross-poll JS state** (`convex-workflow.md` "sharpest constraints"): anything not in the journal vanishes between polls. Mechanical, not enforced by a rule.

## 3. The OCC advance guard (`generationNumber`)

From `convex-workflow.md` §4 + `workflow-source.md` §4:

- Lives on the `workflows` row. Every `_advance`/`_stepDone` reads it and only commits if it still matches the value it captured (a lock-free OCC guard — a stale writer *silently discards itself*, no error).
- **Bumped on cancel and restart.** After a cancel bumps the generation, any in-flight step's `_stepDone` (carrying the old generation in its `context`) no-ops — so a step that finishes *after* cancel can't resurrect the workflow.
- Prevents: double-advance from a duplicate poll, a concurrent poll racing itself, a post-cancel step re-advancing. This is the workflow analogue of the scheduler's `_claim` OCC guard — same discipline, different table.

## 4. What Stackbase already provides vs. what workflow adds

| Need | Source | Status |
|---|---|---|
| Dispatch a step now/after delay (`runAfter`/`runAt`) | `@stackbase/scheduler` facade | ✅ shipped |
| Cancel in-flight steps (cascading) | scheduler cascading cancel | ✅ shipped |
| Notify workflow when a step finishes (`onComplete` + opaque `context`) | scheduler — **built for this** | ✅ shipped |
| `RunResult = success \| failed \| canceled` uniform outcome | scheduler `OnCompleteResult` | ✅ shipped |
| Per-step retries/backoff | scheduler retry/backoff | ✅ shipped |
| **Action steps** (external side effects) | **action runtime (`807ec7b`)** | ✅ **shipped** — closes the research's "one real gap" |
| Deterministic handler execution (seeded RNG, fixed clock, no network) | executor query/mutation profile | ✅ shipped — reuse |
| Reactive `workflow.status` (live in the client + dashboard) | reactive sync tier + range-precise invalidation | ✅ shipped — free |
| Recurring driver seam (for `waitForEvent` wake) | `ComponentDefinition.driver` + commit fan-out | ✅ shipped — reuse |
| **Journal tables + replay loop + generationNumber guard** | — | 🔨 **workflow builds this** |
| **The `step`/`workflow.define`/`start`/`status`/`cancel` authoring surface** | — | 🔨 **workflow builds this** |
| **`waitForEvent`/`sendEvent`** (top market gap) | park-on-waitpoint + driver wake | 🔨 workflow builds (SHOULD) |

The workflow component is a **`requires: ["scheduler"]`** component. It touches *only* the scheduler's public facade — never re-implementing dispatch, timers, or retries (`workflow-source.md §11`: "the scheduler is the only interface the workflow layer touches").

## 5. Best-in-market additions mapped to our seams

- **`waitForEvent` / `sendEvent`** (`lunora-cloudflare-and-market.md` §4.1): a step writes an `events` row `state:"waiting"` and suspends (no scheduler job — it's not timer-driven). `ctx.sendEvent(runId, name, payload)` is a mutation that flips the row to `"received"` + re-enqueues `_advance`; the commit fan-out wakes the driver → the workflow replays and the `waitForEvent` step short-circuits with the payload. **No new engine primitive** — it's a row + the reactive wake we already have. Optional timeout = a companion `sleep` step that cancels the wait.
- **Fan-out/fan-in** (`§4`): `await Promise.all([step.a(), step.b()])` — the replay loop already handles multiple in-flight new steps in one poll (each gets a journal row + a dispatch); the handler suspends until *all* their `_stepDone`s have journaled. A bounded-parallelism config caps concurrent dispatches.
- **Saga/compensation** (COULD): a step declared with a `compensate` handler records it in the journal; on workflow failure, an unwind pass replays the journal in reverse, dispatching each recorded compensation as its own (action/mutation) step. Builds entirely on the existing step machinery.

## 6. Constraints & limits (from the references, apply to us)

- **Handler must be deterministic and fast-returning** — it does no work itself; it only dispatches steps and suspends. A slow/nondeterministic body breaks replay (`convex-workflow.md` §7).
- **Journal size cap** — bound the number of steps / total journal bytes per workflow (Convex enforces a limit); a runaway loop is caught here. Continue-as-new (the Temporal escape hatch) is a WON'T for v1 because our replay cost is journal-read, not full-event-history.
- **Recovery-attempts cap** (borrowed from DBOS `dbos-workflow.md` §4) — a workflow that crashes the process repeatedly is dead-lettered after N recovery attempts, not retried forever.
- **At-most-once action steps** — an action step that crashes mid-run is not blind-retried (inherits the scheduler's at-most-once for actions); the workflow sees it as failed and can compensate. Exactly-once for mutation/query steps.

## 7. Open design questions (for the brainstorm / spec)

1. **v1 scope line:** MUST-only (Convex-parity core) vs. MUST + `waitForEvent` (the top differentiator) in the first slice.
2. **`step` API ergonomics:** match Convex's `step.runMutation(ref, args)` exactly (paste-and-run parity) vs. a slightly richer surface.
3. **Journal-mismatch strictness:** hard-throw on determinism violation (Convex) vs. a softer diagnostic.
4. **Whether `waitForEvent` and saga are v1 SHOULD or explicit v1.1** — depends on the scope appetite.
5. **Codegen:** how `workflow.define` + typed `runId`/status surface through `packages/codegen` (the scheduler added a `serverExports` seam — likely reused).
