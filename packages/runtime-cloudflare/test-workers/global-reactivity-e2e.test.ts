/**
 * M2c Task 7 — the ship gate for the WHOLE global-reactivity poll chain (Tasks 1-6): the D1
 * `_global_versions` counter (T1) -> kernel `globalReads` (T2) -> threading into the subscription
 * (T3) -> the `byGlobalTable` index (T4) -> `GlobalReactivityPoller` (T5) -> the alarm-driven driver
 * wiring at DO boot (T6) — proven CROSS-DO on REAL workerd: TWO real Durable Objects (both
 * `GlobalReactivityDO` instances — a new small fixture, `global-reactivity-fixture.ts`, mirroring the
 * M2b `GlobalD1DO` fixture almost verbatim — distinct DO ids) sharing ONE real D1 binding (`env.DB`,
 * workerd's actual D1/SQLite dialect), with a live WebSocket subscription on one DO observing a
 * `.global()` write committed on the OTHER. Two differently-named stubs of the SAME `GLOBAL_REACTIVITY_DO`
 * namespace already ARE "two DOs sharing one D1 binding" (exactly how `global-d1-e2e.test.ts`'s own
 * five scenarios work across `GLOBAL_D1_DO`), and `StackbaseDurableObject`'s `/api/sync` WebSocket
 * upgrade is available on every subclass already.
 *
 * The poller's cadence is driven DETERMINISTICALLY, never by a wall-clock sleep: `runDurableObjectAlarm`
 * (from `cloudflare:test`) immediately runs and clears whatever alarm is CURRENTLY scheduled on a DO,
 * regardless of the wall-clock time it was set for — BUT the runtime's own `fireDueTimers` (what a DO's
 * `alarm()` handler calls) still gates each due driver timer on its OWN in-process `atMs <= now()`
 * check, and a REAL DO's module scope can't share a mutable injected clock with the test file the way
 * the Node-fake `global-reactivity-driver.test.ts` shares its `let clock` closure directly with an
 * in-process `StackbaseDurableObject`. So this file's fixture (`GlobalReactivityDO`) is armed with a
 * new `DurableObjectAppConfig.globalReactivityPollMs: 0` (a Task-7 addition to `durable-object.ts`,
 * threaded straight through to `bootDurableObjectRuntime`'s existing `globalReactivityPollMs` option) —
 * the poller STILL only ever fires when explicitly triggered via `runDurableObjectAlarm` (never a
 * free-running timer), but a zero interval means any ordinary async overhead between arming and firing
 * (a WS upgrade, a D1 round-trip) already makes the armed timer genuinely due by real wall-clock time,
 * with no explicit `setTimeout`/sleep anywhere in this file.
 *
 * Because `alarm()` -> `runtime.fireDueTimers()` -> the driver's `wake()` kicks off `tick()` (an async
 * D1 read + possibly `notifyWrites`) WITHOUT awaiting it (see `global-reactivity-driver.ts`'s `wake()`
 * — the same fire-and-forget shape the Node-fake driver test documents), `runDurableObjectAlarm`'s own
 * promise can resolve before that in-flight tick has actually finished. `waitForAlarmRearm` below is
 * this file's equivalent of that test's `waitFor(() => state.storage.peekAlarm() === ...)`: it polls
 * the DO's REAL `state.storage.getAlarm()` (via `runInDurableObject`) until the driver's post-tick
 * re-arm has actually landed, which — because re-arm only runs in `tick()`'s own `.finally()` — is the
 * synchronization point proving the D1 read (and any `notifyWrites` push) has fully resolved. Firing
 * order always establishes the poller's first-seen baseline BEFORE the write under test
 * (`GlobalReactivityPoller`'s documented first-tick-doesn't-invalidate semantic — see
 * `global-reactivity-poller.ts`'s header doc), then a second fire is the actual diff-and-push.
 *
 * The 5 ship-gate assertions (Task 7 brief):
 *   1. a `.global()` write via DO-A is observed by a live global subscription on DO-B (the cross-DO
 *      heart) once DO-B's alarm fires;
 *   2. a further DO-B alarm fire with no intervening write pushes nothing;
 *   3. a same-DO global subscription (write and subscribe on the SAME DO) also updates via the poll,
 *      not instantly off the commit path;
 *   4. a global-unique violation still rejects (the poller wiring doesn't disturb the existing D1
 *      write-rejection chain);
 *   5. read-your-own-writes on the writer's own DO (the pending overlay, unaffected by polling).
 *
 * Every DO instance here uses a FRESH `idFromName` and every `counters` row uses a `gr-`-prefixed key,
 * scoped per scenario, to avoid D1-level unique-index collisions with `global-d1-e2e.test.ts`'s own
 * keys — `isolatedStorage: false` + `singleWorker: true` (see `vitest.workers.config.ts`) keep the
 * shared D1 database's state live across this whole test run, including across test FILES.
 */
