/**
 * G4 origin-frontier guarantee + G1 MQS/notify serialization, sync-handler half (client-sync
 * verdict §(d) items 2+3). Uses a controllable stub `SyncUdfExecutor` (the mutation-response-ts /
 * action test pattern) so a test can dictate exactly which subscriptions a commit affects, what a
 * re-run returns, and when it resolves.
 *
 *   (a) the invariant: a session commits touching NOTHING it subscribes to → it still receives a
 *       ts-advancing EMPTY Transition (modifications: []) with endVersion.ts ≥ commitTs.
 *   (b) ordering: when the commit DOES modify the session's subscriptions, the modifications arrive
 *       WITH the ts advance (one Transition), never a separate empty advance first.
 *   fleet fallback: a FORWARDED mutation (no local origin tag) advances the origin frontier once the
 *       drain locally processes a commit at-or-above its commitTs.
 *   (e) G1: a racing MQS + invalidation can no longer interleave → per-session serverValue monotone.
 *   (f) MQS bracket contiguity preserved (execution-time version read → chained brackets).
 *   (g) subscribe behind a pending notify completes (no deadlock; execSub→runQuery never re-enters
 *       the tail).
 */
import { describe, it, expect } from "vitest";
import type { SerializedKeyRange } from "@stackbase/index-key-codec";
import { SyncProtocolHandler, type SyncUdfExecutor, type ServerMessage } from "../src/index";

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

/** Controllable executor: `queryValue` drives runQuery's returned value; `queryTables`/`queryRanges`
 *  drive what a subscription reads (so a test dictates whether a given invalidation matches it). */
function mkExec(opts: {
  queryValue?: () => unknown;
  queryTables?: string[];
  queryRanges?: SerializedKeyRange[];
  beforeRunQuery?: () => Promise<void> | void;
  onRunQueryStart?: () => void;
  onRunQueryEnd?: () => void;
} = {}): SyncUdfExecutor {
  return {
    async runQuery() {
      opts.onRunQueryStart?.();
      if (opts.beforeRunQuery) await opts.beforeRunQuery();
      const value = (opts.queryValue?.() ?? "v") as never;
      opts.onRunQueryEnd?.();
      return { value, tables: opts.queryTables ?? ["t"], readRanges: opts.queryRanges ?? [] };
    },
    async runMutation() {
      return { value: "ok" as never, tables: [], writeRanges: [], commitTs: 0 };
    },
    async runAdminQuery() {
      return { value: "admin" as never, tables: ["t"], readRanges: [] };
    },
    async runAction() {
      return { value: "acted" as never };
    },
  };
}

const subscribe = (h: SyncProtocolHandler, s: string, queryId: number) =>
  h.handleMessage(s, JSON.stringify({ type: "ModifyQuerySet", add: [{ queryId, udfPath: "app:q", args: {} }], remove: [] }));

describe("G4 (a) — origin frontier advances even when the commit touches nothing the session reads", () => {
  it("emits an empty (modifications: []) ts-advancing Transition to the origin session", async () => {
    const h = new SyncProtocolHandler(mkExec({ queryTables: ["mine"] }), { autoNotifyOnMutation: false });
    const s = sock();
    h.connect("s1", s as never);
    await subscribe(h, "s1", 1); // s1 reads table "mine"
    s.sent.length = 0;

    // A commit by s1 that touches "other" — disjoint from s1's read set — with s1 as the origin.
    await h.notifyWrites({ tables: ["other"], ranges: [], commitTs: 42 }, "s1");

    const ts = s.transitions();
    expect(ts).toHaveLength(1);
    expect(ts[0]!.modifications).toEqual([]); // empty — nothing s1 subscribes to changed
    expect(ts[0]!.endVersion.ts).toBe(42); // but its frontier advanced past its own commit
    expect(ts[0]!.endVersion.ts).toBeGreaterThanOrEqual(42);
  });

  it("does not regress or re-emit when the frontier is already at/ahead of commitTs", async () => {
    const h = new SyncProtocolHandler(mkExec({ queryTables: ["mine"] }), { autoNotifyOnMutation: false });
    const s = sock();
    h.connect("s1", s as never);
    await subscribe(h, "s1", 1);
    await h.notifyWrites({ tables: ["other"], ranges: [], commitTs: 50 }, "s1"); // advance to 50
    s.sent.length = 0;
    await h.notifyWrites({ tables: ["other"], ranges: [], commitTs: 30 }, "s1"); // stale — must not emit
    expect(s.transitions()).toHaveLength(0);
  });

  it("no origin → no empty frontier Transition (HTTP/driver commit path)", async () => {
    const h = new SyncProtocolHandler(mkExec({ queryTables: ["mine"] }), { autoNotifyOnMutation: false });
    const s = sock();
    h.connect("s1", s as never);
    await subscribe(h, "s1", 1);
    s.sent.length = 0;
    await h.notifyWrites({ tables: ["other"], ranges: [], commitTs: 7 }); // no origin
    expect(s.transitions()).toHaveLength(0);
  });
});

