/* Stackbase Enterprise. Licensed under the Stackbase Commercial License — see ee/LICENSE. */
/**
 * Fleet writer liveness monitor (Task 4, C4). Runs ONLY while a node is the writer. Its job: notice
 * when this node has lost its exclusive writer lease and exit the process so it can rejoin the fleet
 * as a fresh sync node (exit-and-rejoin) — rather than lingering as a zombie writer that believes it
 * still owns the lock while some other node has taken over.
 *
 * Two independent loss signals feed it:
 *
 *  - `connectionLost()` — DEFINITIVE. The advisory lock lives on `NodePgClient`'s single pinned
 *    connection, which never reconnects (see `NodePgClient.ensure()`); if that connection closes or
 *    errors, the session-level `pg_advisory_lock` is released by Postgres the instant the backend
 *    goes away. So a closed pinned connection == lease definitely lost → exit immediately.
 *
 *  - `probe()` misses — a BACKSTOP for a silently-wedged connection that isn't emitting error/end
 *    events (e.g. a half-open TCP connection). The probe is a caller-supplied liveness round-trip
 *    (`() => client.query("SELECT 1")`); it must NEVER be `pg_try_advisory_lock` — that is re-entrant
 *    on the session already holding the lock and would leak a lock count on every probe. We tolerate
 *    `maxMisses` consecutive failures (transient blips) and exit on the NEXT one; any success resets
 *    the counter. Each probe is itself bounded by `probeTimeoutMs` (default `probeMs`) via
 *    `Promise.race` — a silently-wedged connection (e.g. a half-open TCP socket) can leave
 *    `SELECT 1` hanging forever with no error/end event; without a per-probe timeout `inFlight`
 *    would stay true and every subsequent tick would early-return, so misses would never accrue and
 *    this exact backstop would never fire. A timed-out probe counts as a miss; if the underlying
 *    query later settles anyway, that late settlement is discarded (`Promise.race` only ever acts on
 *    whichever of the probe/timeout settles first) — no reset, no double-count. `inFlight` still
 *    clears once the race settles, so the next tick starts its own fresh attempt regardless of what
 *    the abandoned probe call eventually does.
 *
 * `onExit` is injected: production passes `(reason) => { console.error(...); process.exit(1); }`;
 * tests pass a spy. It fires AT MOST ONCE — the first of (connectionLost, probe-exhaustion) wins,
 * and `stop()` (graceful shutdown / promotion hand-off) halts everything so nothing fires after.
 */

export interface LeaseMonitorDeps {
  /** Liveness round-trip against the pinned writer connection. MUST be a plain query (e.g.
   *  `SELECT 1`), NEVER `pg_try_advisory_lock` (re-entrant → leaks a lock count per probe). */
  probe: () => Promise<void>;
  /** Fired at most once when the lease is deemed lost. Production: `console.error` + `process.exit(1)`. */
  onExit: (reason: string) => void;
  /** Interval between probes. Default 5000ms. */
  probeMs?: number;
  /** Consecutive probe failures tolerated before exit — the NEXT (maxMisses+1-th) miss exits. Default 3. */
  maxMisses?: number;
  /** Per-probe timeout — a probe that hasn't settled by this point counts as a miss (the wedged
   *  connection is abandoned, not awaited further). Default `probeMs`. */
  probeTimeoutMs?: number;
}

const DEFAULT_PROBE_MS = 5000;
const DEFAULT_MAX_MISSES = 3;

export class LeaseMonitor {
  private readonly probe: () => Promise<void>;
  private readonly onExit: (reason: string) => void;
  private readonly probeMs: number;
  private readonly maxMisses: number;
  private readonly probeTimeoutMs: number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private misses = 0;
  private inFlight = false;
  private exited = false;
  private stopped = false;

  constructor(deps: LeaseMonitorDeps) {
    this.probe = deps.probe;
    this.onExit = deps.onExit;
    this.probeMs = deps.probeMs ?? DEFAULT_PROBE_MS;
    this.maxMisses = deps.maxMisses ?? DEFAULT_MAX_MISSES;
    this.probeTimeoutMs = deps.probeTimeoutMs ?? this.probeMs;
  }

  /** Begin probing every `probeMs`. Idempotent; a no-op once stopped or after exit. */
  start(): void {
    if (this.timer !== null || this.stopped || this.exited) return;
    this.timer = setInterval(() => void this.tick(), this.probeMs);
  }

  private async tick(): Promise<void> {
    // Skip if we're shutting down, already exited, or a prior probe is still outstanding (never let
    // slow probes stack up — a wedged connection could leave one hanging indefinitely).
    if (this.stopped || this.exited || this.inFlight) return;
    this.inFlight = true;
    let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
    try {
      // Bound the probe with `probeTimeoutMs` via Promise.race: whichever of (probe settles, timeout
      // fires) happens first wins the race outcome; the loser is simply never looked at again. If the
      // probe later resolves or rejects after the timeout already won, `Promise.race`'s internal
      // resolve/reject on that already-settled race is a no-op — nothing in this function observes
      // it, so it cannot reset the miss counter or double-count as a success.
      const probeSettled = Promise.resolve()
        .then(() => this.probe())
        .then(() => "success" as const);
      const timedOutMarker = new Promise<"timeout">((resolve) => {
        timeoutHandle = setTimeout(() => resolve("timeout"), this.probeTimeoutMs);
      });
      const result = await Promise.race([probeSettled, timedOutMarker]);
      if (this.stopped || this.exited) return;
      if (result === "timeout") {
        this.recordMiss("timed out");
      } else {
        this.misses = 0; // any success resets the streak
      }
    } catch {
      if (this.stopped || this.exited) return;
      this.recordMiss("failed");
    } finally {
      if (timeoutHandle !== null) clearTimeout(timeoutHandle);
      this.inFlight = false;
    }
  }

  private recordMiss(mode: "timed out" | "failed"): void {
    this.misses += 1;
    if (this.misses > this.maxMisses) {
      this.fireExit(`writer lease probe ${mode} (${this.misses} consecutive times)`);
    }
  }

  /** DEFINITIVE lease loss (pinned connection closed/errored) → exit immediately. */
  connectionLost(): void {
    if (this.stopped || this.exited) return;
    this.fireExit("writer lease lost: database connection closed");
  }

  private fireExit(reason: string): void {
    if (this.exited) return;
    this.exited = true;
    this.clearTimer();
    this.onExit(reason);
  }

  /** Halt all probing and disarm exit — graceful shutdown or promotion hand-off. */
  stop(): void {
    this.stopped = true;
    this.clearTimer();
  }

  private clearTimer(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}
