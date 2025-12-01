import { describe, it, expect, beforeEach } from "vitest";
import { convexToJson, type JSONValue, type Value } from "@stackbase/values";
import { TimeoutError, InvalidClientIdError, OccConflictError } from "@stackbase/errors";
import {
  SyncProtocolHandler,
  type SyncUdfExecutor,
  type SyncWebSocket,
  type ServerMessage,
  type RunMutationResult,
  type ClientMutationVerdict,
} from "../src/index";

// A minimal stateful mock executor for the wire/handler layer: it records the dedup keys it was
// called with, keeps an in-memory verdict store (so a resend replays), and lets a test force a
// throw or a replay-shaped return for a given seq.
class MockExecutor implements SyncUdfExecutor {
  readonly runCalls: Array<{ path: string; dedup?: { clientId: string; seq: number } }> = [];
  readonly classifyCalls: Array<{ clientId: string; seq: number }> = [];
  readonly pruneCalls: Array<{ clientId: string; ackedThrough: number }> = [];
  private verdicts = new Map<string, ClientMutationVerdict>();
  /** seq → forced behavior for the NEXT fresh run of that seq: a TERMINAL (deterministic, non-
   *  retryable) throw — mirrors a handler-thrown app error the owner already recorded a verdict for. */
  poison = new Set<number>();
  /** seq → forced behavior for the NEXT fresh run of that seq: a TRANSIENT (retryable) throw —
   *  mirrors an infra hiccup the owner recorded NOTHING for (`handleDedupError`'s retryable branch). */
  transientPoison = new Set<number>();
  private tsCounter = 100;

  key(clientId: string, seq: number): string {
    return `${clientId}:${seq}`;
  }

  async runQuery(): Promise<{ value: Value; tables: string[]; readRanges: [] }> {
    return { value: null as unknown as Value, tables: [], readRanges: [] };
  }
  async runAdminQuery(): Promise<{ value: Value; tables: string[]; readRanges: [] }> {
    return { value: null as unknown as Value, tables: [], readRanges: [] };
  }
  async runAction(): Promise<{ value: Value }> {
    return { value: null as unknown as Value };
  }

  async runMutation(
    path: string,
    _args: JSONValue,
    _identity?: string | null,
    _origin?: string,
    dedup?: { clientId: string; seq: number },
  ): Promise<RunMutationResult> {
    this.runCalls.push({ path, dedup });
    if (dedup) {
      const existing = this.verdicts.get(this.key(dedup.clientId, dedup.seq));
      if (existing) {
        if (existing.verdict === "applied") {
          return {
            replayed: true,
            verdict: "applied",
            commitTs: existing.commitTs,
            ...(existing.valueMissing ? { valueMissing: true } : { value: (existing.value ?? null) as Value }),
          };
        }
        return { replayed: true, verdict: existing.verdict as "failed", commitTs: existing.commitTs, code: existing.code };
      }
      if (this.poison.has(dedup.seq)) {
        // Deterministic terminal: record a failed verdict then throw (mirrors the owner).
        this.verdicts.set(this.key(dedup.clientId, dedup.seq), {
          clientId: dedup.clientId,
          seq: dedup.seq,
          verdict: "failed",
          commitTs: 0,
          code: "BOOM",
        });
        throw new Error("boom");
      }
      if (this.transientPoison.has(dedup.seq)) {
        // Transient/infra: nothing recorded (mirrors `handleDedupError`'s retryable branch) — a
        // resend of this exact seq would run fresh again, unlike the terminal case above.
        throw new TimeoutError("infra hiccup");
      }
    }
    const commitTs = ++this.tsCounter;
    if (dedup) {
      this.verdicts.set(this.key(dedup.clientId, dedup.seq), {
        clientId: dedup.clientId,
        seq: dedup.seq,
        verdict: "applied",
        commitTs,
        value: convexToJson(`ok-${dedup.seq}` as unknown as Value),
      });
    }
    return { replayed: false, value: `ok-${path}` as unknown as Value, tables: [], writeRanges: [], commitTs };
  }

  async classifyClientMutation(_identity: string | null, clientId: string, seq: number): Promise<ClientMutationVerdict> {
    this.classifyCalls.push({ clientId, seq });
    return this.verdicts.get(this.key(clientId, seq)) ?? { clientId, seq, verdict: "unknown" };
  }
  async pruneClientMutations(_identity: string | null, clientId: string, ackedThrough: number): Promise<void> {
    this.pruneCalls.push({ clientId, ackedThrough });
  }
  deploymentId(): string {
    return "deploy-xyz";
  }
}

class MockSocket implements SyncWebSocket {
  readonly messages: ServerMessage[] = [];
  bufferedAmount = 0;
  send(data: string): void {
    this.messages.push(JSON.parse(data) as ServerMessage);
  }
  close(): void {}
  responses(): Extract<ServerMessage, { type: "MutationResponse" }>[] {
    return this.messages.filter((m): m is Extract<ServerMessage, { type: "MutationResponse" }> => m.type === "MutationResponse");
  }
  acks(): Extract<ServerMessage, { type: "ConnectAck" }>[] {
    return this.messages.filter((m): m is Extract<ServerMessage, { type: "ConnectAck" }> => m.type === "ConnectAck");
  }
}

