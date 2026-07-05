/**
 * DLR 2b Task 10 — integrating the DIFFABLE row-diff path with subscription resume (design
 * 2026-07-11): a DIFFABLE (by-id or range) subscription resuming with a matching echoed
 * `resultHash` must reply `QueryUnchanged`, not always a full `QueryDiff` reset — but it must
 * ALSO seed `byIdRowMap` for the (fresh, post-reconnect) session exactly as a real reset would, so
 * a LATER incremental write still diffs correctly instead of computing against a phantom empty map
 * (which would wrongly emit "add" for rows the client already has, or otherwise drift).
 *
 * Models `commit-differ-handler.test.ts`'s fixtures/harness so the two suites stay in lockstep.
 */
import { describe, it, expect } from "vitest";
import {
  serializeKeyRange,
  keySuccessor,
  tableKeyspaceId,
  indexKeyspaceId,
  indexKeyRangeStart,
  indexKeyRangeEnd,
  type SerializedKeyRange,
} from "@helipod/index-key-codec";
import type { Value } from "@helipod/values";
import type { RangeRead } from "../src/classify";
import { orderKeyFor } from "../src/commit-differ";
import {
  SyncProtocolHandler,
  driftChecksum,
  type SyncUdfExecutor,
  type SyncWebSocket,
  type ServerMessage,
  type WriteInvalidation,
} from "../src/index";

const b = (...n: number[]) => new Uint8Array(n);
const pointRange = (keyspace: string, start: Uint8Array): SerializedKeyRange =>
  serializeKeyRange({ keyspace, start, end: keySuccessor(start) });

const KS = tableKeyspaceId("3");
const POINT_A = pointRange(KS, b(1));

const CHANNEL_KEYSPACE = indexKeyspaceId("3", "by_channel");
const CHANNEL_RANGE: RangeRead = {
  keyspace: CHANNEL_KEYSPACE,
  bounds: serializeKeyRange({
    keyspace: CHANNEL_KEYSPACE,
    start: indexKeyRangeStart(["c"]),
    end: indexKeyRangeEnd(["c"])!,
  }),
  filters: [],
  order: "asc",
  fields: ["channelId"],
};
const rangeRow = (id: string, channelId: string, n: number, ct = 100) => ({ _id: id, channelId, n, _creationTime: ct });
const DOC_A = rangeRow("docs|a", "c", 1, 100);
const DOC_B = rangeRow("docs|b", "c", 2, 200);

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

