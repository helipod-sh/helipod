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
 *    the counter.
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
}

const DEFAULT_PROBE_MS = 5000;
const DEFAULT_MAX_MISSES = 3;

export class LeaseMonitor {
  private readonly probe: () => Promise<void>;
  private readonly onExit: (reason: string) => void;
  private readonly probeMs: number;
  private readonly maxMisses: number;
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
    try {
      await this.probe();
      if (this.stopped || this.exited) return;
      this.misses = 0; // any success resets the streak
    } catch {
      if (this.stopped || this.exited) return;
      this.misses += 1;
      if (this.misses > this.maxMisses) {
        this.fireExit(`writer lease probe failed ${this.misses} consecutive times`);
      }
    } finally {
      this.inFlight = false;
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
