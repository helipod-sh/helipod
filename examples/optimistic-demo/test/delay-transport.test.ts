import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { ClientTransport } from "@stackbase/client";
import { delayTransport } from "../web/delay-transport";

type Sent = Parameters<ClientTransport["send"]>[0];

function fakeInner() {
  const sent: Sent[] = [];
  let closed = false;
  const closeListeners: Array<() => void> = [];
  const t: ClientTransport = {
    send: (m) => sent.push(m),
    onMessage: () => () => {},
    onClose: (l) => {
      closeListeners.push(l);
      return () => {};
    },
    onReopen: () => () => {},
    close: () => {
      closed = true;
    },
  };
  return {
    t,
    sent,
    isClosed: () => closed,
    fireClose: () => {
      for (const l of closeListeners) l();
    },
  };
}

const MUT = (n: number) => ({ type: "Mutation", requestId: `r${n}` }) as unknown as Sent;
const SUB = { type: "ModifyQuerySet", add: [], remove: [] } as unknown as Sent;

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("delayTransport", () => {
  it("delay 0: mutations pass through immediately", () => {
    const inner = fakeInner();
    const t = delayTransport("ws://x", () => inner.t);
    t.send(MUT(1));
    expect(inner.sent).toEqual([MUT(1)]);
  });

  it("delay 500: a mutation is held exactly the delay, then delivered", () => {
    const inner = fakeInner();
    const t = delayTransport("ws://x", () => inner.t);
    t.setDelay(500);
    t.send(MUT(1));
    expect(inner.sent).toEqual([]);
    vi.advanceTimersByTime(499);
    expect(inner.sent).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(inner.sent).toEqual([MUT(1)]);
  });

  it("non-mutation frames pass through immediately even at 3s delay", () => {
    const inner = fakeInner();
    const t = delayTransport("ws://x", () => inner.t);
    t.setDelay(3000);
    t.send(SUB);
    expect(inner.sent).toEqual([SUB]);
  });

  it("FIFO survives lowering the delay mid-flight: a later 0ms mutation never overtakes an earlier delayed one", () => {
    const inner = fakeInner();
    const t = delayTransport("ws://x", () => inner.t);
    t.setDelay(1000);
    t.send(MUT(1));
    t.setDelay(0);
    t.send(MUT(2)); // must NOT arrive before MUT(1)
    expect(inner.sent).toEqual([]);
    vi.advanceTimersByTime(1000);
    expect(inner.sent).toEqual([MUT(1), MUT(2)]);
  });

  it("close() drops pending delayed frames — nothing arrives late, inner is closed", () => {
    const inner = fakeInner();
    const t = delayTransport("ws://x", () => inner.t);
    t.setDelay(500);
    t.send(MUT(1));
    t.close();
    vi.advanceTimersByTime(1000);
    expect(inner.sent).toEqual([]);
    expect(inner.isClosed()).toBe(true);
  });

  it("inner socket death drops pending delayed frames", () => {
    const inner = fakeInner();
    const t = delayTransport("ws://x", () => inner.t);
    t.setDelay(500);
    t.send(MUT(1));
    inner.fireClose();
    vi.advanceTimersByTime(1000);
    expect(inner.sent).toEqual([]);
    // A frame sent after the close+reopen window (a fresh inner) is unaffected — a new
    // lastScheduledFireAt of 0 means a 0ms delay sends immediately rather than queueing behind
    // the cancelled fire time.
    t.setDelay(0);
    t.send(MUT(2));
    expect(inner.sent).toEqual([MUT(2)]);
  });

  it("getDelay reflects setDelay", () => {
    const inner = fakeInner();
    const t = delayTransport("ws://x", () => inner.t);
    expect(t.getDelay()).toBe(0);
    t.setDelay(250);
    expect(t.getDelay()).toBe(250);
  });
});