describe("G4 (b) — ordering: when the commit modifies the session's subs, the advance carries them", () => {
  it("delivers ONE Transition with modifications + the ts advance, never a bare empty advance first", async () => {
    const h = new SyncProtocolHandler(mkExec({ queryTables: ["mine"], queryValue: () => "v1" }), {
      autoNotifyOnMutation: false,
    });
    const s = sock();
    h.connect("s1", s as never);
    await subscribe(h, "s1", 1);
    s.sent.length = 0;

    // Commit touches "mine" — s1 IS affected — origin s1.
    await h.notifyWrites({ tables: ["mine"], ranges: [], commitTs: 9 }, "s1");

    const ts = s.transitions();
    expect(ts).toHaveLength(1); // exactly one — not an empty advance + a modification frame
    expect(ts[0]!.endVersion.ts).toBe(9);
    expect(ts[0]!.modifications).toEqual([{ type: "QueryUpdated", queryId: 1, value: "v1" }]);
  });
});

describe("G4 fleet fallback — a forwarded mutation advances the origin frontier via the drain gate", () => {
  /** An executor whose runMutation reports `forwarded: true` (committed on another node, no oplog). */
  function forwardingExec(commitTs: number): SyncUdfExecutor {
    return {
      ...mkExec({ queryTables: ["mine"] }),
      async runMutation() {
        return { value: "ok" as never, tables: [], writeRanges: [], commitTs, forwarded: true };
      },
    };
  }

  it("holds the frontier until a local drain reaches the forwarded commitTs, then emits the empty advance", async () => {
    const h = new SyncProtocolHandler(forwardingExec(100), { autoNotifyOnMutation: false });
    const s = sock();
    h.connect("s1", s as never);
    await subscribe(h, "s1", 1);
    s.sent.length = 0;

    // The forwarded mutation: its origin tag rode a fan-out on ANOTHER node, so no local frontier
    // advance happens here yet — only a pending frontier is recorded.
    await h.handleMessage("s1", JSON.stringify({ type: "Mutation", requestId: "f1", udfPath: "app:m", args: {} }));
    expect(s.transitions()).toHaveLength(0);

    // A local drain BELOW the forwarded commitTs does not yet satisfy it (touches nothing s1 reads).
    await h.notifyWrites({ tables: ["other"], ranges: [], commitTs: 40 });
    expect(s.transitions()).toHaveLength(0);

    // A local drain AT-OR-ABOVE it satisfies the pending frontier with an empty ts-advance.
    await h.notifyWrites({ tables: ["other"], ranges: [], commitTs: 100 });
    const ts = s.transitions();
    expect(ts).toHaveLength(1);
    expect(ts[0]!.modifications).toEqual([]);
    expect(ts[0]!.endVersion.ts).toBe(100);

    // Idempotent — a further drain does not re-emit (the pending frontier was cleared).
    s.sent.length = 0;
    await h.notifyWrites({ tables: ["other"], ranges: [], commitTs: 101 });
    expect(s.transitions()).toHaveLength(0);
  });
});

