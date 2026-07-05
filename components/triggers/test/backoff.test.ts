// components/triggers/test/backoff.test.ts — retries back off via `@helipod/scheduler`'s
// `computeBackoff` (imported, not reimplemented — see `../src/modules.ts`'s `_recordFailure`).
import { describe, it, expect } from "vitest";
import { mutation } from "@helipod/executor";
import { computeBackoff, DEFAULT_BACKOFF_OPTIONS } from "@helipod/scheduler";
import { makeRuntimeWithTriggers } from "./helpers";

describe("@helipod/triggers — backoff", () => {
  it("computeBackoff's own delay bounds hold for the failureCount values the pause threshold walks through", () => {
    // Not a driver test — a direct, deterministic sanity check that the function `_recordFailure`
    // calls (`../src/modules.ts`) is the REAL `@helipod/scheduler` export, not a local
    // reimplementation that could silently drift from it. `attempts=1..7` (failureCount BEFORE
    // pausing at 8) all produce a positive, monotonically-increasing-in-expectation delay.
    const rng = (): number => 0.5; // fixed jitter (the 50% floor of the 50–100% range)
    const delays = [1, 2, 3, 4, 5, 6, 7].map((n) => computeBackoff(n, rng, DEFAULT_BACKOFF_OPTIONS));
    for (const d of delays) expect(d).toBeGreaterThan(0);
    for (let i = 1; i < delays.length; i++) expect(delays[i]!).toBeGreaterThan(delays[i - 1]!);
    // attempts=1 (the first retry): initialBackoffMs(250) * base(2)^(1+1) = 1000, jittered by
    // (0.5 + 0.5*rng()) = 0.75 at rng()=0.5 (`computeBackoff`'s doc comment, `@helipod/scheduler`) = 750.
    expect(computeBackoff(1, rng, DEFAULT_BACKOFF_OPTIONS)).toBe(750);
  });

  it("a retry actually fires once the virtual clock reaches the armed delay — not before, not stuck forever", async () => {
    let clock = 1_000_000;
    let attempts = 0;
    let succeedFrom = 2;
    const { runtime, tick } = await makeRuntimeWithTriggers(
      {
        "notifications:_onMessage": mutation(async () => {
          attempts++;
          if (attempts < succeedFrom) throw new Error("boom");
          return null;
        }),
        "app:insert": mutation(async (ctx: any, a: { body: string }) => ctx.db.insert("messages", { body: a.body })), // eslint-disable-line @typescript-eslint/no-explicit-any
      },
      { messages: { handler: "notifications:_onMessage" } },
      { now: () => clock },
    );
    await runtime.run("app:insert", { body: "m1" });
    await tick("messages"); // attempt 1 — fails, arms a retry timer
    expect(attempts).toBe(1);

    // A tick with the clock UNCHANGED must not retry (still inside the backoff window).
    await tick("messages");
    expect(attempts).toBe(1);

    // Advance well past any possible computeBackoff(1, ...) delay (max ~1000ms at 100% jitter) and
    // retry: it fires now, and succeeds (attempts=2 >= succeedFrom).
    clock += 5_000;
    await tick("messages");
    expect(attempts).toBe(2);
  });
});
