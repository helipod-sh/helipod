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
import type { DiffableRange, DiffablePage } from "@stackbase/executor";
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
import { tableOfKeyspaceId } from "@stackbase/index-key-codec";
import { SubscriptionManager, type Subscription } from "./subscription-manager";
import { classifyByIdRead, rangeReadFromDiffable, pageReadFromDiffable } from "./classify";
import { byIdChangesFor, byIdResetChanges, rangeChangesFor, rangeResetChanges } from "./commit-differ";
import { driftChecksum, type RowVersion } from "./change";
import { ResumeRegistry, regKey } from "./resume-registry";
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
  runQuery(udfPath: string, args: JSONValue, identity?: string | null): Promise<{ value: Value; tables: string[]; readRanges: readonly SerializedKeyRange[]; globalTables: string[]; diffableRange?: DiffableRange; diffablePage?: DiffablePage }>;
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
  runAdminQuery(udfPath: string, args: JSONValue): Promise<{ value: Value; tables: string[]; readRanges: readonly SerializedKeyRange[]; globalTables: string[]; diffableRange?: DiffableRange; diffablePage?: DiffablePage }>;
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
  /**
   * Disarm the handler's process-shaped background timers: the periodic `setInterval` flush/resume
   * sweep AND every per-session heartbeat ping. Defaults to `false` — the long-lived process host
   * (`Bun.serve`/`node:http`) is byte-for-byte unchanged.
   *
   * WHY (the Cloudflare Durable Object host, Slice 3): a DO **hibernates after ~seconds idle** to
   * scale to zero, keeping its WebSockets alive while discarding in-memory state. On a DO these
   * timers are actively harmful, not merely useless: (a) a `setInterval` sweep does not keep a DO
   * alive and is silently lost on hibernation — dead weight; (b) an app-level `socket.ping` heartbeat
   * would **wake the DO on every ping**, destroying the scale-to-zero economics that are the entire
   * point of the DO host. Keepalive on a DO instead moves to the runtime-level
   * `setWebSocketAutoResponse` (a ping/pong the runtime answers WITHOUT waking the object). So the DO
   * host constructs the handler with this set; the process host never does. Additive + off by default
   * so nothing but the DO host observes any change. See
   * `docs/superpowers/specs/2026-03-20-do-host-slice3-design.md` §8.1.
   */
  disableBackgroundTimers?: boolean;
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
 * The well-known symbol the executor stamps a committed-ts onto an error thrown AFTER its transaction
 * committed (a `commitThenThrow`). Read via `Symbol.for` (the global registry) rather than importing
 * the executor so `@stackbase/sync` keeps its executor coupling TYPE-ONLY — no runtime dependency
 * edge, matching how it already treats `DiffableRange`/`transactor`/`index-key-codec`. MUST stay
 * byte-identical to `@stackbase/executor`'s `COMMITTED_TS_ERROR_KEY` (guarded by a cross-package
 * assertion in this handler's tests). See `SyncProtocolHandler.originResponseGates`.
 */
const COMMITTED_TS_ERROR_KEY = Symbol.for("stackbase.executor.committedTs");

/** The committed-ts the executor stamped on a post-commit error, or `undefined` for a pre-commit
 *  throw (no commit → no origin-response gate was ever registered). */
function committedTsOfError(e: unknown): number | undefined {
  if (e !== null && typeof e === "object") {
    const ts = (e as Record<PropertyKey, unknown>)[COMMITTED_TS_ERROR_KEY];
    if (typeof ts === "number") return ts;
  }
  return undefined;
}

/** Same `${sessionId} ${queryId}` composite key `SubscriptionManager` uses internally (it doesn't
 *  export its own) — `byIdRowMap` is keyed identically so the two stay trivially correlated. */
