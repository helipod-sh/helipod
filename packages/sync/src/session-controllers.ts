/**
 * Per-session flow-control controllers — the server half of Foundation seam 6 (fleet hardening).
 *
 * A reactive fan-out can push faster than a client can read. Two failure modes matter:
 *  - **A slow reader** whose OS send buffer fills — without a cap, queued frames grow unbounded and
 *    exhaust server memory. `SessionBackpressureController` bounds that: it becomes the SINGLE
 *    outbound chokepoint for a session, sending straight through when the socket has room, queueing
 *    (up to a frame cap) when it doesn't, and DROPPING frames once the queue is full or the client
 *    has been backpressured for too long. Dropped frames are safe — the client resyncs from its last
 *    acknowledged version — so we favour dropping over stalling the whole node. `MutationResponse`/
 *    `ActionResponse` frames are the one exception: they carry `undroppable: true` and are never
 *    dropped by cap or timeout (they only queue behind the cap; the queue's timeout-abandon path
 *    also spares them) — a dropped response has no version bracket and no retransmit, so losing one
 *    would strand a client-side mutation as permanently "inflight" instead of self-healing.
 *  - **A dead-but-not-closed connection** (half-open TCP: the peer vanished, no FIN/RST). Nothing
 *    reads, nothing errors; the session lingers forever holding subscriptions. `SessionHeartbeat-
 *    Controller` reaps it via transport-level ping/pong liveness — NOT inbound-message silence (an
 *    idle-but-healthy client sends nothing yet must never be reaped).
 *
 * Both are transport-agnostic: they talk only to `SyncWebSocket`. A socket that cannot ping (the
 * in-process loopback — `bufferedAmount` is always 0, there is no peer to die) is transparently
 * exempt from heartbeat, and its sends always pass straight through the backpressure controller, so
 * loopback behaviour is byte-identical to before these controllers existed.
 */
import type { SyncWebSocket } from "./handler";

export interface BackpressureOptions {
  /** Above this `bufferedAmount`, frames queue instead of sending. Default 1 MiB. */
  highWaterBytes?: number;
  /** Queue depth past which new frames are dropped (drop-newest). Default 200. */
  maxQueuedFrames?: number;
  /** Sustained-backpressure duration after which the queue is abandoned to drops. Default 30s. */
  slowClientTimeoutMs?: number;
}

const DEFAULT_HIGH_WATER = 1024 * 1024;
const DEFAULT_MAX_QUEUED = 200;
const DEFAULT_SLOW_CLIENT_MS = 30_000;

/**
 * The single outbound chokepoint for one session. Every server→client frame goes through `send`.
 * A frame is delivered immediately when the socket buffer is below high-water and nothing is
 * already queued; otherwise it queues (FIFO). Once the queue hits `maxQueuedFrames` the newest
 * frame is dropped; once backpressure has been sustained past `slowClientTimeoutMs` the entire
 * queue is abandoned to drops. Drops are counted and warned about exactly once per episode (an
 * episode ends when the session fully drains back to an empty queue with a below-high-water buffer).
 */
/** One queued frame, tagged with whether it may ever be dropped. */
interface QueuedFrame {
  data: string;
  /** True for MutationResponse/ActionResponse — never dropped by cap or by timeout-abandon. */
  undroppable: boolean;
}

export class SessionBackpressureController {
  private readonly highWaterBytes: number;
  private readonly maxQueuedFrames: number;
  private readonly slowClientTimeoutMs: number;
  private readonly queue: QueuedFrame[] = [];
  private _droppedFrames = 0;
  /** Wall-clock ms at which the current backpressure episode began, or null if not backpressured. */
  private backpressureSince: number | null = null;
  /** True once any frame has been dropped in the current episode; resets on full drain. */
  private _droppedThisEpisode = false;

  constructor(
    private readonly socket: SyncWebSocket,
    opts: BackpressureOptions = {},
    private readonly now: () => number = () => Date.now(),
  ) {
    this.highWaterBytes = opts.highWaterBytes ?? DEFAULT_HIGH_WATER;
    this.maxQueuedFrames = opts.maxQueuedFrames ?? DEFAULT_MAX_QUEUED;
    this.slowClientTimeoutMs = opts.slowClientTimeoutMs ?? DEFAULT_SLOW_CLIENT_MS;
  }

  get droppedFrames(): number {
    return this._droppedFrames;
  }

  /** True once anything was dropped since the last fully-drained state (the per-episode warn flag). */
  get droppedThisEpisode(): boolean {
    return this._droppedThisEpisode;
  }

