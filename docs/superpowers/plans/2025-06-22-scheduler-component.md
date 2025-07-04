# `@stackbase/scheduler` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Convex-compatible, durable, event-driven scheduler component — one-off `runAfter/runAt` + crons — driven by the reactive engine (no polling), contention-free under load, with the primitives `@stackbase/workflow` will layer on later.

**Architecture:** A new recurring **`driver`** seam on the component system (the runtime-level parallel to the one-time `boot`) taps the existing commit fan-out (`adapter.subscribe`) for reactive wakeups + a `setTimeout` timer for future jobs. The scheduler component owns all semantics: `scheduler/*` tables, a `ctx.scheduler` facade doing **transactional enqueue** (a job row written in the calling mutation's OCC txn), and a **single-owner, generation-guarded, snapshot-reading** driver loop that claims due jobs, runs them via a `runFunction` primitive, and records results. Crons are self-rescheduling jobs on top.

**Tech Stack:** TypeScript, Bun, Turborepo, vitest. Builds on: the component system (`defineComponent`/`composeComponents`), the runtime (`EmbeddedRuntime`, the `adapter.subscribe` commit fan-out, injected `now`), range-precise reactive invalidation, `cron-parser` (new dep, IANA timezones).

## Global Constraints

- **Bun toolchain:** `bun run build`, `bun run typecheck`, `bun run test`; single pkg `bun run --filter @stackbase/scheduler test`. Never pnpm/npm.
- **Convex API parity is a hard acceptance criterion:** `ctx.scheduler.runAfter(ms, fn, args)` / `runAt(ts|Date, fn, args)` / `cancel(id)` are signature-identical to Convex; `cronJobs().interval/cron/daily/hourly/weekly/monthly` + the `crons.ts` convention resolve unchanged (only the `_generated` import path may differ). `tz`/`catchUp` are additive extensions.
- **This slice schedules mutations + internal functions only.** Actions execute in a sibling slice; build the `kind: "mutation" | "action"` state machine now, but the runner only *runs* mutations (an action job stays claimable but its execution is deferred — mark and skip with a clear `unsupported` result, tested).
- **Event-driven, not polling:** reactive wake (commit fan-out) + earliest-`nextTs` timer. A slow safety sweep (default 30s) only backstops lease reclaim — never the primary dispatch path.
- **Contention-free bookkeeping:** single-owner generation-guarded loop; enqueue/complete/cancel write **append-only `signals`**; the loop reads via **snapshot** (no OCC read-dependency). Never a shared-counter hotspot.
- **Delivery contract:** scheduled mutation = exactly-once-ish (state transition rides the txn); action = at-most-once (`inProgress` committed before execution).
- **Testable clock:** everything time-based uses the runtime's injected `now()`; tests advance a virtual clock — **no real `sleep`s** in tests.
- **`scheduler/*` tables are namespaced** (component tables); the live dashboard inspects them for free — no special observability code.
- **Workflow-ready:** the internal `enqueue({ onComplete, context })` + `runAfter:0`-cheap are load-bearing for the later workflow slice — do not omit.
- TDD, frequent commits, each task ends green (`build`/`typecheck`/`test`). `noUncheckedIndexedAccess: true`.

Backing detail (read before implementing): `docs/superpowers/specs/2025-06-22-scheduler-component-design.md`, `components/scheduler/docs/{features.md,architecture-notes.md}`.

---

## File Structure

- `packages/component/src/define-component.ts` (**modify**) — add `driver?` + `Driver`/`DriverContext` types.
- `packages/component/src/compose.ts` (**modify**) — collect `drivers` from components into the compose result.
- `packages/runtime-embedded/src/runtime.ts` (**modify**) — driver lifecycle (start after boot / stop on shutdown); build `DriverContext` (`runFunction`, `onCommit` off `adapter.subscribe`, `setTimer`, `now`).
- `components/scheduler/` (**new**): `package.json`, `src/schema.ts` (`jobs`/`job_args`/`crons`/`signals`), `src/facade.ts` (`ctx.scheduler` + internal `enqueue`), `src/modules.ts` (internal claim/complete/cancel/peek mutations+queries), `src/driver.ts` (the loop), `src/crons.ts` (`cronJobs()` + `cron-parser`), `src/backoff.ts` (retry math), `src/index.ts` (`defineScheduler()` → `ComponentDefinition`), `test/*`.
- `packages/codegen/*` (**modify**) — expose `cronJobs()` + `internal.*` refs so `crons.ts` resolves.
- default project template + `CLAUDE.md` (**modify**, Task 6).

---

## Task 1: The `driver` seam (component system + runtime)

**Files:**
- Modify: `packages/component/src/define-component.ts`, `packages/component/src/compose.ts`, `packages/runtime-embedded/src/runtime.ts`
- Test: `packages/runtime-embedded/test/driver-seam.test.ts`

**Interfaces:**
- Produces:
  ```ts
  // define-component.ts
  export interface DriverContext {
    runFunction(path: string, args: JSONValue): Promise<unknown>; // runs a registered fn privileged+namespaced, outside a request
    onCommit(cb: (inv: { tables: string[]; ranges: readonly SerializedKeyRange[]; commitTs: number }) => void): () => void; // taps the commit fan-out; returns unsubscribe
    setTimer(atMs: number, cb: () => void): number;   // arm a wake at wall-clock atMs; returns handle
    clearTimer(handle: number): void;
    now(): number;
  }
  export interface Driver { name: string; start(ctx: DriverContext): void | Promise<void>; stop?(): void | Promise<void>; }
  // ComponentDefinition gains: driver?: Driver;
  // compose result gains: drivers: Driver[];
  ```

- [ ] **Step 1: Write the failing test**

`packages/runtime-embedded/test/driver-seam.test.ts` — a toy component with a driver proves the seam: the driver is started after boot, `onCommit` fires when a mutation commits, `runFunction` runs a registered mutation, `setTimer` fires on the virtual clock.

```ts
import { describe, it, expect } from "vitest";
import { SqliteDocStore, NodeSqliteAdapter } from "@stackbase/docstore-sqlite";
import { composeComponents } from "@stackbase/component";
import { EmbeddedRuntime } from "@stackbase/runtime-embedded";
import { defineSchema, defineTable, v } from "@stackbase/values";
import { mutation } from "@stackbase/executor";

describe("driver seam", () => {
  it("starts a component driver after boot; onCommit fires on a commit; runFunction runs a registered fn", async () => {
    const commits: number[] = [];
    let ran = 0;
    const driver = {
      name: "toy",
      start(ctx: any) {
        ctx.onCommit((inv: any) => { commits.push(inv.commitTs); void ctx.runFunction("toy:bump", {}); });
      },
    };
    const schema = defineSchema({ counters: defineTable({ n: v.number() }) });
    const c = composeComponents(
      { schemaJson: schema.export(), moduleMap: { "app:add": mutation(async (ctx) => ctx.db.insert("counters", { n: 1 })) } },
      [{ name: "toy", schema: defineSchema({}), modules: { bump: mutation(async () => { ran += 1; return null; }) }, driver }],
    );
    const r = await EmbeddedRuntime.create({
      store: new SqliteDocStore(new NodeSqliteAdapter()), catalog: c.catalog, modules: c.moduleMap,
      componentNames: c.componentNames, contextProviders: c.contextProviders, policyRegistry: c.policyRegistry,
      policyProviders: c.policyProviders, relationRegistry: c.relationRegistry, bootSteps: c.bootSteps, drivers: c.drivers,
    });
    await r.run("app:add", {});
    await new Promise((res) => setTimeout(res, 30)); // let the async commit fan-out + runFunction settle
    expect(commits.length).toBeGreaterThan(0);       // onCommit fired for the app:add commit
    expect(ran).toBeGreaterThan(0);                  // runFunction("toy:bump") executed
  });
});
```

> Adapt the exact `composeComponents`/`EmbeddedRuntime.create` argument shape to the real signatures (mirror `packages/admin/test/browse-live.test.ts`'s runtime construction). The assertions are the contract.

- [ ] **Step 2: Run — verify it fails**

Run: `bun run --filter @stackbase/runtime-embedded test driver-seam`
Expected: FAIL — `driver`/`drivers`/`DriverContext` unknown.

- [ ] **Step 3: Add the types to `define-component.ts`**

Add `DriverContext`, `Driver` (above), and `driver?: Driver` on `ComponentDefinition`. Import `JSONValue` from `@stackbase/values` and `SerializedKeyRange` from `@stackbase/index-key-codec`.

- [ ] **Step 4: Collect drivers in `compose.ts`**

Add to the compose result type `drivers: Driver[]` and populate: `const drivers = components.filter((c) => c.driver).map((c) => c.driver!);` — include it in the returned object alongside `bootSteps`.

- [ ] **Step 5: Wire the runtime (`runtime.ts`)**

Add `drivers?: Driver[]` to `EmbeddedRuntimeOptions`. **After** the boot-steps loop and **after** the `adapter.subscribe(...)` fan-out is set up, build a `DriverContext` and start each driver:

```ts
    // Driver lifecycle: start component drivers after boot, wired to the commit fan-out + a timer.
    const commitSubs = new Set<(inv: { tables: string[]; ranges: readonly SerializedKeyRange[]; commitTs: number }) => void>();
    // fold into the existing adapter.subscribe callback: after queueing for notifyWrites, also fan out to drivers:
    //   for (const cb of commitSubs) cb({ tables: payload.tables, ranges: payload.ranges, commitTs: payload.commitTs });
    const timers = new Map<number, ReturnType<typeof setTimeout>>();
    let timerSeq = 0;
    const driverCtx: DriverContext = {
      runFunction: async (path, args) => {
        const fn = modules[path]; if (!fn) throw new Error(`driver: unknown function ${path}`);
        const ns = namespaceForPath(path, componentNames);
        const res = await executor.run(fn, jsonToConvex(args), { path, namespace: ns, contextProviders, policyRegistry, policyProviders, relationRegistry, identity: null, privileged: true });
        return res.value;
      },
      onCommit: (cb) => { commitSubs.add(cb); return () => commitSubs.delete(cb); },
      setTimer: (atMs, cb) => { const h = ++timerSeq; timers.set(h, setTimeout(cb, Math.max(0, atMs - (options.now?.() ?? Date.now())))); return h; },
      clearTimer: (h) => { const t = timers.get(h); if (t) { clearTimeout(t); timers.delete(h); } },
      now: () => options.now?.() ?? Date.now(),
    };
    for (const d of options.drivers ?? []) await d.start(driverCtx);
```

Add `commitSubs` fan-out to the existing `adapter.subscribe` callback body. Store drivers/timers on the instance so a `stop()`/shutdown path can clear them (add a `stopDrivers()` method that calls each `driver.stop?.()` and clears timers — invoked on runtime close if one exists; otherwise expose it).

> `setTimer` uses `options.now` for the delay so a virtual clock works in tests — BUT `setTimeout` itself is real. For deterministic tests, Task 3 introduces a test seam where the driver can be *ticked* manually (see Task 3). Keep `setTimer` real here; tests drive dispatch via `onCommit` + a manual tick, not by waiting on real timers.

- [ ] **Step 6: Run — verify it passes**

Run: `bun run --filter @stackbase/runtime-embedded test driver-seam`
Expected: PASS.

- [ ] **Step 7: Whole workspace green + commit**

Run: `bun run build && bun run typecheck && bun run test`
Expected: PASS (additive; existing components have no `driver`, so `drivers` is empty and nothing changes).

```bash
git add packages/component/src/define-component.ts packages/component/src/compose.ts packages/runtime-embedded/src/runtime.ts packages/runtime-embedded/test/driver-seam.test.ts
git commit -m "feat(component): recurring driver seam — runFunction/onCommit/setTimer, wired to the commit fan-out"
```

---

## Task 2: Scheduler schema + `ctx.scheduler` facade + transactional enqueue

**Files:**
- Create: `components/scheduler/package.json`, `src/schema.ts`, `src/facade.ts`, `src/index.ts`
- Test: `components/scheduler/test/enqueue.test.ts`

**Interfaces:**
- Consumes: the component `defineComponent`/context-facade pattern (mirror `components/authz/src/{index,context}.ts`).
- Produces:
  ```ts
  // schema.ts tables (namespaced scheduler/*):
  // jobs:   { fnPath, kind:"mutation"|"action", state:"pending"|"inProgress"|"success"|"failed"|"canceled",
  //          nextTs, attempts, maxFailures, leaseHolder?:string, leaseExpiresAt?:number, idempotencyKey?:string,
  //          appVersion?:string, name?:string, hasArgs:boolean, onComplete?:string, parentId?:string, completedTs?:number }
  //   .index("by_next_ts", ["state","nextTs"]).index("by_completed_ts",["completedTs"]).index("by_parent",["parentId"])
  // job_args: { jobId, args, context? }   .index("by_job", ["jobId"])
  // crons:   (declared here; used in Task 5)
  // signals: { segment:number, kind:"enqueue"|"complete"|"cancel", jobId, payload? } .index("by_segment",["segment"])
  //
  // facade (ctx.scheduler):
  //   runAfter(delayMs:number, fnRef, args): Promise<string>
  //   runAt(ts:number|Date, fnRef, args): Promise<string>
  //   cancel(id:string): Promise<void>
  //   enqueue(fnRef, args, opts?:{ runAfter?:number; runAt?:number; retry?:{maxFailures:number}; name?:string; onComplete?:string; context?:JSONValue }): Promise<string>  // internal, for workflow
  // defineScheduler(): ComponentDefinition  (name:"scheduler", schema, context, driver [wired in Task 3])
  ```

- [ ] **Step 1: Write the failing test**

`components/scheduler/test/enqueue.test.ts` — transactional enqueue + cancel, via the executor with the scheduler component composed in:

```ts
// (build a runtime with defineScheduler() composed; run a mutation that calls ctx.scheduler.runAfter)
it("runAfter writes a pending job row inside the calling mutation's transaction", async () => {
  const { runtime } = await makeRuntimeWithScheduler({
    "app:sched": mutation(async (ctx: any) => { await ctx.scheduler.runAfter(60_000, "app:work", { x: 1 }); return null; }),
    "app:work": mutation(async () => null),
  });
  await runtime.run("app:sched", {});
  const jobs = await readTable(runtime, "scheduler/jobs");
  expect(jobs.length).toBe(1);
  expect(jobs[0]).toMatchObject({ fnPath: "app:work", state: "pending", kind: "mutation" });
  expect(jobs[0].nextTs).toBeGreaterThan(0);
});

it("enqueue is transactional — a mutation that throws after scheduling leaves NO job", async () => {
  const { runtime } = await makeRuntimeWithScheduler({
    "app:boom": mutation(async (ctx: any) => { await ctx.scheduler.runAfter(1000, "app:work", {}); throw new Error("rollback"); }),
    "app:work": mutation(async () => null),
  });
  await expect(runtime.run("app:boom", {})).rejects.toThrow();
  expect((await readTable(runtime, "scheduler/jobs")).length).toBe(0);
});

it("cancel marks a pending job canceled", async () => { /* schedule, capture id, cancel, assert state==="canceled" */ });
```

> `makeRuntimeWithScheduler` + `readTable` are small helpers this test file defines (compose `defineScheduler()` in; `readTable` reads a full-named table via the admin/browse path or `store.scan`). Mirror `packages/admin/test/browse-live.test.ts` for runtime construction + reads. The assertions are the contract.

- [ ] **Step 2: Run — verify it fails**

Run: `bun run --filter @stackbase/scheduler test enqueue`
Expected: FAIL — package/schema/facade don't exist.

- [ ] **Step 3: Scaffold the package**

`components/scheduler/package.json` (mirror `components/authz/package.json`: name `@stackbase/scheduler`, workspace deps `@stackbase/values`, `@stackbase/executor`, `@stackbase/component`; devDeps vitest; add `cron-parser` to `dependencies`). Wire `tsconfig`, build/test scripts like authz.

- [ ] **Step 4: Schema (`src/schema.ts`)**

Define the `jobs`, `job_args`, `crons` (fields per Task 5), and `signals` tables with the indexes listed in Interfaces, using `defineSchema`/`defineTable`/`v` exactly as `components/authz/src/schema.ts` does.

- [ ] **Step 5: The facade (`src/facade.ts`)**

Implement `ctx.scheduler` as a component context facade (mirror `components/authz/src/context.ts`'s facade construction). `runAfter(delayMs, fnRef, args)`:
```ts
async function runAfter(delayMs, fnRef, args) {
  const nextTs = now() + Math.max(0, delayMs);
  return enqueueInternal(fnRef, args, { runAt: nextTs });
}
// runAt normalizes Date → ms; enqueueInternal:
async function enqueueInternal(fnRef, args, opts) {
  const fnPath = getFunctionPath(fnRef);            // string path; accept a string too
  const jobId = await db.insert("jobs", {
    fnPath, kind: kindOf(fnPath) /* "mutation" default this slice */, state: "pending",
    nextTs: opts.runAt ?? now(), attempts: 0, maxFailures: opts.retry?.maxFailures ?? 4,
    hasArgs: true, appVersion: currentAppVersion(), name: opts.name, onComplete: opts.onComplete,
    idempotencyKey: opts.idempotencyKey, parentId: currentJobId() /* null unless run by the driver */,
  });
  await db.insert("job_args", { jobId, args, context: opts.context });
  // ALSO append an enqueue signal so the driver's loop wakes precisely (Task 3 consumes it):
  await db.insert("signals", { segment: segmentOf(now()), kind: "enqueue", jobId });
  return jobId;
}
```
`cancel(id)`: read the job; if `pending` → set `state:"canceled"`, `completedTs: now()`, append a `cancel` signal. (Cascading cancel of children is Task 4.) All writes go through `ctx.db` in the calling txn → transactional + reactive.

> The facade must resolve `fnRef` (a codegen `api.*`/`internal.*` reference or a string path) to a string via `getFunctionPath` (reuse `@stackbase/client`'s helper or the codegen convention). `kindOf`/`currentAppVersion`/`currentJobId`/`segmentOf` are small helpers in the facade module (`kind` defaults to `"mutation"` this slice; `segmentOf(ms) = Math.floor(ms/100)`; `currentJobId` reads a driver-set ambient, else null).

- [ ] **Step 6: `defineScheduler()` (`src/index.ts`)**

Export `defineScheduler(): ComponentDefinition` with `name:"scheduler"`, the schema, and the `context` facade builder (`ctx.scheduler`). Leave `driver` unset until Task 3.

- [ ] **Step 7: Run — verify it passes; whole workspace green + commit**

Run: `bun run --filter @stackbase/scheduler test enqueue` → PASS. Then `bun run build && bun run typecheck && bun run test` → PASS.

```bash
git add components/scheduler bun.lock
git commit -m "feat(scheduler): component schema + ctx.scheduler facade with transactional enqueue + cancel"
```

---

## Task 3: The driver loop — reactive+timer dispatch, single-owner, snapshot claim, run

**Files:**
- Create: `components/scheduler/src/modules.ts` (internal claim/peek/complete mutations+queries), `components/scheduler/src/driver.ts`
- Modify: `components/scheduler/src/index.ts` (attach the driver)
- Test: `components/scheduler/test/dispatch.test.ts`

**Interfaces:**
- Consumes: Task 1's `DriverContext` (`runFunction`/`onCommit`/`setTimer`/`now`); Task 2's tables + `signals`.
- Produces: internal scheduler modules `scheduler:_peekDue` (query → `{ due: Job[], earliestFutureTs: number|null }`), `scheduler:_claim` (mutation → claims a batch `pending→inProgress` with a lease, snapshot-read, generation-guarded), `scheduler:_complete` (mutation → drains a `complete` signal → terminal state + onComplete); a `schedulerDriver` object; **a test seam:** the driver exposes `__tick()` so tests can drive one loop iteration deterministically (no real timers).

- [ ] **Step 1: Write the failing test**

`components/scheduler/test/dispatch.test.ts` — a scheduled mutation runs when due, driven by the virtual clock + manual tick:

```ts
it("a due mutation runs on the next tick; a future one does not until the clock advances", async () => {
  let clock = 1_000_000;
  const ran: string[] = [];
  const { runtime, tick } = await makeRuntimeWithScheduler({
    "app:sched": mutation(async (ctx: any) => { await ctx.scheduler.runAfter(0, "app:work", { tag: "now" }); await ctx.scheduler.runAfter(5000, "app:work", { tag: "later" }); return null; }),
    "app:work": mutation(async (_ctx: any, a: { tag: string }) => { ran.push(a.tag); return null; }),
  }, { now: () => clock });
  await runtime.run("app:sched", {});
  await tick();                                  // drive one loop iteration at clock=1_000_000
  expect(ran).toEqual(["now"]);                  // due-now ran; "later" did not
  clock += 5000; await tick();
  expect(ran.sort()).toEqual(["later","now"]);   // "later" ran once the clock reached its nextTs
});

it("claims are single-run: two concurrent ticks never double-run a job", async () => {
  // schedule one due job; fire tick() twice concurrently; assert app:work ran exactly once + job state==="success"
});
```

> `makeRuntimeWithScheduler` returns `{ runtime, tick }` where `tick()` invokes the driver's `__tick()` (one claim→run→complete iteration). This is the deterministic test seam that replaces real `setTimeout`.

- [ ] **Step 2: Run — verify it fails**

Run: `bun run --filter @stackbase/scheduler test dispatch`
Expected: FAIL — no driver/modules; jobs stay `pending`.

- [ ] **Step 3: Internal modules (`src/modules.ts`)**

- `scheduler:_peekDue` — a **query** (snapshot read, no write): scan `jobs` `by_next_ts` for `state="pending"`; return `due` = those with `nextTs <= now()` (capped at a batch size, e.g. 64) and `earliestFutureTs` = the smallest `nextTs > now()` (for the timer).
- `scheduler:_claim` — a **mutation**: for a given jobId, re-read + exact-match (`state==="pending"`); transition `state:"inProgress"`, set `leaseHolder`, `leaseExpiresAt = now() + LEASE_MS`. Return the job + its args (`job_args`). The single-writer OCC serializes this → the double-exec guard (a second claim sees `state!=="pending"` and no-ops).
- `scheduler:_complete` — a **mutation**: given `{ jobId, result }`, set terminal `state` (`success`/`failed`), null `nextTs`, set `completedTs`, clear lease; if `onComplete` set, `ctx.scheduler.runAfter(0, onComplete, { jobId, context, result })` (Task 6 fully wires the payload); (retry/backoff is Task 4 — here, failure → `failed`).

- [ ] **Step 4: The driver loop (`src/driver.ts`)**

```ts
export function schedulerDriver(): Driver {
  let ctx: DriverContext; let running = false; let timer: number | null = null;
  async function iterate() {
    if (running) return; running = true;                       // single-owner (in-process guard; generation guard on the singleton for multi-claim safety)
    try {
      const { due, earliestFutureTs } = await ctx.runFunction("scheduler:_peekDue", {}) as any;
      for (const job of due) {
        const claimed = await ctx.runFunction("scheduler:_claim", { jobId: job._id }) as any;
        if (!claimed) continue;                                 // lost the claim race → skip
        let result;
        try { const value = await ctx.runFunction(claimed.fnPath, claimed.args); result = { kind: "success", value }; }
        catch (e) { result = { kind: "failed", error: String(e) }; }
        await ctx.runFunction("scheduler:_complete", { jobId: job._id, result });
      }
      // Re-arm the timer to the earliest future job:
      if (timer !== null) { ctx.clearTimer(timer); timer = null; }
      if (earliestFutureTs != null) timer = ctx.setTimer(earliestFutureTs, () => void iterate());
    } finally { running = false; }
  }
  return {
    name: "scheduler",
    start(c) { ctx = c; c.onCommit((inv) => { if (inv.tables.some((t) => t.startsWith("scheduler/"))) void iterate(); }); void iterate(); },
    // test seam:
    // @ts-expect-error attach for tests
    __tick: () => iterate(),
  } as Driver & { __tick: () => Promise<void> };
}
```

Attach it in `src/index.ts`: `driver: schedulerDriver()`. Expose `__tick` so `makeRuntimeWithScheduler` can return `tick`.

> **Reactive wake:** `onCommit` filters for commits touching `scheduler/*` (an enqueue writes the `jobs`+`signals` rows) → the loop re-runs, picking up the new due job with ~0 latency. **Timer wake:** re-armed each iteration to `earliestFutureTs`. **No polling.** `LEASE_MS` (e.g. 30_000) and the batch cap (64) are module constants.

- [ ] **Step 5: Run — verify it passes**

Run: `bun run --filter @stackbase/scheduler test dispatch`
Expected: PASS (due-now runs; future waits; no double-run).

- [ ] **Step 6: Whole workspace green + commit**

Run: `bun run build && bun run typecheck && bun run test` → PASS.

```bash
git add components/scheduler/src/modules.ts components/scheduler/src/driver.ts components/scheduler/src/index.ts components/scheduler/test/dispatch.test.ts
git commit -m "feat(scheduler): event-driven driver loop — reactive+timer dispatch, single-owner, snapshot claim"
```

---

## Task 4: Reliability — retries/backoff/dead-letter, lease reclaim, cascading cancel

**Files:**
- Create: `components/scheduler/src/backoff.ts`
- Modify: `components/scheduler/src/{modules.ts,driver.ts,facade.ts}`
- Test: `components/scheduler/test/reliability.test.ts`

**Interfaces:**
- Consumes: Task 3's modules + driver.
- Produces: `computeBackoff(attempts, { initialBackoffMs=250, base=2 }): number` (with 50–100% jitter via a seeded/injected rng for testability); `_complete` reschedules on failure until `maxFailures` → `failed`; a `scheduler:_reclaim` mutation (lease-expiry sweep); cascading cancel in `cancel`.

- [ ] **Step 1: Write the failing test**

`components/scheduler/test/reliability.test.ts`:

```ts
it("a failing job retries with backoff up to maxFailures, then dead-letters", async () => {
  // schedule app:flaky (throws always) with maxFailures:2; tick; assert state==="pending" + attempts=1 + nextTs advanced by backoff;
  // advance clock past backoff, tick; attempts=2; advance+tick; state==="failed" (dead-letter). app:flaky ran exactly maxFailures times.
});
it("a job left inProgress with an expired lease is reclaimed", async () => {
  // manually insert an inProgress job with leaseExpiresAt in the past; run _reclaim; assert it's back to pending (mutation) with attempts+1.
});
it("canceling a parent cancels its pending children", async () => {
  // a job whose run schedules a child; cancel the parent mid-flight; assert the child (parentId=parent) is canceled.
});
```

- [ ] **Step 2: Run — verify it fails.** `bun run --filter @stackbase/scheduler test reliability` → FAIL.

- [ ] **Step 3: `computeBackoff` (`src/backoff.ts`)**
```ts
export function computeBackoff(attempts: number, rng: () => number, o = { initialBackoffMs: 250, base: 2 }): number {
  const raw = o.initialBackoffMs * o.base ** (attempts + 1);
  return Math.round(raw * (0.5 + 0.5 * rng())); // 50–100% jitter
}
```
The driver/`_complete` gets `rng` from an injected source (default `Math.random`, overridable in tests for determinism — thread it like `now`).

- [ ] **Step 4: Retry in `_complete` (`modules.ts`)**
On `result.kind==="failed"`: `attempts += 1`; if `attempts >= maxFailures` → `state:"failed"`, `completedTs:now()` (dead-letter); else → `state:"pending"`, `nextTs: now() + computeBackoff(attempts, rng)`, clear lease, append an `enqueue` signal (so the driver re-arms). Record `lastError`.

- [ ] **Step 5: Lease reclaim (`_reclaim` + driver safety sweep)**
`scheduler:_reclaim` — a mutation: scan `jobs` for `state="inProgress" AND leaseExpiresAt < now()`; for each, `attempts+=1`, reschedule `pending` (mutation) or `failed` (action, at-most-once) per `kind`. In the driver, `setTimer` a recurring safety sweep (default 30s) that calls `_reclaim` then re-arms — this is the ONLY periodic timer, and it backstops crashes; normal dispatch stays reactive.

- [ ] **Step 6: Cascading cancel (`facade.ts` + `modules.ts`)**
`cancel(id)`: cancel the job if `pending`; then recursively find `jobs` with `parentId=id` in a non-terminal state (via the `by_parent` index) and cancel them too (bounded recursion; a `canceled` parent's future children born `canceled` — set at insert time in `enqueueInternal` if the ambient `parentId` job is already canceled).

- [ ] **Step 7: Run — verify it passes; workspace green + commit**
`bun run --filter @stackbase/scheduler test reliability` → PASS; `bun run build && bun run typecheck && bun run test` → PASS.
```bash
git add components/scheduler/src/backoff.ts components/scheduler/src/modules.ts components/scheduler/src/driver.ts components/scheduler/src/facade.ts components/scheduler/test/reliability.test.ts
git commit -m "feat(scheduler): retries/backoff/dead-letter, lease reclaim, cascading cancel"
```

---

## Task 5: Crons — `cronJobs()` registry, cron-parser, dual-job, catch-up, timezone + codegen

**Files:**
- Create: `components/scheduler/src/crons.ts`
- Modify: `components/scheduler/src/{schema.ts (crons table),modules.ts,index.ts}`, `packages/codegen/*`
- Test: `components/scheduler/test/crons.test.ts`

**Interfaces:**
- Produces: `cronJobs()` returning a registry with `.interval(name, {minutes|hours|seconds}, fnRef, args)`, `.cron(name, expr, fnRef, args, opts?:{tz?})`, `.daily/.hourly/.weekly/.monthly` (Convex signatures); the crons are registered at boot into the `crons` table; a `scheduler:_cronTick` cadence mutation that (per fire) schedules the work job + reschedules itself clock-anchored; `computeNextRun(spec, tz, afterTs)` using `cron-parser`.

- [ ] **Step 1: Write the failing test**

`components/scheduler/test/crons.test.ts`:
```ts
it("an interval cron fires at each period on the virtual clock, clock-anchored (a slow job doesn't drift)", async () => {
  // register crons.interval("beat",{seconds:10}, "app:beat", {}); boot; tick loop while advancing clock by 10s;
  // assert app:beat fires at t0+10,+20,+30 (anchored to schedule, not run-completion time).
});
it("a cron expression with tz computes the right next run (cron-parser)", () => {
  const next = computeNextRun({ kind:"cron", expr:"0 3 * * *" }, "America/New_York", Date.parse("2025-06-22T12:00:00Z"));
  expect(new Date(next).toISOString()).toBe("2025-07-04T07:00:00.000Z"); // 3am EDT = 07:00 UTC
});
it("catchUp:'skip' skips missed occurrences on downtime; 'fireOnce' fires exactly one", async () => { /* advance clock past several periods before ticking; assert skip vs fireOnce counts */ });
it("Convex-parity: a verbatim cronJobs() crons.ts registers + fires unchanged", async () => { /* the crons.ts shape from the spec §5.2 */ });
```

- [ ] **Step 2: Run — verify it fails.** `bun run --filter @stackbase/scheduler test crons` → FAIL.

- [ ] **Step 3: `crons.ts` registry + `computeNextRun`**
`cronJobs()` returns an object collecting entries `{ name, spec, tz, catchUp, workFnPath, workArgs }`; `export default crons`. At boot (a boot step the component adds), reconcile entries into the `crons` table (deterministic by `name`; insert-or-update). `computeNextRun(spec, tz, afterTs)` wraps `cron-parser` (`CronExpressionParser.parse(expr, { currentDate, tz })`) for cron specs and does arithmetic for intervals.

- [ ] **Step 4: Dual-job cadence (`modules.ts`)**
`scheduler:_cronTick(cronName)` — a mutation: read the `crons` row; compute `next = computeNextRun(spec, tz, anchor)` where `anchor = lastScheduledTs` (clock-anchored, not `now()`); apply `catchUp` (skip/fireOnce/fireAll) if `next` is already past; **schedule a separate work job** (`enqueueInternal(workFnPath, workArgs, {runAt: fireTs})`) and **reschedule the cadence** (`enqueueInternal("scheduler:_cronTick", {cronName}, {runAt: next})`) — decoupled so a slow work job never drifts the cadence. Use a deterministic occurrence key `{cronName}:{fireTs}` + insert-or-noop to dedupe.

- [ ] **Step 5: Codegen (`packages/codegen/*`)**
Emit `cronJobs()` (re-exported so `import { cronJobs } from "./_generated/server"` resolves) and ensure `internal.*` function references are generated (so `crons.ts` + `runAfter(ms, internal.foo.bar, …)` type-check). Follow the existing codegen for `api.*`.

- [ ] **Step 6: Run — verify it passes; workspace green + commit**
`bun run --filter @stackbase/scheduler test crons` → PASS; whole workspace green.
```bash
git add components/scheduler/src/crons.ts components/scheduler/src/schema.ts components/scheduler/src/modules.ts components/scheduler/src/index.ts packages/codegen components/scheduler/test/crons.test.ts
git commit -m "feat(scheduler): cronJobs() registry, cron-parser timezones, dual-job clock-anchored crons + catch-up; codegen"
```

---

## Task 6: Workflow-ready primitives + default-install + Convex-parity acceptance + E2E

**Files:**
- Modify: `components/scheduler/src/{facade.ts,modules.ts}`, the default project template, `CLAUDE.md`
- Test: `components/scheduler/test/workflow-ready.test.ts`, `packages/cli/test/scheduler-e2e.test.ts`

**Interfaces:**
- Consumes: all prior tasks.
- Produces: `enqueue(fnRef, args, { onComplete, context, runAfter:0 })` round-tripping `context` verbatim and calling `onComplete` (a mutation) with `{ jobId, context, result }`; the scheduler component in the default template; the E2E parity proof through `stackbase dev`.

- [ ] **Step 1: Write the failing tests**

`components/scheduler/test/workflow-ready.test.ts`:
```ts
it("enqueue with onComplete + context calls onComplete (mutation) with the opaque context round-tripped verbatim", async () => {
  const seen: any[] = [];
  // enqueue "app:work" with context={workflowId:"w1",generationNumber:3}, onComplete="app:done";
  // app:done is a mutation that pushes its args; tick; assert seen[0] === { jobId, context:{workflowId:"w1",generationNumber:3}, result:{kind:"success",value:...} }
});
it("runAfter:0 re-enqueue is cheap and fires on the next tick", async () => { /* enqueue runAfter:0, tick, ran once */ });
```

`packages/cli/test/scheduler-e2e.test.ts` — through the shipped dev server (the "test through the shipped entrypoint" lesson): start `startDevServer` with a project that has the scheduler default-installed + a mutation that `runAfter(0, internal.work, …)`; call the mutation over the real path; assert the scheduled work ran (poll the `scheduler/jobs` table state → `success`, via the admin browse path). Mirror `packages/cli/test/admin-browse-e2e.test.ts` harness.

- [ ] **Step 2: Run — verify they fail.** FAIL — `onComplete` payload not wired; scheduler not in template.

- [ ] **Step 3: Wire `onComplete` + `context` (`modules.ts`, `facade.ts`)**
In `_complete`, when `onComplete` is set: read the job's `context` from `job_args`; `enqueueInternal(onComplete, { jobId, context, result }, { runAfter: 0 })`. Ensure `context` is stored + returned verbatim (opaque JSONValue). Confirm `runAfter:0` writes `nextTs = now()` so it's immediately due (cheap; the reactive wake fires it).

- [ ] **Step 4: Default-install the scheduler**
Add `@stackbase/scheduler` (`defineScheduler()`) to the default project template's component set so `ctx.scheduler` + `cronJobs()` are present out of the box (Convex parity). (Find where the template composes components — mirror how auth/authz are included; if the CLI's example/template lists components, add it there.)

- [ ] **Step 5: Run — verify they pass**
`bun run --filter @stackbase/scheduler test workflow-ready` and `bun run --filter @stackbase/cli test scheduler-e2e` → PASS.

- [ ] **Step 6: Update `CLAUDE.md`**
Note `@stackbase/scheduler` (component, default-installed, Convex-parity `ctx.scheduler`/crons) + the new recurring `driver` component seam under what-works.

- [ ] **Step 7: Whole workspace green + commit**
`bun run build && bun run typecheck && bun run test` → PASS.
```bash
git add components/scheduler packages/cli CLAUDE.md <template files>
git commit -m "feat(scheduler): onComplete/context workflow primitives, default-install, Convex-parity E2E"
```

---

## Self-Review (completed by plan author)

**Spec coverage:** §3 driver seam → Task 1. §4 data model → Task 2 (+crons table Task 5, signals used Task 3). §5.1 facade → Task 2; §5.2 crons → Task 5; §5.3 enqueue/onComplete/context → Task 2 (enqueue) + Task 6 (onComplete/context). §6 driver algorithm → Task 3. §7 contention-free (single-owner/snapshot/signals) → Task 2 (signals) + Task 3 (snapshot-read `_peekDue`, single-owner loop). §8 delivery/retries/lease/cascade/app-version → Task 4 (+ appVersion field Task 2). §9 crons → Task 5. §10 multi-instance/clock → Task 3 (OCC claim) + testable clock throughout. §11 observability → free (namespaced tables). §12 testing → each task + Task 6 E2E. §13 files → matches. §14 out-of-scope → not built. ✅

**Placeholder scan:** No TBD/TODO. Deliberate "recipe-not-transcription" spots (flagged): the exact `composeComponents`/`EmbeddedRuntime.create` arg shapes (told to mirror `admin/test/browse-live.test.ts`), the test helpers `makeRuntimeWithScheduler`/`readTable`/`tick` (contract given, construction mirrors an existing test), and the codegen `cronJobs()` emission (told to follow the existing `api.*` codegen). Each names a concrete existing pattern to copy — no invented APIs.

**Type consistency:** `DriverContext`/`Driver` identical across Task 1 (define) and Task 3 (consume). Job fields (`fnPath`/`kind`/`state`/`nextTs`/`attempts`/`maxFailures`/`lease*`/`onComplete`/`parentId`/`completedTs`) consistent across schema (T2), claim/complete (T3), retries/reclaim/cascade (T4), crons (T5), onComplete (T6). `enqueueInternal` signature stable T2→T6. `computeBackoff`/`computeNextRun` signatures fixed at definition. State values (`pending/inProgress/success/failed/canceled`) identical everywhere. `signals.kind` (`enqueue/complete/cancel`) consistent T2/T3/T4. `runFunction`/`onCommit`/`setTimer`/`now` seam names match T1↔T3. ✅

**Scope note:** Task 3 is the largest (loop + modules + dispatch). It's cohesive (one deliverable: jobs dispatch) and independently testable; splitting claim from run would leave neither testable alone. Kept whole.
