/**
 * DLR 2b — origin-response-gate leak regression (review CRITICAL: node-wide reactive deadlock).
 *
 * The gate (`originResponseGates`, keyed by `commitTs`) is registered SYNCHRONOUSLY at commit time
 * (the runtime's `adapter.subscribe` callback calls `registerOriginResponseGate`) and a diff-capable
 * origin's own reactive `Transition` parks on it inside `doNotifyWrites` until the commit's
 * `MutationResponse` has flushed. The success path releases it inline; the bug was that a
 * `commitThenThrow` mutation — which COMMITS (registering + firing the fan-out that parks on the gate)
 * and THEN throws — reached `processMutation`'s CATCH, which sent the failure response but NEVER
 * released the gate. The parked `doNotifyWrites` then sat on the single `notifyTail` forever, so EVERY
 * subsequent reactive fan-out on the whole node was wedged permanently.
 *
 * The fix: the executor stamps the committed ts onto the thrown error (a `Symbol.for` registry key),
 * and `processMutation`'s catch releases that exact gate. This test drives the sync handler directly
 * (the `origin-frontier` test pattern), simulating the runtime's two decoupled seams — the
 * commit-time gate registration + fan-out (via a controllable `runMutation`) and the serial drain
 * (`notifyWrites`) — to prove a commit-then-throw from a diff-capable SUBSCRIBED origin does NOT wedge
 * a SUBSEQUENT ordinary write's fan-out. It TIMES OUT (fails) on the pre-fix code and passes with it.
 */
import { describe, it, expect } from "vitest";
import { SyncProtocolHandler, type SyncUdfExecutor, type ServerMessage } from "../src/index";
import { COMMITTED_TS_ERROR_KEY, committedTsOfError } from "@helipod/executor";

type Transition = Extract<ServerMessage, { type: "Transition" }>;

function sock() {
  const sent: ServerMessage[] = [];
  return {
    sent,
    send: (d: string) => sent.push(JSON.parse(d) as ServerMessage),
    bufferedAmount: 0,
    close: () => {},
    transitions: () => sent.filter((m): m is Transition => m.type === "Transition"),
  };
}

/** Build the error the executor throws after a `commitThenThrow` — a plain Error with the committed
 *  ts stamped on the well-known `Symbol.for` registry key (byte-identical to what the executor does). */
function commitThenThrowError(message: string, committedTs: number): Error {
  const err = new Error(message);
  (err as unknown as Record<PropertyKey, unknown>)[COMMITTED_TS_ERROR_KEY] = committedTs;
  return err;
}

const connectDiffCapable = (h: SyncProtocolHandler, s: string) =>
  h.handleMessage(s, JSON.stringify({ type: "Connect", supportsQueryDiff: true }));

const subscribe = (h: SyncProtocolHandler, s: string, queryId: number) =>
  h.handleMessage(s, JSON.stringify({ type: "ModifyQuerySet", add: [{ queryId, udfPath: "app:q", args: {} }], remove: [] }));

/** Resolve to "done" if `p` settles first, or "timeout" after `ms` — bounds the pre-fix hang so the
 *  falsifying run FAILS an assertion rather than hanging vitest forever. */
function raceTimeout(p: Promise<unknown>, ms: number): Promise<"done" | "timeout"> {
  return Promise.race([
    p.then(() => "done" as const, () => "done" as const),
    new Promise<"timeout">((r) => setTimeout(() => r("timeout"), ms)),
  ]);
}

