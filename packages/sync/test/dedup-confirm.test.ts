/**
 * Perf-backlog #9 — CONFIRM identical-query dedup in the reactive fan-out.
 *
 * Question: when N subscribers watch the SAME query (same identity + udfPath + args) and a write
 * invalidates them all, does the engine compute the query ONCE and fan the result to all N, or
 * re-execute it N times?
 *
 * Finding (this test documents it): the fan-out re-runs PER SUBSCRIPTION — `doNotifyWrites` groups
 * affected subs `bySession` and `sendSessionTransition` loops per sub calling `execSub`→`runQuery`,
 * with no grouping by `(identity, udfPath, args)`. So N identical RERUN subscriptions cause N
 * executions. The fan-out benchmark's "millions of re-runs/sec" was a cheap in-memory query times
 * the fan-out width, NOT compute-once-fan-to-all. Deduping identical queries (compute once, fan the
 * result/diff to all matching subs) is therefore a real, unclaimed optimization for the broadcast
 * "everyone watching the same channel" case — see the backlog. If that ships, update the
 * `runQueryCalls() === N` assertion below to `=== 1` (and keep the all-N-delivered assertion).
 */
import { describe, it, expect } from "vitest";
import { indexKeyspaceId, keySuccessor, serializeKeyRange, type SerializedKeyRange } from "@stackbase/index-key-codec";
import type { Value } from "@stackbase/values";
import { SyncProtocolHandler, type SyncUdfExecutor, type SyncWebSocket, type ServerMessage, type WriteInvalidation } from "../src/index";

const KS = indexKeyspaceId("notes", "by_box");
const rangeFor = (v: string): SerializedKeyRange => {
  const start = new TextEncoder().encode(v);
  return serializeKeyRange({ keyspace: KS, start, end: keySuccessor(start) });
};
const RANGE_A = rangeFor("a");

class MockSocket implements SyncWebSocket {
  readonly messages: ServerMessage[] = [];
  bufferedAmount = 0;
  send(data: string): void { this.messages.push(JSON.parse(data) as ServerMessage); }
  close(): void {}
}

/** A RERUN executor (returns a plain value + readRanges, no diffable classification) with a
 *  `runQuery` call counter — so we can see exactly how many times the SAME query executes. */
function makeCountingExecutor(): { executor: SyncUdfExecutor; runQueryCalls: () => number } {
  let n = 0;
  const executor: SyncUdfExecutor = {
    async runQuery() {
      n++;
      return { value: [{ _id: "notes|a", box: "a" }] as unknown as Value, tables: ["notes"], readRanges: [RANGE_A], globalTables: [] };
    },
    async runMutation() { throw new Error("unused"); },
    async runAdminQuery() { throw new Error("unused"); },
    async runAction() { throw new Error("unused"); },
  };
  return { executor, runQueryCalls: () => n };
}

describe("perf #9 — identical-query dedup in the reactive fan-out", () => {
  it("re-executes the SAME query once PER subscriber on a write (no dedup today) — and delivers to all", async () => {
    const N = 8;
    const { executor, runQueryCalls } = makeCountingExecutor();
    const handler = new SyncProtocolHandler(executor);
    const sockets: MockSocket[] = [];

    // N sessions all subscribe to the IDENTICAL query (same null identity, same path, same args).
    for (let i = 0; i < N; i++) {
      const socket = new MockSocket();
      handler.connect(`s${i}`, socket);
      sockets.push(socket);
      await handler.handleMessage(`s${i}`, JSON.stringify({ type: "ModifyQuerySet", add: [{ queryId: 1, udfPath: "notes:list", args: { box: "a" } }], remove: [] }));
    }
    // Each subscribe ran the query once (initial answer) → N so far.
    expect(runQueryCalls()).toBe(N);

    // One write intersecting the shared read range invalidates all N.
    const before = runQueryCalls();
    const write: WriteInvalidation = { tables: ["notes"], ranges: [RANGE_A], commitTs: 10 };
    await handler.notifyWrites(write);

    // CONFIRMED: the query re-executed once per subscriber during the fan-out (N times), not once.
    // (A compute-once-fan-to-all dedup would make this delta 1. It does not exist today.)
    expect(runQueryCalls() - before).toBe(N);

    // Correctness invariant a dedup optimization MUST preserve: every subscriber got the update.
    for (const socket of sockets) {
      const gotTransition = socket.messages.some((m) => m.type === "Transition" && m.modifications.some((x) => x.queryId === 1 && (x.type === "QueryUpdated" || x.type === "QueryDiff")));
      expect(gotTransition).toBe(true);
    }
  });
});
