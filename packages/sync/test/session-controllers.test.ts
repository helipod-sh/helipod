import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  SessionBackpressureController,
  SessionHeartbeatController,
  type SyncWebSocket,
} from "../src/index";

const MiB = 1024 * 1024;

/** A settable-bufferedAmount fake socket that records everything sent. */
function makeSocket(): SyncWebSocket & { sent: string[]; bufferedAmount: number; close: ReturnType<typeof vi.fn> } {
  return {
    sent: [] as string[],
    bufferedAmount: 0,
    send(d: string) {
      (this as { sent: string[] }).sent.push(d);
    },
    close: vi.fn(),
  };
}

/** A fake socket that also supports transport-level ping/pong; `pong()` delivers a pong. */
function makePingSocket(): SyncWebSocket & {
  sent: string[];
  bufferedAmount: number;
  close: ReturnType<typeof vi.fn>;
  pings: number;
  pong(): void;
} {
  let onPong: (() => void) | undefined;
  const s = {
    sent: [] as string[],
    bufferedAmount: 0,
    pings: 0,
    send(d: string) {
      s.sent.push(d);
    },
    close: vi.fn(),
    ping(cb: () => void) {
      s.pings++;
      onPong = cb;
    },
    pong() {
      onPong?.();
    },
  };
  return s;
}

describe("SessionBackpressureController", () => {
  it("passes frames through immediately when bufferedAmount is below high-water", () => {
    const s = makeSocket();
    const bp = new SessionBackpressureController(s);
    bp.send("a");
    bp.send("b");
    expect(s.sent).toEqual(["a", "b"]);
    expect(bp.droppedFrames).toBe(0);
    expect(bp.droppedThisEpisode).toBe(false);
  });

  it("queues frames while bufferedAmount is above high-water, delivering them in order on drain", () => {
    const s = makeSocket();
    const bp = new SessionBackpressureController(s);
    s.bufferedAmount = 2 * MiB;
    bp.send("x");
    bp.send("y");
    bp.send("z");
    expect(s.sent).toEqual([]); // nothing delivered while backpressured
    expect(bp.droppedFrames).toBe(0);
    // Client catches up; flush drains in FIFO order.
    s.bufferedAmount = 0;
    bp.flush();
    expect(s.sent).toEqual(["x", "y", "z"]);
    expect(bp.droppedThisEpisode).toBe(false);
  });

  it("drops the NEWEST frame once the queue is full (past maxQueuedFrames)", () => {
    const s = makeSocket();
    const bp = new SessionBackpressureController(s, { maxQueuedFrames: 3 });
    s.bufferedAmount = 2 * MiB;
    bp.send("1");
    bp.send("2");
    bp.send("3"); // queue now full (3)
    bp.send("4"); // dropped — newest
    bp.send("5"); // dropped — newest
    expect(bp.droppedFrames).toBe(2);
    s.bufferedAmount = 0;
    bp.flush();
    expect(s.sent).toEqual(["1", "2", "3"]); // the three oldest survive, in order
  });

  it("flushes the whole queue to drops after sustained backpressure past slowClientTimeoutMs", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(0);
      const s = makeSocket();
      const bp = new SessionBackpressureController(s, { slowClientTimeoutMs: 30_000 });
      s.bufferedAmount = 2 * MiB;
      bp.send("a");
      bp.send("b");
      bp.send("c");
      expect(bp.droppedFrames).toBe(0);
      // 31s of sustained backpressure — the client is declared slow; queue is abandoned.
      vi.advanceTimersByTime(31_000);
      bp.flush();
      expect(bp.droppedFrames).toBe(3);
      expect(s.sent).toEqual([]);
      // A further send while still slow drops immediately too.
      bp.send("d");
      expect(bp.droppedFrames).toBe(4);
    } finally {
      vi.useRealTimers();
    }
  });

  it("warns exactly once per backpressure episode, re-warning after a full drain", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const s = makeSocket();
      const bp = new SessionBackpressureController(s, { maxQueuedFrames: 1 });
      s.bufferedAmount = 2 * MiB;
      bp.send("1"); // queued (1)
      bp.send("2"); // dropped → warn #1
      bp.send("3"); // dropped → NO new warn (same episode)
      expect(warn).toHaveBeenCalledTimes(1);
      expect(bp.droppedThisEpisode).toBe(true);
      // Client fully catches up → episode ends.
      s.bufferedAmount = 0;
      bp.flush();
      expect(s.sent).toEqual(["1"]);
      expect(bp.droppedThisEpisode).toBe(false);
      // New episode drops again → a second warn is allowed.
      s.bufferedAmount = 2 * MiB;
      bp.send("4"); // queued (1)
      bp.send("5"); // dropped → warn #2
      expect(warn).toHaveBeenCalledTimes(2);
    } finally {
      warn.mockRestore();
    }
  });
});