describe("origin-response-gate leak — commitThenThrow must not wedge node-wide reactivity", () => {
  it("cross-package contract: the executor's stamped key IS the Symbol.for registry key the handler reads", () => {
    // The handler reads the ts via its own `Symbol.for("helipod.executor.committedTs")` (kept
    // type-only-coupled to the executor). Pin the two sides to the same global-registry symbol.
    expect(COMMITTED_TS_ERROR_KEY).toBe(Symbol.for("helipod.executor.committedTs"));
    expect(committedTsOfError(commitThenThrowError("x", 7))).toBe(7);
    expect(committedTsOfError(new Error("no ts"))).toBeUndefined();
  });

  it("a subsequent write still fans out to the diff-capable origin after its commit-then-throw", async () => {
    const COMMIT_TS = 100; // the commit-then-throw's committed ts
    const NEXT_TS = 200; // a later ordinary write

    // Controllable executor: the `commitThenThrow` mutation SIMULATES the runtime's commit seam —
    // synchronously register the gate (as `adapter.subscribe` does at commit time), kick the commit's
    // own fan-out onto the drain (as `void drain()` does), then THROW with the committed ts stamped
    // on the error (as the executor does for a `CommitThenThrow`). It touches table "t" — which s1
    // reads — so s1's own Transition parks on the gate inside `doNotifyWrites`.
    let handler!: SyncProtocolHandler;
    const exec: SyncUdfExecutor = {
      async runQuery() {
        return { value: "v" as never, tables: ["t"], readRanges: [], globalTables: [] };
      },
      async runMutation(_path, _args, _identity, origin) {
        handler.registerOriginResponseGate(COMMIT_TS, origin); // commit-time registration
        // The commit's fan-out (decoupled drain): parks on the gate for this diff-capable origin.
        void handler.notifyWrites({ tables: ["t"], ranges: [], commitTs: COMMIT_TS }, origin);
        throw commitThenThrowError("failed-login recorded", COMMIT_TS);
      },
      async runAdminQuery() {
        return { value: "admin" as never, tables: ["t"], readRanges: [], globalTables: [] };
      },
      async runAction() {
        return { value: "acted" as never };
      },
    };

    handler = new SyncProtocolHandler(exec, { autoNotifyOnMutation: false });
    const s = sock();
    handler.connect("s1", s as never);
    await connectDiffCapable(handler, "s1");
    await subscribe(handler, "s1", 1); // s1 (diff-capable) subscribes to table "t"
    s.sent.length = 0;

    // The commit-then-throw mutation: commits (registers + parks the gate), then throws → the catch
    // sends a failure MutationResponse and (with the fix) releases the gate.
    await handler.handleMessage("s1", JSON.stringify({ type: "Mutation", requestId: "m1", udfPath: "app:m", args: {} }));

    // It settled as a failure (the commit-then-throw surfaced an error to the caller)…
    const resp = s.sent.find((m) => m.type === "MutationResponse");
    expect(resp).toMatchObject({ type: "MutationResponse", requestId: "m1", success: false });

    // …and reactivity is NOT wedged: a SUBSEQUENT ordinary write (any path — here an HTTP-style
    // no-origin commit) must still fan out to s1's live subscription. On the pre-fix code the gate for
    // COMMIT_TS is never released, so the parked `doNotifyWrites` blocks the single `notifyTail` and
    // this `notifyWrites` never runs → `raceTimeout` returns "timeout" and the assertion FAILS.
    const later = handler.notifyWrites({ tables: ["t"], ranges: [], commitTs: NEXT_TS }, undefined);
    expect(await raceTimeout(later, 1000)).toBe("done");

    // s1 actually received the later commit's Transition (frontier advanced to NEXT_TS).
    const advanced = s.transitions().some((t) => t.endVersion.ts === NEXT_TS);
    expect(advanced).toBe(true);
  });

  it("bounded by construction: a commit-then-throw whose origin has NO affected subscription leaves no gate", async () => {
    // s1 subscribes to "t" but the commit-then-throw writes "other" (disjoint) — the origin is NOT in
    // `bySession`, so `doNotifyWrites` never parks on the gate. The gate must still be released (not
    // leaked) so the map can't grow unbounded across repeated commit-then-throws.
    const COMMIT_TS = 300;
    let handler!: SyncProtocolHandler;
    const exec: SyncUdfExecutor = {
      async runQuery() {
        return { value: "v" as never, tables: ["t"], readRanges: [], globalTables: [] };
      },
      async runMutation(_path, _args, _identity, origin) {
        handler.registerOriginResponseGate(COMMIT_TS, origin);
        void handler.notifyWrites({ tables: ["other"], ranges: [], commitTs: COMMIT_TS }, origin);
        throw commitThenThrowError("no-affected-sub", COMMIT_TS);
      },
      async runAdminQuery() {
        return { value: "admin" as never, tables: ["t"], readRanges: [], globalTables: [] };
      },
      async runAction() {
        return { value: "acted" as never };
      },
    };
    handler = new SyncProtocolHandler(exec, { autoNotifyOnMutation: false });
    const s = sock();
    handler.connect("s1", s as never);
    await connectDiffCapable(handler, "s1");
    await subscribe(handler, "s1", 1);

    await handler.handleMessage("s1", JSON.stringify({ type: "Mutation", requestId: "m1", udfPath: "app:m", args: {} }));

    // A later write still fans out (the disjoint-write case never parked, but the gate must be gone).
    const later = handler.notifyWrites({ tables: ["t"], ranges: [], commitTs: 400 }, undefined);
    expect(await raceTimeout(later, 1000)).toBe("done");
    expect(s.transitions().some((t) => t.endVersion.ts === 400)).toBe(true);
  });

  it("disconnect backstop: a session that vanishes mid-flight releases its parked gate", async () => {
    // Register a gate for s1, park a notify on it (s1 is diff-capable + subscribed), then DISCONNECT
    // s1 without ever releasing via `processMutation`. The disconnect backstop must resolve the parked
    // gate so a later write's fan-out to OTHER sessions is not wedged behind it on the notifyTail.
    const COMMIT_TS = 500;
    const handler = new SyncProtocolHandler(
      {
        async runQuery() {
          return { value: "v" as never, tables: ["t"], readRanges: [], globalTables: [] };
        },
        async runMutation() {
          return { value: "ok" as never, tables: [], writeRanges: [], commitTs: 0 };
        },
        async runAdminQuery() {
          return { value: "admin" as never, tables: ["t"], readRanges: [], globalTables: [] };
        },
        async runAction() {
          return { value: "acted" as never };
        },
      },
      { autoNotifyOnMutation: false },
    );
    const s1 = sock();
    const s2 = sock();
    handler.connect("s1", s1 as never);
    handler.connect("s2", s2 as never);
    await connectDiffCapable(handler, "s1");
    await subscribe(handler, "s1", 1);
    await subscribe(handler, "s2", 1);
    s2.sent.length = 0;

    // Simulate the commit seam for s1, then park its own Transition on the gate — but never release.
    handler.registerOriginResponseGate(COMMIT_TS, "s1");
    void handler.notifyWrites({ tables: ["t"], ranges: [], commitTs: COMMIT_TS }, "s1");
    // Let `doNotifyWrites` actually REACH the park (`await gate.promise`) before disconnecting — so
    // the disconnect must resolve a genuinely-parked gate, not merely a registered-but-unawaited one.
    for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));

    // s1 disappears mid-flight. The backstop must resolve its still-pending, PARKED gate.
    handler.disconnect("s1");

    // A later write must still reach s2 (the notifyTail is not wedged behind s1's orphaned gate).
    const later = handler.notifyWrites({ tables: ["t"], ranges: [], commitTs: 600 }, undefined);
    expect(await raceTimeout(later, 1000)).toBe("done");
    expect(s2.transitions().some((t) => t.endVersion.ts === 600)).toBe(true);
  });
});
