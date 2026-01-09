/**
 * DLR Stage 3, Task 3: wires the `ResumeRegistry` into `SyncProtocolHandler` — populated on
 * subscribe, advanced on commit (independent of live sessions), retained/released on
 * subscribe/unsubscribe/disconnect. Drives the REAL handler with a fake executor; the registry
 * itself is unit-tested in `resume-registry.test.ts` — this suite only proves the WIRING.
 */
import { describe, it, expect } from "vitest";
import { indexKeyspaceId, keySuccessor, serializeKeyRange, tableKeyspaceId, type SerializedKeyRange } from "@stackbase/index-key-codec";
import type { Value } from "@stackbase/values";
import { regKey } from "../src/resume-registry";
import { SyncProtocolHandler, type SyncUdfExecutor, type SyncWebSocket, type ServerMessage, type WriteInvalidation } from "../src/index";

const KS = indexKeyspaceId("notes", "by_box");
const rangeFor = (value: string): SerializedKeyRange => {
  const start = new TextEncoder().encode(value);
  return serializeKeyRange({ keyspace: KS, start, end: keySuccessor(start) });
};
const RANGE_A = rangeFor("a");
const RANGE_B = rangeFor("b");

class MockSocket implements SyncWebSocket {
  readonly messages: ServerMessage[] = [];
  bufferedAmount = 0;
  send(data: string): void {
    this.messages.push(JSON.parse(data) as ServerMessage);
  }
  close(): void {}
}

