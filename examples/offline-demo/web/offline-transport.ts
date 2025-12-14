/**
 * A demo-local "go offline" switch, built entirely on the PUBLIC `ClientTransport` seam — no
 * client-package changes. Offline = close and discard the inner `webSocketTransport` (its
 * `close()` is terminal and it would otherwise auto-reconnect); online = construct a fresh inner
 * and fire `onReopen`, so the client runs its normal reconnect sequence (SetAuth replay,
 * resubscribe every live query, the outbox `Connect` handshake → FIFO drain). Frames sent while
 * offline are dropped — the reopen sequence rebuilds the whole session from client state, which
 * is exactly how the real transport treats a down period.
 *
 * The flag persists in sessionStorage so a reload while "offline" STAYS offline — per-tab, so
 * going offline in one tab never forces a fresh tab offline — that is what makes the durable
 * outbox's reload-survival visible without a Service Worker.
 */
import { webSocketTransport, type ClientTransport } from "@stackbase/client";

type OutboundMessage = Parameters<ClientTransport["send"]>[0];
type InboundListener = Parameters<ClientTransport["onMessage"]>[0];

export interface OfflineToggleTransport extends ClientTransport {
  setOffline(offline: boolean): void;
  isOffline(): boolean;
  /** Fires with the new flag on every flip — drives the header toggle/badge. */
  onStateChange(listener: (offline: boolean) => void): () => void;
}

const STORAGE_KEY = "packlist:offline";

type FlagStorage = { getItem(k: string): string | null; setItem(k: string, v: string): void };

export function offlineToggleTransport(
  url: string,
  makeInner: (url: string) => ClientTransport = webSocketTransport,
  storage: FlagStorage | undefined = typeof sessionStorage === "undefined" ? undefined : sessionStorage,
): OfflineToggleTransport {
  // Stable listener sets: the client subscribes ONCE (to the wrapper); inner transports come and go.
  const messageListeners = new Set<InboundListener>();
  const closeListeners = new Set<() => void>();
  const reopenListeners = new Set<() => void>();
  const stateListeners = new Set<(offline: boolean) => void>();

  let offline = storage?.getItem(STORAGE_KEY) === "1";
  let terminated = false;
  let inner: ClientTransport | undefined;
  let unwire: Array<() => void> = [];

  function connectInner(): void {
    const t = makeInner(url);
    inner = t;
    unwire = [
      t.onMessage((msg) => {
        for (const l of messageListeners) l(msg);
      }),
      t.onClose(() => {
        for (const l of closeListeners) l();
      }),
      // The inner reconnects BY ITSELF during an online period (real network blips) — forward those.
      t.onReopen?.(() => {
        for (const l of reopenListeners) l();
      }) ?? (() => {}),
    ];
  }

  function dropInner(): void {
    // Unwire FIRST: the inner's own (possibly async) close event must not double-fire the
    // listeners — `setOffline(true)` fires them synchronously itself, exactly once.
    for (const u of unwire) u();
    unwire = [];
    const t = inner;
    inner = undefined;
    t?.close();
  }

  if (!offline) {
    connectInner();
  } else {
    // The real transport announces a failed first connection attempt via onClose (its
    // hadFailedConnect contract) — the client needs `closed = true` so the outbox handshake
    // re-arms on the eventual reopen instead of latching a Connect that was never sent.
    // Async because the client subscribes AFTER construction.
    queueMicrotask(() => {
      if (!terminated && offline) for (const l of closeListeners) l();
    });
  }

  return {
    send(message: OutboundMessage): void {
      if (!terminated && !offline) inner?.send(message);
    },
    onMessage(listener) {
      messageListeners.add(listener);
      return () => messageListeners.delete(listener);
    },
    onClose(listener) {
      closeListeners.add(listener);
      return () => closeListeners.delete(listener);
    },
    onReopen(listener) {
      reopenListeners.add(listener);
      return () => reopenListeners.delete(listener);
    },
    close(): void {
      if (terminated) return;
      terminated = true;
      dropInner();
      for (const l of closeListeners) l();
    },
    setOffline(next: boolean): void {
      if (terminated || offline === next) return;
      offline = next;
      storage?.setItem(STORAGE_KEY, next ? "1" : "0");
      if (next) {
        dropInner();
        for (const l of closeListeners) l(); // the client runs its close disposition NOW
      } else {
        connectInner();
        // The fresh socket hasn't opened yet, but webSocketTransport buffers pre-first-open
        // frames — firing reopen immediately lets the client rebuild the session and every
        // frame is delivered the moment the socket opens.
        for (const l of reopenListeners) l();
      }
      for (const l of stateListeners) l(offline);
    },
    isOffline(): boolean {
      return offline;
    },
    onStateChange(listener) {
      stateListeners.add(listener);
      return () => stateListeners.delete(listener);
    },
  };
}
