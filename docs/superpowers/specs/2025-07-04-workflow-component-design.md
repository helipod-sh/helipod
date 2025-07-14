# `@stackbase/workflow` — design

**Status:** approved (brainstorming) — 2025-07-04
**Slice:** the durable-workflow capstone. A new component, sibling to `@stackbase/scheduler` (shipped `5b806bd`) and built on the just-merged action runtime (`807ec7b`). Not a numbered build-order slice — it's the Convex-parity feature that makes the scheduler + actions investment compound.
**Research:** `components/workflow/docs/{features.md,architecture-notes.md}` + `.reference/workflow-research/{convex-workflow,dbos-workflow,lunora-cloudflare-and-market}.md` + `.reference/scheduling-research/{workflow-source,dbos-source}.md`.
**Predecessor context:** `@stackbase/scheduler` shipped the exact primitives a workflow layer needs (`ctx.scheduler.runAfter/runAt/cancel` + `onComplete` + an opaque `context` round-trip + `RunResult = success|failed|canceled` + per-step retries — `workflow-source.md §11` lists these; the scheduler built them expressly for this). The action runtime shipped `kind:"action"` execution, closing the research's "one real gap" (action steps). The reactive sync tier + range-precise invalidation make `workflow.status` **live** for free. The recurring `driver` seam + commit fan-out give `waitForEvent` its wake mechanism with no new engine primitive.

---

## 1. Goal

Durable, multi-step orchestration: a workflow is an ordinary async function whose progress **survives crashes, restarts, and redeploys**. Each step's result is journaled, so a 20-step flow that dies at step 14 resumes at step 14 without re-running steps 1–13's side effects. Convex `@convex-dev/workflow` parity (paste-and-run), plus `step.waitForEvent` (the top market gap no Convex-workflow/DBOS has) and fan-out/fan-in.

