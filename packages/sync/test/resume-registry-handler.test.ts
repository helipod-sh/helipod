/**
 * DLR Stage 3, Task 3: wires the `ResumeRegistry` into `SyncProtocolHandler` — populated on
 * subscribe, advanced on commit (independent of live sessions), retained/released on
 * subscribe/unsubscribe/disconnect. Drives the REAL handler with a fake executor; the registry
 * itself is unit-tested in `resume-registry.test.ts` — this suite only proves the WIRING.
 */
import { describe, it, expect } from "vitest";
import { indexKeyspaceId, keySuccessor, serializeKeyRange, type SerializedKeyRange } from "@stackbase/index-key-codec";
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
});
