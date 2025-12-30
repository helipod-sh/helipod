/**
 * Handler-level integration coverage for the DLR 2a CommitDiffer (Task 5): a diff-capable session's
 * DIFFABLE_BYID subscription gets a QueryDiff reset on subscribe and an incremental QueryDiff on a
 * matching write, and — the Task 3 review follow-up this task folds in — a subscription whose read
 * SHAPE changes (stops being by-id) never keeps a stale `byId` classification into a later write.
 */
import { describe, it, expect } from "vitest";
import { serializeKeyRange, keySuccessor, tableKeyspaceId, type SerializedKeyRange } from "@stackbase/index-key-codec";
import type { Value } from "@stackbase/values";
import {
  SyncProtocolHandler,
  type SyncUdfExecutor,
  type SyncWebSocket,
  type ServerMessage,
  type WriteInvalidation,
} from "../src/index";

const b = (...n: number[]) => new Uint8Array(n);
const pointRange = (keyspace: string, start: Uint8Array): SerializedKeyRange =>
  serializeKeyRange({ keyspace, start, end: keySuccessor(start) });
const spanRange = (keyspace: string, start: Uint8Array, end: Uint8Array): SerializedKeyRange =>
  serializeKeyRange({ keyspace, start, end });

const KS = tableKeyspaceId("3");
const POINT_A = pointRange(KS, b(1));
const SPAN = spanRange(KS, b(1), b(9));

class MockSocket implements SyncWebSocket {
  readonly messages: ServerMessage[] = [];
  bufferedAmount = 0;
  send(data: string): void {
    this.messages.push(JSON.parse(data) as ServerMessage);
  }
  close(): void {}
  clear(): void {
    this.messages.length = 0;
  }
  modifications(): Array<Extract<ServerMessage, { type: "Transition" }>["modifications"][number]> {
    return this.messages
      .filter((m): m is Extract<ServerMessage, { type: "Transition" }> => m.type === "Transition")
      .flatMap((t) => t.modifications);
  }
}

/** identity === null -> a single-doc by-id read (point range). identity === "flip" -> a multi-row
 *  array read (span range) — a read-SHAPE change across a `SetAuth`. */
