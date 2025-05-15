/**
 * Transports carry the sync protocol between the client and the engine. The client logic is
 * transport-agnostic; pick `loopbackTransport` (in-process / embedded) or `webSocketTransport`
 * (over the network) — the same `StackbaseClient` runs on either.
 */
import type { ClientMessage, ServerMessage } from "@stackbase/sync";

export interface ClientTransport {
  send(message: ClientMessage): void;
  onMessage(listener: (msg: ServerMessage) => void): () => void;
  close(): void;
}

/** Anything shaped like an embedded loopback connection. */
export interface LoopbackLike {
  send(message: ClientMessage): unknown;
  onMessage(listener: (msg: ServerMessage) => void): () => void;
  close(): void;
}

export function loopbackTransport(connection: LoopbackLike): ClientTransport {
  return {
    send(message) {
      void Promise.resolve(connection.send(message));
    },
    onMessage(listener) {
      return connection.onMessage(listener);
    },
    close() {
      connection.close();
    },
  };
}

/** WebSocket transport over the platform `WebSocket` (browsers, Node 22+, Bun). */
export function webSocketTransport(url: string): ClientTransport {
  const ws = new WebSocket(url);
  const listeners = new Set<(msg: ServerMessage) => void>();
  const queue: ClientMessage[] = [];
  let open = false;

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

  return {
    send(message) {
      if (open) ws.send(JSON.stringify(message));
      else queue.push(message);
    },
    onMessage(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    close() {
      ws.close();
    },
  };
}