describe("G1 (e) — MQS and invalidation are serialized: serverValue never regresses", () => {
  it("a subscribe racing an invalidation never interleaves their runQuery executions", async () => {
    let active = 0;
    let maxActive = 0;
    let current = "v0";
    const h = new SyncProtocolHandler(
      mkExec({
        queryTables: ["mine"],
        queryValue: () => current,
        onRunQueryStart: () => {
          active++;
          maxActive = Math.max(maxActive, active);
        },
        // Force an overlap opportunity: yield the event loop mid-execution.
        beforeRunQuery: () => new Promise<void>((r) => setImmediate(r)),
        onRunQueryEnd: () => {
          active--;
        },
      }),
      { autoNotifyOnMutation: false },
    );
    const s = sock();
    h.connect("s1", s as never);
    await subscribe(h, "s1", 1);
    s.sent.length = 0;

    // Fire a second subscribe (MQS) and an invalidation concurrently, without awaiting between them.
    current = "v1";
    const mqs = subscribe(h, "s1", 2); // MQS enqueues on the tail
    const inv = h.notifyWrites({ tables: ["mine"], ranges: [], commitTs: 5 }, undefined); // notify on the tail
    await Promise.all([mqs, inv]);

    // Serialized on one tail → their runQuery bodies never overlapped.
    expect(maxActive).toBe(1);
    // Per-session serverValue is monotone: every delivered value for query 1 is the fresh "v1", and
    // ts is non-decreasing across the session's transitions (no older value lands after a newer one).
    const tss = s.transitions();
    let lastTs = -1;
    for (const t of tss) {
      expect(t.endVersion.ts).toBeGreaterThanOrEqual(lastTs);
      lastTs = t.endVersion.ts;
      for (const m of t.modifications) {
        if (m.type === "QueryUpdated" && m.queryId === 1) expect(m.value).toBe("v1");
      }
    }
  });
});

describe("G1 (f) — MQS bracket contiguity preserved (execution-time version read)", () => {
  it("every Transition's startVersion equals the previous Transition's endVersion", async () => {
    const h = new SyncProtocolHandler(mkExec({ queryTables: ["mine"], queryValue: () => "v" }), {
      autoNotifyOnMutation: false,
    });
    const s = sock();
    h.connect("s1", s as never);
    await subscribe(h, "s1", 1);
    s.sent.length = 0;

    // Interleave a notify (advances ts) and an MQS (bumps querySet), both on the same tail. Because
    // the MQS reads session.version at EXECUTION time, its bracket chains off the notify's endVersion
    // rather than a stale pre-notify version — so the whole delivered stream is gap-free.
    const inv = h.notifyWrites({ tables: ["mine"], ranges: [], commitTs: 11 }, undefined);
    const mqs = subscribe(h, "s1", 2);
    await Promise.all([inv, mqs]);

    const tss = s.transitions();
    expect(tss.length).toBeGreaterThanOrEqual(2);
    for (let i = 1; i < tss.length; i++) {
      expect(tss[i]!.startVersion).toEqual(tss[i - 1]!.endVersion);
    }
  });
});

describe("G1 (g) — subscribe behind a pending notify completes (no tail re-entrancy / deadlock)", () => {
  it("a subscribe issued during an in-flight notify still resolves and delivers its result", async () => {
    let releaseNotify!: () => void;
    const notifyGate = new Promise<void>((r) => (releaseNotify = r));
    let notifyRunning = false;
    const h = new SyncProtocolHandler(
      mkExec({
        queryTables: ["mine"],
        queryValue: () => "v",
        beforeRunQuery: async () => {
          // The FIRST runQuery (the notify's re-run) blocks on the gate; later ones (the MQS) don't.
          if (notifyRunning) {
            await notifyGate;
            notifyRunning = false;
          }
        },
      }),
      { autoNotifyOnMutation: false },
    );
    const s = sock();
    h.connect("s1", s as never);
    await subscribe(h, "s1", 1);
    s.sent.length = 0;

    // Start a notify that will block mid-execution, then enqueue a subscribe behind it.
    notifyRunning = true;
    const inv = h.notifyWrites({ tables: ["mine"], ranges: [], commitTs: 3 }, undefined);
    const mqs = subscribe(h, "s1", 2);

    // The subscribe cannot resolve while the notify is gated (it's behind it on the tail)…
    let mqsDone = false;
    void mqs.then(() => (mqsDone = true));
    await new Promise((r) => setImmediate(r));
    expect(mqsDone).toBe(false);

    // …release the notify → both complete (no deadlock), and the subscribe delivered query 2.
    releaseNotify();
    await Promise.all([inv, mqs]);
    const q2 = s.transitions().flatMap((t) => t.modifications).find((m) => m.type === "QueryUpdated" && m.queryId === 2);
    expect(q2).toBeDefined();
  });
});
