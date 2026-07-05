/**
 * `GlobalReactivityPoller`: the pure poll → diff → `notifyWrites` mechanism (M2c Task 5). Drives
 * `tick()` directly (the deterministic test seam — see `src/global-reactivity-poller.ts`'s header)
 * against fakes: a scripted `readVersions`, a mutable `subscribedGlobalTables` list, and a stub
 * `notifyWrites` that records its calls. No alarm/DO wiring here — that's Task 6.
 */
import { describe, it, expect, vi } from "vitest";
import { GlobalReactivityPoller } from "../src/global-reactivity-poller";

function makeHarness(initialTables: string[] = ["users"]) {
  let subscribed = initialTables;
  const versionScript: Record<string, number>[] = [];
  const readVersions = vi.fn(async (_tables: string[]) => {
    if (versionScript.length === 0) throw new Error("readVersions called with no scripted response left");
    return versionScript.shift()!;
  });
  const notifyWrites = vi.fn(async (_inv: { tables: string[]; ranges: never[]; commitTs: number; global: true }) => {});

  const poller = new GlobalReactivityPoller({
    readVersions,
    subscribedGlobalTables: () => subscribed,
    notifyWrites,
  });

  return {
    poller,
    readVersions,
    notifyWrites,
    script(v: Record<string, number>) {
      versionScript.push(v);
    },
    setSubscribed(tables: string[]) {
      subscribed = tables;
    },
  };
}

describe("GlobalReactivityPoller.tick", () => {
  it("first tick with a new table records the baseline and does NOT invalidate", async () => {
    const h = makeHarness();
    h.script({ users: 1 });

    await h.poller.tick();

    expect(h.readVersions).toHaveBeenCalledTimes(1);
    expect(h.readVersions).toHaveBeenCalledWith(["users"]);
    expect(h.notifyWrites).not.toHaveBeenCalled();
  });

  it("a subsequent version bump invalidates exactly once for that table", async () => {
    const h = makeHarness();
    h.script({ users: 1 }); // baseline
    h.script({ users: 2 }); // bump

    await h.poller.tick();
    await h.poller.tick();

    expect(h.notifyWrites).toHaveBeenCalledTimes(1);
    // M2c Critical fix: `commitTs` is a harmless placeholder (0) on a global invalidation — never a
    // wall-clock/counter value fed into the local-ts frontier — and `global: true` is set so the sync
    // handler treats it as frontier-neutral. See `WriteInvalidation.global`'s doc in `@helipod/sync`.
    expect(h.notifyWrites).toHaveBeenCalledWith({
      tables: ["users"],
      ranges: [],
      commitTs: 0,
      global: true,
    });
  });

  it("an unchanged version does not invalidate again", async () => {
    const h = makeHarness();
    h.script({ users: 1 }); // baseline
    h.script({ users: 2 }); // bump -> notify
    h.script({ users: 2 }); // unchanged -> no notify

    await h.poller.tick();
    await h.poller.tick();
    await h.poller.tick();

    expect(h.notifyWrites).toHaveBeenCalledTimes(1);
  });

  it("a table with no subscribers is a full no-op: readVersions is not even called", async () => {
    const h = makeHarness([]);

    await h.poller.tick();

    expect(h.readVersions).not.toHaveBeenCalled();
    expect(h.notifyWrites).not.toHaveBeenCalled();
  });

  it("a table that loses all subscribers forgets its baseline, so re-subscribing re-baselines", async () => {
    const h = makeHarness(["users"]);
    h.script({ users: 1 }); // baseline
    await h.poller.tick();

    // Subscriber count drops to zero: tick is a no-op for `users` (and overall, since no tables).
    h.setSubscribed([]);
    await h.poller.tick();
    expect(h.readVersions).toHaveBeenCalledTimes(1); // still just the first call

    // Re-subscribe at a HIGHER version than the old baseline. If the old baseline (1) were still
    // remembered, this would look like a bump (2 > 1) and wrongly fire notifyWrites. Forgetting it
    // means this is treated as first-seen again: re-baseline, no notify.
    h.setSubscribed(["users"]);
    h.script({ users: 2 });
    await h.poller.tick();

    expect(h.notifyWrites).not.toHaveBeenCalled();

    // Confirm the new baseline (2) is now in effect: a further bump does notify.
    h.script({ users: 3 });
    await h.poller.tick();
    expect(h.notifyWrites).toHaveBeenCalledTimes(1);
    expect(h.notifyWrites).toHaveBeenCalledWith({ tables: ["users"], ranges: [], commitTs: 0, global: true });
  });

  it("multiple subscribed tables are diffed independently in one tick", async () => {
    const h = makeHarness(["users", "orgs"]);
    h.script({ users: 1, orgs: 1 }); // both baseline
    h.script({ users: 2, orgs: 1 }); // only users bumps

    await h.poller.tick();
    await h.poller.tick();

    expect(h.notifyWrites).toHaveBeenCalledTimes(1);
    expect(h.notifyWrites).toHaveBeenCalledWith({ tables: ["users"], ranges: [], commitTs: 0, global: true });
  });

  it("M2c Critical fix: commitTs is always the placeholder 0, regardless of poll count/timing — there is no clock to source it from anymore", async () => {
    const notifyWrites = vi.fn(async (_inv: { tables: string[]; ranges: never[]; commitTs: number; global: true }) => {});
    const readVersions = vi.fn(async () => versions.shift()!);
    const versions: Record<string, number>[] = [{ users: 1 }, { users: 2 }, { users: 3 }];
    const poller = new GlobalReactivityPoller({
      readVersions,
      subscribedGlobalTables: () => ["users"],
      notifyWrites,
    });

    await poller.tick(); // baseline
    await poller.tick(); // bump 1 -> 2
    await poller.tick(); // bump 2 -> 3

    expect(notifyWrites).toHaveBeenCalledTimes(2);
    for (const call of notifyWrites.mock.calls) {
      expect(call[0]).toMatchObject({ commitTs: 0, global: true });
    }
  });
});
