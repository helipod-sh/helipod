// components/triggers/test/reliability.test.ts — failure -> redelivery (dedup via changeId),
// failureCount persistence across a simulated restart, pause at MAX_CONSECUTIVE_FAILURES, resume.
import { describe, it, expect } from "vitest";
import { SqliteDocStore, NodeSqliteAdapter } from "@stackbase/docstore-sqlite";
import { mutation } from "@stackbase/executor";
import { MAX_CONSECUTIVE_FAILURES } from "../src/index";
import { makeRuntimeWithTriggers, readCursors } from "./helpers";

// A failed delivery arms an in-memory backoff gate (`nextAttemptAt` in `../src/driver.ts`) that
// blocks the NEXT attempt until real time (per the injected virtual clock) reaches it — a real
// retry timer would fire on its own; a test instead advances the clock past any conceivable
// `computeBackoff` delay (max 64s at failureCount=7, the last retry before pausing at
// `MAX_CONSECUTIVE_FAILURES`=8, with 100% jitter) before its next `tick()`, so every retry in a
// test loop actually attempts instead of silently no-oping on a still-armed gate.
const PAST_ANY_BACKOFF_MS = 200_000;

describe("@stackbase/triggers — reliability", () => {
  it("a failed delivery redelivers the SAME changeIds — even when the rescan window later grows", async () => {
    const seenChangeIds: string[][] = [];
    let failNext = true;
    let clock = 1_000_000;
    const { runtime, tick } = await makeRuntimeWithTriggers(
      {
        "notifications:_onMessage": mutation(async (_ctx: any, a: { changes: { changeId: string }[] }) => { // eslint-disable-line @typescript-eslint/no-explicit-any
          seenChangeIds.push(a.changes.map((c) => c.changeId));
          if (failNext) {
            failNext = false;
            throw new Error("boom");
          }
          return null;
        }),
        "app:insert": mutation(async (ctx: any, a: { body: string }) => ctx.db.insert("messages", { body: a.body })), // eslint-disable-line @typescript-eslint/no-explicit-any
      },
      { messages: { handler: "notifications:_onMessage" } },
      { now: () => clock },
    );

    await runtime.run("app:insert", { body: "m1" });
    await tick("messages"); // fails — the batch (just m1) is NOT delivered-and-advanced

    expect(seenChangeIds).toHaveLength(1);
    const firstAttemptIds = seenChangeIds[0]!;
    expect(firstAttemptIds).toHaveLength(1);

    // A NEW commit lands before the retry — the rescan window is now larger.
    await runtime.run("app:insert", { body: "m2" });
    clock += PAST_ANY_BACKOFF_MS;
    await tick("messages"); // retries — succeeds this time

    expect(seenChangeIds).toHaveLength(2);
    const secondAttemptIds = seenChangeIds[1]!;
    // The redelivered set is a SUPERSET (m2 joined in), but m1's changeId is byte-identical across
    // both attempts — the dedup key a handler relies on never shifts under it.
    expect(secondAttemptIds).toEqual(expect.arrayContaining(firstAttemptIds));
    expect(firstAttemptIds[0]).toBe(secondAttemptIds[0]); // m1's changeId, unchanged
  });

  it("failureCount persists across a simulated restart (a new driver instance, same store)", async () => {
    const store = new SqliteDocStore(new NodeSqliteAdapter());
    let attempts = 0;
    const handler = mutation(async () => {
      attempts++;
      throw new Error(`fail ${attempts}`);
    });
    const modules = {
      "notifications:_onMessage": handler,
      "app:insert": mutation(async (ctx: any, a: { body: string }) => ctx.db.insert("messages", { body: a.body })), // eslint-disable-line @typescript-eslint/no-explicit-any
    };

    const first = await makeRuntimeWithTriggers(modules, { messages: { handler: "notifications:_onMessage" } }, { store });
    await first.runtime.run("app:insert", { body: "m1" });
    await first.tick("messages"); // fails once — failureCount -> 1
    let cursors = await readCursors(first.runtime);
    expect(cursors[0]).toMatchObject({ name: "messages", failureCount: 1, state: "running" });
    expect(attempts).toBe(1);

    // "Restart": a brand-new driver instance (a fresh `makeRuntimeWithTriggers` call) over the SAME
    // store, with the SAME (still-failing) handler. The in-memory backoff gate and the `attempts`
    // closure counter are process-local and don't carry over — only the PERSISTED `failureCount`
    // does. `makeRuntimeWithTriggers`'s own settle-tick (see its doc comment) is what drives THIS
    // instance's first (ungated — a fresh driver's backoff map starts empty) retry attempt.
    const second = await makeRuntimeWithTriggers(modules, { messages: { handler: "notifications:_onMessage" } }, { store });
    cursors = await readCursors(second.runtime);
    expect(cursors[0]).toMatchObject({ name: "messages", failureCount: 2, state: "running" }); // NOT reset to 1 by the restart
    expect(attempts).toBe(2);
  });

  it(`pauses with pausedReason "max-failures" after ${MAX_CONSECUTIVE_FAILURES} consecutive failures, and stops retrying`, async () => {
    let attempts = 0;
    let clock = 1_000_000;
    const { runtime, tick } = await makeRuntimeWithTriggers(
      {
        "notifications:_onMessage": mutation(async () => {
          attempts++;
          throw new Error("always fails");
        }),
        "app:insert": mutation(async (ctx: any, a: { body: string }) => ctx.db.insert("messages", { body: a.body })), // eslint-disable-line @typescript-eslint/no-explicit-any
      },
      { messages: { handler: "notifications:_onMessage" } },
      { now: () => clock },
    );
    await runtime.run("app:insert", { body: "m1" });

    // One `tick()` per consecutive failure, advancing the virtual clock well past the backoff gate
    // each time — simulates each real retry timer eventually firing, without waiting real time.
    for (let i = 0; i < MAX_CONSECUTIVE_FAILURES; i++) {
      clock += PAST_ANY_BACKOFF_MS;
      await tick("messages");
    }

    expect(attempts).toBe(MAX_CONSECUTIVE_FAILURES);
    const cursors = await readCursors(runtime);
    expect(cursors[0]).toMatchObject({
      name: "messages",
      state: "paused",
      pausedReason: "max-failures",
      failureCount: MAX_CONSECUTIVE_FAILURES,
    });

    // Further ticks do NOT retry — the trigger is paused.
    clock += PAST_ANY_BACKOFF_MS;
    await tick("messages");
    expect(attempts).toBe(MAX_CONSECUTIVE_FAILURES);
  });

  it("triggers:resume un-pauses a trigger and clears its failure/pause diagnostics", async () => {
    let shouldFail = true;
    let clock = 1_000_000;
    const delivered: unknown[] = [];
    const { runtime, tick } = await makeRuntimeWithTriggers(
      {
        "notifications:_onMessage": mutation(async (_ctx: any, a: { changes: unknown[] }) => { // eslint-disable-line @typescript-eslint/no-explicit-any
          if (shouldFail) throw new Error("always fails");
          delivered.push(...a.changes);
          return null;
        }),
        "app:insert": mutation(async (ctx: any, a: { body: string }) => ctx.db.insert("messages", { body: a.body })), // eslint-disable-line @typescript-eslint/no-explicit-any
      },
      { messages: { handler: "notifications:_onMessage" } },
      { now: () => clock },
    );
    await runtime.run("app:insert", { body: "m1" });
    for (let i = 0; i < MAX_CONSECUTIVE_FAILURES; i++) {
      clock += PAST_ANY_BACKOFF_MS;
      await tick("messages");
    }

    let cursors = await readCursors(runtime);
    expect(cursors[0]).toMatchObject({ state: "paused", pausedReason: "max-failures" });

    shouldFail = false;
    await runtime.run("triggers:resume", { name: "messages" });
    await tick("messages");

    cursors = await readCursors(runtime);
    expect(cursors[0]).toMatchObject({ name: "messages", state: "running", failureCount: 0 });
    // `compact()` OMITS undefined-valued keys entirely (rather than writing a literal `undefined`
    // — the wire codec rejects that), so these are absent keys, not `undefined`-valued ones;
    // `toBeUndefined()` reads correctly either way.
    expect(cursors[0].lastError).toBeUndefined();
    expect(cursors[0].pausedReason).toBeUndefined();
    expect(delivered).toHaveLength(1); // the originally-failed batch is finally delivered
  });
});
