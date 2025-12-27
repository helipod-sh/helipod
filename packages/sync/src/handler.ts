/**
 * `SyncProtocolHandler` — turns client messages into engine calls and pushes reactive
 * updates. The reactive heart: a `Mutation` runs, its written tables become a
 * `WriteInvalidation`, and `notifyWrites` recomputes every subscription that read those
 * tables and pushes a version-bracketed `Transition`. Ephemeral `Broadcast`s take a separate
 * path that never touches the engine. It talks only to abstract `SyncWebSocket` /
 * `SyncUdfExecutor`, so the same handler runs in-process (Tier 0) or as a fleet node (Tier 2).
 */
import { createHash } from "node:crypto";
import { convexToJson, type JSONValue, type Value } from "@stackbase/values";
import { isRetryableError, isStackbaseError } from "@stackbase/errors";
import type { SerializedKeyRange } from "@stackbase/index-key-codec";
import type { WrittenDoc } from "@stackbase/transactor";
import {
  encodeServerMessage,
  parseClientMessage,
  INITIAL_VERSION,
  type ClientMessage,
  type ServerMessage,
  type StateModification,
  type StateVersion,
  type ClientMutationRef,
  type ClientMutationVerdict,
  type MutationBatchEntry,
} from "./protocol";
import { SubscriptionManager, type Subscription } from "./subscription-manager";
import { classifyByIdRead } from "./classify";
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

/** Today's fresh-run mutation result (a real commit happened), tagged so the handler discriminates
 *  it from a {@link MutationReplay}. */
export interface MutationRan {
  replayed?: false;
  value: Value;
  tables: string[];
  writeRanges: readonly SerializedKeyRange[];
  commitTs: number;
  forwarded?: boolean;
}

/**
 * A replay of a prior verdict (Receipted Outbox, verdict §(c)) — NO commit happened on this call.
 * The classification at the OWNER (`runMutation`'s `dedup` path) hit a recorded verdict (or the
 * floor), so the mutation is NOT re-run. The handler must therefore skip `notifyWrites` AND the G4
 * pending-frontier (nothing was written this call — verdict §(c) Risk R7).
 */
export interface MutationReplay {
  replayed: true;
  verdict: "applied" | "failed" | "stale";
  /** The ORIGINAL commitTs for an `applied`/`failed` record (keeps the client gate sound); absent
   *  for `stale` (no commit ever happened). */
  commitTs?: number;
  /** Present only for `applied` with a recorded return value. */
  value?: Value;
  /** `applied` whose value was never recorded (crash-window) or exceeded the 64KB cap. */
  valueMissing?: true;
  /** The terminal verdict code for `failed` (the recorded error code) or `"STALE_CLIENT"` for `stale`. */
  code?: string;
}

export type RunMutationResult = MutationRan | MutationReplay;

