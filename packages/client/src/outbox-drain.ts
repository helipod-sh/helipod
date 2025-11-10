/**
 * Task 4 — the drain (verdict §(d) "Drain", `docs/dev/research/offline-outbox/verdict.md`). The
 * state machine that turns the durable queue (`OutboxStorage`) into exactly-once server effects.
 *
 * Shape (verdict §(d)):
 *  - **Web Locks leader** (`stackbase:outbox:<origin>:<deployment>`) — probe `navigator.locks`,
 *    single-tab fallback when it's absent. Locks are *efficiency*, not correctness: two drainers
 *    double-sending is harmless because Plan A's exact-match receipts replay-ack the loser (verdict
 *    §(d): "locks are efficiency; correctness is the records"). Mid-drain lock loss (the tab killed,
 *    or `stop()` on close) → stop cleanly; the durable records make the successor safe (hazard 7).
 *  - **Hydrate** the durable queue into the in-memory log under each entry's RECORDED `(clientId,
 *    seq)` (cross-session entries a prior page-load left behind), then prune dead-clientId meta rows.
 *  - **FIFO by persisted `order`**, sent as `MutationBatch` chunks (default 50 — repair 4, the
 *    500-drain arithmetic in verdict §(a)/(h)); ONE unacked chunk in flight at a time.
 *  - **Per-unit resolution** of each chunk's per-entry `MutationResponse`:
 *      - `applied`/replayed → settle (resolve + dequeue + the baseline-gated drop rule via T3) and
 *        advance.
 *      - coded (terminal) failure → default **skip-and-record**: the SERVER recorded the terminal
 *        verdict, so the client settles the promise terminally and CONTINUES past it; the
 *        `poisonPolicy: "pause"` option instead HALTS the drain and surfaces (verdict §(c) R5).
 *      - codeless (transient/infra) failure → back off (a local mirror of the scheduler's
 *        `computeBackoff`) and re-send FROM the failed unit.
 *      - the **transient-stop chunk contract** (Plan A's server semantics, its E2E is the
 *        reference): a transient failure STOPS the server mid-batch, so every unit AFTER it gets NO
 *        response — those remain queued and re-send on the next chunk.
 *  - **Identity gate per entry at flush**: an entry whose stored `identityFingerprint` no longer
 *    matches the session's current one terminal-fails LOUDLY with `OFFLINE_IDENTITY_CHANGED`
 *    (hazard 9) — a mutation queued as user A must never flush as user B.
 *  - **Wakes**: on enqueue, on reconnect-after-baseline, and on an interval nudge — NEVER
 *    `navigator.onLine` (hazard 13: it lies).
 *
 * The drain owns no promise callbacks and no wire types beyond `MutationBatch`/`MutationResponse`;
 * every settlement routes back through `client.ts` via {@link DrainHost} so the T3 seam
 * (`settleVerdict`'s primitives — resolve/reject, dequeue, the drop rule) is reused, not forked.
 */
import { jsonToConvex, type JSONValue, type Value } from "@stackbase/values";
import type { MutationBatchEntry, ServerMessage } from "@stackbase/sync";
import type { PendingMutation } from "./mutation-log";
import type { OutboxEntry, OutboxStorage } from "./outbox-storage";

type MutationResponse = Extract<ServerMessage, { type: "MutationResponse" }>;

/** How the drain treats a coded (terminal, server-recorded) mutation failure (verdict §(c) R5). */
export type PoisonPolicy =
  /** DEFAULT — skip-and-record: settle the promise terminally and CONTINUE draining. The server
   *  already recorded the verdict, so a restart can never un-skip it. */
  | "skip"
  /** Halt the whole drain on the first coded failure and surface it (A's argument, honored as an
   *  option, not the default). */
  | "pause";

/* -------------------------------------------------------------------------------------------------
 * Backoff — a LOCAL MIRROR of `computeBackoff` from `components/scheduler/src/backoff.ts`.
 *
 * The client is a browser SDK; it must NOT depend on the server-side `@stackbase/scheduler`
 * component (which pulls in `@stackbase/executor` and the whole engine). So the formula is
 * duplicated here with attribution — keep the two in sync. `attempts` is the transient-failure
 * count AFTER this failure is recorded (call with the already-incremented count), matching the
 * scheduler's contract exactly. Jitter is 50–100% of the raw backoff; capped so a long offline
 * streak never schedules an absurd delay.
 * ------------------------------------------------------------------------------------------------- */
