/**
 * M2c Critical fix (whole-branch review): a GLOBAL invalidation must be FRONTIER-NEUTRAL — it must
 * never advance the client-facing local-ts frontier (`session.version.ts`/`Transition.endVersion.ts`)
 * or the local-ts `ResumeRegistry`, and any subscription reading a global table must always re-run on
 * reconnect (never the `QueryUnchanged` compute-skip, which is keyed off that same local-ts registry).
 *
 * Before this fix, `doNotifyWrites`/`sendSessionTransition` fed `invalidation.commitTs` straight into
 * BOTH the resume registry's `advanceOnCommit` AND `session.version.ts` — correct for a local MVCC
 * commit (a small monotone counter), but silently wrong for a global (D1-backed) table's poll-driven
 * invalidation, whose `commitTs` lives in an entirely different clock domain (or, pre-fix, was sourced
 * from wall-clock `Date.now()`). A client with both a local and a global subscription shared ONE
 * `session.version.ts` scalar across the two incompatible domains, which (a) prematurely/permanently
 * degraded local optimistic-update gating and (b) made every local query's reconnect `sinceTs` land
 * far in the "future", so local queries silently never re-ran on reconnect.
 *
 * This suite drives the REAL `SyncProtocolHandler` against fake executors, mirroring the conventions
 * already established in `resume-registry-handler.test.ts` / `global-tables-subscription.test.ts`. See
 * `.superpowers/sdd/m2c-critical-fix-brief.md` for the full design.
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

class MockSocket implements SyncWebSocket {
  readonly messages: ServerMessage[] = [];
  bufferedAmount = 0;
  send(data: string): void {
    this.messages.push(JSON.parse(data) as ServerMessage);
  }
  close(): void {}
}

/**
 * A LOCAL-only query (`notes:list`, reads the `notes` table via a real range) and a GLOBAL-only query
 * (`users:list`, reads only a `.global()` table — no local `readRanges` at all), routed by `path`.
 * Neither classifies as DIFFABLE (an empty/zero-length `readRanges` never satisfies
 * `classifyByIdRead`, and this fake executor never returns `diffableRange`/`diffablePage`), so both
 * always take the plain RERUN branch on notify — the shape `sendSessionTransition`'s final `else` arm
 * and `doModifyQuerySet`'s execSub-then-hash arm both handle.
 */
