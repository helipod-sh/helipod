/**
 * In-memory loopback transport. A `LoopbackConnection` is the client end of an in-process
 * "WebSocket": `send` delivers a client message straight to the sync handler, and the
 * handler's server-side socket delivers messages straight back to the connection's
 * listeners. No sockets, no serialization-over-the-wire — but the EXACT same `SyncWebSocket`
 * the handler talks to, so a real WebSocket transport drops in unchanged at Tier 2.
 */
import type { SyncWebSocket } from "@helipod/sync";
import { parseClientMessage, type ClientMessage, type ServerMessage } from "@helipod/sync";

export type ServerMessageListener = (msg: ServerMessage) => void;

export interface LoopbackConnection {
  readonly sessionId: string;
  /** Client → server. Resolves once the handler has finished processing (loopback is synchronous). */
  send(message: ClientMessage | string): Promise<void>;
  /** Register a server → client listener; returns an unsubscribe. */
  onMessage(listener: ServerMessageListener): () => void;
  close(): void;
}

/** Server-side socket the handler sends through; forwards to the connection's listeners. */
class LoopbackServerSocket implements SyncWebSocket {
  readonly bufferedAmount = 0;
  private readonly listeners = new Set<ServerMessageListener>();
  private open = true;

  send(data: string): void {
    if (!this.open) return;
    const msg = JSON.parse(data) as ServerMessage;
    for (const listener of this.listeners) listener(msg);
  }

  close(): void {
    this.open = false;
  }

  addListener(listener: ServerMessageListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

export interface LoopbackHandler {
  connect(sessionId: string, socket: SyncWebSocket): void;
  disconnect(sessionId: string): void;
  handleMessage(sessionId: string, raw: string): Promise<void>;
}

export function createLoopbackConnection(handler: LoopbackHandler, sessionId: string): LoopbackConnection {
  const socket = new LoopbackServerSocket();
  handler.connect(sessionId, socket);

  return {
    sessionId,
    async send(message: ClientMessage | string): Promise<void> {
      const raw = typeof message === "string" ? message : JSON.stringify(message);
      // Validate shape eagerly so malformed client messages fail at the call site.
      parseClientMessage(raw);
      await handler.handleMessage(sessionId, raw);
    },
    onMessage(listener: ServerMessageListener): () => void {
      return socket.addListener(listener);
    },
    close(): void {
      socket.close();
      handler.disconnect(sessionId);
    },
  };
}
