/**
 * W1 (client-sync verdict §(d) item 1): `MutationResponse.ts` carries the mutation's commitTs,
 * and the send-site invariant check that keeps a poisoned `0` off the wire. Uses a lightweight
 * stub `SyncUdfExecutor` (the `action.test.ts` pattern) for full control over commitTs, rather
 * than the real engine — the real-engine loopback path (ts matches the observing Transition) is
 * covered separately in `sync.test.ts`.
 */
import { describe, it, expect, vi } from "vitest";
import { SyncProtocolHandler, type SyncUdfExecutor, type ServerMessage } from "../src/index";

function mkExec(commitTs: number, runMutationOverride?: SyncUdfExecutor["runMutation"]): SyncUdfExecutor {
  return {
    async runQuery(path) {
      return { value: `user:${path}` as never, tables: ["t"], readRanges: [], globalTables: [] };
    },
    runMutation:
      runMutationOverride ??
      (async () => ({ value: "ok" as never, tables: ["t"], writeRanges: [], commitTs })),
    async runAdminQuery(path) {
      return { value: `admin:${path}` as never, tables: ["t"], readRanges: [], globalTables: [] };
    },
    async runAction(path) {
      return { value: `acted:${path}` as never };
    },
  };
}

function sock() {
  const sent: ServerMessage[] = [];
  return { sent, send: (d: string) => sent.push(JSON.parse(d) as ServerMessage), bufferedAmount: 0, close: () => {} };
}

describe("MutationResponse.ts send-site invariant", () => {
  it("populates ts from a valid (> 0) commitTs", async () => {
    const h = new SyncProtocolHandler(mkExec(42), { autoNotifyOnMutation: false });
    const s = sock();
    h.connect("s1", s as never);
    await h.handleMessage("s1", JSON.stringify({ type: "Mutation", requestId: "r1", udfPath: "app:mut", args: {} }));
    const resp = s.sent.find((m) => m.type === "MutationResponse") as Extract<
      ServerMessage,
      { type: "MutationResponse"; success: true }
    >;
    expect(resp).toMatchObject({ requestId: "r1", success: true, ts: 42 });
  });

  it("commitTs <= 0 (the runtime.ts `?? 0n` fallback leaking through): console.error's and OMITS ts from the wire rather than sending a lying 0", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const h = new SyncProtocolHandler(mkExec(0), { autoNotifyOnMutation: false });
      const s = sock();
      h.connect("s1", s as never);
      await h.handleMessage("s1", JSON.stringify({ type: "Mutation", requestId: "r2", udfPath: "app:mut", args: {} }));
      const resp = s.sent.find((m) => m.type === "MutationResponse") as Extract<ServerMessage, { type: "MutationResponse" }>;
      expect(resp.success).toBe(true);
      // Omitted, not present-as-0: JSON.stringify drops an undefined field entirely.
      expect("ts" in resp).toBe(false);
      expect(errSpy).toHaveBeenCalledTimes(1);
      expect(errSpy.mock.calls[0]![0]).toMatch(/commitTs invariant violated/);
    } finally {
      errSpy.mockRestore();
    }
  });

  it("a negative commitTs is treated the same as 0 — logged, ts omitted", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const h = new SyncProtocolHandler(mkExec(-1), { autoNotifyOnMutation: false });
      const s = sock();
      h.connect("s1", s as never);
      await h.handleMessage("s1", JSON.stringify({ type: "Mutation", requestId: "r3", udfPath: "app:mut", args: {} }));
      const resp = s.sent.find((m) => m.type === "MutationResponse") as Extract<ServerMessage, { type: "MutationResponse" }>;
      expect("ts" in resp).toBe(false);
      expect(errSpy).toHaveBeenCalledTimes(1);
    } finally {
      errSpy.mockRestore();
    }
  });

  it("a failed mutation's MutationResponse has no ts field at all (unaffected by W1)", async () => {
    const h = new SyncProtocolHandler(
      mkExec(0, async () => {
        throw new Error("boom");
      }),
      { autoNotifyOnMutation: false },
    );
    const s = sock();
    h.connect("s1", s as never);
    await h.handleMessage("s1", JSON.stringify({ type: "Mutation", requestId: "r4", udfPath: "app:mut", args: {} }));
    const resp = s.sent.find((m) => m.type === "MutationResponse") as Extract<ServerMessage, { type: "MutationResponse" }>;
    expect(resp).toMatchObject({ requestId: "r4", success: false, error: "boom" });
    expect("ts" in resp).toBe(false);
  });
});

