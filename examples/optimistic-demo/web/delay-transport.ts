/**
 * A latency-injecting wrapper on the PUBLIC `ClientTransport` seam — the demo's device for
 * making optimistic updates visible. Only outbound `Mutation` frames are delayed: subscriptions
 * and every inbound frame stay instant, so queries are live and only WRITES feel the latency —
 * which is exactly where optimistic UI lives.
 *
 * FIFO is load-bearing: mutation order matters to the engine, so a frame is scheduled at
 * `max(now + delay, lastScheduledFireAt)` — lowering the slider mid-flight can never let a
 * later mutation overtake an earlier one.
 */
import { webSocketTransport, type ClientTransport } from "@stackbase/client";

type OutboundMessage = Parameters<ClientTransport["send"]>[0];

export interface DelayTransport extends ClientTransport {
  setDelay(ms: number): void;
  getDelay(): number;
}

export function delayTransport(
  url: string,
  makeInner: (url: string) => ClientTransport = webSocketTransport,
): DelayTransport {
  const inner = makeInner(url);
  let delayMs = 0;
  let closed = false;
  let lastScheduledFireAt = 0;
  const pending = new Set<ReturnType<typeof setTimeout>>();

  return {
    send(message: OutboundMessage): void {
      if (closed) return;
      const isMutation = (message as { type?: string }).type === "Mutation";
      const now = Date.now();
      const fireAt = isMutation ? Math.max(now + delayMs, lastScheduledFireAt) : now;
      if (fireAt <= now && pending.size === 0) {
        inner.send(message);
        return;
      }
      if (isMutation) lastScheduledFireAt = fireAt;
      if (!isMutation) {
        // Non-mutation frames never queue behind mutations — pass through now.
        inner.send(message);
        return;
      }
      const timer = setTimeout(() => {
        pending.delete(timer);
        if (!closed) inner.send(message);
      }, fireAt - now);
      pending.add(timer);
    },
    onMessage: (l) => inner.onMessage(l),
    onClose: (l) => inner.onClose(l),
    onReopen: (l) => inner.onReopen?.(l) ?? (() => {}),
    close(): void {
      if (closed) return;
      closed = true;
      for (const t of pending) clearTimeout(t);
      pending.clear();
      inner.close();
    },
    setDelay(ms: number): void {
      delayMs = ms;
    },
    getDelay(): number {
      return delayMs;
    },
  };
}
