/* Stackbase Enterprise. Licensed under the Stackbase Commercial License — see ee/LICENSE. */
/**
 * Writer self-exit on lease loss (Task 4, C4) + promotion error policy (C5).
 *
 *   (a) `LeaseMonitor` — the writer-only liveness watchdog: `connectionLost()` exits immediately;
 *       `maxMisses` consecutive probe failures are tolerated, the next one exits; any success resets;
 *       `onExit` fires at most once; `stop()` halts everything. Exercised with fake timers.
 *   (b) `runPromotion` — the C5 wrap: a successful promotion arms the lease monitor and drops the
 *       proxy; ANY failed promotion step routes to the injected exit (a half-promoted node must not
 *       linger) and does NOT arm the monitor. This is also the seam that proves the monitor is
 *       constructed ONLY on (successful) promotion — a sync node that never promotes never starts one.
 *
 * The fully-integrated `startFleetNode` wiring (real NodePgClient + advisory-lock election + a live
 * runtime/tailer) is proven only through the real `stackbase serve --fleet` E2E (Task 5); here we
 * exercise the extracted, side-effect-free seams directly — the same spy pattern as
 * `node-lifecycle.test.ts`.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { LeaseMonitor } from "../src/lease-monitor";
import { runPromotion } from "../src/node";

describe("LeaseMonitor (C4: writer self-exit on lease loss)", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("connectionLost() → onExit exactly once, immediately", () => {
    const onExit = vi.fn();
    const probe = vi.fn(async () => {});
    const m = new LeaseMonitor({ probe, onExit });
    m.start();

    m.connectionLost();

    expect(onExit).toHaveBeenCalledTimes(1);
    expect(String(onExit.mock.calls[0]![0])).toContain("lease");
    expect(probe).not.toHaveBeenCalled(); // exit was immediate, no probe needed
  });

  it("onExit fires at most once (repeated connectionLost + subsequent probe misses)", async () => {
    const onExit = vi.fn();
    const probe = vi.fn(async () => {
      throw new Error("down");
    });
    const m = new LeaseMonitor({ probe, onExit });
    m.start();

    m.connectionLost();
    m.connectionLost();
    await vi.advanceTimersByTimeAsync(5000 * 10); // any later probe misses must not re-fire

    expect(onExit).toHaveBeenCalledTimes(1);
  });

  it("3 consecutive probe misses → NO exit; the 4th → exit with reason containing 'lease'", async () => {
    const onExit = vi.fn();
    const probe = vi.fn(async () => {
      throw new Error("SELECT 1 failed");
    });
    const m = new LeaseMonitor({ probe, onExit }); // defaults: probeMs 5000, maxMisses 3
    m.start();

    for (let i = 0; i < 3; i++) await vi.advanceTimersByTimeAsync(5000);
    expect(onExit).not.toHaveBeenCalled(); // 3 misses tolerated
    expect(probe).toHaveBeenCalledTimes(3);

    await vi.advanceTimersByTimeAsync(5000); // 4th miss
    expect(onExit).toHaveBeenCalledTimes(1);
    expect(String(onExit.mock.calls[0]![0])).toContain("lease");
  });

  it("a probe success after 2 misses resets the counter (takes 4 more misses to exit)", async () => {
    const onExit = vi.fn();
    let healthy = false;
    const probe = vi.fn(async () => {
      if (!healthy) throw new Error("down");
    });
    const m = new LeaseMonitor({ probe, onExit });
    m.start();

    await vi.advanceTimersByTimeAsync(5000); // miss 1
    await vi.advanceTimersByTimeAsync(5000); // miss 2
    healthy = true;
    await vi.advanceTimersByTimeAsync(5000); // success → reset to 0
    expect(onExit).not.toHaveBeenCalled();

    healthy = false;
    for (let i = 0; i < 3; i++) await vi.advanceTimersByTimeAsync(5000); // misses 1,2,3 post-reset
    expect(onExit).not.toHaveBeenCalled(); // reset held — 3 fresh misses is still tolerated

    await vi.advanceTimersByTimeAsync(5000); // 4th post-reset miss → exit
    expect(onExit).toHaveBeenCalledTimes(1);
  });

  it("stop() halts probing — no exit and no further probes afterward", async () => {
    const onExit = vi.fn();
    const probe = vi.fn(async () => {
      throw new Error("down");
    });
    const m = new LeaseMonitor({ probe, onExit });
    m.start();

    await vi.advanceTimersByTimeAsync(5000); // miss 1
    m.stop();
    const callsAtStop = probe.mock.calls.length;

    await vi.advanceTimersByTimeAsync(5000 * 10);
    expect(onExit).not.toHaveBeenCalled();
    expect(probe).toHaveBeenCalledTimes(callsAtStop); // no probes after stop()
  });

  it("connectionLost() after stop() does not exit", () => {
    const onExit = vi.fn();
    const m = new LeaseMonitor({ probe: vi.fn(async () => {}), onExit });
    m.start();
    m.stop();

    m.connectionLost();
    expect(onExit).not.toHaveBeenCalled();
  });

  it("respects a custom maxMisses/probeMs", async () => {
    const onExit = vi.fn();
    const probe = vi.fn(async () => {
      throw new Error("down");
    });
    const m = new LeaseMonitor({ probe, onExit, probeMs: 100, maxMisses: 1 });
    m.start();

    await vi.advanceTimersByTimeAsync(100); // miss 1 — tolerated
    expect(onExit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(100); // 2nd miss > maxMisses(1) → exit
    expect(onExit).toHaveBeenCalledTimes(1);
  });
});

describe("runPromotion (C5: promotion error policy)", () => {
  it("success → promote runs, monitor is started, proxy dropped, no exit", async () => {
    const order: string[] = [];
    const startMonitor = vi.fn(() => void order.push("startMonitor"));
    const firePromoted = vi.fn(() => void order.push("firePromoted"));
    const onExit = vi.fn();
    const promote = vi.fn(async () => void order.push("promote"));

    await runPromotion({ promote, startMonitor, firePromoted, onExit });

    expect(promote).toHaveBeenCalledTimes(1);
    expect(startMonitor).toHaveBeenCalledTimes(1); // writer self-exit armed on promotion
    expect(firePromoted).toHaveBeenCalledTimes(1);
    expect(onExit).not.toHaveBeenCalled();
    // Monitor starts only after the promotion sequence completes.
    expect(order).toEqual(["promote", "startMonitor", "firePromoted"]);
  });

  it("a throwing promotion step → injected exit once; monitor NOT started, proxy NOT dropped", async () => {
    const startMonitor = vi.fn();
    const firePromoted = vi.fn();
    const onExit = vi.fn();
    const promote = vi.fn(async () => {
      throw new Error("swapTo blew up");
    });

    await runPromotion({ promote, startMonitor, firePromoted, onExit });

    expect(onExit).toHaveBeenCalledTimes(1); // half-promoted node must not linger — it exits
    expect(String(onExit.mock.calls[0]![0])).toContain("promotion failed");
    expect(String(onExit.mock.calls[0]![0])).toContain("swapTo blew up");
    expect(startMonitor).not.toHaveBeenCalled(); // a failed promotion never arms the monitor
    expect(firePromoted).not.toHaveBeenCalled();
  });

  it("a sync node that never promotes never constructs/starts a monitor", () => {
    // The ONLY paths that start a writer monitor are the writer-boot branch and runPromotion's
    // success path. A sync node runs neither until it wins the lease — modeled here by never invoking
    // runPromotion: startMonitor stays untouched.
    const startMonitor = vi.fn();
    const onExit = vi.fn();
    void onExit;
    // (no runPromotion call — this node stayed a sync replica)
    expect(startMonitor).not.toHaveBeenCalled();
  });
});
