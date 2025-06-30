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

/** The minimal socket the handler needs (abstract — WS, Durable Object, or loopback). */
export interface SyncWebSocket {
  send(data: string): void;
  readonly bufferedAmount: number;
  close(): void;
}

/** Runs UDFs for the sync tier. Backed by the executor; returns table sets + precise read ranges for matching. */
export interface SyncUdfExecutor {
  runQuery(udfPath: string, args: JSONValue, identity?: string | null): Promise<{ value: Value; tables: string[]; readRanges: readonly SerializedKeyRange[] }>;
  runMutation(udfPath: string, args: JSONValue, identity?: string | null): Promise<{ value: Value; tables: string[]; writeRanges: readonly SerializedKeyRange[]; commitTs: number }>;
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
}

interface Session {
  sessionId: string;
  socket: SyncWebSocket;
  version: StateVersion;
  identity: string | null;
}

function errMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export class SyncProtocolHandler {
  private readonly sessions = new Map<string, Session>();
  private readonly subscriptions = new SubscriptionManager();
  private notifyTail: Promise<void> = Promise.resolve();

  constructor(
    private readonly executor: SyncUdfExecutor,
    private readonly options: SyncProtocolHandlerOptions = {},
  ) {}

  connect(sessionId: string, socket: SyncWebSocket): void {
    this.sessions.set(sessionId, { sessionId, socket, version: { ...INITIAL_VERSION }, identity: null });
  }

  disconnect(sessionId: string): void {
    this.subscriptions.removeSession(sessionId);
    this.sessions.delete(sessionId);
  }

  private send(session: Session, msg: ServerMessage): void {
    session.socket.send(encodeServerMessage(msg));
  }

  async handleMessage(sessionId: string, raw: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`unknown session: ${sessionId}`);
    const msg: ClientMessage = parseClientMessage(raw);
    switch (msg.type) {
      case "Connect":
        return;
      case "ModifyQuerySet":
        return this.handleModifyQuerySet(session, msg);
      case "Mutation":
        return this.handleMutation(session, msg);
      case "EphemeralPublish":
        this.publishEphemeral(msg.topic, msg.event, sessionId);
        return;
      case "SetAuth":
        return this.handleSetAuth(session, msg);
    }
  }

  private async handleModifyQuerySet(
    session: Session,
    msg: Extract<ClientMessage, { type: "ModifyQuerySet" }>,
  ): Promise<void> {
    const modifications: StateModification[] = [];
    for (const q of msg.add) {
      try {
        const { value, tables, readRanges } = await this.executor.runQuery(q.udfPath, q.args, session.identity);
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
      this.send(session, { type: "MutationResponse", requestId: msg.requestId, success: true, value: convexToJson(value) });
      if (this.options.autoNotifyOnMutation !== false) {
        await this.notifyWrites({ tables, ranges: writeRanges, commitTs }, session.sessionId);
      }
    } catch (e) {
      this.send(session, { type: "MutationResponse", requestId: msg.requestId, success: false, error: errMessage(e) });
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
          const { value, tables, readRanges } = await this.executor.runQuery(sub.udfPath, sub.args, session.identity);
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

  private async handleSetAuth(session: Session, msg: Extract<ClientMessage, { type: "SetAuth" }>): Promise<void> {
    session.identity = msg.token;
    const subs = this.subscriptions.forSession(session.sessionId);
    const modifications: StateModification[] = [];
    for (const sub of subs) {
      try {
        const { value, tables, readRanges } = await this.executor.runQuery(sub.udfPath, sub.args, session.identity);
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
