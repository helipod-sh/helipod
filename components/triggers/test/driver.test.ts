// components/triggers/test/driver.test.ts — the cursor loop: batch delivery, continuation, quiet
// tables, byte-budget cutting, and per-trigger sequential isolation.
import { describe, it, expect } from "vitest";
import { mutation, action } from "@stackbase/executor";
import { makeRuntimeWithTriggers, readCursors } from "./helpers";

describe("@stackbase/triggers — driver loop", () => {
  it("a batch is delivered to the handler and the cursor advances to maxScannedTs", async () => {
    const delivered: unknown[][] = [];
    const { runtime, tick } = await makeRuntimeWithTriggers(
      {
        "notifications:_onMessage": mutation(async (_ctx: any, a: { changes: unknown[] }) => { // eslint-disable-line @typescript-eslint/no-explicit-any
          delivered.push(a.changes);
          return null;
        }),
        "app:insert": mutation(async (ctx: any, a: { body: string }) => ctx.db.insert("messages", { body: a.body })), // eslint-disable-line @typescript-eslint/no-explicit-any
      },
      { messages: { handler: "notifications:_onMessage" } },
    );

    await runtime.run("app:insert", { body: "hello" });
    await tick("messages");

    expect(delivered).toHaveLength(1);
    expect(delivered[0]).toHaveLength(1);
    expect(delivered[0]![0]).toMatchObject({ table: "messages", op: "insert", newDoc: { body: "hello" } });

    // `cursorTs` isn't pinned to an exact literal here — see the "quiet watched table" test below
    // for why: it's a GLOBAL log timestamp, shared with every other table's (including
    // `triggers/cursors`' own bookkeeping) writes, not a per-trigger delivery counter.
    const cursors = await readCursors(runtime);
    expect(cursors[0]).toMatchObject({ name: "messages", failureCount: 0 });
    expect(cursors[0].cursorTs).toBeGreaterThanOrEqual(1);
  });

  it("a full batch keeps looping within one pass — no manual re-tick needed", async () => {
    const delivered: unknown[][] = [];
    const { runtime, tick } = await makeRuntimeWithTriggers(
      {
        "notifications:_onMessage": mutation(async (_ctx: any, a: { changes: unknown[] }) => { // eslint-disable-line @typescript-eslint/no-explicit-any
          delivered.push(a.changes);
          return null;
        }),
        // Inserts TWO messages in one commit (one ts) — with `batchSize: 2` this makes each
        // `readLog` page land exactly on a ts-group boundary (see `runtime.ts`'s degenerate
        // same-ts-group handling), so every delivery below is a genuine full (size-2) batch,
        // rather than the conservative single-row trailing-group drop a `limit` scan otherwise
        // applies (see `DriverContext.readLog`'s doc comment).
        "app:insertPair": mutation(async (ctx: any, a: { bodies: string[] }) => { // eslint-disable-line @typescript-eslint/no-explicit-any
          for (const body of a.bodies) await ctx.db.insert("messages", { body });
          return null;
        }),
      },
      { messages: { handler: "notifications:_onMessage", batchSize: 2 } },
    );

    // 3 commits, 2 messages each = 6 messages, 3 distinct ts — batchSize 2 forces 3 full-batch
    // deliveries, all within the SAME `tick()` call (the loop's own continuation, not a re-tick).
    await runtime.run("app:insertPair", { bodies: ["a1", "a2"] });
    await runtime.run("app:insertPair", { bodies: ["b1", "b2"] });
    await runtime.run("app:insertPair", { bodies: ["c1", "c2"] });
    await tick("messages");

    expect(delivered).toHaveLength(3);
    expect(delivered.map((b) => b.length)).toEqual([2, 2, 2]);
  });

  it("a quiet watched table on a busy log still advances the cursor without any deliveries", async () => {
    const delivered: unknown[][] = [];
    const { runtime, tick } = await makeRuntimeWithTriggers(
      {
        "notifications:_onMessage": mutation(async (_ctx: any, a: { changes: unknown[] }) => { // eslint-disable-line @typescript-eslint/no-explicit-any
          delivered.push(a.changes);
          return null;
        }),
        "app:insertUnwatched": mutation(async (ctx: any, a: { body: string }) => ctx.db.insert("unwatched", { body: a.body })), // eslint-disable-line @typescript-eslint/no-explicit-any
      },
      { messages: { handler: "notifications:_onMessage" } },
    );

    // Only writes to `unwatched` — `messages` (the watched table) never changes.
    await runtime.run("app:insertUnwatched", { body: "noise-1" });
    await runtime.run("app:insertUnwatched", { body: "noise-2" });
    await tick("messages");

    expect(delivered).toEqual([]); // no matching changes — the handler is never called
    // `cursorTs` DOES advance (proving quiet-table progress happened, not a stall) — but not to an
    // exact hand-computed literal: it's a GLOBAL log timestamp. `triggers:_advanceCursor` itself is
    // a commit (to `triggers/cursors`), so the act of recording "caught up" nudges the global tip
    // forward too; a later read of this same cursor could legitimately show it having absorbed that
    // (harmless) self-traffic as well. The behavior under test — no deliveries, progress was made —
    // doesn't depend on the counter's exact value.
    const cursors = await readCursors(runtime);
    expect(cursors[0].cursorTs as number).toBeGreaterThanOrEqual(2); // past both `unwatched` commits
  });

  it("byte-budget cut: an oversized batch is delivered in pieces, never splitting a single commit's ts group", async () => {
    const bigBody = "x".repeat(400_000); // ~400KB serialized per change — 3 of them exceed the ~1MB budget
    const deliveredBatches: number[] = [];
    const { runtime, tick } = await makeRuntimeWithTriggers(
      {
        "notifications:_onMessage": mutation(async (_ctx: any, a: { changes: unknown[] }) => { // eslint-disable-line @typescript-eslint/no-explicit-any
          deliveredBatches.push(a.changes.length);
          return null;
        }),
        "app:insert": mutation(async (ctx: any, a: { body: string }) => ctx.db.insert("messages", { body: a.body })), // eslint-disable-line @typescript-eslint/no-explicit-any
      },
      { messages: { handler: "notifications:_onMessage", batchSize: 64 } },
    );

    for (let i = 0; i < 4; i++) await runtime.run("app:insert", { body: bigBody });
    await tick("messages");

    // Cut before the budget is exceeded — not all 4 in one batch.
    expect(deliveredBatches.length).toBeGreaterThan(1);
    expect(Math.max(...deliveredBatches)).toBeLessThan(4);
    expect(deliveredBatches.reduce((a, b) => a + b, 0)).toBe(4); // every change still delivered, just split
  });

  it("sequential per trigger: a slow handler on one trigger does not block a second trigger's progress", async () => {
    // The slow handler is an ACTION, deliberately: this engine's mutations serialize through a
    // single-writer transactor (the whole architecture — see CLAUDE.md's reactivity model), so a
    // hanging MUTATION handler would block every other mutation in the runtime, not just its own
    // trigger — that's a property of the engine, not something a driver could route around.
    // Actions run OUTSIDE the transaction (no `ctx.db`, no writer lock — see `@stackbase/executor`'s
    // `ActionCtx` doc comment), so a slow action is the correct way to prove "sequential per
    // trigger, concurrent across triggers": the fast trigger's MUTATION handler must still be able
    // to acquire the writer lock and complete while the slow action is in flight.
    let releaseSlow: (() => void) | undefined;
    const slowStarted: string[] = [];
    const fastDelivered: string[] = [];
    const { runtime, tick } = await makeRuntimeWithTriggers(
      {
        "app:_onSlow": action(async (_ctx: any, a: { changes: { newDoc: { body: string } }[] }) => { // eslint-disable-line @typescript-eslint/no-explicit-any
          slowStarted.push(a.changes[0]!.newDoc.body);
          await new Promise<void>((resolve) => { releaseSlow = resolve; });
          return null;
        }),
        "app:_onFast": mutation(async (_ctx: any, a: { changes: { newDoc: { body: string } }[] }) => { // eslint-disable-line @typescript-eslint/no-explicit-any
          fastDelivered.push(a.changes[0]!.newDoc.body);
          return null;
        }),
        "app:insertMessage": mutation(async (ctx: any, a: { body: string }) => ctx.db.insert("messages", { body: a.body })), // eslint-disable-line @typescript-eslint/no-explicit-any
        "app:insertRoom": mutation(async (ctx: any, a: { body: string }) => ctx.db.insert("rooms", { body: a.body })), // eslint-disable-line @typescript-eslint/no-explicit-any
      },
      {
        messages: { handler: "app:_onSlow" },
        rooms: { handler: "app:_onFast" },
      },
    );

    await runtime.run("app:insertMessage", { body: "slow-1" });
    await runtime.run("app:insertRoom", { body: "fast-1" });

    const slowTick = tick("messages"); // hangs until `releaseSlow()` is called
    // The fast trigger's own tick must complete independently, without waiting on the slow one.
    await tick("rooms");
    expect(fastDelivered).toEqual(["fast-1"]);
    expect(slowStarted).toEqual(["slow-1"]); // started, but not yet resolved

    releaseSlow?.();
    await slowTick;
  });
});