describe("backpressure exemption: MutationResponse/ActionResponse are undroppable", () => {
  /** A socket that never drains on its own — bufferedAmount stays high until the test flips it. */
  function stuckSocket() {
    const sent: ServerMessage[] = [];
    return {
      sent,
      bufferedAmount: 2 * 1024 * 1024, // above the 1 MiB default high-water mark
      send: (d: string) => sent.push(JSON.parse(d) as ServerMessage),
      close: () => {},
    };
  }

  it("under a flooded, backed-up session, Transitions get dropped but the MutationResponse always arrives", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const h = new SyncProtocolHandler(mkExec(99), {
        backpressure: { maxQueuedFrames: 3 }, // small cap — easy to flood
      });
      const s = stuckSocket();
      h.connect("s1", s as never);

      // Subscribe (queues a Transition-shaped response for ModifyQuerySet — irrelevant here),
      // then flood the session with reactive Transitions by mutating repeatedly from ANOTHER
      // session subscribed to the same query, well past maxQueuedFrames.
      await h.handleMessage(
        "s1",
        JSON.stringify({ type: "ModifyQuerySet", add: [{ queryId: 1, udfPath: "app:q", args: {} }], remove: [] }),
      );
      s.sent.length = 0; // clear the initial subscribe response

      for (let i = 0; i < 10; i++) {
        await h.notifyWrites({ tables: ["t"], ranges: [], commitTs: i + 1 }, "other-session");
      }
      // The queue capped at 3 — some Transitions must have been dropped.
      expect(s.sent.filter((m) => m.type === "Transition").length).toBeLessThan(10);
      expect(warn).toHaveBeenCalled(); // backpressure warning fired for the dropped Transitions

      // Now issue a Mutation on the SAME still-stuck session — its MutationResponse must still
      // be queued (not dropped), and must be delivered once the client catches up.
      await h.handleMessage("s1", JSON.stringify({ type: "Mutation", requestId: "flooded", udfPath: "app:mut", args: {} }));
      s.bufferedAmount = 0; // client catches up
      // Drive a flush: any further send on this session's chokepoint flushes the queue first
      // (a no-op ModifyQuerySet still produces one Transition send).
      await h.handleMessage("s1", JSON.stringify({ type: "ModifyQuerySet", add: [], remove: [] }));
      h.dispose();

      const resp = s.sent.find((m) => m.type === "MutationResponse") as Extract<ServerMessage, { type: "MutationResponse" }>;
      expect(resp).toBeDefined();
      expect(resp).toMatchObject({ requestId: "flooded", success: true });
    } finally {
      warn.mockRestore();
    }
  });
});

describe("undroppable-queue-overflow: flooding mutations past the cap terminates the session", () => {
  /** A socket that never drains and tracks close() so termination is observable. */
  function stuckSocketWithClose() {
    const sent: ServerMessage[] = [];
    return {
      sent,
      bufferedAmount: 2 * 1024 * 1024, // above the 1 MiB default high-water mark
      send: (d: string) => sent.push(JSON.parse(d) as ServerMessage),
      close: vi.fn(),
    };
  }

  it("terminates the session with a distinct reason once queued undroppable frames exceed the cap; below the cap, all queue (never dropped)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const h = new SyncProtocolHandler(mkExec(1), {
        autoNotifyOnMutation: false,
        backpressure: { maxUndroppableQueuedFrames: 2 }, // small cap — easy to flood
      });
      const s = stuckSocketWithClose();
      h.connect("s1", s as never);

      // Below the cap: two mutations queue their MutationResponse — no drop, no termination.
      await h.handleMessage("s1", JSON.stringify({ type: "Mutation", requestId: "m0", udfPath: "app:mut", args: {} }));
      await h.handleMessage("s1", JSON.stringify({ type: "Mutation", requestId: "m1", udfPath: "app:mut", args: {} }));
      expect(s.close).not.toHaveBeenCalled();
      expect(s.sent.filter((m) => m.type === "MutationResponse")).toHaveLength(0); // still queued, socket stuck

      // Past the cap: the session is terminated instead of silently dropping the 3rd response.
      await h.handleMessage("s1", JSON.stringify({ type: "Mutation", requestId: "m2", udfPath: "app:mut", args: {} }));
      expect(s.close).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("undroppable-queue-overflow"));

      // The session is gone — a further message on it is an explicit, loud failure (unknown
      // session), never a silent no-op. This is the "in-flight becomes an explicit error" contract.
      await expect(
        h.handleMessage("s1", JSON.stringify({ type: "Mutation", requestId: "m3", udfPath: "app:mut", args: {} })),
      ).rejects.toThrow(/unknown session/);
    } finally {
      warn.mockRestore();
    }
  });
});