const DRAIN_INITIAL_BACKOFF_MS = 250;
const DRAIN_BACKOFF_BASE = 2;
const DRAIN_MAX_BACKOFF_MS = 30_000;

export function computeDrainBackoff(attempts: number, rng: () => number = Math.random): number {
  const raw = DRAIN_INITIAL_BACKOFF_MS * DRAIN_BACKOFF_BASE ** (attempts + 1);
  const jittered = Math.round(raw * (0.5 + 0.5 * rng()));
  return Math.min(jittered, DRAIN_MAX_BACKOFF_MS);
}

/** The default `MutationBatch` chunk size (verdict §(a)/(h) repair 4). */
export const DEFAULT_DRAIN_CHUNK_SIZE = 50;
/** The default interval-nudge period — the backstop wake (verdict §(d): never `navigator.onLine`). */
export const DEFAULT_DRAIN_INTERVAL_MS = 5_000;

/* -------------------------------------------------------------------------------------------------
 * The Web Locks seam (feature-probed, fake-able in tests).
 * ------------------------------------------------------------------------------------------------- */

/** The one method the drain needs from `navigator.locks` — a minimal, structurally-fakeable seam.
 *  `request(name, options, cb)` holds the named lock for the lifetime of `cb`'s returned promise
 *  (exactly the real `LockManager.request` 3-arg contract). */
export interface OutboxLockManager {
  request(
    name: string,
    options: { signal?: AbortSignal; mode?: "exclusive" | "shared"; ifAvailable?: boolean },
    callback: () => Promise<unknown>,
  ): Promise<unknown>;
}

/** Probe the ambient `navigator.locks`, wrapped into the seam (avoids overload-variance friction of
 *  passing the DOM `LockManager` type straight through). Returns `undefined` when unavailable — the
 *  drain then runs single-tab (correctness is the records, not the lock). */
function probeLockManager(): OutboxLockManager | undefined {
  const nav = (globalThis as { navigator?: { locks?: { request?: unknown } } }).navigator;
  const locks = nav?.locks;
  if (locks && typeof locks.request === "function") {
    return {
      request: (name, options, callback) =>
        (locks as { request: OutboxLockManager["request"] }).request(name, options, callback),
    };
  }
  return undefined;
}

/* -------------------------------------------------------------------------------------------------
 * The host seam — what the drain needs from `client.ts` (so the T3 settlement primitives are reused).
 * ------------------------------------------------------------------------------------------------- */

export interface DrainHost {
  readonly outbox: OutboxStorage;
  /** This tab-session's current clientId (re-minted on `onClientReset`). */
  currentClientId(): string | undefined;
  /** The session's current identity fingerprint — the flush-time identity gate compares against it. */
  currentFingerprint(): string;
  /** The transport is up (not closed) — the drain never sends while down. */
  transportOpen(): boolean;
  /** A `ConnectAck` has proven server-side receipt dedup for this session (S4 armed) — the drain
   *  never flushes before this, so it can never re-execute against an old/undedup'd server. */
  isArmed(): boolean;
  /** Drain-eligible entries (`unsent`/`parked`, durable, `clientId`+`seq` set), FIFO by `order`. */
  drainable(): PendingMutation[];
  /** Add a hydrated durable entry to the log under a FRESH requestId (idempotent by `(clientId,
   *  seq)`). The persisted requestId was session-correlation only, so a fresh one avoids colliding
   *  with this session's own requestId counter. */
  addHydrated(entry: OutboxEntry): void;
  /** Send the first-connect `Connect` handshake if one hasn't gone out on this connection yet
   *  (idempotent) — the reload analog of T3's reopen handshake (verdict §(d): "the drain starts
   *  only after the reconnect baseline Transition has been adopted"). */
  ensureInitialHandshake(): void;
  /** Flip an in-log entry's status (drain-owned transitions: `inflight` on flush, back to `unsent`
   *  on a transient revert). */
  setStatus(entry: PendingMutation, status: "inflight" | "unsent"): void;
  /** Build the wire `MutationBatchEntry` for an in-log entry. */
  batchEntry(entry: PendingMutation): MutationBatchEntry;
  /** Send one `MutationBatch` chunk. */
  sendBatch(entries: MutationBatchEntry[]): void;
  /** applied/replayed settlement (verdict §(d) drop rule, T3's `settleVerdict` primitives): resolve
   *  the awaiting promise (if any), dequeue the durable record, drop the layer after baseline. */
  settleApplied(requestId: string, value: Value | null): void;
  /** Terminal settlement: reject the awaiting promise (coded), dequeue, drop the layer. */
  settleTerminal(requestId: string, code: string | undefined, message: string): void;
  /** Resolves once the first post-`Connect` baseline Transition has been adopted (verdict §(d) —
   *  the drain's send gate). Resolves immediately when no handshake is in flight. */
  whenBaselineAdopted(): Promise<void>;
}

