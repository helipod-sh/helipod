/**
 * Transports carry the sync protocol between the client and the engine. The client logic is
 * transport-agnostic; pick `loopbackTransport` (in-process / embedded) or `webSocketTransport`
 * (over the network) — the same `StackbaseClient` runs on either.
 */
import type { ClientMessage, ServerMessage } from "@stackbase/sync";

export interface ClientTransport {
  send(message: ClientMessage): void;
  onMessage(listener: (msg: ServerMessage) => void): () => void;
  /** Fires when the transport closes or errors (so the client can fail pending work / resync). */
  onClose(listener: () => void): () => void;
  /**
   * Optional (T6): fires once per successful RECONNECT — never for the initial connect. A
   * transport that never reconnects (e.g. `loopbackTransport`) simply doesn't implement this; the
   * client treats it as absent (`transport.onReopen?.(...)`). Implemented by `webSocketTransport`
   * so the client can replay `SetAuth`, resubscribe every live query, and flush unsent mutations
   * against the fresh session.
   */
  onReopen?(listener: () => void): () => void;
  close(): void;
}

/** Anything shaped like an embedded loopback connection. */
export interface LoopbackLike {
  send(message: ClientMessage): unknown;
  onMessage(listener: (msg: ServerMessage) => void): () => void;
  close(): void;
}

export function loopbackTransport(connection: LoopbackLike): ClientTransport {
  const closeListeners = new Set<() => void>();
  let closed = false;
  return {
    send(message) {
      if (!closed) void Promise.resolve(connection.send(message));
    },
    onMessage(listener) {
      return connection.onMessage(listener);
    },
    onClose(listener) {
      closeListeners.add(listener);
      return () => closeListeners.delete(listener);
    },
    close() {
      if (closed) return;
      closed = true;
      connection.close();
      for (const l of closeListeners) l();
    },
  };
}

export interface WebSocketTransportOptions {
  /** Reconnect automatically after a disconnect, with exponential backoff + jitter. Default `true`
   *  — `{ reconnect: false }` restores the old terminal-on-close behavior verbatim. */
  reconnect?: boolean;
  /** Base delay before the first reconnect attempt; doubles each subsequent attempt. Default `300`. */
  initialBackoffMs?: number;
  /** Reconnect backoff cap. Default `30_000` (~30s). */
  maxBackoffMs?: number;
  /** @internal test seam — how to construct the underlying `WebSocket`. Defaults to `new WebSocket(url)`. */
  createWebSocket?: (url: string) => WebSocket;
}

/**
 * Equal-jitter exponential backoff: half the exponential delay, plus up to another half at random
 * — never zero (avoids a thundering-herd reconnect storm) and monotone-capped at `maxBackoffMs`.
 * Exported so the schedule itself is directly unit-testable without simulating a WebSocket.
 */
export function reconnectDelayMs(attempt: number, initialBackoffMs: number, maxBackoffMs: number, rand: () => number = Math.random): number {
  const exp = Math.min(maxBackoffMs, initialBackoffMs * 2 ** attempt);
  const half = exp / 2;
  return half + rand() * half;
}

/**
 * WebSocket transport over the platform `WebSocket` (browsers, Node 22+, Bun). Reconnects by
 * default on disconnect — exponential backoff + jitter, capped ~30s (`{ reconnect: false }` opts
 * out, preserving the old terminal-on-close contract exactly). `onClose` fires once per disconnect
 * (so the client can run its close disposition — reject inflight, retain unsent, drop layers);
 * `onReopen` fires once per successful RECONNECT, never for the very first connect, so the client
 * knows when to replay `SetAuth`, resubscribe, and flush unsent mutations against the fresh session.
 */
