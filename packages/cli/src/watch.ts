/**
 * A small debounced watch loop. The fs-watch wiring is injected so the debounce/dispatch
 * logic is testable without touching the filesystem.
 */
export type WatchTriggerReason = "initial" | "change";

export interface WatchLoopOptions {
  /** Subscribe to raw change events; return an unsubscribe. */
  subscribe: (onChange: () => void) => () => void;
  /** Called (debounced) to rebuild; reason "initial" fires once up front. */
  onTrigger: (reason: WatchTriggerReason) => void | Promise<void>;
  debounceMs?: number;
  /** Injectable timer for tests. */
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

export interface WatchLoop {
  start(): void;
  stop(): void;
}

export function createWatchLoop(options: WatchLoopOptions): WatchLoop {
  const debounceMs = options.debounceMs ?? 50;
  const setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = options.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  let timer: unknown = null;
  let unsubscribe: (() => void) | null = null;

  const fire = () => {
    timer = null;
    void options.onTrigger("change");
  };

  return {
    start(): void {
      void options.onTrigger("initial");
      unsubscribe = options.subscribe(() => {
        if (timer !== null) clearTimer(timer);
        timer = setTimer(fire, debounceMs);
      });
    },
    stop(): void {
      if (timer !== null) clearTimer(timer);
      unsubscribe?.();
      unsubscribe = null;
    },
  };
}
