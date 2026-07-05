// components/triggers/test/breaker.test.ts — the circuit breaker: a deliveries-per-window safety
// net, distinct from the failure-count breaker (a self-recursive/runaway handler that keeps
// SUCCEEDING too often, not one that fails).
import { describe, it, expect } from "vitest";
import { mutation } from "@helipod/executor";
import { makeRuntimeWithTriggers, readCursors } from "./helpers";

describe("@helipod/triggers — circuit breaker", () => {
  it('1001 deliveries within the window pauses the trigger with pausedReason "circuit-breaker"', async () => {
    let deliveries = 0;
    const { runtime, tick } = await makeRuntimeWithTriggers(
      {
        "notifications:_onMessage": mutation(async () => {
          deliveries++;
          return null;
        }),
        "app:insert": mutation(async (ctx: any, a: { body: string }) => ctx.db.insert("messages", { body: a.body })), // eslint-disable-line @typescript-eslint/no-explicit-any
      },
      // `batchSize: 1` — each of the 1001 messages below becomes its own delivery (one handler
      // call per message), so the breaker's "N deliveries in the window" count is exercised
      // directly rather than needing to reason about batch grouping.
      { messages: { handler: "notifications:_onMessage", batchSize: 1, maxDeliveriesPerWindow: 1000 } },
    );

    // 1001 separate commits, all well within the breaker's 10s window (no virtual clock advance —
    // they all land "at once" from the driver's perspective).
    for (let i = 0; i < 1001; i++) await runtime.run("app:insert", { body: `m${i}` });
    await tick("messages");

    // The 1001st delivery is preemptively blocked (not run-then-punished) — see
    // `recordDeliveryAndCheckBreaker`'s call site in `../src/driver.ts`.
    expect(deliveries).toBe(1000);
    const cursors = await readCursors(runtime);
    expect(cursors[0]).toMatchObject({ name: "messages", state: "paused", pausedReason: "circuit-breaker" });

    // Paused — further ticks do not resume deliveries on their own.
    await tick("messages");
    expect(deliveries).toBe(1000);
  });

  it("a custom maxDeliveriesPerWindow is honored", async () => {
    let deliveries = 0;
    const { runtime, tick } = await makeRuntimeWithTriggers(
      {
        "notifications:_onMessage": mutation(async () => {
          deliveries++;
          return null;
        }),
        "app:insert": mutation(async (ctx: any, a: { body: string }) => ctx.db.insert("messages", { body: a.body })), // eslint-disable-line @typescript-eslint/no-explicit-any
      },
      { messages: { handler: "notifications:_onMessage", batchSize: 1, maxDeliveriesPerWindow: 5 } },
    );

    for (let i = 0; i < 10; i++) await runtime.run("app:insert", { body: `m${i}` });
    await tick("messages");

    expect(deliveries).toBe(5);
    const cursors = await readCursors(runtime);
    expect(cursors[0]).toMatchObject({ state: "paused", pausedReason: "circuit-breaker" });
  });

  it("deliveries under the threshold never trip the breaker", async () => {
    let deliveries = 0;
    const { runtime, tick } = await makeRuntimeWithTriggers(
      {
        "notifications:_onMessage": mutation(async () => {
          deliveries++;
          return null;
        }),
        "app:insert": mutation(async (ctx: any, a: { body: string }) => ctx.db.insert("messages", { body: a.body })), // eslint-disable-line @typescript-eslint/no-explicit-any
      },
      { messages: { handler: "notifications:_onMessage", batchSize: 1, maxDeliveriesPerWindow: 5 } },
    );

    for (let i = 0; i < 3; i++) await runtime.run("app:insert", { body: `m${i}` });
    await tick("messages");

    expect(deliveries).toBe(3);
    const cursors = await readCursors(runtime);
    expect(cursors[0]).toMatchObject({ state: "running" });
  });
});
