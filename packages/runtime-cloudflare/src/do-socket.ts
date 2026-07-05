/**
 * Adapt a hibernatable Durable Object `WebSocket` to the engine's abstract `SyncWebSocket`.
 *
 * DELIBERATELY NO `ping` (decision 6 / §8.1): the engine's `SessionHeartbeatController` is exempt for
 * a socket that omits `ping` (the loopback exemption). On a DO, an app-level `socket.ping` would WAKE
 * the hibernated object on every beat, destroying scale-to-zero — so keepalive moves to the
 * runtime-level `setWebSocketAutoResponse` (a ping/pong workerd answers WITHOUT waking the DO). By
 * not exposing `ping` here the heartbeat is disarmed by construction; the runtime is ALSO booted with
 * `disableSyncBackgroundTimers: true` as belt-and-suspenders (and to disarm the flush sweep).
 */
import type { SyncWebSocket } from "@helipod/sync";
import type { DoWebSocketLike } from "./cf-types";

export function doSyncSocket(ws: DoWebSocketLike): SyncWebSocket {
  return {
    send: (data) => ws.send(data),
    get bufferedAmount() {
      // A DO WebSocket exposes `bufferedAmount`; if a stand-in omits it, treat as 0 (never
      // backpressured) — correct for a fake, and a real DO always provides it.
      return ws.bufferedAmount ?? 0;
    },
    close: () => ws.close(),
    // No `ping` — see the module doc. The engine's heartbeat controller no-ops without it.
  };
}