let handler: SyncProtocolHandler;
let exec: MockExecutor;
let socket: MockSocket;

beforeEach(() => {
  exec = new MockExecutor();
  handler = new SyncProtocolHandler(exec, { autoNotifyOnMutation: false });
  socket = new MockSocket();
  handler.connect("s1", socket);
});

function send(msg: unknown): Promise<void> {
  return handler.handleMessage("s1", JSON.stringify(msg));
}

describe("Receipted Outbox wire — Mutation classification", () => {
  it("a dedup-keyed mutation runs once, and a resend replay-acks with the original ts (not re-run)", async () => {
    await send({ type: "Mutation", requestId: "r1", udfPath: "m:x", args: {}, clientId: "c1", seq: 1 });
    await send({ type: "Mutation", requestId: "r2", udfPath: "m:x", args: {}, clientId: "c1", seq: 1 });

    const rs = socket.responses();
    expect(rs).toHaveLength(2);
    expect(rs[0]).toMatchObject({ requestId: "r1", success: true });
    expect(rs[0]).not.toHaveProperty("replayed");
    const firstTs = (rs[0] as { ts?: number }).ts;
    expect(rs[1]).toMatchObject({ requestId: "r2", success: true, replayed: true, ts: firstTs });
    // The executor's runMutation was called both times (classification lives at the owner, inside it),
    // but the SECOND returned a replay — the mock only appends a verdict once.
    expect(exec.runCalls.map((c) => c.dedup?.seq)).toEqual([1, 1]);
  });

  it("a failed verdict replays as a failure response carrying its code", async () => {
    exec.poison.add(7);
    await send({ type: "Mutation", requestId: "r1", udfPath: "m:x", args: {}, clientId: "c1", seq: 7 });
    await send({ type: "Mutation", requestId: "r2", udfPath: "m:x", args: {}, clientId: "c1", seq: 7 });
    const rs = socket.responses();
    // First: the fresh run threw → generic failure (no code yet on the first miss).
    expect(rs[0]).toMatchObject({ requestId: "r1", success: false });
    // Resend: replays the recorded terminal verdict WITH its code.
    expect(rs[1]).toMatchObject({ requestId: "r2", success: false, code: "BOOM" });
  });

  it("a FRESH (non-replayed) failure carries the thrown error's typed code on the wire (Task 4 bug fix)", async () => {
    // Unlike `exec.poison` (a plain `Error`, no code), this throws a REAL StackbaseError — the
    // handler's fresh-failure catch (processMutation) must thread its `.code` onto the wire, not
    // just the message. Previously only the dedup-REPLAY branch above populated `code`; a genuinely
    // fresh failure (this one — no prior verdict recorded, no dedup key involved at all) sent
    // `{success:false, error}` with no `code`, which misled the outbox drain's coded-vs-codeless
    // retry classification (a terminal app error looked transient).
    exec.runMutation = async () => {
      throw new InvalidClientIdError('_id belongs to table "messages", not "conversations"');
    };
    await send({ type: "Mutation", requestId: "r1", udfPath: "app:createConversation", args: {} });
    expect(socket.responses()[0]).toMatchObject({ requestId: "r1", success: false, code: "INVALID_CLIENT_ID" });
  });

  it("a FRESH RETRYABLE failure carries NO code on the wire — only terminal errors get a code (re-review FIX 1)", async () => {
    // The wire invariant is "coded ⇒ terminal, server-recorded verdict" (the outbox drain's
    // coded-vs-codeless classification and `handleDedupError`'s own retryable check both depend on
    // it). A fresh (non-replayed) TRANSIENT error — here a real `OccConflictError` — must NOT carry
    // a `.code`, even though it IS a `StackbaseError` with one: threading it through would make the
    // drain settle a transient failure as terminal (durable mutation lost / poison-pause).
    exec.runMutation = async () => {
      throw new OccConflictError("write conflict, retry");
    };
    await send({ type: "Mutation", requestId: "r1", udfPath: "app:createConversation", args: {} });
    const r = socket.responses()[0]!;
    expect(r).toMatchObject({ requestId: "r1", success: false });
    if (r.success !== false) throw new Error("unreachable — asserted above");
    expect(r.code).toBeUndefined();
  });

  it("a stale verdict replays as a STALE_CLIENT failure", async () => {
    // Force the mock to return a stale replay directly.
    exec.runMutation = async () => ({ replayed: true, verdict: "stale", code: "STALE_CLIENT" });
    await send({ type: "Mutation", requestId: "r1", udfPath: "m:x", args: {}, clientId: "c1", seq: 3 });
    expect(socket.responses()[0]).toMatchObject({ requestId: "r1", success: false, code: "STALE_CLIENT" });
  });

  it("old-client bit-compat: a Mutation with no clientId threads NO dedup key (classification untouched)", async () => {
    await send({ type: "Mutation", requestId: "r1", udfPath: "m:x", args: {} });
    expect(exec.runCalls).toHaveLength(1);
    expect(exec.runCalls[0]!.dedup).toBeUndefined();
    expect(exec.classifyCalls).toHaveLength(0);
    expect(socket.responses()[0]).toMatchObject({ requestId: "r1", success: true });
  });
});