import { describe, it, expect } from "vitest";
import { env, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";

interface DoNs {
  idFromName(n: string): unknown;
  get(id: unknown): { fetch(req: Request): Promise<Response & { webSocket?: WebSocket }> };
}
const DO = () => (env as { GLOBAL_REACTIVITY_DO: DoNs }).GLOBAL_REACTIVITY_DO;
const stub = (name: string) => DO().get(DO().idFromName(name));

function post(path: string, bodyObj: unknown): Request {
  return new Request(`https://do.test${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(bodyObj),
  });
}

async function run(s: ReturnType<typeof stub>, path: string, args: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await s.fetch(post("/api/run", { path, args }));
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

async function waitFor(cond: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
}

/**
 * Poll the DO's REAL durable alarm slot (via `runInDurableObject`) until something is armed again —
 * the driver's post-`tick()` re-arm, which only happens in `tick()`'s own `.finally()` once the D1
 * `readVersions` (and any `notifyWrites`) has fully resolved. This is the deterministic
 * synchronization point substituting for a wall-clock sleep after `runDurableObjectAlarm`.
 */
async function waitForAlarmRearm(s: ReturnType<typeof stub>, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  for (;;) {
    const armed = await runInDurableObject(s as never, async (_i, state) => (await state.storage.getAlarm()) !== null);
    if (armed) return;
    if (Date.now() - start > timeoutMs) throw new Error("waitForAlarmRearm timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
}

/** Bounded-poll `state.storage.getAlarm()` (the REAL armed timestamp) until it is actually due by real
 *  wall-clock time — NOT a blind sleep for the poller's whole cadence: with `globalReactivityPollMs`
 *  set near-zero on this file's fixture (see its header doc), this settles almost immediately (the
 *  ordinary async overhead of a WS upgrade / D1 round-trip already elapses more real time than the
 *  cadence). A `null` reading (nothing currently scheduled) is treated as "proceed" too: workerd's own
 *  local alarm simulation can auto-fire a genuinely-due alarm in the background independent of this
 *  test's explicit `runDurableObjectAlarm` calls (confirmed empirically — a near-zero cadence makes a
 *  once-armed timer due almost immediately either way), so `null` here means a tick is already in
 *  flight or just landed, not that nothing was ever armed (`waitForAlarmRearm` is what guards THAT). */
async function waitUntilAlarmDue(s: ReturnType<typeof stub>, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  for (;;) {
    const armedAt = await runInDurableObject(s as never, async (_i, state) => state.storage.getAlarm());
    if (armedAt === null || Date.now() >= armedAt) return;
    if (Date.now() - start > timeoutMs) throw new Error("waitUntilAlarmDue timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
}

/**
 * Fire a DO's currently-scheduled alarm deterministically (no wall-clock sleep for the poller's
 * cadence) and block until the driver's own post-tick re-arm has landed — i.e. until its `tick()` has
 * genuinely finished. `runDurableObjectAlarm`'s own return value is intentionally NOT the success
 * signal here (see `waitUntilAlarmDue`'s doc: a near-zero cadence means workerd's own local alarm
 * simulation can race this explicit call and consume the SAME due alarm first, in which case this call
 * correctly finds nothing left to fire — the tick still ran, just not via THIS call). Callers assert
 * on the OBSERVABLE outcome (the pushed frame, or its absence) instead, which is correct regardless of
 * which of the two paths actually ran the tick. */
async function fireAlarmAndSettle(s: ReturnType<typeof stub>): Promise<void> {
  // `DoAlarmWakeHost.armWake` is explicitly fire-and-forget (never awaited by the boot/re-arm flow —
  // see its own doc comment), so a DO's `blockConcurrencyWhile`-wrapped boot (or a prior tick's
  // `finally`) can return before the underlying `ctx.storage.setAlarm` write has actually landed.
  // Without this guard, firing immediately after boot could see `getAlarm() === null` before the
  // driver's bootstrap force-arm (Task 6) has actually persisted.
  await waitForAlarmRearm(s);
  await waitUntilAlarmDue(s);
  await runDurableObjectAlarm(s as never);
  await waitForAlarmRearm(s);
}

/** Open a real WebSocket to a DO's sync endpoint and subscribe to one `.global()` query. */
async function subscribe(s: ReturnType<typeof stub>, queryId: number, udfPath: string, args: unknown): Promise<{ received: string[] }> {
  const upgrade = await s.fetch(new Request("https://do.test/api/sync", { headers: { Upgrade: "websocket" } }));
  expect(upgrade.status).toBe(101);
  const ws = upgrade.webSocket!;
  ws.accept();
  const received: string[] = [];
  ws.addEventListener("message", (e: MessageEvent) => {
    received.push(typeof e.data === "string" ? e.data : "");
  });
  ws.send(JSON.stringify({ type: "ModifyQuerySet", add: [{ queryId, udfPath, args }], remove: [] }));
  await waitFor(() => received.some((m) => m.includes("Transition")));
  return { received };
}

function transitionCount(received: string[]): number {
  return received.filter((m) => m.includes("Transition")).length;
}

describe("M2c ship gate: cross-DO .global() reactivity on REAL workerd (miniflare multi-DO + D1)", () => {
  it("1&2. a write on DO-A is observed by DO-B's live subscription via its poller; a further tick with no write pushes nothing", async () => {
    const doA = stub("gr-cross-a");
    const doB = stub("gr-cross-b");

    // Subscribe on DO-B BEFORE any write — its initial (empty) result is delivered synchronously,
    // over the normal subscribe path (never the poller).
    const { received } = await subscribe(doB, 1, "counters:getByKey", { key: "gr-cross-1" });
    expect(transitionCount(received)).toBe(1);

    // Fire DO-B's alarm with no writes yet: the poller's bootstrap tick, which establishes ITS
    // baseline version for `counters` (first-seen — does not invalidate, per Task 5's documented
    // semantics). Must happen BEFORE the write, or the very first-ever tick would wrongly treat the
    // post-write version as the baseline and silently swallow the update.
    await fireAlarmAndSettle(doB);
    expect(transitionCount(received)).toBe(1); // unchanged — a baseline tick, not a push

    // The write happens on DO-A — a COMPLETELY SEPARATE Durable Object — via the shared D1 binding.
    const before = received.length;
    const created = await run(doA, "counters:create", { key: "gr-cross-1", value: 42 });
    expect(created.status).toBe(200);
    // No push from the commit path itself: DO-A has no socket of its own here, and a `.global()`
    // write never touches local MVCC fan-out on ANY DO (see `executor.ts`'s `globalStore.commitBatch`).
    expect(received.length).toBe(before);

    // Fire DO-B's alarm again — THIS is the cross-DO propagation: DO-B's poller reads D1's bumped
    // `_global_versions` for `counters` (written by DO-A) and pushes DO-B's live subscription. Settle
    // via `waitFor` on the observable push rather than `fireAlarmAndSettle`'s own return value (see its
    // doc: workerd's local alarm simulation can race the explicit call and win, which still means the
    // tick ran — just not attributably to THIS call).
    await fireAlarmAndSettle(doB);
    await waitFor(() => transitionCount(received) > 1);
    expect(transitionCount(received)).toBe(2);
    expect(received.join("")).toContain("gr-cross-1");
    expect(received.join("")).toContain("42");

    // Assertion 2: a further tick with NO intervening write pushes nothing — true regardless of how
    // many (natural or explicit) no-op ticks run in between, since the poller only ever calls
    // `notifyWrites` when a table's version actually moved (Task 5's diff, not a blind re-push).
    const afterCrossDoPush = received.length;
    await fireAlarmAndSettle(doB);
    expect(received.length).toBe(afterCrossDoPush);
    expect(transitionCount(received)).toBe(2);
  });

  it("3. a same-DO global subscription also updates via the poll (not instantly off the commit path)", async () => {
    const doC = stub("gr-same-c");
    const { received } = await subscribe(doC, 1, "counters:getByKey", { key: "gr-same-1" });
    expect(transitionCount(received)).toBe(1);

    // Baseline tick before the write (same reasoning as scenario 1).
    await fireAlarmAndSettle(doC);
    expect(transitionCount(received)).toBe(1);

    // Write via THIS SAME DO instance.
    const before = received.length;
    const created = await run(doC, "counters:create", { key: "gr-same-1", value: 7 });
    expect(created.status).toBe(200);
    // Still no instant push — a `.global()` write bypasses local MVCC fan-out even on the writer's
    // own DO; only the poller's next tick notices it.
    expect(received.length).toBe(before);

    await fireAlarmAndSettle(doC);
    await waitFor(() => transitionCount(received) > 1);
    expect(transitionCount(received)).toBe(2);
    expect(received.join("")).toContain("gr-same-1");
    expect(received.join("")).toContain("7");
  });

  it("4. a global-unique violation still rejects (the poller wiring doesn't disturb the D1 write-rejection chain)", async () => {
    const s = stub("gr-unique-d");
    const first = await run(s, "counters:create", { key: "gr-dup", value: 1 });
    expect(first.status).toBe(200);

    const second = await run(s, "counters:create", { key: "gr-dup", value: 2 });
    expect(second.status).not.toBe(200);
    expect(typeof second.body.error).toBe("string");
    expect(String(second.body.error).toLowerCase()).toContain("unique constraint");
    expect(typeof second.body.code).toBe("string");

    const read = await run(s, "counters:getByKey", { key: "gr-dup" });
    expect(read.body.value).toMatchObject({ key: "gr-dup", value: 1 });
  });

  it("5. read-your-own-writes on the writer's own DO (the pending overlay, unaffected by polling)", async () => {
    const s = stub("gr-ryow-e");
    const res = await run(s, "counters:createAndReadBack", { key: "gr-ryow-1", value: 99 });
    expect(res.status).toBe(200);
    const value = res.body.value as { id: string; byId: { key: string; value: number } | null; byIndexCount: number };
    expect(typeof value.id).toBe("string");
    expect(value.byId).toMatchObject({ key: "gr-ryow-1", value: 99 });
    expect(value.byIndexCount).toBe(1);
  });
});