**The one concept to get right: durable execution via deterministic replay.** The workflow handler re-runs top-to-top on every advance; a persisted **journal** short-circuits already-completed steps; the first incomplete step dispatches (via the scheduler) and the handler suspends. The journal is the source of truth for "where are we." (See `architecture-notes.md §0` for why the **replay** model — not DBOS checkpoint or DO-memoization — is the right fit: Stackbase's OCC/deterministic core makes it strictly safer to implement here, and mutation steps get exactly-once *free*.)

---

## 2. Locked decisions (from research + brainstorming)

1. **Deterministic-replay model** (not DBOS checkpoint, not DO-per-instance). Rationale in `architecture-notes.md §0`.
2. **A `requires: ["scheduler"]` component**, opt-in via `stackbase.config.ts` (`defineWorkflow({ workflows })`, mirroring `defineScheduler`). No auto-install. It touches ONLY the scheduler's public facade — never re-implements dispatch/timers/retries.
3. **Convex `@convex-dev/workflow` API parity** — paste-and-run (a hard project principle). `workflow.define`, `step.runMutation/runQuery/runAction`, `step.sleep`, `ctx.workflow.start/cancel`, `workflow.status`, `onComplete`.
4. **v1 scope:** the replay core + `step.waitForEvent`/`ctx.sendEvent` + fan-out/fan-in. **v1.1 (deferred):** saga/compensation, sub-workflows, replay-debugging. **Non-goals:** in-place versioning of in-flight workflows; the full throttle/rate-limit/batch matrix; any separate workflow runtime/interpreter/CRIU/DO.
5. **Journal-mismatch = hard-throw** (`"Journal entry mismatch"`) — it is the entire determinism-violation surface; a soft diagnostic would let journal corruption through.
6. **Codegen reuses the scheduler's `serverExports` seam** for `workflow.define` + typed refs.

---

## 3. Execution model — the handler runs inside `_advance`

A workflow handler is NOT a new UDF type. It is a deterministic function in a registry (like `cronJobs()`), executed **inside an internal `workflow:_advance` mutation** under the executor's normal deterministic profile (seeded RNG, fixed clock, no network — already enforced for mutations). The handler does no IO itself; it only calls `step.*`, which either short-circuits from the journal or dispatches a scheduler job and suspends. Consequences:

- The replay loop reuses the OCC/determinism machinery already in the executor. No new runtime.
- A step's actual work (a mutation/query/action) runs as its OWN scheduler-dispatched job — outside the `_advance` mutation — so an action step's side effects happen in the action tier, never inside the replay transaction.
- The handler suspends by returning from `_advance` with its promise unresolved; it resumes when a step's `onComplete` re-enqueues `_advance`.

---

## 4. Journal data model (`workflow/*` tables)

Namespaced tables (mirroring the scheduler's schema style; JSON-safe value codec; size-capped payloads).

- **`workflows`** — the durable run record:
  `{ workflowFnPath: string, args: JSONValue, state: "running"|"completed"|"failed"|"canceled", generationNumber: number, result?: JSONValue, error?: string, onComplete?: string, context?: JSONValue, recoveryAttempts: number, startedTs: number, completedTs?: number }`. Index `by_state [state]`.
- **`steps`** (the journal — replay source of truth) — one row per step, created when the step is first dispatched:
  `{ workflowId: Id, stepNumber: number, name: string, kind: "mutation"|"query"|"action"|"sleep"|"waitForEvent", args: JSONValue, result?: JSONValue, error?: string, state: "pending"|"success"|"failed", scheduledJobId?: string, startedTs: number, completedTs?: number }`. Index `by_workflow [workflowId, stepNumber]`.
- **`events`** (for `waitForEvent`) — `{ workflowId: Id, name: string, payload?: JSONValue, state: "waiting"|"received", createdTs: number }`. Index `by_workflow_name [workflowId, name]`.
- **`config`** — tuning singleton (max journal steps, max recovery attempts).

## 5. The replay loop + OCC guard

`workflow:_advance` (an internal mutation, `workflowId` arg):
1. Load the `workflows` row; capture its `generationNumber`. If `state !== "running"`, no-op (already terminal/canceled).
2. Load the journal (`steps` for this workflow, ordered by `stepNumber`) into an in-memory ordered array; a cursor starts at 0.
3. Run the user's handler from line 1, passing a `step` object whose methods race the handler:
   - **Cached step** (cursor points at an existing journal row): validate `{name, kind, args}` against the recorded row (mismatch → throw `"Journal entry mismatch"`). If the row is `success`, resolve the handler's `await` with `result`; if `failed`, reject with `error`; advance the cursor. No re-execution.
   - **New step** (cursor past the journal end): write a `steps` row (`state:"pending"`, next `stepNumber`) + dispatch via `ctx.scheduler.runAfter(0, <stepFnPath>, args, { maxAttempts?, onComplete: "workflow:_stepDone", context: { workflowId, stepNumber, generationNumber } })`. Record `scheduledJobId`. Then **stop advancing this poll** — the handler's promise for this step stays unresolved; `_advance` returns.
   - **Fan-out:** multiple new `step.*` calls awaited together (`Promise.all`) each get a journal row + a dispatch in this same poll; the handler suspends until ALL their `_stepDone`s have journaled. A `config` max-parallelism caps concurrent dispatches.
4. If the handler RETURNS (all steps cached, no new dispatch): set `workflows.state = "completed"`, `result`, `completedTs`; fire the workflow's own `onComplete` (via the scheduler's `fireOnComplete`, reused). If the handler THROWS a non-journal error: `state = "failed"`, `error`; fire `onComplete` with the failure.

`workflow:_stepDone` (the scheduler `onComplete` callback, a mutation, receives `{ jobId, context: {workflowId, stepNumber, generationNumber}, result: RunResult }`):
1. Re-read the `workflows` row; if its `generationNumber !== context.generationNumber`, **silently no-op** (a stale step from before a cancel/restart — must not resurrect the run). This is the OCC guard.
2. Journal the step's outcome into its `steps` row (`success`+`result` or `failed`+`error`).
3. If a step `failed` terminally AND it's not compensable (v1: no saga), set the workflow `failed` + fire its `onComplete`. Otherwise re-enqueue `workflow:_advance` (via `runAfter(0)`) → the next poll replays, the now-cached step short-circuits, execution proceeds to the next new step.

**`generationNumber`** (on `workflows`) is bumped by `cancel` and `restart`. A duplicate `_advance` poll or a late `_stepDone` carrying an old generation self-discards. This is the workflow analogue of the scheduler's `_claim` OCC guard.

**Zero cross-poll JS state:** anything not journaled vanishes between polls — mechanical, not a rule.

## 6. Authoring & management API (Convex parity)

```ts
// registered in stackbase.config.ts via defineWorkflow({ workflows: { orderFlow } })
const orderFlow = workflow.define({
  handler: async (step, args: { orderId: string }) => {
    const charge = await step.runAction(api.payments.charge, { orderId: args.orderId }); // action step
    const rec    = await step.runMutation(api.orders.markPaid, { orderId: args.orderId, charge });
    await step.sleep(60_000);                                                            // durable timer
    const [ship, notify] = await Promise.all([                                           // fan-out/fan-in
      step.runAction(api.shipping.create, { orderId: args.orderId }),
      step.runAction(api.email.confirm,  { orderId: args.orderId }),
    ]);
    const approved = await step.waitForEvent("manager_approved", { timeoutMs: 86_400_000 }); // signal
    return { charge, ship, approved };
  },
});
```

- **`step.runMutation(ref, args) → result`**, **`step.runQuery(ref, args) → result`**, **`step.runAction(ref, args, { maxAttempts?, initialBackoffMs?, base? }?) → result`** — dispatch a step; the result is journaled. Signatures match Convex.
- **`step.sleep(ms)` / `step.sleepUntil(ts)`** — a durable no-op timer step (dispatched as a delayed scheduler job; zero cost while parked).
- **`step.waitForEvent(name, { timeoutMs? }?) → payload`** — writes an `events` row `state:"waiting"` and suspends WITHOUT a scheduler job (not timer-driven). An optional `timeoutMs` adds a companion `sleep` step that, if it fires first, rejects the wait (timeout). Resumes when `sendEvent` flips the row.
- **`ctx.workflow.start(ref, args) → runId`** — facade method (parallel to `ctx.scheduler.runAfter`), callable from any mutation/action; creates the `workflows` row + kicks the first `_advance`. Also `ctx.workflow.startAfter/startAt` for delayed kickoff (COULD; reuses scheduler delay).
- **`ctx.workflow.cancel(runId)`** — bumps `generationNumber`, sets `canceled`, cascades cancel to in-flight step jobs (scheduler cascading cancel).
- **`ctx.sendEvent(runId, name, payload)`** — a mutation: flips the matching `events` row to `received`+`payload`, re-enqueues `_advance`. The commit fan-out wakes the driver → replay resolves the `waitForEvent`. (Exposed on the workflow facade; internally a `_sendEvent` mutation.)
- **`workflow.status(runId) → { state, result?, error? }`** — a **live** query (reactive for free because state lives in tables). The DX edge: `useQuery(workflow.status, {runId})` updates in real time as the workflow progresses.
- **`onComplete`** — a workflow-level completion callback (mutation), reusing the scheduler's `onComplete`/`context` round-trip.

## 7. Determinism, failure, limits

- **Handler determinism:** the body may call only `step.*`/`ctx.*`. Direct DB, network, `Date`, `Math.random` are forbidden (same discipline as a mutation — the executor already shims/forbids these). A determinism violation surfaces as a journal-mismatch throw on the next replay.
- **Per-step retries:** action/mutation steps retry per the scheduler's backoff (`maxAttempts`); action steps are **at-most-once** on crash (inherit the scheduler's contract — a crashed action step fails the step; the workflow sees failure). Mutation/query steps are exactly-once.
- **Recovery-attempts cap:** a workflow whose `_advance` crashes the process repeatedly increments `recoveryAttempts`; past the cap it's dead-lettered `failed` (borrowed from DBOS), not retried forever.
- **Journal size cap:** bound steps-per-workflow / total journal bytes (`config`); a runaway loop is caught here. (Continue-as-new is a WON'T — our replay cost is a journal read, not full event-history replay.)
- **Errors:** a step's terminal failure fails the workflow (v1, no saga) and fires `onComplete{failed}`. A failed `onComplete` is itself durable (reuses the scheduler's onComplete-failure handling).