function makeExecutor(): SyncUdfExecutor {
  return {
    async runQuery(_path, _args, identity) {
      if (identity === "flip") {
        return {
          value: [{ _id: "docs|a", n: 1 }, { _id: "docs|b", n: 2 }] as unknown as Value,
          tables: ["table:3"],
          readRanges: [SPAN],
        };
      }
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

describe("SyncProtocolHandler: DIFFABLE_BYID QueryDiff emission", () => {
  it("subscribe (diff-capable session) gets a QueryDiff reset, not QueryUpdated", async () => {
    const handler = new SyncProtocolHandler(makeExecutor());
    const socket = new MockSocket();
    handler.connect("s1", socket);
    await handler.handleMessage("s1", JSON.stringify({ type: "Connect", sessionId: "s1", supportsQueryDiff: true }));

    await handler.handleMessage(
      "s1",
      JSON.stringify({ type: "ModifyQuerySet", add: [{ queryId: 1, udfPath: "q", args: {} }], remove: [] }),
    );

    const mods = socket.modifications();
    expect(mods).toHaveLength(1);
    expect(mods[0]).toMatchObject({
      type: "QueryDiff",
      queryId: 1,
      changes: [{ t: "add", key: "docs|a", row: { _id: "docs|a", n: 1 } }],
    });
  });

  it("a matching write gets an incremental QueryDiff, skipping execSub entirely", async () => {
    const handler = new SyncProtocolHandler(makeExecutor());
    const socket = new MockSocket();
    handler.connect("s1", socket);
    await handler.handleMessage("s1", JSON.stringify({ type: "Connect", sessionId: "s1", supportsQueryDiff: true }));
    await handler.handleMessage(
      "s1",
      JSON.stringify({ type: "ModifyQuerySet", add: [{ queryId: 1, udfPath: "q", args: {} }], remove: [] }),
    );
    socket.clear();

    const inv: WriteInvalidation = {
      tables: ["table:3"],
      ranges: [POINT_A],
      commitTs: 42,
      writtenDocs: [{ keyspace: KS, key: POINT_A.start, docId: "docs|a", newRow: { _id: "docs|a", n: 2 }, wasPresent: true, ts: 42 }],
    };
    await handler.notifyWrites(inv);

    const mods = socket.modifications();
    expect(mods).toHaveLength(1);
    expect(mods[0]).toMatchObject({
      type: "QueryDiff",
      queryId: 1,
      changes: [{ t: "edit", key: "docs|a", row: { _id: "docs|a", n: 2 }, ts: 42 }],
    });
  });

  it("a session that never advertised supportsQueryDiff always gets QueryUpdated, never QueryDiff", async () => {
    const handler = new SyncProtocolHandler(makeExecutor());
    const socket = new MockSocket();
    handler.connect("s1", socket);
    // No Connect at all — supportsQueryDiff defaults to false.
    await handler.handleMessage(
      "s1",
      JSON.stringify({ type: "ModifyQuerySet", add: [{ queryId: 1, udfPath: "q", args: {} }], remove: [] }),
    );
    expect(socket.modifications()[0]!.type).toBe("QueryUpdated");
  });

  it("a shape change (stops being by-id) does NOT keep a stale byId into a later write", async () => {
    const handler = new SyncProtocolHandler(makeExecutor());
    const socket = new MockSocket();
    handler.connect("s1", socket);
    await handler.handleMessage("s1", JSON.stringify({ type: "Connect", sessionId: "s1", supportsQueryDiff: true }));

    // Subscribe while identity is null: classified DIFFABLE_BYID, gets a QueryDiff reset.
    await handler.handleMessage(
      "s1",
      JSON.stringify({ type: "ModifyQuerySet", add: [{ queryId: 1, udfPath: "q", args: {} }], remove: [] }),
    );
    expect(socket.modifications()[0]!.type).toBe("QueryDiff");
    socket.clear();

    // SetAuth flips identity, which flips the query's read SHAPE to a multi-row array/span-range
    // read (no longer by-id). This refresh always answers with QueryUpdated (unchanged behavior);
    // the fix under test is that it also RECLASSIFIES byId (now undefined) rather than carrying the
    // stale one forward.
    await handler.handleMessage("s1", JSON.stringify({ type: "SetAuth", token: "flip" }));
    const setAuthMods = socket.modifications();
    expect(setAuthMods).toHaveLength(1);
    expect(setAuthMods[0]).toMatchObject({ type: "QueryUpdated" });
    socket.clear();

    // A write that overlaps the sub's CURRENT read range (the span, post-shape-change) must be
    // answered with a fresh QueryUpdated (full re-run) — NOT a QueryDiff. Were `byId` still stale
    // (carrying the original point-range/docId classification from before the shape change), this
    // write would incorrectly take the diff branch and emit a WRONG (and likely empty, since the
    // stale byId's keyspace/key won't match this write's key) QueryDiff instead of the correct
    // full array value.
    const inv: WriteInvalidation = {
      tables: ["table:3"],
      ranges: [pointRange(KS, b(2))], // inside the SPAN [b(1), b(9)) the post-flip sub now reads
      commitTs: 99,
      writtenDocs: [{ keyspace: KS, key: pointRange(KS, b(2)).start, docId: "docs|b", newRow: { _id: "docs|b", n: 3 }, wasPresent: true, ts: 99 }],
    };
    await handler.notifyWrites(inv);

    const mods = socket.modifications();
    expect(mods).toHaveLength(1);
    // Must be the RERUN QueryUpdated path with the fresh (array) value — never a QueryDiff.
    expect(mods[0]!.type).toBe("QueryUpdated");
    if (mods[0]!.type === "QueryUpdated") {
      expect(mods[0]!.value).toEqual([{ _id: "docs|a", n: 1 }, { _id: "docs|b", n: 2 }]);
    }
  });
});