export function webSocketTransport(url: string, opts: WebSocketTransportOptions = {}): ClientTransport {
  const reconnect = opts.reconnect ?? true;
  const initialBackoffMs = opts.initialBackoffMs ?? 300;
  const maxBackoffMs = opts.maxBackoffMs ?? 30_000;
  const createWebSocket = opts.createWebSocket ?? ((u: string) => new WebSocket(u));

  const listeners = new Set<(msg: ServerMessage) => void>();
  const closeListeners = new Set<() => void>();
  const reopenListeners = new Set<() => void>();
  // Only buffers frames sent before the transport's very FIRST socket has ever opened (normal
  // connection-establishment latency), or — with `{reconnect: false}` — a terminal transport's
  // manual-first-open window. It must NEVER accumulate frames sent during a down period AFTER a
  // socket has already opened once: see the `send()` guard below for why.
  const queue: ClientMessage[] = [];

  let ws: WebSocket;
  let open = false;
  let everOpened = false; // true once ANY socket has opened — makes the next open a "reopen"
  let announced = false; // a close was already told to listeners since the last open
  let terminated = false; // `.close()` was called, or reconnect is disabled and the socket died
  let attempt = 0;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;

  const clearReconnectTimer = (): void => {
    if (reconnectTimer !== undefined) {
      clearTimeout(reconnectTimer);
      reconnectTimer = undefined;
    }
  };

  const announceClose = (): void => {
    if (announced) return;
    announced = true;
    // Belt-and-suspenders: `send()` below already refuses to enqueue once `everOpened && reconnect`,
    // so this is normally a no-op by the time it runs. It stays as the backstop for the one case
    // where the queue can legitimately hold something at this point — the very first connection
    // attempt closing/erroring before ever opening — so nothing stale lingers into a later cycle.
    queue.length = 0;
    for (const l of closeListeners) l();
  };

  const handleDisconnect = (): void => {
    open = false;
    announceClose();
    if (terminated || !reconnect) {
      terminated = true;
      return;
    }
    const delay = reconnectDelayMs(attempt, initialBackoffMs, maxBackoffMs);
    attempt++;
    clearReconnectTimer();
    reconnectTimer = setTimeout(() => {
      reconnectTimer = undefined;
      if (terminated) return;
      ws = createWebSocket(url);
      wire(ws);
    }, delay);
    (reconnectTimer as { unref?: () => void }).unref?.();
  };

  function wire(socket: WebSocket): void {
    socket.addEventListener("open", () => {
      if (terminated) return;
      open = true;
      announced = false;
      attempt = 0;
      for (const m of queue) socket.send(JSON.stringify(m));
      queue.length = 0;
      if (everOpened) {
        for (const l of reopenListeners) l();
      }
      everOpened = true;
    });
    socket.addEventListener("message", (ev: MessageEvent) => {
      if (typeof ev.data !== "string") return;
      const msg = JSON.parse(ev.data) as ServerMessage;
      for (const l of listeners) l(msg);
    });
    socket.addEventListener("close", handleDisconnect);
    socket.addEventListener("error", handleDisconnect);
  }

  ws = createWebSocket(url);
  wire(ws);

  return {
    send(message) {
      if (terminated) return; // never throw after a terminal close
      if (open) {
        ws.send(JSON.stringify(message));
        return;
      }
      // THE RULE: once a socket has opened at least once and reconnect is enabled, a NEW session is
      // reconstructed ENTIRELY from client state by the reopen sequence (SetAuth replay,
      // resubscribe-from-live-queries, unsent-mutation flush) — see `client.ts#onTransportReopened`.
      // A frame sent here, while down between sessions, is stale by definition: whatever it
      // represents (a subscribe/unsubscribe against the live-query map, a SetAuth token, an
      // ephemeral publish) is either re-derived by that sequence or is correctly lossy (ephemeral).
      // Queueing it would let it land on the fresh session ahead of — and duplicating/pre-empting —
      // the reopen sequence, so it's dropped instead of buffered. Pre-first-open buffering (normal
      // connection latency) and `{reconnect: false}`'s terminal buffering are untouched: this branch
      // only applies once `everOpened && reconnect`.
      if (everOpened && reconnect) return;
      queue.push(message);
    },
    onMessage(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    onClose(listener) {
      closeListeners.add(listener);
      return () => closeListeners.delete(listener);
    },
    onReopen(listener) {
      reopenListeners.add(listener);
      return () => reopenListeners.delete(listener);
    },
    close() {
      terminated = true;
      clearReconnectTimer();
      announceClose(); // synchronous, regardless of whether the underlying socket already fired "close"
      try {
        ws.close();
      } catch {
        /* already closing */
      }
    },
  };
}
