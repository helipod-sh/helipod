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

/** WebSocket transport over the platform `WebSocket` (browsers, Node 22+, Bun). */
export function webSocketTransport(url: string): ClientTransport {
  const ws = new WebSocket(url);
  const listeners = new Set<(msg: ServerMessage) => void>();
  const closeListeners = new Set<() => void>();
  const queue: ClientMessage[] = []; // only buffers pre-OPEN; flushed on open, cleared on close
  let open = false;
  let closed = false;

  const fireClose = (): void => {
    if (closed) return;
    closed = true;
    queue.length = 0;
    for (const l of closeListeners) l();
  };

  ws.addEventListener("open", () => {
    open = true;
    for (const m of queue) ws.send(JSON.stringify(m));
    queue.length = 0;
  });
  ws.addEventListener("message", (ev: MessageEvent) => {
    if (typeof ev.data !== "string") return;
    const msg = JSON.parse(ev.data) as ServerMessage;
    for (const l of listeners) l(msg);
  });
  ws.addEventListener("close", fireClose);
  ws.addEventListener("error", fireClose);

  return {
    send(message) {
      if (closed) return; // never throw after close
      if (open) ws.send(JSON.stringify(message));
      else queue.push(message);
    },
    onMessage(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    onClose(listener) {
      closeListeners.add(listener);
      return () => closeListeners.delete(listener);
    },
    close() {
      if (!closed) {
        try {
          ws.close();
        } catch {
          /* already closing */
        }
      }
      fireClose();
    },
  };
}
