/**
 * The `disableBackgroundTimers` knob (Slice 3, DO host — decision 6). A Durable Object host must
 * arm NO process-shaped timers: the `setInterval` flush/resume sweep is lost on hibernation and the
 * per-session ping heartbeat would wake a hibernated DO on every beat, defeating scale-to-zero. This
 * proves BOTH halves are disarmed when the option is set — and, critically, that the DEFAULT
 * (process host) path is byte-for-byte unchanged: the sweep still ticks and the heartbeat still pings.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { SyncProtocolHandler, type SyncUdfExecutor, type SyncWebSocket } from "../src/index";

const noopExecutor: SyncUdfExecutor = {
  async runQuery() {
    return { value: null, tables: [], readRanges: [] };
  },
  async runMutation() {
    return { value: null, tables: [], ranges: [], commitTs: 1, writtenDocs: [] };
  },
  async runAdminQuery() {
    return { value: null, tables: [], readRanges: [] };
  },
  async runAction() {
    return { value: null };
  },
};

/** A fake WS that records pings; a real transport (WS/Bun) has `ping`, the loopback omits it. */
function makePingSocket(): SyncWebSocket & { pings: number } {
  const s = {
    pings: 0,
    bufferedAmount: 0,
    send() {},
    close() {},
    ping(_cb: () => void) {
      s.pings++;
    },
  };
  return s;
}

describe("SyncProtocolHandler disableBackgroundTimers (the DO host knob)", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("DEFAULT: arms the setInterval sweep and the per-session ping heartbeat (process host unchanged)", () => {
    const setIntervalSpy = vi.spyOn(globalThis, "setInterval");
    const handler = new SyncProtocolHandler(noopExecutor);
    // The constructor's flush/resume sweep timer is armed.
    expect(setIntervalSpy).toHaveBeenCalled();

    const s = makePingSocket();
    handler.connect("s1", s);
    // Advance past the default 30s ping interval — the heartbeat fired at least one ping.
    vi.advanceTimersByTime(31_000);
    expect(s.pings).toBeGreaterThan(0);

    handler.disconnect("s1");
    handler.dispose();
    setIntervalSpy.mockRestore();
  });

  it("disabled: arms NO setInterval sweep and NO heartbeat ping (the DO host)", () => {
    const setIntervalSpy = vi.spyOn(globalThis, "setInterval");
    const handler = new SyncProtocolHandler(noopExecutor, { disableBackgroundTimers: true });
    // No background sweep timer was created in the constructor.
    expect(setIntervalSpy).not.toHaveBeenCalled();

    const s = makePingSocket();
    handler.connect("s1", s);
    // Even well past the ping interval, no ping is ever sent — the heartbeat is disarmed.
    vi.advanceTimersByTime(120_000);
    expect(s.pings).toBe(0);

    handler.disconnect("s1");
    handler.dispose(); // a no-op when nothing was armed — must not throw
    setIntervalSpy.mockRestore();
  });
});