function makeExecutor(): { executor: SyncUdfExecutor; runQueryCalls: (path: string) => number } {
  const calls: Record<string, number> = {};
  const executor: SyncUdfExecutor = {
    async runQuery(path) {
      calls[path] = (calls[path] ?? 0) + 1;
      if (path === "notes:list") {
        return {
          value: [{ _id: "notes|a", box: "a" }] as unknown as Value,
          tables: ["notes"],
          readRanges: [RANGE_A],
          globalTables: [],
        };
      }
      if (path === "users:list") {
        return {
          value: [{ _id: "users|a", name: "a" }] as unknown as Value,
          tables: [],
          readRanges: [],
          globalTables: ["users"],
        };
      }
      throw new Error(`unexpected path in test executor: ${path}`);
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
  return { executor, runQueryCalls: (path) => calls[path] ?? 0 };
}

function lastTransition(socket: MockSocket): Extract<ServerMessage, { type: "Transition" }> {
  const t = socket.messages.at(-1);
  if (!t || t.type !== "Transition") throw new Error("expected the last message to be a Transition");
  return t;
}

describe("M2c Critical fix: a global invalidation is frontier-neutral", () => {
  it("1. does not advance session.version.ts / Transition.endVersion.ts — even with a wall-clock-shaped commitTs (the exact contamination the bug had)", async () => {
    const { executor } = makeExecutor();
    const handler = new SyncProtocolHandler(executor);
    const socket = new MockSocket();
    handler.connect("s1", socket);
    await handler.handleMessage(
      "s1",
      JSON.stringify({
        type: "ModifyQuerySet",
        add: [
          { queryId: 1, udfPath: "notes:list", args: {} },
          { queryId: 2, udfPath: "users:list", args: {} },
        ],
        remove: [],
      }),
    );

    // Establish a real local frontier via a LOCAL commit intersecting the notes subscription.
    const localInv: WriteInvalidation = { tables: ["notes"], ranges: [RANGE_A], commitTs: 10 };
    await handler.notifyWrites(localInv);
    const afterLocal = lastTransition(socket);
    expect(afterLocal.endVersion.ts).toBe(10);

    // A GLOBAL invalidation with a wall-clock-shaped commitTs — exactly the shape the bug had
    // (`Date.now()` fed straight into the shared local-ts frontier).
    const globalInv: WriteInvalidation = { tables: ["users"], ranges: [], commitTs: 1_732_000_000_000, global: true };
    await handler.notifyWrites(globalInv);
    const afterGlobal = lastTransition(socket);

    // The global query's fresh data still reaches the client...
    expect(afterGlobal.modifications).toEqual([expect.objectContaining({ type: "QueryUpdated", queryId: 2 })]);
    // ...but the frontier stays exactly where the local commit left it — NOT the wall-clock value.
    expect(afterGlobal.startVersion.ts).toBe(10);
    expect(afterGlobal.endVersion.ts).toBe(10);
  });

  it("2. local frontier mechanism stays monotone in the LOCAL domain across an interleaved global push (optimistic-gate proxy: a later local commit's Transition still brackets off the LAST LOCAL commit, never off the global push)", async () => {
    const { executor } = makeExecutor();
    const handler = new SyncProtocolHandler(executor);
    const socket = new MockSocket();
    handler.connect("s1", socket);
    await handler.handleMessage(
      "s1",
      JSON.stringify({
        type: "ModifyQuerySet",
        add: [
          { queryId: 1, udfPath: "notes:list", args: {} },
          { queryId: 2, udfPath: "users:list", args: {} },
        ],
        remove: [],
      }),
    );

    await handler.notifyWrites({ tables: ["notes"], ranges: [RANGE_A], commitTs: 10 });
    expect(lastTransition(socket).endVersion.ts).toBe(10);

    // A global push lands in between two local commits...
    await handler.notifyWrites({ tables: ["users"], ranges: [], commitTs: 999_999_999_999, global: true });
    expect(lastTransition(socket).endVersion.ts).toBe(10); // untouched

    // ...a SUBSEQUENT local commit's Transition still starts exactly where the LAST LOCAL commit left
    // the frontier (10), never from the interleaved global push's wall-clock value — a client-side
    // optimistic gate keyed off this frontier is never prematurely closed/skewed by the global push.
    await handler.notifyWrites({ tables: ["notes"], ranges: [RANGE_A], commitTs: 20 });
    const final = lastTransition(socket);
    expect(final.startVersion.ts).toBe(10);
    expect(final.endVersion.ts).toBe(20);
  });
});

describe("M2c Critical fix: a global-reading subscription always re-runs on reconnect", () => {
  it("3. a GLOBAL query resubscribes with sinceTs >= lastInvalidatedTs and still gets a fresh QueryUpdated (never QueryUnchanged); contrast a pure-LOCAL query, which still skips as before", async () => {
    const { executor, runQueryCalls } = makeExecutor();
    const handler = new SyncProtocolHandler(executor);
    const socket1 = new MockSocket();
    handler.connect("s1", socket1);
    await handler.handleMessage(
      "s1",
      JSON.stringify({
        type: "ModifyQuerySet",
        add: [
          { queryId: 1, udfPath: "notes:list", args: {} },
          { queryId: 2, udfPath: "users:list", args: {} },
        ],
        remove: [],
      }),
    );
    expect(runQueryCalls("notes:list")).toBe(1);
    expect(runQueryCalls("users:list")).toBe(1);

    const localKey = regKey(null, "notes:list", {});
    const globalKey = regKey(null, "users:list", {});
    const localSeededTs = handler.__resumeRegistry.lookup(localKey)!.lastInvalidatedTs;
    const globalSeededTs = handler.__resumeRegistry.lookup(globalKey)!.lastInvalidatedTs;
    // Sanity: the registry entry for the global query DOES record its global-table membership —
    // that's the field Change 4's gate reads.
    expect(handler.__resumeRegistry.lookup(globalKey)!.globalTables).toContain("users");

    handler.disconnect("s1");

    const socket2 = new MockSocket();
    handler.connect("s2", socket2);
    await handler.handleMessage(
      "s2",
      JSON.stringify({
        type: "ModifyQuerySet",
        add: [
          { queryId: 1, udfPath: "notes:list", args: {}, sinceTs: localSeededTs },
          { queryId: 2, udfPath: "users:list", args: {}, sinceTs: globalSeededTs },
        ],
        remove: [],
      }),
    );

    // The LOCAL query's read set is genuinely untouched since seeding -> the existing compute-skip
    // fires (no re-run). The GLOBAL query ALWAYS re-runs, regardless of sinceTs vs lastInvalidatedTs.
    expect(runQueryCalls("notes:list")).toBe(1); // unchanged: skipped, no re-run
    expect(runQueryCalls("users:list")).toBe(2); // re-ran

    const resumeTransition = lastTransition(socket2);
    const localMod = resumeTransition.modifications.find((m) => m.queryId === 1);
    const globalMod = resumeTransition.modifications.find((m) => m.queryId === 2);
    expect(localMod).toEqual({ type: "QueryUnchanged", queryId: 1 });
    expect(globalMod).toEqual(expect.objectContaining({ type: "QueryUpdated", queryId: 2 }));
  });
});

describe("M2c Critical fix: a pure-local query's reconnect-resume stays intact", () => {
  it("4. a prior GLOBAL invalidation on the session does not contaminate a pure-LOCAL query's later reconnect-resume — genuinely-unchanged still QueryUnchanged-skips, and a real gap write still re-runs", async () => {
    const { executor, runQueryCalls } = makeExecutor();
    const handler = new SyncProtocolHandler(executor);
    const socket1 = new MockSocket();
    handler.connect("s1", socket1);
    await handler.handleMessage(
      "s1",
      JSON.stringify({ type: "ModifyQuerySet", add: [{ queryId: 1, udfPath: "notes:list", args: {} }], remove: [] }),
    );
    expect(runQueryCalls("notes:list")).toBe(1);

    const key = regKey(null, "notes:list", {});
    const seededTs = handler.__resumeRegistry.lookup(key)!.lastInvalidatedTs;

    // A GLOBAL invalidation happens on the session BEFORE it disconnects — must not touch this local
    // entry's lastInvalidatedTs (Change 2's `!invalidation.global` guard on `advanceOnCommit`).
    await handler.notifyWrites({ tables: ["users"], ranges: [], commitTs: 555_555_555_555, global: true });
    expect(handler.__resumeRegistry.lookup(key)!.lastInvalidatedTs).toBe(seededTs);

    handler.disconnect("s1");

    // Reconnect: genuinely unchanged -> the QueryUnchanged skip still fires (unaffected by the
    // earlier global push).
    const socket2 = new MockSocket();
    handler.connect("s2", socket2);
    await handler.handleMessage(
      "s2",
      JSON.stringify({
        type: "ModifyQuerySet",
        add: [{ queryId: 2, udfPath: "notes:list", args: {}, sinceTs: seededTs }],
        remove: [],
      }),
    );
    expect(runQueryCalls("notes:list")).toBe(1); // skipped
    expect(lastTransition(socket2).modifications).toEqual([{ type: "QueryUnchanged", queryId: 2 }]);

    // A REAL local gap write still forces a re-run on the next reconnect, exactly as before this fix.
    handler.disconnect("s2");
    await handler.notifyWrites({ tables: ["notes"], ranges: [RANGE_A], commitTs: seededTs + 50 });

    const socket3 = new MockSocket();
    handler.connect("s3", socket3);
    await handler.handleMessage(
      "s3",
      JSON.stringify({
        type: "ModifyQuerySet",
        add: [{ queryId: 3, udfPath: "notes:list", args: {}, sinceTs: seededTs }],
        remove: [],
      }),
    );
    expect(runQueryCalls("notes:list")).toBe(2); // re-ran: the gap write is above sinceTs
    expect(lastTransition(socket3).modifications).toEqual([expect.objectContaining({ type: "QueryUpdated", queryId: 3 })]);
  });
});

describe("M2c Critical fix: non-global notifyWrites is byte-identical (regression)", () => {
  it("5. an ordinary (non-global) commit still advances the frontier + the resume registry exactly as before this fix", async () => {
    const { executor } = makeExecutor();
    const handler = new SyncProtocolHandler(executor);
    const socket = new MockSocket();
    handler.connect("s1", socket);
    await handler.handleMessage(
      "s1",
      JSON.stringify({ type: "ModifyQuerySet", add: [{ queryId: 1, udfPath: "notes:list", args: {} }], remove: [] }),
    );

    const key = regKey(null, "notes:list", {});
    expect(handler.__resumeRegistry.lookup(key)!.lastInvalidatedTs).toBe(0); // INITIAL_VERSION.ts

    // `global` omitted entirely — must behave exactly as pre-fix: advances both the resume registry
    // AND session.version.ts/Transition.endVersion.ts to the commit's own ts.
    await handler.notifyWrites({ tables: ["notes"], ranges: [RANGE_A], commitTs: 42 });

    expect(handler.__resumeRegistry.lookup(key)!.lastInvalidatedTs).toBe(42);
    const t = lastTransition(socket);
    expect(t.startVersion.ts).toBe(0);
    expect(t.endVersion.ts).toBe(42);
    expect(t.modifications).toEqual([expect.objectContaining({ type: "QueryUpdated", queryId: 1 })]);
  });
});