/** Terminal code for the flush-time identity gate (hazard 9). */
export const OFFLINE_IDENTITY_CHANGED = "OFFLINE_IDENTITY_CHANGED";

export interface OutboxDrainOptions {
  /** The Web Locks lock name — `stackbase:outbox:<origin>:<deployment>`. */
  lockName: string;
  /** `undefined` → probe `navigator.locks`; `null` → force single-tab; an object → use it (tests). */
  locks?: OutboxLockManager | null;
  poisonPolicy?: PoisonPolicy;
  chunkSize?: number;
  intervalMs?: number;
  /** Injectable backoff (tests drive it deterministically); defaults to {@link computeDrainBackoff}. */
  backoffMs?: (attempts: number) => number;
  /** Fired once when `poisonPolicy: "pause"` halts the drain on a coded failure (surfacing). */
  onPause?: (info: { requestId: string; udfPath: string; code: string }) => void;
}

/* -------------------------------------------------------------------------------------------------
 * The drain.
 * ------------------------------------------------------------------------------------------------- */

export class OutboxDrain {
  private readonly host: DrainHost;
  private readonly lockName: string;
  private readonly locksOption: OutboxLockManager | null | undefined;
  private readonly poisonPolicy: PoisonPolicy;
  private readonly chunkSize: number;
  private readonly intervalMs: number;
  private readonly backoffMs: (attempts: number) => number;
  private readonly onPause?: (info: { requestId: string; udfPath: string; code: string }) => void;

  private started = false;
  private leader = false;
  private stopped = false;
  private paused = false;
  private hydrated = false;
  /** The in-flight chunk: requestId → in-log entry. Non-null iff one unacked chunk is outstanding. */
  private active: Map<string, PendingMutation> | null = null;
  /** Re-entrancy guard around `maybeDrainNext`'s `await whenBaselineAdopted()` (one flush at a time). */
  private flushScheduling = false;
  /** Consecutive transient-stop count — the backoff attempt number (reset on any forward progress). */
  private transientAttempts = 0;

  private readonly abort = new AbortController();
  private releaseLeadership?: () => void;
  private intervalTimer?: ReturnType<typeof setInterval>;
  private backoffTimer?: ReturnType<typeof setTimeout>;

  constructor(host: DrainHost, opts: OutboxDrainOptions) {
    this.host = host;
    this.lockName = opts.lockName;
    this.locksOption = opts.locks;
    this.poisonPolicy = opts.poisonPolicy ?? "skip";
    this.chunkSize = opts.chunkSize ?? DEFAULT_DRAIN_CHUNK_SIZE;
    this.intervalMs = opts.intervalMs ?? DEFAULT_DRAIN_INTERVAL_MS;
    this.backoffMs = opts.backoffMs ?? ((attempts) => computeDrainBackoff(attempts));
    this.onPause = opts.onPause;
  }

  /** Acquire leadership (Web Locks, or single-tab fallback) and, once leader, hydrate + drain. Safe
   *  to call once; a no-op afterward. */
  start(): void {
    if (this.started) return;
    this.started = true;
    const locks = this.locksOption === undefined ? probeLockManager() : this.locksOption ?? undefined;
    if (!locks) {
      // Single-tab: assume leadership on a microtask (so construction returns before hydrate runs).
      queueMicrotask(() => void this.becomeLeader());
      return;
    }
    // Hold the lock for the lifetime of `becomeLeader`'s promise (resolves on `stop()`). A pending
    // request the abort signal cancels (or any failure) simply means "not leader" — never a throw.
    void locks
      .request(this.lockName, { signal: this.abort.signal }, async () => {
        if (this.stopped) return;
        await this.becomeLeader();
      })
      .catch(() => {
        /* aborted before acquisition, or the lock request rejected — we are simply not the leader. */
      });
  }