describe("Receipted Outbox wire — MutationBatch", () => {
  it("applies entries sequentially, emits one MutationResponse per entry in order", async () => {
    await send({
      type: "MutationBatch",
      entries: [
        { requestId: "b1", udfPath: "m:x", args: {}, clientId: "c1", seq: 1 },
        { requestId: "b2", udfPath: "m:x", args: {}, clientId: "c1", seq: 2 },
        { requestId: "b3", udfPath: "m:x", args: {}, clientId: "c1", seq: 3 },
      ],
    });
    expect(socket.responses().map((r) => r.requestId)).toEqual(["b1", "b2", "b3"]);
    expect(socket.responses().every((r) => r.success)).toBe(true);
  });

  it("a mid-batch terminal failure responds and CONTINUES (prior units applied, later units still run)", async () => {
    exec.poison.add(2);
    await send({
      type: "MutationBatch",
      entries: [
        { requestId: "b1", udfPath: "m:x", args: {}, clientId: "c1", seq: 1 },
        { requestId: "b2", udfPath: "m:x", args: {}, clientId: "c1", seq: 2 },
        { requestId: "b3", udfPath: "m:x", args: {}, clientId: "c1", seq: 3 },
      ],
    });
    const rs = socket.responses();
    expect(rs.map((r) => r.requestId)).toEqual(["b1", "b2", "b3"]);
    expect(rs[0]!.success).toBe(true);
    expect(rs[1]!.success).toBe(false); // the poison unit
    expect(rs[2]!.success).toBe(true); // the drain continued
  });

  it("a mid-batch TRANSIENT failure responds that unit's failure and STOPS the drain — the FIFO obligation (T5-review FIX 1)", async () => {
    exec.transientPoison.add(2);
    await send({
      type: "MutationBatch",
      entries: [
        { requestId: "b1", udfPath: "m:x", args: {}, clientId: "c1", seq: 1 },
        { requestId: "b2", udfPath: "m:x", args: {}, clientId: "c1", seq: 2 },
        { requestId: "b3", udfPath: "m:x", args: {}, clientId: "c1", seq: 3 },
      ],
    });
    const rs = socket.responses();
    // Unit 3 gets NO response at all — the drain stopped after unit 2's transient failure.
    expect(rs.map((r) => r.requestId)).toEqual(["b1", "b2"]);
    expect(rs[0]!.success).toBe(true);
    expect(rs[1]!.success).toBe(false);
    // Unit 3 was never even attempted (not just unresponded — NOT applied).
    expect(exec.runCalls.map((c) => c.dedup?.seq)).toEqual([1, 2]);
  });
});

describe("Receipted Outbox wire — Connect / ConnectAck", () => {
  it("a bare Connect (no resume fields) stays the reserved no-op — no ConnectAck", async () => {
    await send({ type: "Connect", sessionId: "s1" });
    expect(socket.acks()).toHaveLength(0);
  });

  it("classifies held into results, prunes ackedThrough, and stamps the deploymentId", async () => {
    // Seed an applied verdict for (c1, 1) via a real run.
    await send({ type: "Mutation", requestId: "r1", udfPath: "m:x", args: {}, clientId: "c1", seq: 1 });
    await send({
      type: "Connect",
      sessionId: "s1",
      clientId: "c1",
      held: [
        { clientId: "c1", seq: 1 },
        { clientId: "c1", seq: 99 },
      ],
      ackedThrough: [{ clientId: "c1", seq: 0 }],
    });
    const ack = socket.acks()[0]!;
    expect(ack.deploymentId).toBe("deploy-xyz");
    expect(ack.known).toBe(true); // seq 1 is recognized
    expect(ack.results).toHaveLength(2);
    expect(ack.results.find((r) => r.seq === 1)).toMatchObject({ verdict: "applied" });
    expect(ack.results.find((r) => r.seq === 99)).toMatchObject({ verdict: "unknown" });
    expect(exec.pruneCalls).toEqual([{ clientId: "c1", ackedThrough: 0 }]);
  });

  it("known:false when the client presents history the server recognizes none of", async () => {
    await send({
      type: "Connect",
      sessionId: "s1",
      clientId: "c9",
      held: [{ clientId: "c9", seq: 5 }],
    });
    const ack = socket.acks()[0]!;
    expect(ack.known).toBe(false);
    expect(ack.results[0]).toMatchObject({ seq: 5, verdict: "unknown" });
  });
});