## 8. Testing

- **Replay unit:** a cached step short-circuits (no re-dispatch); a new step writes a journal row + dispatches + suspends; the handler resumes on `_stepDone` and proceeds to the next step; a full 3-step flow completes.
- **OCC guard:** a `_stepDone` carrying a stale `generationNumber` (after `cancel`) no-ops — the canceled workflow is not resurrected; a duplicate `_advance` poll doesn't double-dispatch.
- **Determinism:** a journal `{name/kind/args}` mismatch throws `"Journal entry mismatch"`.
- **Fan-out/fan-in:** `Promise.all([step.a(), step.b()])` journals 2 steps in one poll and the handler resumes only after both `_stepDone`s.
- **`waitForEvent`:** a workflow parks on `waitForEvent`; `sendEvent` flips the row + the workflow resolves with the payload; a timeout variant rejects after the companion sleep.
- **Action step (at-most-once):** an action step runs; a crash-mid-action (inProgress+expired lease) fails the step, workflow sees failure — not a blind re-run (proving the scheduler at-most-once contract flows through).
- **E2E through the shipped `stackbase dev` server:** a client mutation calls `ctx.workflow.start` for a multi-step flow (mutation + action step + a `waitForEvent`); a second client call `sendEvent` resolves the wait; a live `useQuery(workflow.status)` subscription transitions `running → completed` — proving the whole replay+advance+wake loop reactively through the real server (the "test through the shipped entrypoint" discipline).
- **Regression:** existing scheduler/executor/sync/dashboard suites green.

