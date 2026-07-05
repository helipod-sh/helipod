/**
 * M2c Task 3: threads `UdfResult.globalTables` (Task 2) from the executor's query-run result into
 * the registered `Subscription.globalTables` field (Task 4 adds the `byGlobalTable` index +
 * matching that actually READS this field — this suite only proves the value survives the whole
 * subscribe / resume / RERUN / SetAuth-refresh path unmangled).
 */
import { describe, it, expect } from "vitest";
import { indexKeyspaceId, keySuccessor, serializeKeyRange, type SerializedKeyRange } from "@helipod/index-key-codec";
import type { Value } from "@helipod/values";
import { regKey } from "../src/resume-registry";
import { SyncProtocolHandler, type SyncUdfExecutor, type SyncWebSocket, type ServerMessage, type WriteInvalidation } from "../src/index";

const KS = indexKeyspaceId("notes", "by_box");
const rangeFor = (value: string): SerializedKeyRange => {
  const start = new TextEncoder().encode(value);
  return serializeKeyRange({ keyspace: KS, start, end: keySuccessor(start) });
};
const RANGE_A = rangeFor("a");

class MockSocket implements SyncWebSocket {
  readonly messages: ServerMessage[] = [];
  bufferedAmount = 0;
  send(data: string): void {
    this.messages.push(JSON.parse(data) as ServerMessage);
  }
  close(): void {}
}

/** A query that reads a local range (`notes`) AND a global table (`users`) — the classic case
 *  the grounding doc flags as the real gap `findAffectedByRanges` must eventually close (Task 4). */
function makeExecutor(): SyncUdfExecutor {
  return {
    async runQuery() {
      return {
        value: [{ _id: "notes|a", box: "a" }] as unknown as Value,
        tables: ["notes"],
        readRanges: [RANGE_A],
        globalTables: ["users"],
      };
    },
    async runMutation() {
      throw new Error("not used in this test");
    },
    async runAdminQuery() {
      throw new Error("not used in this test");
    },
    async runAction() {
      throw new Error("not used in this test");
    },
  };
}

describe("SyncProtocolHandler: globalTables threading (M2c Task 3)", () => {
  it("subscribe registers the sub AND the resume-registry entry with globalTables from the query result", async () => {
    const handler = new SyncProtocolHandler(makeExecutor());
    const socket = new MockSocket();
    handler.connect("s1", socket);
    await handler.handleMessage(
      "s1",
      JSON.stringify({ type: "ModifyQuerySet", add: [{ queryId: 1, udfPath: "notes:list", args: { box: "a" } }], remove: [] }),
    );

    const sub = handler.__subscriptions.get("s1", 1);
    expect(sub).toBeDefined();
    expect(sub!.globalTables).toContain("users");
    // The local range/table classification is untouched — globalTables is additive, never merged in.
    expect(sub!.tables).toEqual(["notes"]);

    const key = regKey(null, "notes:list", { box: "a" });
    const entry = handler.__resumeRegistry.lookup(key);
    expect(entry).toBeDefined();
    expect(entry!.globalTables).toContain("users");
  });

  it("a reconnect resume of a MIXED (local+global) query always re-runs (M2c Critical fix), and the fresh sub still carries globalTables", async () => {
    // M2c Critical fix (whole-branch review): this query mixes a local range read (`notes`) with a
    // global-table read (`users`, via `makeExecutor()`'s fixed `globalTables: ["users"]`). Before the
    // fix, the reconnect compute-skip (`doModifyQuerySet`) only looked at `lastInvalidatedTs` — a
    // LOCAL-ts value the global-reactivity poller never advances — so a mixed query wrongly took the
    // `QueryUnchanged` fast path on resume and could miss a foreign global-table change that happened
    // during the gap. The fix bypasses the skip for any query whose resume-registry entry has a
    // non-empty `globalTables` (Change 4), so this now ALWAYS re-runs on resume instead.
    const handler = new SyncProtocolHandler(makeExecutor());
    const socket1 = new MockSocket();
    handler.connect("s1", socket1);
    await handler.handleMessage(
      "s1",
      JSON.stringify({ type: "ModifyQuerySet", add: [{ queryId: 1, udfPath: "notes:list", args: { box: "a" } }], remove: [] }),
    );
    const key = regKey(null, "notes:list", { box: "a" });
    const seededTs = handler.__resumeRegistry.lookup(key)!.lastInvalidatedTs;
    handler.disconnect("s1"); // release (TTL-retained, not evicted)

    const socket2 = new MockSocket();
    handler.connect("s2", socket2);
    await handler.handleMessage(
      "s2",
      JSON.stringify({
        type: "ModifyQuerySet",
        add: [{ queryId: 2, udfPath: "notes:list", args: { box: "a" }, sinceTs: seededTs }],
        remove: [],
      }),
    );

    // The skip branch is BYPASSED (a fresh QueryUpdated, not QueryUnchanged) precisely because this
    // sub's globalTables is non-empty — but the resumed sub still carries globalTables forward.
    const resumeTransition = socket2.messages.at(-1) as Extract<ServerMessage, { type: "Transition" }>;
    expect(resumeTransition.modifications).toEqual([expect.objectContaining({ type: "QueryUpdated", queryId: 2 })]);
    const sub = handler.__subscriptions.get("s2", 2);
    expect(sub!.globalTables).toContain("users");
  });

  it("a RERUN triggered by an intersecting write re-populates globalTables on the refreshed sub", async () => {
    const handler = new SyncProtocolHandler(makeExecutor());
    const socket = new MockSocket();
    handler.connect("s1", socket);
    await handler.handleMessage(
      "s1",
      JSON.stringify({ type: "ModifyQuerySet", add: [{ queryId: 1, udfPath: "notes:list", args: { box: "a" } }], remove: [] }),
    );

    const inv: WriteInvalidation = { tables: ["notes"], ranges: [RANGE_A], commitTs: 99 };
    await handler.notifyWrites(inv);

    const sub = handler.__subscriptions.get("s1", 1);
    expect(sub!.globalTables).toContain("users");
    const key = regKey(null, "notes:list", { box: "a" });
    expect(handler.__resumeRegistry.lookup(key)!.globalTables).toContain("users");
  });

  it("a SetAuth re-run re-populates globalTables on the refreshed sub", async () => {
    const handler = new SyncProtocolHandler(makeExecutor());
    const socket = new MockSocket();
    handler.connect("s1", socket);
    await handler.handleMessage(
      "s1",
      JSON.stringify({ type: "ModifyQuerySet", add: [{ queryId: 1, udfPath: "notes:list", args: { box: "a" } }], remove: [] }),
    );

    await handler.handleMessage("s1", JSON.stringify({ type: "SetAuth", token: "user123" }));

    const sub = handler.__subscriptions.get("s1", 1);
    expect(sub!.globalTables).toContain("users");
  });
});

