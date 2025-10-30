/**
 * `SyncProtocolHandler` — turns client messages into engine calls and pushes reactive
 * updates. The reactive heart: a `Mutation` runs, its written tables become a
 * `WriteInvalidation`, and `notifyWrites` recomputes every subscription that read those
 * tables and pushes a version-bracketed `Transition`. Ephemeral `Broadcast`s take a separate
 * path that never touches the engine. It talks only to abstract `SyncWebSocket` /
 * `SyncUdfExecutor`, so the same handler runs in-process (Tier 0) or as a fleet node (Tier 2).
 */
import { convexToJson, type JSONValue, type Value } from "@stackbase/values";
import type { SerializedKeyRange } from "@stackbase/index-key-codec";
import {
  encodeServerMessage,
  parseClientMessage,
  INITIAL_VERSION,
  type ClientMessage,
  type ServerMessage,
  type StateModification,
  type StateVersion,
} from "./protocol";
import { SubscriptionManager, type Subscription } from "./subscription-manager";
import {
  SessionBackpressureController,
  SessionHeartbeatController,
  type BackpressureOptions,
  type HeartbeatOptions,
} from "./session-controllers";

/** How often the handler sweeps every session's send queue for a drain/abandon opportunity. */
const FLUSH_SWEEP_MS = 1000;

/** The minimal socket the handler needs (abstract — WS, Durable Object, or loopback). */
export interface SyncWebSocket {
  send(data: string): void;
  readonly bufferedAmount: number;
  close(): void;
  /**
   * Send a transport-level ping; invoke `onPong` when the matching pong arrives. OPTIONAL — a
   * socket that omits it (the in-process loopback, which has no peer to die) is exempt from
   * heartbeat reaping. Real WebSocket transports implement it.
   */
  ping?(onPong: () => void): void;
}

/** Runs UDFs for the sync tier. Backed by the executor; returns table sets + precise read ranges for matching. */
export interface SyncUdfExecutor {
  runQuery(udfPath: string, args: JSONValue, identity?: string | null): Promise<{ value: Value; tables: string[]; readRanges: readonly SerializedKeyRange[] }>;
  runMutation(udfPath: string, args: JSONValue, identity?: string | null): Promise<{ value: Value; tables: string[]; writeRanges: readonly SerializedKeyRange[]; commitTs: number }>;
  runAdminQuery(udfPath: string, args: JSONValue): Promise<{ value: Value; tables: string[]; readRanges: readonly SerializedKeyRange[] }>;
  /** One-shot, non-reactive: an action has no read/write set of its own to fan out. */
  runAction(udfPath: string, args: JSONValue, identity?: string | null): Promise<{ value: Value }>;
}

/** A committed write's invalidation — the transactor→sync fan-out payload (Tier 2: from a stream). */
export interface WriteInvalidation {
  tables: string[];
  /** Precise write ranges for surgical (range-level) invalidation. */
  ranges: readonly SerializedKeyRange[];
  commitTs: number;
}

export interface SyncProtocolHandlerOptions {
  /** Exclude the mutating session from the reactive transition (it has the MutationResponse). */
  excludeOriginFromTransition?: boolean;
  /**
   * Whether a mutation handled here triggers `notifyWrites` inline (default true). Set false
   * when an external write-fan-out drives invalidation (so commits via OTHER paths — e.g. HTTP
   * — also push, and there's no double-notify).
   */
  autoNotifyOnMutation?: boolean;
  /** Validate an admin key presented via `SetAdminAuth`. Defaults to `() => false` (no admin). */
  verifyAdmin?: (key: string) => boolean;
  /** Per-session outbound flow control (queue caps, slow-client drops). Defaults apply if omitted. */
  backpressure?: BackpressureOptions;
  /** Per-session ping/pong liveness reaping. Defaults apply if omitted. */
  heartbeat?: HeartbeatOptions;
}

interface Session {
  sessionId: string;
  socket: SyncWebSocket;
  version: StateVersion;
  identity: string | null;
  privileged: boolean;
  /** The single outbound chokepoint — every server→client frame for this session goes through it. */
  bp: SessionBackpressureController;
  /** Transport-level liveness; reaps half-open connections. No-op for ping-less sockets (loopback). */
  hb: SessionHeartbeatController;
}

function errMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export class SyncProtocolHandler {
  private readonly sessions = new Map<string, Session>();
  private readonly subscriptions = new SubscriptionManager();
  private notifyTail: Promise<void> = Promise.resolve();
  private readonly verifyAdmin: (key: string) => boolean;
  /** Periodic drain sweep — drains recovered clients and abandons terminally-slow queues. */
  private sweepTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly executor: SyncUdfExecutor,
    private readonly options: SyncProtocolHandlerOptions = {},
  ) {
    this.verifyAdmin = options.verifyAdmin ?? (() => false);
    this.sweepTimer = setInterval(() => {
      for (const session of this.sessions.values()) session.bp.flush();
    }, FLUSH_SWEEP_MS);
    // Don't keep the process alive for the sweep (Node); loopback-only usage exits cleanly.
    (this.sweepTimer as { unref?: () => void }).unref?.();
  }

  connect(sessionId: string, socket: SyncWebSocket): void {
    const bp = new SessionBackpressureController(socket, this.options.backpressure);
    const hb = new SessionHeartbeatController(socket, () => this.reap(sessionId), this.options.heartbeat);
    this.sessions.set(sessionId, { sessionId, socket, version: { ...INITIAL_VERSION }, identity: null, privileged: false, bp, hb });
    hb.start();
  }

  disconnect(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    session?.hb.stop();
    this.subscriptions.removeSession(sessionId);
    this.sessions.delete(sessionId);
  }

  /** Reap a session whose heartbeat went dead: close the socket, then tear down like a disconnect. */
  private reap(sessionId: string): void {
    this.sessions.get(sessionId)?.socket.close();
    this.disconnect(sessionId);
  }

  /** Stop the background sweep. Call on shutdown; sessions must already be disconnected. */
  dispose(): void {
    if (this.sweepTimer !== null) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
  }

  private send(session: Session, msg: ServerMessage): void {
    // MutationResponse/ActionResponse are undroppable under backpressure (§(d) item 4 of the
    // client-sync verdict): a dropped Transition self-heals via the version-gap resync, but a
    // dropped response has no bracket and no retransmit — it would strand the mutation/action
    // as permanently "inflight" on an otherwise-healthy connection. They're small, rare, and
    // per-request, so always queuing (never dropping) them is cheap.
    const undroppable = msg.type === "MutationResponse" || msg.type === "ActionResponse";
    session.bp.send(encodeServerMessage(msg), undroppable);
  }

  /**
   * `MutationResponse.ts` (W1) must be the mutation's real commitTs — a client-side optimistic-
   * update gate treats it as an ack signal, and a `0` (or absent) commitTs there would either
   * false-close the gate immediately or wedge a pending layer forever. `commitTs` SHOULD always
   * be a positive integer for a committed mutation; the one known way it can leak as `<= 0` is
   * the `?? 0n` fallback for a forwarded-fleet-write whose owner commitTs didn't make it back
   * (`runtime-embedded/src/runtime.ts`). This codebase has no existing dev/prod split (no
   * `NODE_ENV`/`__DEV__` convention anywhere in `packages/`), so this is unconditional: log
   * loudly every time, and never put a lying `0` on the wire — omit `ts` instead, which is
   * exactly the pre-W1 wire shape every client already knows how to handle.
   */
  private mutationResponseTs(commitTs: number): number | undefined {
    if (commitTs > 0) return commitTs;
    console.error(
      `[sync] MutationResponse: commitTs invariant violated (expected > 0, got ${commitTs}); omitting ts from the wire`,
    );
    return undefined;
  }

  async handleMessage(sessionId: string, raw: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`unknown session: ${sessionId}`);
    session.hb.noteActivity(); // any inbound frame is liveness credit
    const msg: ClientMessage = parseClientMessage(raw);
    switch (msg.type) {
      case "Connect":
        return;
      case "ModifyQuerySet":
        return this.handleModifyQuerySet(session, msg);
      case "Mutation":
        return this.handleMutation(session, msg);
      case "Action":
        return this.handleAction(session, msg);
      case "EphemeralPublish":
        this.publishEphemeral(msg.topic, msg.event, sessionId);
        return;
      case "SetAuth":
        return this.handleSetAuth(session, msg);
      case "SetAdminAuth":
        return this.handleSetAdminAuth(session, msg);
    }
  }

  /** Run a subscription's query — privileged for _admin:* on a privileged session; else identity-scoped. */
  private async execSub(session: Session, udfPath: string, args: JSONValue): Promise<{ value: Value; tables: string[]; readRanges: readonly SerializedKeyRange[] }> {
    if (udfPath.startsWith("_admin:")) {
      if (!session.privileged) throw new Error("Forbidden: admin subscription requires admin auth");
      return this.executor.runAdminQuery(udfPath, args);
    }
    return this.executor.runQuery(udfPath, args, session.identity);
  }

  private async handleModifyQuerySet(
    session: Session,
    msg: Extract<ClientMessage, { type: "ModifyQuerySet" }>,
  ): Promise<void> {
    const modifications: StateModification[] = [];
    for (const q of msg.add) {
      try {
        const { value, tables, readRanges } = await this.execSub(session, q.udfPath, q.args);
        this.subscriptions.add({ sessionId: session.sessionId, queryId: q.queryId, udfPath: q.udfPath, args: q.args, tables, readRanges });
        modifications.push({ type: "QueryUpdated", queryId: q.queryId, value: convexToJson(value) });
      } catch (e) {
        modifications.push({ type: "QueryFailed", queryId: q.queryId, error: errMessage(e) });
      }
    }
    for (const queryId of msg.remove) {
      this.subscriptions.remove(session.sessionId, queryId);
      modifications.push({ type: "QueryRemoved", queryId });
    }
    // A query-set change bumps querySet (keeps ts).
    const start = session.version;
    const end: StateVersion = { querySet: start.querySet + 1, ts: start.ts };
    session.version = end;
    this.send(session, { type: "Transition", startVersion: start, endVersion: end, modifications });
  }

  private async handleMutation(
    session: Session,
    msg: Extract<ClientMessage, { type: "Mutation" }>,
  ): Promise<void> {
    try {
      const { value, tables, writeRanges, commitTs } = await this.executor.runMutation(msg.udfPath, msg.args, session.identity);
      this.send(session, {
        type: "MutationResponse",
        requestId: msg.requestId,
        success: true,
        value: convexToJson(value),
        ts: this.mutationResponseTs(commitTs),
      });
      if (this.options.autoNotifyOnMutation !== false) {
        await this.notifyWrites({ tables, ranges: writeRanges, commitTs }, session.sessionId);
      }
    } catch (e) {
      this.send(session, { type: "MutationResponse", requestId: msg.requestId, success: false, error: errMessage(e) });
    }
  }

  /**
   * A one-shot request→value call — NOT reactive (an action has no read/write set of its own).
   * Deliberately does NOT call `notifyWrites`: any mutation the action invoked via
   * `ctx.runMutation` already fanned out through that mutation's own commit.
   */
  private async handleAction(
    session: Session,
    msg: Extract<ClientMessage, { type: "Action" }>,
  ): Promise<void> {
    try {
      const { value } = await this.executor.runAction(msg.udfPath, msg.args, session.identity);
      this.send(session, { type: "ActionResponse", requestId: msg.requestId, success: true, value: convexToJson(value) });
    } catch (e) {
      this.send(session, { type: "ActionResponse", requestId: msg.requestId, success: false, error: errMessage(e) });
    }
  }

  /**
   * Reactive fan-out: recompute subscriptions a write touched and push transitions. Calls are
   * serialized so per-session version brackets advance monotonically (concurrent notifies
   * would otherwise reorder and trigger false client resyncs).
   */
  notifyWrites(invalidation: WriteInvalidation, originSessionId?: string): Promise<void> {
    const run = this.notifyTail.then(() => this.doNotifyWrites(invalidation, originSessionId));
    this.notifyTail = run.catch(() => undefined);
    return run;
  }

  private async doNotifyWrites(invalidation: WriteInvalidation, originSessionId?: string): Promise<void> {
    // Use surgical range-level matching: only re-run subscriptions whose read ranges overlap the write ranges.
    const affected = this.subscriptions.findAffectedByRanges(invalidation.ranges ?? [], invalidation.tables);

    const bySession = new Map<string, Subscription[]>();
    for (const sub of affected) {
      if (this.options.excludeOriginFromTransition && sub.sessionId === originSessionId) continue;
      const list = bySession.get(sub.sessionId) ?? [];
      list.push(sub);
      bySession.set(sub.sessionId, list);
    }

    for (const [sessionId, subs] of bySession) {
      const session = this.sessions.get(sessionId);
      if (!session) continue;
      const modifications: StateModification[] = [];
      for (const sub of subs) {
        try {
          const { value, tables, readRanges } = await this.execSub(session, sub.udfPath, sub.args);
          this.subscriptions.add({ ...sub, tables, readRanges }); // refresh the read set
          modifications.push({ type: "QueryUpdated", queryId: sub.queryId, value: convexToJson(value) });
        } catch (e) {
          modifications.push({ type: "QueryFailed", queryId: sub.queryId, error: errMessage(e) });
        }
      }
      const start = session.version;
      const end: StateVersion = { querySet: start.querySet, ts: invalidation.commitTs };
      session.version = end;
      this.send(session, { type: "Transition", startVersion: start, endVersion: end, modifications });
    }
  }

  private async handleSetAdminAuth(session: Session, msg: Extract<ClientMessage, { type: "SetAdminAuth" }>): Promise<void> {
    session.privileged = this.verifyAdmin(msg.key);
    // The client sends SetAdminAuth before subscribing; no re-run needed here.
  }

  private async handleSetAuth(session: Session, msg: Extract<ClientMessage, { type: "SetAuth" }>): Promise<void> {
    session.identity = msg.token;
    const subs = this.subscriptions.forSession(session.sessionId);
    const modifications: StateModification[] = [];
    for (const sub of subs) {
      try {
        const { value, tables, readRanges } = await this.execSub(session, sub.udfPath, sub.args);
        this.subscriptions.add({ ...sub, tables, readRanges });
        modifications.push({ type: "QueryUpdated", queryId: sub.queryId, value: convexToJson(value) });
      } catch (e) {
        modifications.push({ type: "QueryFailed", queryId: sub.queryId, error: errMessage(e) });
      }
    }
    const start = session.version;
    const end: StateVersion = { querySet: start.querySet + 1, ts: start.ts };
    session.version = end;
    this.send(session, { type: "Transition", startVersion: start, endVersion: end, modifications });
  }

  /** Ephemeral broadcast (presence/typing) — bypasses the engine entirely. */
  publishEphemeral(topic: string, event: JSONValue, fromSessionId?: string): void {
    for (const [sessionId, session] of this.sessions) {
      if (sessionId === fromSessionId) continue;
      this.send(session, { type: "Broadcast", topic, event });
    }
  }
}