/** A passthrough single-index-range collect over table 3's `by_channel` index (DIFFABLE_RANGE). */
function makeRangeExecutor(): SyncUdfExecutor {
  return {
    async runQuery() {
      return {
        value: [DOC_A, DOC_B] as unknown as Value,
        tables: ["table:3"],
        readRanges: [CHANNEL_RANGE.bounds],
        globalTables: [],
        diffableRange: CHANNEL_RANGE,
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

/** A single-doc point-range read (DIFFABLE_BYID) on docs|a. */
function makeByIdExecutor(): SyncUdfExecutor {
  return {
    async runQuery() {
      return {
        value: { _id: "docs|a", n: 1 } as unknown as Value,
        tables: ["table:3"],
        readRanges: [POINT_A],
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

const connectDiffCapable = (h: SyncProtocolHandler, s: string) =>
  h.handleMessage(s, JSON.stringify({ type: "Connect", sessionId: s, supportsQueryDiff: true }));

const subscribe = (h: SyncProtocolHandler, s: string, queryId: number, resultHash?: string) =>
  h.handleMessage(s, JSON.stringify({ type: "ModifyQuerySet", add: [{ queryId, udfPath: "q", args: {}, resultHash }], remove: [] }));

describe("DLR 2b Task 10 — DIFFABLE_RANGE resume via QueryUnchanged", () => {
  it("a matching resultHash resumes via QueryUnchanged, and byIdRowMap is still seeded for a correct LATER incremental diff", async () => {
    const handler = new SyncProtocolHandler(makeRangeExecutor());
    const socket = new MockSocket();
    handler.connect("s1", socket);
    await connectDiffCapable(handler, "s1");

    // Initial subscribe: no resultHash -> a full QueryDiff reset, carrying `hash`.
    await subscribe(handler, "s1", 1);
    const reset = socket.modifications()[0] as Extract<ServerMessage, { type: "Transition" }>["modifications"][number] & {
      hash?: string;
    };
    expect(reset.type).toBe("QueryDiff");
    expect(typeof reset.hash).toBe("string");
    const baselineHash = reset.hash!;
    socket.clear();

    // Simulate a reconnect: tear down the session (clears byIdRowMap for it) and reconnect fresh —
    // a NEW server session, exactly like a real reconnect gets a brand-new sessionId.
    handler.disconnect("s1");
    handler.connect("s1", socket);
    await connectDiffCapable(handler, "s1");

    // Resubscribe echoing the baseline hash: nothing changed server-side, so this must resolve to
    // QueryUnchanged (Task 10) — NOT another full reset.
    await subscribe(handler, "s1", 1, baselineHash);
    const resumeMods = socket.modifications();
    expect(resumeMods).toHaveLength(1);
    expect(resumeMods[0]!.type).toBe("QueryUnchanged");
    socket.clear();

    // CRITICAL: even though nothing was sent on the wire, byIdRowMap MUST have been seeded for this
    // fresh session — otherwise the next incremental write would diff against a phantom empty map
    // (computing "add" for docs|a/docs|b, which the client already has, instead of a clean "add" for
    // ONLY the new row).
    const docC = rangeRow("docs|c", "c", 3, 300);
    const orderKeyC = orderKeyFor(CHANNEL_RANGE, docC);
    const inv: WriteInvalidation = {
      tables: ["table:3"],
      ranges: [CHANNEL_RANGE.bounds],
      commitTs: 42,
      writtenDocs: [{ keyspace: KS, key: "irrelevant", docId: "docs|c", newRow: docC, wasPresent: false, ts: 42 }],
    };
    await handler.notifyWrites(inv);

    const mods = socket.modifications();
    expect(mods).toHaveLength(1);
    expect(mods[0]).toMatchObject({
      type: "QueryDiff",
      queryId: 1,
      changes: [{ t: "add", key: "docs|c", row: docC, ts: 42, orderKey: orderKeyC }],
    });
    // The seeded-map invariant: the checksum reflects {docs|a, docs|b, docs|c} — i.e. the incremental
    // diff was computed on top of the PROPERLY seeded 2-row baseline, not an empty phantom map (which
    // would instead redundantly "add" docs|a/docs|b here, or simply produce a different checksum).
    const orderKeyA = orderKeyFor(CHANNEL_RANGE, DOC_A);
    const orderKeyB = orderKeyFor(CHANNEL_RANGE, DOC_B);
    const expectedMap = new Map([
      ["docs|a", { row: DOC_A, ts: 0, orderKey: orderKeyA }],
      ["docs|b", { row: DOC_B, ts: 0, orderKey: orderKeyB }],
      ["docs|c", { row: docC, ts: 42, orderKey: orderKeyC }],
    ]);
    expect((mods[0] as { checksum: string }).checksum).toBe(driftChecksum(expectedMap));
  });

  it("a MISMATCHED resultHash (data changed while away) resumes via a QueryDiff reset carrying a fresh hash, not QueryUnchanged", async () => {
    const handler = new SyncProtocolHandler(makeRangeExecutor());
    const socket = new MockSocket();
    handler.connect("s1", socket);
    await connectDiffCapable(handler, "s1");
    await subscribe(handler, "s1", 1);
    socket.clear();

    handler.disconnect("s1");
    handler.connect("s1", socket);
    await connectDiffCapable(handler, "s1");

    // A stale/wrong hash never matches the fresh [DOC_A, DOC_B] scan.
    await subscribe(handler, "s1", 1, "sha256:" + "0".repeat(64));
    const mods = socket.modifications();
    expect(mods).toHaveLength(1);
    expect(mods[0]!.type).toBe("QueryDiff");
    const diff = mods[0] as Extract<ServerMessage, { type: "Transition" }>["modifications"][number] & {
      reset?: unknown;
      hash?: string;
    };
    expect(diff.reset).toEqual({ mode: "range", orderDir: "asc" });
    expect(typeof diff.hash).toBe("string");
  });

  it("no resultHash echoed (first subscribe, or an old client) always gets a full QueryDiff reset, never QueryUnchanged", async () => {
    const handler = new SyncProtocolHandler(makeRangeExecutor());
    const socket = new MockSocket();
    handler.connect("s1", socket);
    await connectDiffCapable(handler, "s1");
    await subscribe(handler, "s1", 1); // no resultHash
    const mods = socket.modifications();
    expect(mods).toHaveLength(1);
    expect(mods[0]!.type).toBe("QueryDiff");
    expect((mods[0] as { reset?: unknown }).reset).toBeDefined();
  });
});

describe("DLR 2b Task 10 — DIFFABLE_BYID resume via QueryUnchanged", () => {
  it("a matching resultHash resumes via QueryUnchanged, and byIdRowMap is still seeded for a correct LATER incremental diff", async () => {
    const handler = new SyncProtocolHandler(makeByIdExecutor());
    const socket = new MockSocket();
    handler.connect("s1", socket);
    await connectDiffCapable(handler, "s1");

    await subscribe(handler, "s1", 1);
    const reset = socket.modifications()[0] as Extract<ServerMessage, { type: "Transition" }>["modifications"][number] & {
      hash?: string;
    };
    expect(reset.type).toBe("QueryDiff");
    expect(typeof reset.hash).toBe("string");
    const baselineHash = reset.hash!;
    socket.clear();

    handler.disconnect("s1");
    handler.connect("s1", socket);
    await connectDiffCapable(handler, "s1");

    await subscribe(handler, "s1", 1, baselineHash);
    const resumeMods = socket.modifications();
    expect(resumeMods).toHaveLength(1);
    expect(resumeMods[0]!.type).toBe("QueryUnchanged");
    socket.clear();

    // A write to docs|a must diff as an "edit" (present in the seeded map) — a phantom empty
    // prev-map would instead (per `byIdChangesFor`) emit an "add", the tell-tale symptom of a
    // never-seeded row-map.
    const inv: WriteInvalidation = {
      tables: ["table:3"],
      ranges: [POINT_A],
      commitTs: 7,
      writtenDocs: [{ keyspace: KS, key: POINT_A.start, docId: "docs|a", newRow: { _id: "docs|a", n: 2 }, wasPresent: true, ts: 7 }],
    };
    await handler.notifyWrites(inv);

    const mods = socket.modifications();
    expect(mods).toHaveLength(1);
    expect(mods[0]).toMatchObject({
      type: "QueryDiff",
      queryId: 1,
      changes: [{ t: "edit", key: "docs|a", row: { _id: "docs|a", n: 2 }, ts: 7 }],
    });
    const expectedMap = new Map([["docs|a", { row: { _id: "docs|a", n: 2 }, ts: 7 }]]);
    expect((mods[0] as { checksum: string }).checksum).toBe(driftChecksum(expectedMap));
  });
});

describe("DLR 2b Task 10 — a session whose capability flips mid-session (server side, documenting the residual)", () => {
  it("a write landing after supportsQueryDiff flips true — but BEFORE this session's row-map was ever seeded — still takes the incremental-diff shortcut against an empty map (pre-existing `?? new Map()` fallback, unchanged by Task 10); the client-side guard is the actual safety net", async () => {
    // A session that has NEVER (re)subscribed via the diffable branch — e.g. `supportsQueryDiff`
    // flips true mid-session (a `Connect` arriving asynchronously after the client's own capability-
    // less subscribe: an outbox client's handshake ordering in `client.ts` is exactly this shape) —
    // lets a live write take the incremental-diff shortcut in `sendSessionTransition` against an
    // EMPTY substituted map (`this.byIdRowMap.get(key) ?? new Map()`), same as the pre-existing
    // RERUN-fallback-then-reseed pattern `commit-differ-handler.test.ts` already pins (a range sub's
    // map is unconditionally dropped there too, expecting a later write to reseed off just its own
    // written docs). Task 10 does NOT change this invalidation-loop arm — the spec is explicit that
    // it "stays hashless" — so this test documents the wire shape as-is (an incremental `add`, not a
    // fallback to `QueryUpdated`) rather than asserting a guard that would collide with that
    // pre-existing, deliberately-tested RERUN-reseed behavior.
    //
    // The client-observable residual this CAN create (a client whose local `renderMode` was never
    // established rendering this incorrectly) is guarded where it actually matters: client-side, in
    // `reconcile.ts#ingestTransition`'s `QueryDiff` arm — see `resume-e2e.test.ts` scenario 3 (which
    // exercises this exact server race through a real client) and the guard's own unit-test coverage.
    const handler = new SyncProtocolHandler(makeRangeExecutor());
    const socket = new MockSocket();
    handler.connect("s1", socket);
    // Subscribe BEFORE advertising the diff capability — takes the RERUN path (QueryUpdated), and
    // never seeds byIdRowMap for this (session, queryId).
    await subscribe(handler, "s1", 1);
    expect(socket.modifications()[0]!.type).toBe("QueryUpdated");
    socket.clear();

    // NOW the capability arrives (mid-session), same as a real Connect racing ahead of/behind a
    // resync in `client.ts`.
    await connectDiffCapable(handler, "s1");

    const docC = rangeRow("docs|c", "c", 3, 300);
    const inv: WriteInvalidation = {
      tables: ["table:3"],
      ranges: [CHANNEL_RANGE.bounds],
      commitTs: 10,
      writtenDocs: [{ keyspace: KS, key: "irrelevant", docId: "docs|c", newRow: docC, wasPresent: false, ts: 10 }],
    };
    await handler.notifyWrites(inv);

    const mods = socket.modifications();
    expect(mods).toHaveLength(1);
    expect(mods[0]).toMatchObject({ type: "QueryDiff", queryId: 1, changes: [{ t: "add", key: "docs|c", row: docC }] });
  });
});