## 9. File structure

New `components/workflow/` (mirrors `components/scheduler/`):
- `src/schema.ts` — the `workflows`/`steps`/`events`/`config` tables + indexes.
- `src/replay.ts` — the replay engine (the `step` object, journal cursor, cached-vs-new dispatch, fan-out).
- `src/facade.ts` — `ctx.workflow` (`start`/`cancel`/`sendEvent`) + the `context:`/`buildAction` providers (so `ctx.workflow.start` works in mutations AND actions, via the scheduler's `buildAction` pattern).
- `src/modules.ts` — internal mutations `_advance`, `_stepDone`, `_start`, `_cancel`, `_sendEvent`; the `status` query.
- `src/events.ts` — `waitForEvent`/`sendEvent` waitpoint logic.
- `src/index.ts` — `defineWorkflow({ workflows })` + `workflow.define`; modules map; `requires: ["scheduler"]`; reuses codegen `serverExports`.
- `test/{replay,occ-guard,fanout,wait-event,action-step}.test.ts` + `helpers.ts`; the E2E in `packages/cli/test/workflow-e2e.test.ts`.
- Reference pattern added to `examples/auth-demo/stackbase.config.ts` (`defineWorkflow` alongside `defineScheduler`).
- `CLAUDE.md` updated (workflow shipped; the What-works line).

## 10. Out of scope (v1.1+ / non-goals)

**v1.1:** saga/compensation (declarative per-step `rollback`, reverse-unwound on failure); sub-workflows (`step.runWorkflow`); replay-debugging. **Non-goals (bloat for a lean self-hostable engine):** Temporal-style in-place versioning/migration of in-flight workflows (drain-on-original-version instead); the full Inngest throttle/rate-limit/batch/CEL-virtual-queue matrix (one concurrency-by-key knob is the 80%); any separate workflow runtime/interpreter, CRIU process-snapshot, or DO-per-instance model.
