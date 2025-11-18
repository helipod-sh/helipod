/**
 * S4 — `closeDisposition`'s pure-function contract, including Task 2's park swap. See
 * `reconnect.test.ts` and `outbox-enqueue.test.ts` for the through-the-client integration proof
 * (real `StackbaseClient` + a real transport close).
 */
import { describe, it, expect } from "vitest";
import { closeDisposition, MutationUndeliveredError } from "../src/delivery-policy";
import type { PendingMutation } from "../src/mutation-log";

function makePending(overrides: Partial<PendingMutation> = {}): PendingMutation {
  return {
    requestId: "r0",
    udfPath: "messages:send",
    args: { body: "hi" },
    seed: { entropy: "e0", now: 0 },
    touched: new Set(),
    status: { type: "inflight" },
    ...overrides,
  };
}

describe("closeDisposition — pre-Task-2 behavior, byte-identical", () => {
  it("unsent retains, inflight rejects+drops, completed drops — no `armed` argument at all", () => {
    const entries = [
      makePending({ requestId: "u", status: { type: "unsent" } }),
      makePending({ requestId: "i", status: { type: "inflight" } }),
      makePending({ requestId: "c", status: { type: "completed", commitTs: 5, completedAt: 5 } }),
    ];
    const disp = closeDisposition(entries);
    expect(disp.retain).toEqual(["u"]);
    expect(disp.reject).toEqual(["i"]);
    expect(disp.drop.sort()).toEqual(["c", "i"]);
    expect(disp.park).toEqual([]);
  });

  it("an inflight entry with `durable: true` still rejects (not parked) when `armed` is omitted/false", () => {
    const entries = [makePending({ requestId: "i", status: { type: "inflight" }, clientId: "c1", seq: 0, durable: true })];
    expect(closeDisposition(entries).park).toEqual([]);
    expect(closeDisposition(entries, {}).park).toEqual([]);
    expect(closeDisposition(entries, { armed: false }).reject).toEqual(["i"]);
  });
});

describe("closeDisposition — Task 2's park swap", () => {
  it("park-requires-durability: armed + durable parks; armed + NOT durable still rejects", () => {
    const durable = makePending({ requestId: "durable", status: { type: "inflight" }, clientId: "c1", seq: 0, durable: true });
    const notDurable = makePending({ requestId: "stalled", status: { type: "inflight" }, clientId: "c1", seq: 1, durable: false });
    const disp = closeDisposition([durable, notDurable], { armed: true });
    expect(disp.park).toEqual(["durable"]);
    expect(disp.reject).toEqual(["stalled"]);
    // Both still drop their layer — "the unchanged rule".
    expect(disp.drop.sort()).toEqual(["durable", "stalled"]);
  });

  it("a parked entry is retained (not rejected, not re-dropped) across ANOTHER close", () => {
    const entries = [makePending({ requestId: "p", status: { type: "parked" }, clientId: "c1", seq: 0 })];
    const disp = closeDisposition(entries, { armed: true });
    expect(disp.retain).toEqual(["p"]);
    expect(disp.reject).toEqual([]);
    expect(disp.drop).toEqual([]);
    expect(disp.park).toEqual([]);
  });

  it("armed with no outbox-tracked entries (no clientId) never parks — durable is always falsy for those", () => {
    const entries = [makePending({ requestId: "plain", status: { type: "inflight" } })];
    const disp = closeDisposition(entries, { armed: true });
    expect(disp.park).toEqual([]);
    expect(disp.reject).toEqual(["plain"]);
  });
});

describe("MutationUndeliveredError", () => {
  it("is unaffected by this task — same message, same name", () => {
    const e = new MutationUndeliveredError();
    expect(e.name).toBe("MutationUndeliveredError");
    expect(e.message).toMatch(/connection closed/);
  });
});