describe("SessionHeartbeatController", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("keeps the session alive while pongs arrive within the interval", () => {
    const s = makePingSocket();
    const onDead = vi.fn();
    const hb = new SessionHeartbeatController(s, onDead, { pingIntervalMs: 1000, missedPongLimit: 2 });
    hb.start();
    for (let i = 0; i < 5; i++) {
      vi.advanceTimersByTime(1000); // ping
      s.pong(); // pong resets the miss counter
    }
    expect(onDead).not.toHaveBeenCalled();
    expect(s.pings).toBe(5);
    hb.stop();
  });

  it("fires onDead exactly once after missedPongLimit consecutive missed pongs", () => {
    const s = makePingSocket();
    const onDead = vi.fn();
    const hb = new SessionHeartbeatController(s, onDead, { pingIntervalMs: 1000, missedPongLimit: 2 });
    hb.start();
    vi.advanceTimersByTime(1000); // ping 1 — unanswered (missed=1)
    vi.advanceTimersByTime(1000); // ping 2 — unanswered (missed=2) → dead
    expect(onDead).toHaveBeenCalledTimes(1);
    // Timer is cleared on death — no further ticks, no second onDead.
    vi.advanceTimersByTime(10_000);
    expect(onDead).toHaveBeenCalledTimes(1);
  });

  it("resets the miss counter on noteActivity() between pings", () => {
    const s = makePingSocket();
    const onDead = vi.fn();
    const hb = new SessionHeartbeatController(s, onDead, { pingIntervalMs: 1000, missedPongLimit: 2 });
    hb.start();
    vi.advanceTimersByTime(1000); // missed=1
    hb.noteActivity(); // inbound traffic → missed=0
    vi.advanceTimersByTime(1000); // missed=1
    hb.noteActivity(); // missed=0
    vi.advanceTimersByTime(1000); // missed=1
    expect(onDead).not.toHaveBeenCalled();
    hb.stop();
  });

  it("never arms timers when the socket has no ping (loopback exemption)", () => {
    const s = makeSocket(); // no ping method
    const onDead = vi.fn();
    const hb = new SessionHeartbeatController(s, onDead, { pingIntervalMs: 1000, missedPongLimit: 2 });
    hb.start();
    vi.advanceTimersByTime(100_000);
    expect(onDead).not.toHaveBeenCalled();
  });

  it("stop() clears timers so no further pings or death occur", () => {
    const s = makePingSocket();
    const onDead = vi.fn();
    const hb = new SessionHeartbeatController(s, onDead, { pingIntervalMs: 1000, missedPongLimit: 2 });
    hb.start();
    vi.advanceTimersByTime(1000); // ping 1
    hb.stop();
    const pingsAtStop = s.pings;
    vi.advanceTimersByTime(100_000);
    expect(s.pings).toBe(pingsAtStop);
    expect(onDead).not.toHaveBeenCalled();
  });
});
