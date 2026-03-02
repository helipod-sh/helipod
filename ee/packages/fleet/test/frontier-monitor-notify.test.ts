/* Stackbase Enterprise. Licensed under the Stackbase Commercial License — see ee/LICENSE. */
/**
 * T3.5 — `FrontierMonitor` notify-on-advance. Root-caused by the fleet-connections bench (see
 * `.superpowers/sdd/notify-diagnosis.md`): `closeIdleFrontiers`/`bumpOrphanFrontiers` advance
 * `shard_leases.frontier_ts` with a bare `UPDATE` and never NOTIFY, so the event that actually
 * un-pins the fleet ceiling `F = min(frontier_ts)` on a lightly-loaded fleet (most shards idle) is
 * invisible to every `ReplicaTailer`'s LISTEN — delivery falls through to the 1000ms poll fallback.
 *
 * This exercises `FrontierMonitor.beat()` directly against a fake `LeaseManager` (no real Postgres
 * needed — `beat()`'s own logic, not `LeaseManager`'s queries, is under test here), asserting:
 *   1. a beat that advances `F` past the PRIOR beat's own reading fires exactly one notify with the
 *      new ceiling;
 *   2. a no-op beat (ceiling unchanged) never notifies;
 *   3. a sync node's read-only monitor (`closeIdle: false`) never notifies, even when `F` visibly
 *      advances underneath it (only the writer performed the advancing work, so only it announces).
 *
 * (The package's `PgliteClient` test stub throws on `listen`/`notify` by design — see its own doc
 * comment — so a real end-to-end NOTIFY assertion belongs to the bench's real-server smoke test,
 * not this unit; see `.superpowers/sdd/task-3.5-report.md` for that evidence.)
 */
import { describe, it, expect, vi } from "vitest";
import type { LeaseManager } from "../src/lease";
import { FrontierMonitor } from "../src/node";

/** A minimal fake satisfying exactly the `LeaseManager` surface `FrontierMonitor.beat()` touches —
 *  `closeIdleFrontiers`/`bumpOrphanFrontiers`/`readAllFrontiers`, plus `advertiseUrl` (only read by
 *  the replica-lag warning branch, unexercised here). Cast through `unknown` like the package's own
 *  `commit-notifier.test.ts` ad-hoc client mock — a real `LeaseManager` needs a live Postgres client
 *  this unit deliberately avoids. */
function fakeLease(opts: {
  closeIdleFrontiers: () => Promise<bigint>;
  frontiers: Array<Array<{ shardId: string; frontierTs: bigint }>>;
}): LeaseManager {
  let call = 0;
  return {
    advertiseUrl: "http://test-node",
    closeIdleFrontiers: vi.fn(opts.closeIdleFrontiers),
    bumpOrphanFrontiers: vi.fn(async () => {}),
    readAllFrontiers: vi.fn(async () => opts.frontiers[Math.min(call++, opts.frontiers.length - 1)]),
  } as unknown as LeaseManager;
}

/** Directly invoke the private `beat()` — the exact unit under test, matching how `start()`'s
 *  periodic timer and `triggerCoalesced()`'s coalesce timer both drive it in production. */
async function runBeat(monitor: FrontierMonitor): Promise<void> {
  await (monitor as unknown as { beat: () => Promise<void> }).beat();
}

const runExclusiveOnShard = async (_shardId: string, fn: () => Promise<void>): Promise<boolean> => {
  await fn();
  return true;
};

describe("FrontierMonitor notify-on-advance (T3.5)", () => {
  it("fires exactly one notify, with the new ceiling, on a beat that advances F", async () => {
    const lease = fakeLease({
      closeIdleFrontiers: async () => 9n,
      frontiers: [
        [{ shardId: "default", frontierTs: 5n }], // beat 1: baseline — no prior reading, no notify
        [{ shardId: "default", frontierTs: 9n }], // beat 2: 5 -> 9, the idle-close's real advance
      ],
    });
    const notifyOnAdvance = vi.fn();
    const monitor = new FrontierMonitor(lease, { closeIdle: true, runExclusiveOnShard, notifyOnAdvance });

    await runBeat(monitor); // cold-start baseline beat
    expect(notifyOnAdvance).not.toHaveBeenCalled();

    await runBeat(monitor); // the advancing beat
    expect(notifyOnAdvance).toHaveBeenCalledTimes(1);
    expect(notifyOnAdvance).toHaveBeenCalledWith(9n);
  });

  it("never notifies across repeated no-op beats (ceiling unchanged)", async () => {
    const lease = fakeLease({
      closeIdleFrontiers: async () => 5n,
      frontiers: [[{ shardId: "default", frontierTs: 5n }]],
    });
    const notifyOnAdvance = vi.fn();
    const monitor = new FrontierMonitor(lease, { closeIdle: true, runExclusiveOnShard, notifyOnAdvance });

    await runBeat(monitor);
    await runBeat(monitor);
    await runBeat(monitor);
    expect(notifyOnAdvance).not.toHaveBeenCalled();
  });

  it("a sync node's read-only monitor (closeIdle: false) never notifies, even when F advances", async () => {
    const lease = fakeLease({
      closeIdleFrontiers: async () => 9n, // never called — closeIdle is false
      frontiers: [
        [{ shardId: "default", frontierTs: 5n }],
        [{ shardId: "default", frontierTs: 9n }], // F visibly advances underneath the read-only monitor
      ],
    });
    const notifyOnAdvance = vi.fn();
    const monitor = new FrontierMonitor(lease, { closeIdle: false, notifyOnAdvance });

    await runBeat(monitor);
    await runBeat(monitor);
    expect(notifyOnAdvance).not.toHaveBeenCalled();
    expect(lease.closeIdleFrontiers).not.toHaveBeenCalled();
  });

  it("a notifyOnAdvance callback throwing does not break the beat (failure-safe)", async () => {
    const lease = fakeLease({
      closeIdleFrontiers: async () => 9n,
      frontiers: [
        [{ shardId: "default", frontierTs: 5n }],
        [{ shardId: "default", frontierTs: 9n }],
      ],
    });
    const notifyOnAdvance = vi.fn(() => {
      throw new Error("notify boom");
    });
    const monitor = new FrontierMonitor(lease, { closeIdle: true, runExclusiveOnShard, notifyOnAdvance });

    await runBeat(monitor);
    await expect(runBeat(monitor)).resolves.toBeUndefined(); // beat()'s own catch-all swallows it
    expect(notifyOnAdvance).toHaveBeenCalledTimes(1);
    expect(monitor.stats()?.frontier).toBe(9n); // the beat's own bookkeeping still completed
  });
});