/** A query that never reads a global table — used as the negative-case executor below. */
function makeNonGlobalExecutor(): SyncUdfExecutor {
  return {
    async runQuery() {
      return {
        value: [{ _id: "notes|a", box: "a" }] as unknown as Value,
        tables: ["notes"],
        readRanges: [RANGE_A],
        globalTables: [],
      };
    },
    async runMutation() {
      throw new Error("not used in this test");
    },
    async runAdminQuery() {
      throw new Error("not used in this test");
    },
    async runAction() {
      throw new Error("not used in this test");
    },
  };
}

/**
 * Whole-branch-review fix: `fireGlobalSubscribe()` must also fire from the two OTHER paths that
 * (re-)register a subscription — `handleSetAuth`'s re-exec and `sendSessionTransition`'s live-re-run
 * (the RERUN branch a non-diffable sub takes on an intersecting write). Both mirror the
 * fresh-subscribe arm-on-subscribe fix (`fc9da93`, `doModifyQuerySet`'s `onGlobalSubscribe` hook) but
 * were left unwired — a subscription that gains a global table on an identity flip or a
 * data-dependent re-run branch would otherwise register with nothing to re-arm a disarmed poller.
 */
describe("SyncProtocolHandler: onGlobalSubscribe fires on SetAuth re-exec + live-re-run (whole-branch review fix)", () => {
  it("fires onGlobalSubscribe when a SetAuth re-exec refreshes a sub with non-empty globalTables", async () => {
    const handler = new SyncProtocolHandler(makeExecutor());
    const socket = new MockSocket();
    handler.connect("s1", socket);
    await handler.handleMessage(
      "s1",
      JSON.stringify({ type: "ModifyQuerySet", add: [{ queryId: 1, udfPath: "notes:list", args: { box: "a" } }], remove: [] }),
    );

    let fireCount = 0;
    handler.onGlobalSubscribe(() => {
      fireCount++;
    });

    await handler.handleMessage("s1", JSON.stringify({ type: "SetAuth", token: "user123" }));

    expect(fireCount).toBe(1);
  });

  it("does NOT fire onGlobalSubscribe when a SetAuth re-exec refreshes a sub with empty globalTables", async () => {
    const handler = new SyncProtocolHandler(makeNonGlobalExecutor());
    const socket = new MockSocket();
    handler.connect("s1", socket);
    await handler.handleMessage(
      "s1",
      JSON.stringify({ type: "ModifyQuerySet", add: [{ queryId: 1, udfPath: "notes:list", args: { box: "a" } }], remove: [] }),
    );

    let fireCount = 0;
    handler.onGlobalSubscribe(() => {
      fireCount++;
    });

    await handler.handleMessage("s1", JSON.stringify({ type: "SetAuth", token: "user123" }));

    expect(fireCount).toBe(0);
  });

  it("fires onGlobalSubscribe when a live-re-run (RERUN branch, intersecting write) refreshes a sub with non-empty globalTables", async () => {
    const handler = new SyncProtocolHandler(makeExecutor());
    const socket = new MockSocket();
    handler.connect("s1", socket);
    await handler.handleMessage(
      "s1",
      JSON.stringify({ type: "ModifyQuerySet", add: [{ queryId: 1, udfPath: "notes:list", args: { box: "a" } }], remove: [] }),
    );

    let fireCount = 0;
    handler.onGlobalSubscribe(() => {
      fireCount++;
    });

    const inv: WriteInvalidation = { tables: ["notes"], ranges: [RANGE_A], commitTs: 99 };
    await handler.notifyWrites(inv);

    expect(fireCount).toBe(1);
  });

  it("does NOT fire onGlobalSubscribe when a live-re-run refreshes a sub with empty globalTables", async () => {
    const handler = new SyncProtocolHandler(makeNonGlobalExecutor());
    const socket = new MockSocket();
    handler.connect("s1", socket);
    await handler.handleMessage(
      "s1",
      JSON.stringify({ type: "ModifyQuerySet", add: [{ queryId: 1, udfPath: "notes:list", args: { box: "a" } }], remove: [] }),
    );

    let fireCount = 0;
    handler.onGlobalSubscribe(() => {
      fireCount++;
    });

    const inv: WriteInvalidation = { tables: ["notes"], ranges: [RANGE_A], commitTs: 99 };
    await handler.notifyWrites(inv);

    expect(fireCount).toBe(0);
  });
});