/** Runs UDFs for the sync tier. Backed by the executor; returns table sets + precise read ranges for matching. */
export interface SyncUdfExecutor {
  runQuery(udfPath: string, args: JSONValue, identity?: string | null): Promise<{ value: Value; tables: string[]; readRanges: readonly SerializedKeyRange[] }>;
  /**
   * `origin` (G4, client-sync verdict §(d) item 2): the committing session's id, threaded onto the
   * commit's `OplogDelta.origin` so the fan-out can advance THAT session's own `version.ts` past its
   * commit even when it touched nothing the session subscribes to. `forwarded` (fleet): true when
   * the mutation committed on ANOTHER node (no local oplog) — its origin tag couldn't ride this
   * node's local fan-out, so the handler advances the origin frontier via a drain-gated fallback.
   *
   * `dedup` (Receipted Outbox, verdict §(c)): the durable `(clientId, seq)` — absent = today's
   * unconditional path, bit-for-bit (no classification read, no receipt write). Present → the OWNER's
   * `runMutation` impl classifies: a recorded/floored verdict short-circuits to a {@link MutationReplay}
   * (no commit); a miss runs the mutation with the dedup key rideng the commit meta (the receipts
   * guard writes the `applied` receipt atomically). The handler only threads `dedup` down and
   * interprets the discriminated return — it NEVER reads the classification store itself (it runs on
   * any node, incl. a fleet follower; the read must run where the commit runs — verdict §(c) repair 3).
   */
  runMutation(udfPath: string, args: JSONValue, identity?: string | null, origin?: string, dedup?: ClientMutationRef): Promise<RunMutationResult>;
  runAdminQuery(udfPath: string, args: JSONValue): Promise<{ value: Value; tables: string[]; readRanges: readonly SerializedKeyRange[] }>;
  /** One-shot, non-reactive: an action has no read/write set of its own to fan out. */
  runAction(udfPath: string, args: JSONValue, identity?: string | null): Promise<{ value: Value }>;
  /**
   * Classify a presented `(identity, clientId, seq)` for the `Connect` resume handshake (verdict
   * §(e)) — the read-only sibling of `runMutation`'s dedup path. Returns the recorded verdict, or
   * `"stale"` (below the floor, no record), or `"unknown"` (never seen — the client should resend).
   * Optional: an executor without receipts support (or an old one) omits it → `Connect` degrades to
   * `known: false` with empty results.
   */
  classifyClientMutation?(identity: string | null, clientId: string, seq: number): Promise<ClientMutationVerdict>;
  /** Ack-prune the contiguous settled prefix `seq <= ackedThrough` for `(identity, clientId)` on a
   *  `Connect` (verdict §(c) Retention). Optional (same reason as `classifyClientMutation`). */
  pruneClientMutations?(identity: string | null, clientId: string, ackedThrough: number): Promise<void>;
  /** The deployment-id stamp for `ConnectAck` (verdict §(g) hazard 15 — same-timeline proof). */
  deploymentId?(): string;
}

/** A committed write's invalidation — the transactor→sync fan-out payload (Tier 2: from a stream). */
export interface WriteInvalidation {
  tables: string[];
  /** Precise write ranges for surgical (range-level) invalidation. */
  ranges: readonly SerializedKeyRange[];
  commitTs: number;
  /** Written docs for local row-diffing (§DLR 2a). Absent → affected DIFFABLE subs fall back to RERUN. */
  writtenDocs?: WrittenDoc[];
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
  /** DLR 2a: this session's client advertised `supportsQueryDiff` on `Connect`. Defaults to `false`
   *  (an old client that predates `QueryDiff`, or one that hasn't sent `Connect` yet) — the emit
   *  side (Task 5) must check this before ever sending a `QueryDiff` modification. */
  supportsQueryDiff: boolean;
}

function errMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * Server-minted result fingerprint (subscription resume, design 2025-11-28). Hashes THIS server's
 * own serialization of the value — the client stores and echoes it opaquely, so attach-site and
 * compare-site using this SAME helper is the entire contract; a cross-version server simply
 * mismatches (falls through to a full send), never crashes or lies.
 */
