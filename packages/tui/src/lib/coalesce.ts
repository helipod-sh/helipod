/**
 * Leading-edge coalescer for the write fan-out.
 *
 * `onCommit` fires once per committed mutation. Wiring it straight to a refresh
 * meant a heavy write burst (say 40 commits/s) triggered 40 recompute-and-redraw
 * cycles per second — real event-loop time stolen from the very requests
 * generating the load, and invisible anyway (no one perceives 40 redraws/s).
 *
 * This fires `fn` immediately on the first event, then suppresses further calls
 * for `waitMs`; if any were suppressed, it fires once more at the end of the
 * window. So a burst of N commits costs at most 2 refreshes per window — the
 * dashboard stays live, but its cost is decoupled from write throughput.
 */
export function coalesce(fn: () => void, waitMs: number): { call: () => void; cancel: () => void } {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let suppressed = false;

  const call = () => {
    if (timer) {
      suppressed = true;
      return;
    }
    fn();
    timer = setTimeout(() => {
      timer = null;
      if (suppressed) {
        suppressed = false;
        call();
      }
    }, waitMs);
  };

  const cancel = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    suppressed = false;
  };

  return { call, cancel };
}