  /** Stop cleanly (client close, or mid-drain lock loss). Releases leadership, cancels a pending
   *  lock request, and clears every timer — the durable records make a successor leader safe. */
  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.leader = false;
    this.active = null;
    if (this.intervalTimer !== undefined) clearInterval(this.intervalTimer);
    if (this.backoffTimer !== undefined) clearTimeout(this.backoffTimer);
    this.intervalTimer = undefined;
    this.backoffTimer = undefined;
    this.abort.abort();
    this.releaseLeadership?.();
  }

  /** Wake the drain (enqueue / reconnect-after-baseline / an explicit nudge). Deferred to a
   *  microtask so a synchronous settling frame (e.g. a `ConnectAck` emitted right after reopen)
   *  always settles its entries BEFORE the drain re-reads the queue. */
  nudge(): void {
    if (this.stopped || !this.leader) return;
    queueMicrotask(() => void this.maybeDrainNext());
  }

  /** True iff `requestId` belongs to the drain's in-flight chunk — `client.ts` routes that unit's
   *  `MutationResponse` here instead of down the direct-send path. */
  handles(requestId: string): boolean {
    return this.active?.has(requestId) ?? false;
  }

  /** @internal test/debug — the drain halted on a coded failure under `poisonPolicy: "pause"`. */
  get isPaused(): boolean {
    return this.paused;
  }

  /** @internal test/debug — the drain currently holds leadership. */
  get isLeader(): boolean {
    return this.leader;
  }

  /** Resume a `pause`d drain (T5 owns the app-facing retry surface; this is the mechanism). */
  resume(): void {
    if (!this.paused) return;
    this.paused = false;
    this.transientAttempts = 0;
    this.nudge();
  }

  private async becomeLeader(): Promise<void> {
    if (this.stopped) return;
    this.leader = true;
    await this.hydrateOnce();
    if (this.stopped) return;
    // A reload with a durable backlog fires the first-connect handshake (arms the S4 swap + lets
    // the server classify held entries); a fresh empty queue defers to the normal reopen handshake
    // so an empty-outbox client is byte-identical to before this task (no spurious Connect frame).
    if (this.host.transportOpen() && this.host.drainable().length > 0) this.host.ensureInitialHandshake();
    this.startInterval();
    void this.maybeDrainNext();
    // Hold leadership until `stop()`; resolving this promise releases the Web Lock.
    await new Promise<void>((resolve) => {
      this.releaseLeadership = resolve;
    });
  }

  private startInterval(): void {
    if (this.intervalTimer !== undefined || this.intervalMs <= 0) return;
    this.intervalTimer = setInterval(() => void this.maybeDrainNext(), this.intervalMs);
    (this.intervalTimer as { unref?: () => void }).unref?.();
  }

  /** Load the durable queue into the log (once), under recorded ids, then prune dead meta rows. */
  private async hydrateOnce(): Promise<void> {
    if (this.hydrated) return;
    this.hydrated = true;
    const { entries } = await this.host.outbox.loadAll();
    for (const e of entries) this.host.addHydrated(e);
    await this.pruneDeadMeta();
  }

  /** Delete meta rows for clientIds with no live entries and that aren't the current session's — the
   *  T1-flagged unbounded-tiny-rows gap (one dead row accrues per prior tab-session + every reset).
   *  Capability-gated: a minimal `OutboxStorage` (a bare test double) may omit the two optional
   *  methods, in which case pruning is simply skipped. */
  private async pruneDeadMeta(): Promise<void> {
    const list = this.host.outbox.listMetaClientIds;
    const del = this.host.outbox.deleteMeta;
    if (!list || !del) return;
    let ids: string[];
    try {
      ids = await list.call(this.host.outbox);
    } catch {
      return;
    }
    const current = this.host.currentClientId();
    const live = new Set<string>();
    for (const e of this.host.drainable()) if (e.clientId !== undefined) live.add(e.clientId);
    for (const id of ids) {
      if (id === current || live.has(id)) continue;
      try {
        await del.call(this.host.outbox, id);
      } catch {
        /* best-effort — a failed prune is never a correctness problem. */
      }
    }
  }

  private canDrain(): boolean {
    return (
      this.leader &&
      !this.stopped &&
      !this.paused &&
      this.active === null &&
      this.host.transportOpen() &&
      this.host.isArmed() &&
      this.host.drainable().length > 0
    );
  }

  /** Flush the next chunk when eligible. The `flushScheduling` guard + the synchronous `this.active`
   *  set (in `flushChunk`) keep exactly one chunk in flight across the `await` yield. */
  private async maybeDrainNext(): Promise<void> {
    if (this.flushScheduling || !this.canDrain()) return;
    this.flushScheduling = true;
    try {
      await this.host.whenBaselineAdopted();
      if (!this.canDrain()) return;
      this.flushChunk();
    } finally {
      this.flushScheduling = false;
    }
  }

  private flushChunk(): void {
    const all = this.host.drainable();
    const currentFingerprint = this.host.currentFingerprint();
    const chunk: MutationBatchEntry[] = [];
    const map = new Map<string, PendingMutation>();
    let settledIdentityFailure = false;

    for (const entry of all) {
      if (chunk.length >= this.chunkSize) break;
      // Identity gate (hazard 9): a mutation queued under a different auth identity must never flush.
      if (entry.identityFingerprint !== undefined && entry.identityFingerprint !== currentFingerprint) {
        console.error(
          `[stackbase] outbox: dropping mutation "${entry.udfPath}" — it was queued under a different ` +
            `identity than the current session (${OFFLINE_IDENTITY_CHANGED})`,
        );
        this.host.settleTerminal(
          entry.requestId,
          OFFLINE_IDENTITY_CHANGED,
          `mutation "${entry.udfPath}" dropped: the session identity changed since it was queued`,
        );
        settledIdentityFailure = true;
        continue;
      }
      this.host.setStatus(entry, "inflight");
      map.set(entry.requestId, entry);
      chunk.push(this.host.batchEntry(entry));
    }

    if (chunk.length === 0) {
      // Everything eligible was identity-failed (and settled); re-evaluate in case more remain.
      if (settledIdentityFailure) this.nudge();
      return;
    }

    this.active = map;
    this.host.sendBatch(chunk);
  }

  /** Route one unit's `MutationResponse` (only ever called for a requestId in the active chunk). */
  onResponse(msg: MutationResponse): void {
    const active = this.active;
    const entry = active?.get(msg.requestId);
    if (!active || !entry) return;

    if (msg.success) {
      active.delete(msg.requestId);
      const value = this.resolveResponseValue(msg);
      this.host.settleApplied(msg.requestId, value);
      this.onForwardProgress();
      return;
    }

    if (msg.code !== undefined) {
      // Coded (terminal, server-recorded) failure.
      if (this.poisonPolicy === "pause") {
        this.paused = true;
        console.error(
          `[stackbase] outbox drain PAUSED on a coded failure of "${entry.udfPath}" (${msg.code}); ` +
            `poisonPolicy="pause" — the queue is halted until resumed`,
        );
        this.onPause?.({ requestId: msg.requestId, udfPath: entry.udfPath, code: msg.code });
        // Halt: leave the poisoned entry (and the rest of the chunk) queued, revert to re-sendable.
        this.revertActive();
        return;
      }
      // Skip-and-record (default): settle terminally and CONTINUE (the server already recorded it).
      active.delete(msg.requestId);
      this.host.settleTerminal(msg.requestId, msg.code, `mutation "${entry.udfPath}" failed`);
      this.onForwardProgress();
      return;
    }

    // Codeless (transient/infra) failure → the server STOPPED the batch here: this unit and every
    // unit after it (which got NO response) stay queued and re-send after a backoff, FROM this unit.
    this.transientAttempts++;
    this.revertActive();
    const delay = this.backoffMs(this.transientAttempts);
    this.backoffTimer = setTimeout(() => {
      this.backoffTimer = undefined;
      void this.maybeDrainNext();
    }, delay);
    (this.backoffTimer as { unref?: () => void }).unref?.();
  }

  private resolveResponseValue(msg: Extract<MutationResponse, { success: true }>): Value | null {
    if (msg.valueMissing) return null;
    return msg.value !== undefined ? jsonToConvex(msg.value as JSONValue) : null;
  }

  /** A unit settled (applied or coded-terminal): if the chunk is now empty, advance to the next. */
  private onForwardProgress(): void {
    this.transientAttempts = 0;
    if (this.active && this.active.size === 0) {
      this.active = null;
      this.nudge();
    }
  }

  /** Revert every still-in-flight entry of the active chunk to `unsent` (re-sendable) and clear the
   *  chunk — used by the transient-stop and pause paths. The units that got no response are exactly
   *  those still in `active`. */
  private revertActive(): void {
    if (!this.active) return;
    for (const entry of this.active.values()) this.host.setStatus(entry, "unsent");
    this.active = null;
  }
}