function makeExecutor(): SyncUdfExecutor {
  return {
    async runQuery() {
      return {
        value: [{ _id: "notes|a", box: "a" }] as unknown as Value,
        tables: ["notes"],
        readRanges: [RANGE_A],
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

/** A single-doc point-range read (DIFFABLE_BYID) on docs|a — same shape `resume-diffable.test.ts`
 *  uses, kept local so this suite doesn't reach into another test file's internals. */
const DOC_KS = tableKeyspaceId("3");
const POINT_A: SerializedKeyRange = serializeKeyRange({ keyspace: DOC_KS, start: new Uint8Array([1]), end: keySuccessor(new Uint8Array([1])) });
function makeByIdExecutor(): SyncUdfExecutor {
  return {
    async runQuery() {
      return {
        value: { _id: "docs|a", n: 1 } as unknown as Value,
        tables: ["table:3"],
        readRanges: [POINT_A],
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

/** Wraps an executor's `runQuery` with a call counter, so tests can assert the compute-skip branch
 *  did (or did NOT) invoke `execSub`. */
function withRunQueryCounter(base: SyncUdfExecutor): { executor: SyncUdfExecutor; runQueryCalls: () => number } {
  let n = 0;
  const executor: SyncUdfExecutor = {
    ...base,
    async runQuery(udfPath, args, identity) {
      n++;
      return base.runQuery(udfPath, args, identity);
    },
  };
  return { executor, runQueryCalls: () => n };
}

describe("SyncProtocolHandler: ResumeRegistry wiring (DLR Stage 3, Task 3)", () => {
  it("populates the registry on subscribe, advances on an intersecting commit, ignores a non-intersecting one", async () => {
    const handler = new SyncProtocolHandler(makeExecutor());
    const socket = new MockSocket();
    handler.connect("s1", socket);
    await handler.handleMessage(
      "s1",
      JSON.stringify({ type: "ModifyQuerySet", add: [{ queryId: 1, udfPath: "notes:list", args: { box: "a" } }], remove: [] }),
    );

    const key = regKey(null, "notes:list", { box: "a" });
    const entry = handler.__resumeRegistry.lookup(key);
    expect(entry).toBeDefined();
    const seededTs = entry!.lastInvalidatedTs;

    // Non-intersecting commit (different box) leaves it unchanged.
    const nonIntersecting: WriteInvalidation = { tables: ["notes"], ranges: [RANGE_B], commitTs: 50 };
    await handler.notifyWrites(nonIntersecting);
    expect(handler.__resumeRegistry.lookup(key)!.lastInvalidatedTs).toBe(seededTs);

    // Intersecting commit (same box) advances it to the commit ts.
    const intersecting: WriteInvalidation = { tables: ["notes"], ranges: [RANGE_A], commitTs: 99 };
    await handler.notifyWrites(intersecting);
    expect(handler.__resumeRegistry.lookup(key)!.lastInvalidatedTs).toBe(99);
  });

  it("disconnect releases (not evicts) — entry persists with refCount 0 + an expiry, and a later intersecting commit still advances it (gap-invalidation guard)", async () => {
    const handler = new SyncProtocolHandler(makeExecutor());
    const socket = new MockSocket();
    handler.connect("s1", socket);
    await handler.handleMessage(
      "s1",
      JSON.stringify({ type: "ModifyQuerySet", add: [{ queryId: 1, udfPath: "notes:list", args: { box: "a" } }], remove: [] }),
    );

    const key = regKey(null, "notes:list", { box: "a" });
    expect(handler.__resumeRegistry.lookup(key)).toBeDefined();

    handler.disconnect("s1");

    // Entry persists (TTL-retained), not immediately evicted.
    expect(handler.__resumeRegistry.lookup(key)).toBeDefined();
    expect(handler.__resumeRegistry.__refCount(key)).toBe(0);
    expect(handler.__resumeRegistry.__expiresAtMs(key)).toBeDefined();

    // A write landing during the "gap" still advances lastInvalidatedTs — a resuming client must
    // never trust a stale result just because nobody was subscribed at the moment of the write.
    const intersecting: WriteInvalidation = { tables: ["notes"], ranges: [RANGE_A], commitTs: 123 };
    await handler.notifyWrites(intersecting);
    expect(handler.__resumeRegistry.lookup(key)!.lastInvalidatedTs).toBe(123);
  });

  it("unsubscribe (remove) releases the entry the same way disconnect does", async () => {
    const handler = new SyncProtocolHandler(makeExecutor());
    const socket = new MockSocket();
    handler.connect("s1", socket);
    await handler.handleMessage(
      "s1",
      JSON.stringify({ type: "ModifyQuerySet", add: [{ queryId: 1, udfPath: "notes:list", args: { box: "a" } }], remove: [] }),
    );

    const key = regKey(null, "notes:list", { box: "a" });
    expect(handler.__resumeRegistry.__refCount(key)).toBe(1);

    await handler.handleMessage("s1", JSON.stringify({ type: "ModifyQuerySet", add: [], remove: [1] }));

    expect(handler.__resumeRegistry.lookup(key)).toBeDefined(); // still TTL-retained
    expect(handler.__resumeRegistry.__refCount(key)).toBe(0);
  });

  it("SetAuth after subscribe does not leak — release uses the sub's stored resumeKey, not the mutated session.identity", async () => {
    const handler = new SyncProtocolHandler(makeExecutor());
    const socket = new MockSocket();
    handler.connect("s1", socket);
    // Subscribe while anonymous (identity === null) — the registry entry is keyed under null.
    await handler.handleMessage(
      "s1",
      JSON.stringify({ type: "ModifyQuerySet", add: [{ queryId: 1, udfPath: "notes:list", args: { box: "a" } }], remove: [] }),
    );
    const anonKey = regKey(null, "notes:list", { box: "a" });
    expect(handler.__resumeRegistry.__refCount(anonKey)).toBe(1);

    // Authenticate: `handleSetAuth` mutates `session.identity` in place and re-runs the sub.
    await handler.handleMessage("s1", JSON.stringify({ type: "SetAuth", token: "user123" }));

    // Disconnect. Release MUST target the ORIGINAL (null) key the entry was created under — a key
    // re-derived from the now-"user123" identity would miss it and leak the entry forever.
    handler.disconnect("s1");
    expect(handler.__resumeRegistry.__refCount(anonKey)).toBe(0); // released, not leaked
    expect(handler.__resumeRegistry.__expiresAtMs(anonKey)).toBeDefined(); // TTL-armed → will be swept
    // And no stray entry was ever created under the post-auth identity.
    expect(handler.__resumeRegistry.lookup(regKey("user123", "notes:list", { box: "a" }))).toBeUndefined();
  });
});

describe("SyncProtocolHandler: reconnect compute-skip (DLR Stage 3, Task 4)", () => {
  it("Scenario A: a resume resubscribe with sinceTs >= lastInvalidatedTs skips execSub and answers QueryUnchanged; the sub is still live", async () => {
    const { executor, runQueryCalls } = withRunQueryCounter(makeExecutor());
    const handler = new SyncProtocolHandler(executor);
    const socket1 = new MockSocket();
    handler.connect("s1", socket1);
    await handler.handleMessage(
      "s1",
      JSON.stringify({ type: "ModifyQuerySet", add: [{ queryId: 1, udfPath: "notes:list", args: { box: "a" } }], remove: [] }),
    );
    expect(runQueryCalls()).toBe(1);

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

    // The skip branch fired: execSub was NOT invoked a second time.
    expect(runQueryCalls()).toBe(1);

    const resumeTransition = socket2.messages.at(-1) as Extract<ServerMessage, { type: "Transition" }>;
    expect(resumeTransition.type).toBe("Transition");
    expect(resumeTransition.modifications).toEqual([{ type: "QueryUnchanged", queryId: 2 }]);

    // The new sub is registered live (not a leaked/orphaned no-op): a subsequent intersecting write
    // produces a Transition for it.
    const intersecting: WriteInvalidation = { tables: ["notes"], ranges: [RANGE_A], commitTs: seededTs + 50 };
    await handler.notifyWrites(intersecting);
    expect(runQueryCalls()).toBe(2); // the RERUN path re-executes on the live write
    const pushed = socket2.messages.at(-1) as Extract<ServerMessage, { type: "Transition" }>;
    expect(pushed.type).toBe("Transition");
    expect(pushed.modifications).toEqual([
      expect.objectContaining({ type: "QueryUpdated", queryId: 2 }),
    ]);
  });

  it("Scenario A: the skip-path sub carries resumeKey — disconnect releases it (no leak)", async () => {
    const { executor } = withRunQueryCounter(makeExecutor());
    const handler = new SyncProtocolHandler(executor);
    const socket1 = new MockSocket();
    handler.connect("s1", socket1);
    await handler.handleMessage(
      "s1",
      JSON.stringify({ type: "ModifyQuerySet", add: [{ queryId: 1, udfPath: "notes:list", args: { box: "a" } }], remove: [] }),
    );
    const key = regKey(null, "notes:list", { box: "a" });
    const seededTs = handler.__resumeRegistry.lookup(key)!.lastInvalidatedTs;
    handler.disconnect("s1");

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
    expect(handler.__resumeRegistry.__refCount(key)).toBe(1); // retained by the skip path

    handler.disconnect("s2");
    // If the skip-path `add` had omitted `resumeKey`, this release would be a no-op (removedSub
    // would have no stored resumeKey to release by) and refCount would stay stuck at 1 forever.
    expect(handler.__resumeRegistry.__refCount(key)).toBe(0);
  });

  it("Scenario B (CRITICAL — gap-write guard): a write intersecting the query's range above sinceTs during the gap forces a full re-run, never the skip", async () => {
    const { executor, runQueryCalls } = withRunQueryCounter(makeExecutor());
    const handler = new SyncProtocolHandler(executor);
    const socket1 = new MockSocket();
    handler.connect("s1", socket1);
    await handler.handleMessage(
      "s1",
      JSON.stringify({ type: "ModifyQuerySet", add: [{ queryId: 1, udfPath: "notes:list", args: { box: "a" } }], remove: [] }),
    );
    expect(runQueryCalls()).toBe(1);

    const key = regKey(null, "notes:list", { box: "a" });
    const staleSinceTs = handler.__resumeRegistry.lookup(key)!.lastInvalidatedTs;

    handler.disconnect("s1");

    // A gap write: intersects the query's range, lands ABOVE staleSinceTs, while nobody is subscribed.
    const gapWrite: WriteInvalidation = { tables: ["notes"], ranges: [RANGE_A], commitTs: staleSinceTs + 9 };
    await handler.notifyWrites(gapWrite);
    expect(handler.__resumeRegistry.lookup(key)!.lastInvalidatedTs).toBe(staleSinceTs + 9);

    const socket2 = new MockSocket();
    handler.connect("s2", socket2);
    await handler.handleMessage(
      "s2",
      JSON.stringify({
        type: "ModifyQuerySet",
        add: [{ queryId: 2, udfPath: "notes:list", args: { box: "a" }, sinceTs: staleSinceTs }],
        remove: [],
      }),
    );

    // lastInvalidatedTs (staleSinceTs + 9) > sinceTs (staleSinceTs) => re-run, NOT skipped.
    expect(runQueryCalls()).toBe(2);
    const transition = socket2.messages.at(-1) as Extract<ServerMessage, { type: "Transition" }>;
    expect(transition.modifications[0]!.type).not.toBe("QueryUnchanged");
  });

  it("Scenario C: a DIFFABLE (by-id) registry entry is EXCLUDED from the skip — it keeps taking the existing resume path (execSub still runs)", async () => {
    const { executor, runQueryCalls } = withRunQueryCounter(makeByIdExecutor());
    const handler = new SyncProtocolHandler(executor);
    const socket1 = new MockSocket();
    handler.connect("s1", socket1);
    await handler.handleMessage(
      "s1",
      JSON.stringify({ type: "ModifyQuerySet", add: [{ queryId: 1, udfPath: "docs:get", args: { id: "docs|a" } }], remove: [] }),
    );
    expect(runQueryCalls()).toBe(1);

    const key = regKey(null, "docs:get", { id: "docs|a" });
    const entry = handler.__resumeRegistry.lookup(key)!;
    // Confirms this scenario is realized via a REAL diffable result (classifyByIdRead's point-range
    // classification), not just asserted at the unit-gate boundary.
    expect(entry.wasDiffable).toBe(true);
    const seededTs = entry.lastInvalidatedTs;

    handler.disconnect("s1");

    const socket2 = new MockSocket();
    handler.connect("s2", socket2);
    await handler.handleMessage(
      "s2",
      JSON.stringify({
        type: "ModifyQuerySet",
        add: [{ queryId: 2, udfPath: "docs:get", args: { id: "docs|a" }, sinceTs: seededTs }],
        remove: [],
      }),
    );

    // wasDiffable === true => the !entry.wasDiffable gate fails => never eligible for the skip,
    // regardless of how favorable sinceTs is.
    expect(runQueryCalls()).toBe(2);
  });
});