function hashValue(value: JSONValue): string {
  return "sha256:" + createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export class SyncProtocolHandler {
  private readonly sessions = new Map<string, Session>();
  private readonly subscriptions = new SubscriptionManager();
  private notifyTail: Promise<void> = Promise.resolve();
  /**
   * G4 fleet fallback (client-sync verdict §(d) item 2): sessionId → the commitTs of a FORWARDED
   * mutation whose origin tag couldn't ride this (forwarding) node's local fan-out. Satisfied with
   * an empty ts-advancing Transition once the drain processes a commit at-or-above it (gated on the
   * drain's last-processed commitTs — see `sweepPendingFrontiers`). Holds at most one entry per
   * in-flight forwarded mutation per session; cleared on satisfy or disconnect, so the sweep it
   * drives stays tiny (usually empty on a single-node deployment, where nothing is ever forwarded).
   */
  private readonly pendingFrontiers = new Map<string, number>();
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
    // The undroppable-queue-overflow cap terminates the session through the SAME reap-and-close
    // path a dead heartbeat uses (see session-controllers.ts) — one place that owns "this session
    // is being torn down", not two independently-evolving ones.
    const bp = new SessionBackpressureController(socket, this.options.backpressure, undefined, () => this.reap(sessionId));
    const hb = new SessionHeartbeatController(socket, () => this.reap(sessionId), this.options.heartbeat);
    this.sessions.set(sessionId, { sessionId, socket, version: { ...INITIAL_VERSION }, identity: null, privileged: false, bp, hb, supportsQueryDiff: false });
    hb.start();
  }

  disconnect(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    session?.hb.stop();
    this.subscriptions.removeSession(sessionId);
    this.sessions.delete(sessionId);
    this.pendingFrontiers.delete(sessionId);
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
        return this.handleConnect(session, msg);
      case "ModifyQuerySet":
        return this.handleModifyQuerySet(session, msg);
      case "Mutation":
        return this.handleMutation(session, msg);
      case "MutationBatch":
        return this.handleMutationBatch(session, msg);
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

  /**
   * G1 hardening (client-sync verdict §(d) item 3): a query-set change is SERIALIZED with the
   * reactive fan-out on the same `notifyTail`, per handler. The shipped code ran MQS inline while
   * `notifyWrites` ran on the tail, so a concurrent invalidation could deliver a NEWER value and
   * then MQS deliver an OLDER one under contiguous brackets — a silent base regression (with
   * optimistic layers, "your own committed write vanishes"). Enqueuing MQS on the tail makes the two
   * strictly ordered: the enqueued unit reads `session.version` at EXECUTION time (inside
   * `doModifyQuerySet`), so its bracket chains contiguously off whatever notify ran just before it.
   * `execSub`→`runQuery` never re-enters this tail (it's a pure engine read), so there is no
   * deadlock — subscribe just waits behind any pending notifies (the accepted latency cost).
   */
  private handleModifyQuerySet(
    session: Session,
    msg: Extract<ClientMessage, { type: "ModifyQuerySet" }>,
  ): Promise<void> {
    const run = this.notifyTail.then(() => this.doModifyQuerySet(session, msg));
    this.notifyTail = run.catch(() => undefined);
    return run;
  }

  private async doModifyQuerySet(
    session: Session,
    msg: Extract<ClientMessage, { type: "ModifyQuerySet" }>,
  ): Promise<void> {
    const modifications: StateModification[] = [];
    for (const q of msg.add) {
      try {
        const { value, tables, readRanges } = await this.execSub(session, q.udfPath, q.args);
        // Subscription registration is UNCONDITIONAL and always fresh, whether or not the result
        // turns out unchanged below — a write-after-Unchanged-resume must still invalidate.
        const byId = classifyByIdRead(value, readRanges) ?? undefined;
        this.subscriptions.add({ sessionId: session.sessionId, queryId: q.queryId, udfPath: q.udfPath, args: q.args, tables, readRanges, byId });
        const json = convexToJson(value);
        const hash = hashValue(json);
        if (q.resultHash !== undefined && q.resultHash === hash) {
          modifications.push({ type: "QueryUnchanged", queryId: q.queryId });
        } else {
          modifications.push({ type: "QueryUpdated", queryId: q.queryId, value: json, hash });
        }
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
    await this.processMutation(session, msg);
  }

  /**
   * A drained-outbox chunk (verdict §(e)): ONE inbound message carrying N entries. Applied
   * SEQUENTIALLY (`await` each in order) — the client sends only one unacked chunk at a time and
   * relies on per-client FIFO, so units MUST commit in order. One `MutationResponse` is emitted per
   * entry as it settles, EXCEPT when a unit fails TRANSIENTLY (see `processMutation`'s doc comment):
   * that unit still gets its failure response, but the loop then STOPS — the remaining entries get
   * NO response at all, preserving the FIFO drain obligation (a causally-dependent later unit must
   * never apply after an earlier transient/infra failure). The client's one-unacked-chunk-at-a-time
   * protocol resends the whole chunk on the next attempt; per-seq receipts make that resend safe
   * (an already-applied unit replay-acks instead of re-running).
   */
  private async handleMutationBatch(
    session: Session,
    msg: Extract<ClientMessage, { type: "MutationBatch" }>,
  ): Promise<void> {
    for (const entry of msg.entries) {
      const outcome = await this.processMutation(session, entry);
      if (outcome === "stop") break;
    }
  }

  /**
   * The per-unit mutation core shared by `Mutation` and `MutationBatch` — threads the durable
   * `(clientId, seq)` down to the OWNER's classification (verdict §(c)), sends the response, and
   * (for a fresh commit only) fans out. A `MutationReplay` return skips `notifyWrites` AND the G4
   * pending-frontier entirely (nothing was written this call — Risk R7): its `commitTs` is the
   * ORIGINAL, long past the current frontier, so arming a frontier or fanning out would be a lie.
   *
   * Returns `"continue" | "stop"` — meaningful only to `handleMutationBatch`'s drain loop (a
   * standalone `Mutation` ignores it). A thrown error is classified via the executor's retryable
   * discipline (`isRetryableError`, `@stackbase/errors` — the same classification
   * `handleDedupError`'s dedup path already applies when deciding whether to record a verdict):
   *  - TERMINAL (not retryable — a deterministic app error, a coded verdict failure/replay) means the
   *    executor already recorded whatever verdict applies; the batch drain CONTINUES past it (a
   *    poison unit never blocks the rest — matches the spec's documented mid-batch-continue case).
   *  - TRANSIENT (retryable — infra/conflict) means nothing durable happened for this unit; the batch
   *    drain STOPS here so a later, causally-dependent unit can never apply out of order relative to
   *    it. The remaining units get no response and the client's FIFO resend picks them back up.
   */
  private async processMutation(
    session: Session,
    unit: { requestId: string; udfPath: string; args: JSONValue; clientId?: string; seq?: number },
  ): Promise<"continue" | "stop"> {
    const dedup: ClientMutationRef | undefined =
      unit.clientId !== undefined && unit.seq !== undefined ? { clientId: unit.clientId, seq: unit.seq } : undefined;
    try {
      // G4: pass this session's id as `origin` so the commit's fan-out advances its own frontier.
      const r = await this.executor.runMutation(unit.udfPath, unit.args, session.identity, session.sessionId, dedup);
      if (r.replayed) {
        // A replay commits nothing — no fan-out, no frontier. `applied`/`stale`/`failed` map to the
        // wire: `applied` → success+ts (+value|valueMissing); `failed`/`stale` → failure+code.
        if (r.verdict === "applied") {
          this.send(session, {
            type: "MutationResponse",
            requestId: unit.requestId,
            success: true,
            replayed: true,
            ts: r.commitTs !== undefined ? this.mutationResponseTs(r.commitTs) : undefined,
            ...(r.valueMissing ? { valueMissing: true } : { value: convexToJson(r.value as Value) }),
          });
        } else {
          this.send(session, {
            type: "MutationResponse",
            requestId: unit.requestId,
            success: false,
            error: r.code ?? (r.verdict === "stale" ? "STALE_CLIENT" : "mutation failed"),
            code: r.code ?? (r.verdict === "stale" ? "STALE_CLIENT" : undefined),
          });
        }
        return "continue";
      }
      const { value, tables, writeRanges, commitTs, forwarded } = r;
      this.send(session, {
        type: "MutationResponse",
        requestId: unit.requestId,
        success: true,
        value: convexToJson(value),
        ts: this.mutationResponseTs(commitTs),
      });
      if (forwarded && commitTs > 0) {
        // G4 fleet fallback: the origin tag rode a fan-out on ANOTHER node, so it can't reach this
        // node's `doNotifyWrites`. Record the frontier; `sweepPendingFrontiers` advances this
        // session's `version.ts` once the drain locally processes a commit at-or-above `commitTs`.
        const prev = this.pendingFrontiers.get(session.sessionId);
        if (prev === undefined || commitTs > prev) this.pendingFrontiers.set(session.sessionId, commitTs);
      }
      if (this.options.autoNotifyOnMutation !== false) {
        await this.notifyWrites({ tables, ranges: writeRanges, commitTs }, session.sessionId);
      }
      return "continue";
    } catch (e) {
      // Thread the thrown error's typed `code` (when it's one of ours) onto the wire — a genuinely
      // FRESH (non-replayed) failure previously sent `error` with no `code`, even though the wire
      // shape supports one; only the dedup-replay branch above populated it. That silently starved
      // the outbox drain's coded-vs-codeless retry policy (client.ts/outbox-drain.ts key off
      // `.code`): a fresh terminal app error was misclassified as transient (whole-chunk revert +
      // backoff) instead of settling immediately.
      //
      // But only a TERMINAL error gets a code: the wire invariant is "coded ⇒ terminal, server-
      // recorded verdict" (mirrors `handleDedupError`'s own `!isRetryableError(e)` gate — only a
      // non-retryable failure ever gets a recorded verdict). A retryable `StackbaseError` (OCC
      // conflict, timeout, rate limit, service-unavailable) still HAS a `.code`, but threading it
      // through here would make the drain settle a transient failure as terminal — durable mutation
      // lost, or on a `MutationBatch` "stop", the coded path skips `revertActive` and wedges the
      // chunk (re-review FIX 1).
      this.send(session, {
        type: "MutationResponse",
        requestId: unit.requestId,
        success: false,
        error: errMessage(e),
        code: isStackbaseError(e) && !isRetryableError(e) ? e.code : undefined,
      });
      // See the doc comment above: TRANSIENT (retryable) stops the batch drain; TERMINAL continues.
      return isRetryableError(e) ? "stop" : "continue";
    }
  }

  /**
   * The `Connect` resume handshake (verdict §(e)): activated from the reserved no-op. Classifies each
   * presented `held` seq into `ConnectAck.results`, ack-prunes the `ackedThrough` contiguous
   * settled-prefix, and stamps the `deploymentId` (same-timeline proof, §(g) hazard 15). `known`
   * is false when the client presents history the server recognizes NONE of (a swept/foreign timeline
   * → the client resets). A bare `Connect` (no `clientId`/`held`/`ackedThrough`, or an executor with
   * no receipts support) stays the pre-Outbox no-op: no ConnectAck is sent, bit-for-bit.
   */
  private async handleConnect(
    session: Session,
    msg: Extract<ClientMessage, { type: "Connect" }>,
  ): Promise<void> {
    // DLR 2a: record the capability regardless of the resume-handshake fields below — a client
    // with no `clientId`/`held`/`ackedThrough` can still advertise `supportsQueryDiff`.
    session.supportsQueryDiff = msg.supportsQueryDiff === true;
    // Old-client / no-receipts path: a Connect with no resume fields is the reserved no-op.
    if (msg.clientId === undefined && msg.held === undefined && msg.ackedThrough === undefined) return;
    if (!this.executor.classifyClientMutation || !this.executor.deploymentId) return;

    const results: ClientMutationVerdict[] = [];
    let recognizedAny = false;
    let presentedAny = false;
    for (const ref of msg.held ?? []) {
      presentedAny = true;
      const v = await this.executor.classifyClientMutation(session.identity, ref.clientId, ref.seq);
      if (v.verdict !== "unknown") recognizedAny = true;
      results.push(v);
    }
    for (const ref of msg.ackedThrough ?? []) {
      presentedAny = true;
      // A floor exists (or gets created) for an acked client, so the server "knows" it even with no
      // held records left — classify at the acked seq to detect a recognized floor before pruning.
      if (this.executor.classifyClientMutation) {
        const v = await this.executor.classifyClientMutation(session.identity, ref.clientId, ref.seq);
        if (v.verdict !== "unknown") recognizedAny = true;
      }
      await this.executor.pruneClientMutations?.(session.identity, ref.clientId, ref.seq);
    }
    this.send(session, {
      type: "ConnectAck",
      known: presentedAny ? recognizedAny : true,
      results,
      deploymentId: this.executor.deploymentId(),
    });
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
          const json = convexToJson(value);
          modifications.push({ type: "QueryUpdated", queryId: sub.queryId, value: json, hash: hashValue(json) });
        } catch (e) {
          modifications.push({ type: "QueryFailed", queryId: sub.queryId, error: errMessage(e) });
        }
      }
      const start = session.version;
      const end: StateVersion = { querySet: start.querySet, ts: invalidation.commitTs };
      session.version = end;
      this.send(session, { type: "Transition", startVersion: start, endVersion: end, modifications });
    }

    // G4 primary origin-frontier guarantee: the committing session must see its own `version.ts`
    // advance past its commit. If this commit touched some of ITS subscriptions it is in `bySession`
    // and the loop above already advanced its ts alongside the write's own modifications — so the ts
    // advance NEVER precedes the modifications it confirms (ordering correct by construction). Only
    // when the commit touched NOTHING it subscribes to (absent from `bySession`) do we emit a
    // standalone empty (`modifications: []`) ts-advancing Transition here.
    this.advanceOriginFrontier(originSessionId, bySession, invalidation.commitTs);

    // G4 fleet fallback: a FORWARDED mutation's commit fanned out on the OWNER node, so its origin
    // tag never reached this forwarding node — `handleMutation` recorded a pending frontier instead.
    // Now that the drain has locally processed a commit at `invalidation.commitTs` (the drain's
    // last-processed ts), satisfy any pending frontier at-or-below it that a session's own
    // subscription update this drain didn't already cover.
    this.sweepPendingFrontiers(invalidation.commitTs, bySession);
  }

  /** Emit a standalone empty ts-advancing Transition — advances `session.version.ts` to `ts` with no
   *  modifications. The one construct that closes a client's optimistic-update gate for a commit that
   *  touched nothing the session subscribes to. Callers guard `ts > session.version.ts` (monotone). */
  private emitEmptyFrontier(session: Session, ts: number): void {
    const start = session.version;
    const end: StateVersion = { querySet: start.querySet, ts };
    session.version = end;
    this.send(session, { type: "Transition", startVersion: start, endVersion: end, modifications: [] });
  }

  /** G4 primary: advance the LOCAL origin session's frontier when its own commit missed all its
   *  subscriptions. A local commit supersedes any stale forwarded fallback entry for that session. */
  private advanceOriginFrontier(
    originSessionId: string | undefined,
    bySession: Map<string, Subscription[]>,
    commitTs: number,
  ): void {
    if (!originSessionId || bySession.has(originSessionId)) return;
    const session = this.sessions.get(originSessionId);
    if (!session || commitTs <= session.version.ts) return;
    this.emitEmptyFrontier(session, commitTs);
    this.pendingFrontiers.delete(originSessionId);
  }

  /** G4 fleet fallback: satisfy pending forwarded-mutation frontiers now that the drain reached
   *  `drainTs`. A frontier still above `drainTs` waits for a later drain; one already covered by the
   *  session's own subscription update (in `bySession` this drain, or an earlier ts advance) clears
   *  without a redundant frame; otherwise an empty ts-advance to the frontier is emitted. */
  private sweepPendingFrontiers(drainTs: number, bySession: Map<string, Subscription[]>): void {
    if (this.pendingFrontiers.size === 0) return;
    for (const [sessionId, frontierTs] of this.pendingFrontiers) {
      if (frontierTs > drainTs) continue; // the forwarded commit hasn't drained locally yet
      const session = this.sessions.get(sessionId);
      if (session && session.version.ts < frontierTs && !bySession.has(sessionId)) {
        this.emitEmptyFrontier(session, frontierTs);
      }
      this.pendingFrontiers.delete(sessionId);
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
        const json = convexToJson(value);
        modifications.push({ type: "QueryUpdated", queryId: sub.queryId, value: json, hash: hashValue(json) });
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