function subKey(sessionId: string, queryId: number): string {
  return `${sessionId} ${queryId}`;
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
  /**
   * DLR 2a CommitDiffer state: `${sessionId} ${queryId}` -> the current materialized 0-or-1-row map
   * for a DIFFABLE_BYID sub whose client is diff-capable. EPHEMERAL — reseeded on every subscribe
   * (`doModifyQuerySet`'s reset), updated on every incremental diff (`doNotifyWrites`), and dropped on
   * unsubscribe/disconnect. NOT a durable CVR: if lost (process restart, or a sub falling back to the
   * RERUN/QueryUpdated path for one turn) the drift checksum's client-side mismatch check is the
   * backstop that resyncs the one affected query — see `change.ts`'s `driftChecksum` doc comment.
   */
  private readonly byIdRowMap = new Map<string, Map<string, RowVersion>>();
  /**
   * DLR 2b — the response-before-Transition gate (replaces the fragile, timer-starvable
   * `setTimeout(0)`). `commitTs` → a one-shot latch a diff-capable origin's OWN reactive Transition
   * parks on inside `doNotifyWrites`, released once `processMutation` has actually enqueued that
   * commit's `MutationResponse` onto the session's outbound queue.
   *
   * WHY commit-time registration (via {@link registerOriginResponseGate}, called from the runtime's
   * fan-out subscribe callback) rather than lazily inside `doNotifyWrites`: the fan-out drain is
   * SERIAL, so under load `doNotifyWrites` for a commit can run long after that commit's response was
   * already sent (the drain is backed up behind a flood). Registering the gate inside `doNotifyWrites`
   * would then happen AFTER the release — the release would find no gate (no-op), and the late gate
   * would park FOREVER, wedging the whole `notifyTail` (the backpressure-flood regression). The
   * subscribe callback instead fires SYNCHRONOUSLY inside the commit (before `runMutation` resolves,
   * hence before the response can be sent), so the gate always exists before its release, whatever the
   * drain backlog.
   *
   * WHY a microtask latch, not `setTimeout(0)`: the release runs as `processMutation` resumes after
   * `await runMutation` — a MICROTASK, which a tight `await`-loop of mutations (`for (…) await
   * client.mutation(…)`) drains between every iteration. The old timer sat in Node's TIMER phase,
   * which that same loop STARVES; because the yield sat ON the single `notifyTail`, a starved timer
   * stalled the entire fan-out chain. A microtask cannot be starved and cannot stall the tail.
   *
   * Scoped to a diff-capable LOCAL origin session (see `registerOriginResponseGate`), so every gate
   * created here is balanced by exactly one release from that session's own `processMutation` — on
   * EVERY post-commit outcome: the success path releases inline, and a commit-then-throw (or any
   * throw after the commit) releases from its catch via the `committedTs` the executor stamps on the
   * error (see `releaseOriginResponseGate`/`committedTsOfError`). Entries are transient: one per
   * in-flight diff-capable-origin commit, created at commit and dropped on release (or on
   * `disconnect`, which resolves+drops any still-pending gate for the vanishing session so a
   * mid-flight teardown can never strand a parked `doNotifyWrites`). The `sessionId` is retained so
   * that disconnect backstop can find a session's gates in this commitTs-keyed map.
   */
  private readonly originResponseGates = new Map<number, { promise: Promise<void>; resolve: () => void; sessionId: string }>();
  /**
   * DLR Stage 3: the compute-saving half of reconnect resume (see `resume-registry.ts`'s doc
   * comment). Populated on every subscribe (`doModifyQuerySet`), advanced on every commit
   * (`doNotifyWrites`, unconditionally — independent of `bySession`, so an entry with zero live
   * subscribers still advances during its TTL-retained "gap"), and retain/release-tracked across
   * subscribe/unsubscribe/disconnect. Not yet CONSULTED anywhere (that's a later task) — this task
   * only keeps it correctly populated.
   */
  private readonly resumeRegistry = new ResumeRegistry();
  private readonly verifyAdmin: (key: string) => boolean;
  /** Periodic drain sweep — drains recovered clients and abandons terminally-slow queues. */
  private sweepTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly executor: SyncUdfExecutor,
    private readonly options: SyncProtocolHandlerOptions = {},
  ) {
    this.verifyAdmin = options.verifyAdmin ?? (() => false);
    // A DO host disarms this sweep (`disableBackgroundTimers`) — a `setInterval` is lost on
    // hibernation and can't keep a DO alive, so it's pure dead weight there; the DO drives the same
    // per-session flush inline on each `webSocketMessage`/fan-out turn instead. Every process host
    // leaves it on (the default), byte-for-byte unchanged.
    if (!options.disableBackgroundTimers) {
      this.sweepTimer = setInterval(() => {
        for (const session of this.sessions.values()) session.bp.flush();
        // DLR Stage 3: also sweep expired resume-registry entries here, not only on commit
        // (`doNotifyWrites`) — otherwise a fully IDLE server (no commits) never evicts a released
        // entry past its TTL. Bounded, memory-only cleanup; the on-commit sweep still handles the busy case.
        this.resumeRegistry.sweep(Date.now());
      }, FLUSH_SWEEP_MS);
      // Don't keep the process alive for the sweep (Node); loopback-only usage exits cleanly.
      (this.sweepTimer as { unref?: () => void }).unref?.();
    }
  }

  connect(sessionId: string, socket: SyncWebSocket): void {
    // The undroppable-queue-overflow cap terminates the session through the SAME reap-and-close
    // path a dead heartbeat uses (see session-controllers.ts) — one place that owns "this session
    // is being torn down", not two independently-evolving ones.
    const bp = new SessionBackpressureController(socket, this.options.backpressure, undefined, () => this.reap(sessionId));
    const hb = new SessionHeartbeatController(socket, () => this.reap(sessionId), this.options.heartbeat);
    this.sessions.set(sessionId, { sessionId, socket, version: { ...INITIAL_VERSION }, identity: null, privileged: false, bp, hb, supportsQueryDiff: false });
    // `disableBackgroundTimers` (the DO host) skips the per-session ping heartbeat: an app-level ping
    // would wake a hibernated DO on every beat, defeating scale-to-zero (runtime-level
    // `setWebSocketAutoResponse` handles keepalive there instead). A DO socket also omits `ping`
    // entirely, so `start()` is already a no-op for it — this makes the intent explicit and holds
    // even if a DO socket ever gained a `ping`. Every process host leaves it armed (the default).
    if (!this.options.disableBackgroundTimers) hb.start();
  }

  disconnect(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    session?.hb.stop();
    // DLR Stage 3: release this session's resume-registry entries BEFORE dropping its
    // subscriptions — by each sub's STORED `resumeKey` (never a key re-derived from the
    // possibly-since-changed `session.identity`). A sub with zero remaining subscribers (across
    // ALL sessions) stays TTL-retained, not evicted — see `resumeRegistry`'s doc comment.
    for (const sub of this.subscriptions.forSession(sessionId)) {
      if (sub.resumeKey) this.resumeRegistry.release(sub.resumeKey, Date.now());
    }
    this.subscriptions.removeSession(sessionId);
    this.sessions.delete(sessionId);
    this.pendingFrontiers.delete(sessionId);
    this.clearByIdRowMapForSession(sessionId);
    // Backstop: resolve+drop any origin-response gate still pending for this vanishing session, so a
    // mutation that committed (registering a gate) but disconnected before its `processMutation`
    // released it can never leave a `doNotifyWrites` parked forever (DLR 2b review). Under normal
    // operation `processMutation` releases the gate on every outcome, so this loop is usually empty.
    for (const [commitTs, gate] of this.originResponseGates) {
      if (gate.sessionId === sessionId) this.releaseOriginResponseGate(commitTs);
    }
  }

  /** Drop every `byIdRowMap` entry for a session (disconnect/reap) — ephemeral per-sub state, never
   *  durable, so there's nothing to persist on the way out. */
  private clearByIdRowMapForSession(sessionId: string): void {
    const prefix = `${sessionId} `;
    for (const key of [...this.byIdRowMap.keys()]) if (key.startsWith(prefix)) this.byIdRowMap.delete(key);
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

  /** @internal test/debug only — the live ResumeRegistry (DLR Stage 3), for tests to assert
   *  population/advance/retain-release wiring without duplicating its internals. */
  get __resumeRegistry(): ResumeRegistry {
    return this.resumeRegistry;
  }

  /** @internal test/debug only — the live SubscriptionManager (M2c), for tests to assert
   *  registration wiring (e.g. `globalTables`) without duplicating its internals. */
  get __subscriptions(): SubscriptionManager {
    return this.subscriptions;
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
  private async execSub(session: Session, udfPath: string, args: JSONValue): Promise<{ value: Value; tables: string[]; readRanges: readonly SerializedKeyRange[]; globalTables: string[]; diffableRange?: DiffableRange; diffablePage?: DiffablePage }> {
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
        // DLR Stage 3 — the reconnect COMPUTE-SKIP: a resume resubscribe carries `sinceTs` (the
        // client's own last-observed frontier). If the resume registry proves this query's read set
        // hasn't been touched by any commit since then, the cached client result is PROVABLY still
        // valid — answer `QueryUnchanged` without paying for a re-run. Diffable subs (byId/range/page)
        // are excluded: they have their own fingerprint/QueryDiff resume path below, and mixing the
        // two would bypass their reset-seeding (`byIdRowMap`) invariants. A missing entry (TTL-evicted)
        // or a `lastInvalidatedTs` above `sinceTs` (a write landed during the gap) falls through to the
        // normal `execSub` re-run below.
        if (q.sinceTs !== undefined) {
          const rrKey = regKey(session.identity, q.udfPath, q.args);
          const entry = this.resumeRegistry.lookup(rrKey);
          if (entry && !entry.wasDiffable && entry.lastInvalidatedTs <= q.sinceTs) {
            // The skipped sub registers with the RETAINED read set — correct, since an unchanged
            // result means an unchanged read set. Must carry the SAME `rrKey` as both `resumeKey` (so
            // a later release targets the right entry) and the `retain` below (paired with THIS
            // subscription, mirroring the populate-site invariant in the execSub path below).
            this.subscriptions.add({
              sessionId: session.sessionId,
              queryId: q.queryId,
              udfPath: q.udfPath,
              args: q.args,
              tables: [...entry.tables],
              readRanges: entry.readRanges,
              globalTables: [...entry.globalTables],
              byId: undefined,
              resumeKey: rrKey,
            });
            this.resumeRegistry.retain(rrKey);
            modifications.push({ type: "QueryUnchanged", queryId: q.queryId });
            continue;
          }
        }
        const { value, tables, readRanges, globalTables, diffableRange, diffablePage } = await this.execSub(session, q.udfPath, q.args);
        // Subscription registration is UNCONDITIONAL and always fresh, whether or not the result
        // turns out unchanged below — a write-after-Unchanged-resume must still invalidate.
        const byId = classifyByIdRead(value, readRanges) ?? undefined;
        const range = diffableRange ? rangeReadFromDiffable(diffableRange) : undefined;
        // DLR 2c: a page IS a range for invalidation purposes (two-sided bounds + pageMeta) — the
        // existing range differ (`rangeChangesFor`) already handles it unchanged, see `doNotifyWrites`.
        const page = diffablePage ? pageReadFromDiffable(diffablePage) : undefined;
        // DLR Stage 3: capture the resume-registry key at subscribe time and store it ON the sub, so
        // release uses the SAME key `upsert` created it under — even if `SetAuth` later mutates
        // `session.identity` in place (a re-derived key would miss the entry → permanent leak).
        const rrKey = regKey(session.identity, q.udfPath, q.args);
        this.subscriptions.add({ sessionId: session.sessionId, queryId: q.queryId, udfPath: q.udfPath, args: q.args, tables, readRanges, globalTables, byId, range: page ?? range, resumeKey: rrKey });
        // Populate the resume registry for this (identity, path, args). ALWAYS pair `upsert` with
        // `retain` — an `upsert` on a refCount-0 TTL-pending entry clears `expiresAtMs`; without a
        // paired `retain` it would leak (never swept again).
        const wasDiffable = !!(diffableRange || diffablePage || byId);
        this.resumeRegistry.upsert(rrKey, readRanges, tables, session.version.ts, wasDiffable, globalTables);
        this.resumeRegistry.retain(rrKey);
        const json = convexToJson(value);
        if (page && session.supportsQueryDiff) {
          // DLR 2c: a DIFFABLE_PAGE sub's initial/resumed answer — same reset-with-hash contract as
          // the range arm below, but the reset descriptor also carries the page's own fixed metadata
          // (`nextCursor`/`hasMore`/`scanCapped`) so a diff-capable client's pagination controls stay
          // in sync without a separate `QueryUpdated` round-trip. The passthrough guarantee (the
          // executor's `.paginate()` return shape) means `json.page` IS the ordered page rows.
          const orderedRows = (json as { page: JSONValue[] }).page;
          const { changes, next } = rangeResetChanges(page, orderedRows, session.version.ts);
          this.byIdRowMap.set(subKey(session.sessionId, q.queryId), next);
          const hash = hashValue(json);
          if (q.resultHash !== undefined && q.resultHash === hash) {
            modifications.push({ type: "QueryUnchanged", queryId: q.queryId });
          } else {
            modifications.push({
              type: "QueryDiff",
              queryId: q.queryId,
              changes,
              checksum: driftChecksum(next),
              reset: {
                mode: "page",
                orderDir: page.order,
                nextCursor: page.pageMeta!.nextCursor,
                hasMore: page.pageMeta!.hasMore,
                scanCapped: page.pageMeta!.scanCapped,
              },
              hash,
            });
          }
        } else if (range && session.supportsQueryDiff) {
          // DLR 2b Task 10: a DIFFABLE_RANGE sub's initial/resumed answer to a diff-capable client is
          // fingerprinted with the SAME strong `hashValue` a RERUN `QueryUpdated` uses, so subscription
          // resume (design 2025-11-28) works for a diffable sub too. A matching echoed `resultHash`
          // means the fresh result is byte-identical to what the client already has — reply
          // `QueryUnchanged` (no changes on the wire) instead of a full reset.
          //
          // CRITICAL: `byIdRowMap` is seeded EITHER WAY. A reconnect is a fresh server session with an
          // empty `byIdRowMap` (see `disconnect`/`clearByIdRowMapForSession`) — even when the client's
          // baseline is unchanged and nothing is sent, THIS session still needs a materialized row-map
          // on file so a LATER incremental write can diff against it (`sendSessionTransition`'s range
          // arm) instead of finding an empty `prevMap` and computing a wrong diff (spurious `add`s for
          // rows the client already has).
          const { changes, next } = rangeResetChanges(range, json as JSONValue[], session.version.ts);
          this.byIdRowMap.set(subKey(session.sessionId, q.queryId), next);
          const hash = hashValue(json);
          if (q.resultHash !== undefined && q.resultHash === hash) {
            modifications.push({ type: "QueryUnchanged", queryId: q.queryId });
          } else {
            modifications.push({
              type: "QueryDiff",
              queryId: q.queryId,
              changes,
              checksum: driftChecksum(next),
              reset: { mode: "range", orderDir: range.order },
              hash,
            });
          }
        } else if (byId && session.supportsQueryDiff) {
          // DLR 2a/2b Task 10: a DIFFABLE_BYID sub's initial/resumed answer — same resume integration
          // as the range arm above (fingerprint + QueryUnchanged-on-match + unconditional seed).
          //
          // Reset-ts nuance: `execSub`'s return shape (`{value, tables, readRanges}`) doesn't surface
          // the document's own engine commit ts, only the value. Rather than plumb a new field through
          // the whole `SyncUdfExecutor` interface for this one call site, we use the session's own
          // current confirmed ts (`session.version.ts`, unchanged by a ModifyQuerySet — it only bumps
          // `querySet`) as the reset row's ts. This is safe: the checksum only needs client/server
          // agreement on THIS row-map (both sides compute it the same way over whatever ts is chosen),
          // and the very next real write to this id carries its OWN true commit ts through
          // `byIdChangesFor`, so any placeholder-ts imprecision self-corrects on the first write.
          const { changes, next } = byIdResetChanges(byId.docId, json, session.version.ts);
          this.byIdRowMap.set(subKey(session.sessionId, q.queryId), next);
          const hash = hashValue(json);
          if (q.resultHash !== undefined && q.resultHash === hash) {
            modifications.push({ type: "QueryUnchanged", queryId: q.queryId });
          } else {
            modifications.push({ type: "QueryDiff", queryId: q.queryId, changes, checksum: driftChecksum(next), reset: true, hash });
          }
        } else {
          const hash = hashValue(json);
          if (q.resultHash !== undefined && q.resultHash === hash) {
            modifications.push({ type: "QueryUnchanged", queryId: q.queryId });
          } else {
            modifications.push({ type: "QueryUpdated", queryId: q.queryId, value: json, hash });
          }
        }
      } catch (e) {
        modifications.push({ type: "QueryFailed", queryId: q.queryId, error: errMessage(e) });
      }
    }
    for (const queryId of msg.remove) {
      // DLR Stage 3: release by the sub's STORED `resumeKey` (the key `upsert` created it under),
      // never a key re-derived from the possibly-since-changed `session.identity`.
      const removedSub = this.subscriptions.get(session.sessionId, queryId);
      if (removedSub?.resumeKey) {
        this.resumeRegistry.release(removedSub.resumeKey, Date.now());
      }
      this.subscriptions.remove(session.sessionId, queryId);
      this.byIdRowMap.delete(subKey(session.sessionId, queryId));
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
      // DLR 2b: this commit's MutationResponse is now enqueued on the session's outbound queue AHEAD
      // of the commit's own reactive Transition. Release the gate registered at commit time (when the
      // origin is a diff-capable session) so `doNotifyWrites` may now flush the origin's own Transition
      // strictly behind the response. This runs as `processMutation` resumes after `await runMutation`
      // — a microtask, so a tight `await`-loop of mutations can't starve it. A no-op when no gate was
      // registered (inline mode, or a diff-incapable origin). See `originResponseGates`.
      this.releaseOriginResponseGate(commitTs);
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
      // DLR 2b leak fix: a `commitThenThrow` (or any throw AFTER the transaction committed) reaches
      // THIS catch, not the success release above — but its commit already fired the fan-out, which
      // registered an origin-response gate at commit time. Release it here, keyed by the `commitTs`
      // the executor stamped on the error, or a diff-capable subscribed origin's `doNotifyWrites`
      // parks on the never-resolved gate forever and wedges the whole node's reactive drain. A no-op
      // when the throw was PRE-commit (no `committedTs` on the error → no gate was ever registered)
      // or when no gate was registered for this commit (diff-incapable origin). See
      // `releaseOriginResponseGate`.
      const committedTs = committedTsOfError(e);
      if (committedTs !== undefined) this.releaseOriginResponseGate(committedTs);
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
      // Ordering note: `releaseOriginResponseGate` above runs BEFORE this `send`, and that ordering is
      // intentional and harmless — the release only SCHEDULES a microtask (it un-parks a gated
      // `doNotifyWrites`), so this synchronous `send` still puts the `MutationResponse` on the wire
      // first; the released drain can only run once this catch yields.
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
    // DLR Stage 3: advance the resume registry ONCE per commit, independent of `bySession` below —
    // an entry with zero live subscribers (TTL-retained across a disconnect "gap") must still see
    // its `lastInvalidatedTs` advance, or a resuming client would wrongly trust a stale result.
    // Piggyback a bounded opportunistic sweep here too (no separate timer needed).
    this.resumeRegistry.advanceOnCommit(invalidation.ranges ?? [], invalidation.tables, invalidation.commitTs);
    this.resumeRegistry.sweep(Date.now());

    // Use surgical range-level matching: only re-run subscriptions whose read ranges overlap the write ranges.
    const affected = this.subscriptions.findAffectedByRanges(invalidation.ranges ?? [], invalidation.tables);

    const bySession = new Map<string, Subscription[]>();
    for (const sub of affected) {
      if (this.options.excludeOriginFromTransition && sub.sessionId === originSessionId) continue;
      const list = bySession.get(sub.sessionId) ?? [];
      list.push(sub);
      bySession.set(sub.sessionId, list);
    }

    // Response-before-Transition ordering (client-sync verdict §(d); DLR 2b). The committing
    // session's own `MutationResponse` (which carries the commitTs the client's optimistic gate keys
    // off) MUST reach the client BEFORE this commit's Transition — only then is the optimistic layer
    // marked `completed` and dropped ATOMICALLY as the authoritative row ingests (drop-on-observed-
    // inclusion, never a transient temp+real duplicate frame). But the sync handler and the fan-out
    // are decoupled (`autoNotifyOnMutation: false`): the fan-out kicks this notify SYNCHRONOUSLY
    // inside the commit (within `runMutation`), so `doNotifyWrites` is scheduled on a microtask AHEAD
    // of the response — whose own microtask is only scheduled once `runMutation` resolves back in
    // `processMutation`. The RERUN (`QueryUpdated`) arm incidentally re-orders correctly by awaiting
    // `execSub` (a real query), which yields long enough for the response to flush first. The
    // synchronous DIFFABLE (by-id / range `QueryDiff`) arms have no such yield, so their Transition
    // raced — and beat — the response, leaving the layer `inflight` at ingest (the 2b regression).
    //
    // Restore the invariant at the source for the diff path with a MICROTASK gate rather than a
    // macrotask yield: when the origin is a diff-capable client about to receive its OWN commit's
    // Transition, park that Transition on the gate registered at COMMIT time for this `commitTs`
    // (`originResponseGates`), and let it resume only once `processMutation` has actually enqueued this
    // commit's `MutationResponse` (which releases the gate — see `releaseOriginResponseGate`). The
    // prior fix used `await setTimeout(0)`, which runs in Node's TIMER phase; a tight `await`-loop of
    // mutations (`for (…) await client.mutation(…)`) STARVES that phase, so the timer never fired and —
    // because this yield sits ON the single `notifyTail` — it BLOCKED the entire fan-out chain (the
    // backpressure-flood regression: a stalled victim received ZERO fan-out). The gate instead resumes
    // on a MICROTASK (the response send is `processMutation` resuming after `await runMutation`), and
    // microtasks drain between every `await` of that loop — so it cannot be starved and cannot stall
    // the `notifyTail`. Registration lives at commit time (not here) precisely because the serial drain
    // can run this method long after the response was sent; see `originResponseGates`' doc comment.
    //
    // SCOPED to the origin's own Transition only (DLR 2b review): the gate exists solely to let the
    // origin's `MutationResponse` flush ahead of ITS Transition — a non-origin session has no response
    // of its own to order against, so delaying its send too is pure unnecessary fan-out latency (and,
    // worse, skews any timing-sensitive backpressure test aimed at a non-origin victim). Every
    // non-origin session is therefore computed+sent FIRST, with no added delay; only the origin's own
    // compute+send (if it's diff-capable and present in `bySession`) parks on the gate. A
    // diff-incapable origin has no synchronous QueryDiff race to guard against, so it is NOT skipped
    // out of the main loop — it sends inline in its natural iteration position, exactly like any
    // non-origin session.
    const originIsDiffCapable =
      !!originSessionId && bySession.has(originSessionId) && this.sessions.get(originSessionId)?.supportsQueryDiff === true;

    for (const [sessionId, subs] of bySession) {
      if (originIsDiffCapable && sessionId === originSessionId) continue; // handled below, after the gate
      const session = this.sessions.get(sessionId);
      if (!session) continue;
      await this.sendSessionTransition(session, subs, invalidation);
    }

    if (originIsDiffCapable) {
      const originSubs = bySession.get(originSessionId!)!;
      const originSession = this.sessions.get(originSessionId!)!;
      // Park until this commit's `MutationResponse` has been enqueued. The gate was registered at
      // commit time; if the response already flushed (the drain ran this method late), it's already
      // released (absent) and we proceed immediately. Either way, the origin Transition never precedes
      // its own response on the wire.
      const gate = this.originResponseGates.get(invalidation.commitTs);
      if (gate) await gate.promise;
      await this.sendSessionTransition(originSession, originSubs, invalidation);
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

  /**
   * DLR 2b — register the response-before-Transition gate for `commitTs`, at COMMIT time. Called
   * SYNCHRONOUSLY from the runtime's fan-out subscribe callback (which fires inside the commit,
   * before `runMutation` resolves and thus before this commit's `MutationResponse` can be sent), so
   * the gate reliably exists before {@link releaseOriginResponseGate} runs — no matter how backed up
   * the serial fan-out drain is. Public because the decoupled runtime owns the commit-time seam.
   *
   * Registers ONLY for a diff-capable LOCAL origin session — exactly the case `doNotifyWrites` parks
   * on, and exactly the case whose own `processMutation` will release it, so every gate is balanced
   * (no leak). A no-origin commit, a foreign/absent session, or a diff-incapable session registers
   * nothing. Idempotent per `commitTs`.
   */
  registerOriginResponseGate(commitTs: number, originSessionId: string | undefined): void {
    if (originSessionId === undefined) return;
    if (this.sessions.get(originSessionId)?.supportsQueryDiff !== true) return;
    if (this.originResponseGates.has(commitTs)) return;
    let resolve!: () => void;
    const promise = new Promise<void>((r) => (resolve = r));
    this.originResponseGates.set(commitTs, { promise, resolve, sessionId: originSessionId });
  }

  /**
   * DLR 2b — release (and drop) the response gate for `commitTs`. Called right after the commit's
   * `MutationResponse` is enqueued, so the parked origin Transition flushes strictly behind it. A
   * no-op when no gate is registered (a diff-incapable / no-origin commit never registered one) — so
   * an ordinary commit costs nothing here.
   */
  private releaseOriginResponseGate(commitTs: number): void {
    const gate = this.originResponseGates.get(commitTs);
    if (gate !== undefined) {
      this.originResponseGates.delete(commitTs);
      gate.resolve();
    }
  }

  /**
   * Compute one session's modifications for this commit (by-id / range `QueryDiff` incremental arms,
   * or the RERUN `QueryUpdated`/`QueryFailed` arm) and send its Transition. Extracted from
   * `doNotifyWrites`'s per-session loop body (byte-identical logic) so the origin session's own call
   * can be deferred past the response-ordering macrotask yield while every non-origin session is
   * computed+sent immediately, with no shared logic duplicated between the two call sites.
   */
  private async sendSessionTransition(
    session: Session,
    subs: Subscription[],
    invalidation: WriteInvalidation,
  ): Promise<void> {
    const modifications: StateModification[] = [];
    for (const sub of subs) {
      try {
        // NOTE (DLR 2b Task 10): a session's `supportsQueryDiff` can flip true asynchronously
        // mid-session, independent of when a given sub was last (re)answered — e.g. an outbox
        // client's capability rides its resume `Connect`, sent AFTER its own resync's
        // `ModifyQuerySet` (`onTransportReopened`'s ordering; see `client.ts`). That can let a write
        // take the incremental-diff shortcut below even for a sub this SERVER SESSION never actually
        // seeded a row-map for (`this.byIdRowMap.get(key) ?? new Map()` silently substitutes an empty
        // one) — but that empty substitution is the SAME pre-existing behavior the RERUN-fallback
        // arm below already deliberately relies on (a range sub's map is unconditionally dropped
        // there, expecting a LATER incremental write to reseed off nothing but its own written docs)
        // — see `commit-differ-handler.test.ts`'s "RERUN fallback ... re-seeds via a fresh add-all"
        // and the SetAuth re-thread test, both of which pin this. Task 10 does not touch this
        // invalidation-loop behavior (its own remit is the subscribe-answer path); the client-side
        // residual this CAN expose (a diff-capable-but-never-actually-reset client rendering wrong)
        // is instead guarded at the source of truth for render shape — `reconcile.ts`'s
        // `ingestTransition` — which resyncs rather than trusting an uninitialized `renderMode`.
        const key = subKey(sub.sessionId, sub.queryId);
        if (sub.range && session.supportsQueryDiff && invalidation.writtenDocs) {
          // DLR 2b: a DIFFABLE_RANGE sub with a diff-capable client and a commit that carried its
          // written docs gets an incremental QueryDiff — no execSub re-run needed. Unlike a by-id
          // sub (which only ever cares about writes at its OWN key), a range sub must consider
          // EVERY write in its TABLE: a write anywhere in the table can enter or exit the range
          // (an insert, an update that crosses the bounds/filter, a delete). `writtenDocs` is
          // filtered to the sub's table via `tableOfKeyspaceId` — `sub.range.keyspace` is an INDEX
          // keyspace (`index:<tableNumber>:<indexName>`) while `wd.keyspace` is always a PRIMARY
          // keyspace (`table:<tableNumber>`), but both embed the identical `encodeStorageTableId`
          // table-number string (verified against `indexKeyspaceId`/`tableKeyspaceId`'s shared
          // encoding in `@stackbase/index-key-codec`), so comparing the parsed table id is the
          // provably correct match — not a coincidental string prefix trick.
          const subTable = tableOfKeyspaceId(sub.range.keyspace);
          const wds = invalidation.writtenDocs.filter((w) => tableOfKeyspaceId(w.keyspace) === subTable);
          const prevMap = this.byIdRowMap.get(key) ?? new Map<string, RowVersion>();
          const { changes, next } = rangeChangesFor(sub.range, prevMap, wds);
          this.byIdRowMap.set(key, next);
          // Pushed even with an empty `changes` array (e.g. every written doc in the table this
          // commit was outside the sub's bounds/filter) — an empty QueryDiff still advances the
          // client's version frontier under this Transition's bracket; the client no-ops it.
          modifications.push({ type: "QueryDiff", queryId: sub.queryId, changes, checksum: driftChecksum(next) });
          continue;
        }
        if (sub.byId && session.supportsQueryDiff && invalidation.writtenDocs) {
          // DLR 2a: a DIFFABLE_BYID sub with a diff-capable client and a commit that carried its
          // written docs gets an incremental QueryDiff — no execSub re-run needed (a write to this
          // id can only change the single row's VALUE, never the shape of what a future `db.get(id)`
          // reads, so `sub.byId` itself is trusted as-is here — no reclassification necessary).
          const wd = invalidation.writtenDocs.find(
            (w) => w.keyspace === sub.byId!.keyspace && w.key === sub.byId!.key,
          );
          const prevMap = this.byIdRowMap.get(key) ?? new Map<string, RowVersion>();
          const { changes, next } = byIdChangesFor(sub.byId, prevMap, wd);
          this.byIdRowMap.set(key, next);
          modifications.push({ type: "QueryDiff", queryId: sub.queryId, changes, checksum: driftChecksum(next) });
          continue;
        }
        const { value, tables, readRanges, globalTables, diffableRange, diffablePage } = await this.execSub(session, sub.udfPath, sub.args);
        // Recompute `byId`/`range` from THIS fresh (value, readRanges, diffableRange) instead of
        // spreading the sub's stale classification — a query whose read shape changes across a
        // refresh (data/identity-dependent branching) must not keep carrying a `byId`/`range` that
        // no longer matches what it actually reads now (Task 3 review follow-up: a stale `byId`
        // here would drive a WRONG diff the next time this sub takes a branch above).
        const byId = classifyByIdRead(value, readRanges) ?? undefined;
        const range = diffableRange ? rangeReadFromDiffable(diffableRange) : undefined;
        // DLR 2c: same reasoning for a page sub — without this, a page's RERUN fallback (a commit
        // with no `writtenDocs`) would silently DROP its classification (`diffablePage` was never
        // read here, so `range` would resolve to `undefined` and overwrite the sub's page range via
        // `...sub`'s spread below), permanently reverting it to RERUN even once `writtenDocs` starts
        // flowing again on a later commit.
        const page = diffablePage ? pageReadFromDiffable(diffablePage) : undefined;
        this.subscriptions.add({ ...sub, tables, readRanges, globalTables, byId, range: page ?? range }); // refresh the read set
        // DLR Stage 3 (whole-branch review fix): keep the resume registry's read-set in LOCKSTEP with
        // this fresh re-run. A data/identity-dependent query can shift its read ranges here (e.g.
        // `get(user)` then a range keyed on `user.currentRoom`); a registry still frozen at the
        // ORIGINAL subscribe would then miss a gap write to the NEW range → `lastInvalidatedTs`
        // wouldn't advance → a wrong reconnect skip → SILENT STALE DATA. Re-upsert re-indexes the
        // entry under the current ranges; `advanceOnCommit` already moved its `lastInvalidatedTs` to
        // this commit, so the ts is a no-op — only the ranges/tables/wasDiffable change. (No `retain`:
        // the sub is live, so refCount ≥ 1 and `expiresAtMs` is already unset — no leak.)
        if (sub.resumeKey) {
          this.resumeRegistry.upsert(sub.resumeKey, readRanges, tables, Number(invalidation.commitTs), !!(page ?? range) || !!byId, globalTables);
        }
        // Reset-semantics follow-up: if the sub's byId just transitioned away from what it was
        // (or vanished entirely), drop any old byIdRowMap entry — it's keyed to a byId this
        // refresh has just superseded. Left alone, a LATER incremental write (once this sub is
        // diff-capable again) would diff against a stale prev-map keyed to the OLD id and
        // accumulate a second, never-pruned entry (the identity-flip bug this closes). A sub
        // that keeps the SAME byId across this refresh is untouched — its map stays accurate.
        if (sub.byId && (!byId || byId.keyspace !== sub.byId.keyspace || byId.key !== sub.byId.key)) {
          this.byIdRowMap.delete(subKey(sub.sessionId, sub.queryId));
        }
        // Same idea for a range sub, but unconditional: this RERUN branch means a full re-scan
        // (not an incremental diff) answered this turn — a write anywhere in the table could have
        // shifted the range's MEMBERSHIP (not just one row's value) with no per-doc diff tracking
        // it, so the old row-map's membership snapshot predates this RERUN and must not be reused
        // by a later incremental diff. Drop it unconditionally (not gated on the range classification
        // itself changing, unlike byId above). Re-seed happens via a DRIFT-TRIGGERED RESYNC, NOT a
        // fresh QueryDiff reset: the client ingests the `QueryUpdated` below (which reverts the sub to
        // plain RERUN rendering — clears `renderMode`/`diffRows`, Finding 2 in `layered-store.ts`),
        // then on the next write the server emits an INCREMENTAL QueryDiff off the now-empty map
        // (carrying only that commit's written docs, not full membership). The client sees an
        // incremental diff against an uninitialized render mode and resyncs (`reconcile.ts`'s
        // uninitialized-render-mode guard), which is what re-establishes a clean baseline.
        if (sub.range) {
          this.byIdRowMap.delete(subKey(sub.sessionId, sub.queryId));
        }
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
        const { value, tables, readRanges, globalTables, diffableRange, diffablePage } = await this.execSub(session, sub.udfPath, sub.args);
        // Recompute `byId`/`range` from THIS fresh (value, readRanges, diffableRange) instead of
        // spreading the sub's stale classification — an identity change can change WHAT a query
        // reads (e.g. an identity-scoped `db.get`, or an identity-scoped range's bounds/filters),
        // so a stale `byId`/`range` here would drive a wrong diff on a later write.
        const byId = classifyByIdRead(value, readRanges) ?? undefined;
        const range = diffableRange ? rangeReadFromDiffable(diffableRange) : undefined;
        // DLR 2c: same reasoning for a page sub — a fresh page (with fresh two-sided bounds) is
        // threaded through as `range` (a page IS a range for invalidation), same as the
        // subscribe-answer path in `doModifyQuerySet`.
        const page = diffablePage ? pageReadFromDiffable(diffablePage) : undefined;
        // DLR Stage 3: an identity change RE-KEYS this sub's resume-registry entry. The read-set was
        // captured under the OLD identity; under the NEW identity the query can read different rows,
        // so the entry must move to `regKey(newIdentity, ...)`. This keeps the load-bearing invariant
        // that `sub.resumeKey === regKey(session.identity, path, args)` at all times — which is what
        // makes the live-re-run upsert (in `sendSessionTransition`) correctly keyed. Upsert the new
        // key first (so `retain` finds it), then retain-new + release-old only when the key actually
        // changed (refCount stays balanced: original subscribe retained the old key). A reconnect
        // under the new identity now finds the migrated entry; a reconnect under the OLD identity
        // misses (its entry TTL-sweeps) → re-run, never a stale skip.
        const newResumeKey = regKey(session.identity, sub.udfPath, sub.args);
        this.resumeRegistry.upsert(newResumeKey, readRanges, tables, session.version.ts, !!(page ?? range) || !!byId, globalTables);
        if (sub.resumeKey !== newResumeKey) {
          this.resumeRegistry.retain(newResumeKey);
          if (sub.resumeKey) this.resumeRegistry.release(sub.resumeKey, Date.now());
        }
        this.subscriptions.add({ ...sub, tables, readRanges, globalTables, byId, range: page ?? range, resumeKey: newResumeKey });
        const key = subKey(session.sessionId, sub.queryId);
        const json = convexToJson(value);
        if (byId && session.supportsQueryDiff) {
          // Reset semantics: this is a RE-BASELINE, not an incremental diff off a single write — the
          // sub's byId may have just changed to a DIFFERENT (keyspace, key, docId) (e.g. an
          // identity-scoped `db.get(ctx.identity)` whose target flips under this very SetAuth), so
          // the row-map must be reseeded from THIS fresh value, never carried forward from whatever
          // (possibly now-stale) map was on file. Reusing the old map here is exactly the bug this
          // fixes: the next incremental write would diff against the OLD id's stale prev-map and
          // accumulate a second, never-pruned entry.
          const { changes, next } = byIdResetChanges(byId.docId, json, session.version.ts);
          this.byIdRowMap.set(key, next);
          modifications.push({ type: "QueryDiff", queryId: sub.queryId, changes, checksum: driftChecksum(next), reset: true });
        } else {
          // Not DIFFABLE post-refresh (or a non-capable session): unchanged RERUN path. Drop any
          // stale byIdRowMap entry so a LATER re-classification back to DIFFABLE never resumes
          // incremental diffing from a map keyed to a byId this refresh has just superseded.
          this.byIdRowMap.delete(key);
          modifications.push({ type: "QueryUpdated", queryId: sub.queryId, value: json, hash: hashValue(json) });
        }
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