  /**
   * The ONLY way frames leave a session. Sends now, queues, or drops per the class contract.
   * `undroppable` (default false) exempts a frame from BOTH drop paths below — the cap check
   * and the sustained-backpressure abandon — so it only ever queues or sends, never vanishes.
   */
  send(data: string, undroppable = false): void {
    // Drain first so a recovered client immediately gets both its backlog and this frame in order.
    this.flush();
    if (this.queue.length === 0 && this.socket.bufferedAmount < this.highWaterBytes) {
      this.socket.send(data);
      return;
    }
    if (undroppable) {
      this.queue.push({ data, undroppable: true });
      return;
    }
    // Backpressured: mark the episode start on first entry.
    if (this.backpressureSince === null) this.backpressureSince = this.now();
    // Give up on a client that has been backpressured too long — abandon the whole backlog + this frame
    // (undroppable frames already queued survive; see `dropQueue`).
    if (this.now() - this.backpressureSince >= this.slowClientTimeoutMs) {
      this.dropQueue();
      this.countDrop();
      return;
    }
    // Bounded queue: past the cap, drop the newest (this) frame — the client resyncs regardless.
    if (this.queue.length >= this.maxQueuedFrames) {
      this.countDrop();
      return;
    }
    this.queue.push({ data, undroppable: false });
  }

  /**
   * Deliver as many queued frames as the socket buffer will take. Called before each send and on a
   * periodic sweep, so a client that recovers (or goes terminally slow) without new traffic still
   * gets its queue drained (or abandoned). Resets the episode once fully drained.
   */
  flush(): void {
    while (this.queue.length > 0 && this.socket.bufferedAmount < this.highWaterBytes) {
      this.socket.send((this.queue.shift() as QueuedFrame).data);
    }
    if (this.queue.length === 0 && this.socket.bufferedAmount < this.highWaterBytes) {
      // Fully caught up — end the episode so a later re-entry warns afresh.
      this.backpressureSince = null;
      this._droppedThisEpisode = false;
      return;
    }
    // Still backpressured (buffer high and/or frames stuck in the queue).
    if (this.backpressureSince === null) this.backpressureSince = this.now();
    if (this.queue.length > 0 && this.now() - this.backpressureSince >= this.slowClientTimeoutMs) {
      this.dropQueue();
    }
  }

  /** Abandon the queue to drops — EXCEPT undroppable frames, which stay queued for a later flush. */
  private dropQueue(): void {
    const survivors = this.queue.filter((f) => f.undroppable);
    const droppedCount = this.queue.length - survivors.length;
    if (droppedCount === 0) return;
    this._droppedFrames += droppedCount;
    this.queue.length = 0;
    this.queue.push(...survivors);
    this.markEpisodeDropped();
  }

  private countDrop(): void {
    this._droppedFrames += 1;
    this.markEpisodeDropped();
  }

  private markEpisodeDropped(): void {
    if (this._droppedThisEpisode) return;
    this._droppedThisEpisode = true;
    // Exactly one warn per episode — re-warns only after a full drain resets the flag.
    console.warn(`[sync] backpressure: dropping frames for slow client (total dropped=${this._droppedFrames})`);
  }
}

export interface HeartbeatOptions {
  /** How often to send a transport-level ping. Default 30s. */
  pingIntervalMs?: number;
  /** Consecutive unanswered pings before the session is declared dead. Default 2. */
  missedPongLimit?: number;
}

const DEFAULT_PING_INTERVAL_MS = 30_000;
const DEFAULT_MISSED_PONG_LIMIT = 2;

/**
 * Transport-level ping/pong liveness for one session. Every `pingIntervalMs` it sends a ping and
 * increments a miss counter; a pong (or any inbound activity via `noteActivity`) resets it to zero.
 * After `missedPongLimit` consecutive unanswered pings the session is declared dead and `onDead`
 * fires exactly once. A socket without a `ping` capability (loopback) is exempt: `start()` is a
 * no-op, so its session is never reaped.
 */
export class SessionHeartbeatController {
  private readonly pingIntervalMs: number;
  private readonly missedPongLimit: number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private missed = 0;
  private dead = false;

  constructor(
    private readonly socket: SyncWebSocket,
    private readonly onDead: () => void,
    opts: HeartbeatOptions = {},
  ) {
    this.pingIntervalMs = opts.pingIntervalMs ?? DEFAULT_PING_INTERVAL_MS;
    this.missedPongLimit = opts.missedPongLimit ?? DEFAULT_MISSED_PONG_LIMIT;
  }

  /** Begin pinging. No-op when the socket cannot ping (loopback exemption) or already started. */
  start(): void {
    if (!this.socket.ping) return;
    if (this.timer !== null) return;
    this.missed = 0;
    this.dead = false;
    this.timer = setInterval(() => this.tick(), this.pingIntervalMs);
  }

  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Any inbound message is liveness credit — resets the consecutive-miss counter. */
  noteActivity(): void {
    this.missed = 0;
  }

  private tick(): void {
    // Register a pong handler that resets the miss counter, then send the ping. A ping counts as a
    // miss the instant it's outstanding; the pong (arriving before the next tick) cancels it.
    this.socket.ping?.(() => {
      this.missed = 0;
    });
    this.missed += 1;
    if (this.missed >= this.missedPongLimit) this.fireDead();
  }

  private fireDead(): void {
    if (this.dead) return;
    this.dead = true;
    this.stop();
    this.onDead();
  }
}
