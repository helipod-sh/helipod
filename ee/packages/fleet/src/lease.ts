/* Stackbase Enterprise. Licensed under the Stackbase Commercial License — see ee/LICENSE. */
import type { PgClient, PgRow, PgValue } from "@stackbase/docstore-postgres";

/** The shard this lease coordinates. B1 is single-shard only — every row/read/write below is
 *  pinned to `'default'`; multi-shard routing is B2. */
const SHARD_ID = "default";

/** TTL a fresh acquisition/heartbeat extends `expires_at` by. Matches the LeaseMonitor's 5s probe
 *  cadence with headroom for several missed round-trips before a fencer would consider this node
 *  wedged (D4 — not implemented by this class; a future eviction path reads this column). */
const LEASE_TTL_SECONDS = 15;

/** The current fleet writer lease: which epoch is live and which node holds it. */
export interface LeaseState {
  epoch: bigint;
  writerUrl: string;
}

/** `LeaseManager.read()`'s full row — every `shard_leases` column (Fenced Frontier B1, D2). The
 *  extra columns beyond `LeaseState` are consumed by the D4 eviction/D5 tailer-frontier work; this
 *  class only writes them (frontier_ts/prev_ts advance via the commit-guard SQL installed in
 *  `node.ts`, never through this class directly), so they're returned loosely typed for now. */
export interface LeaseRow extends LeaseState {
  writerAppName: string | null;
  /** Raw Postgres value for the TIMESTAMPTZ column (a `Date` under `NodePgClient`, ISO-ish string
   *  under PGlite) — not a `LeaseManager` client's job to interpret; a heartbeat/fence caller only
   *  cares about row-count effects, not the wall-clock value. */
  expiresAt: unknown;
  frontierTs: bigint;
  prevTs: bigint;
}

export interface LeaseManagerOptions {
  /** URL this node advertises as the writer, recorded into shard_leases on acquire. */
  advertiseUrl: string;
  /** This node's Postgres `application_name` (see `fleetApplicationName`), recorded on acquire so
   *  a D4 eviction fencer can `pg_terminate_backend` the exact wedged holder's connection. */
  applicationName?: string;
  /** Interval between tryAcquire() attempts inside acquireLoop(). Default 2000ms. */
  retryMs?: number;
}

const DEFAULT_RETRY_MS = 2000;

function toBigIntOrZero(v: PgValue | undefined): bigint {
  if (v === null || v === undefined) return 0n;
  return typeof v === "bigint" ? v : BigInt(v as number | string);
}

function rowToLeaseRow(row: PgRow): LeaseRow {
  return {
    epoch: row.epoch as bigint,
    writerUrl: row.writer_url as string,
    writerAppName: (row.writer_app_name as string | null | undefined) ?? null,
    expiresAt: row.expires_at,
    frontierTs: toBigIntOrZero(row.frontier_ts),
    prevTs: toBigIntOrZero(row.prev_ts),
  };
}

/**
 * Coordinates the single-writer lease across a fleet of nodes sharing one Postgres database.
 * The advisory lock (PgClient.tryAcquireWriterLock) is the FAST-PATH mutual-exclusion primitive;
 * `shard_leases` is the fencing token + discovery row + frontier chain — one row per shard (B1:
 * only `'default'`) so any node (including read replicas forwarding writes) can find the current
 * writer's URL/epoch, and so `PostgresDocStore`'s installed commit guard can verify — inside every
 * commit transaction — that the writer holding the advisory lock is STILL the epoch on file (see
 * `node.ts`'s `installCommitGuard`). `epoch` bumps on every acquisition (D2); `frontier_ts`/
 * `prev_ts` are the durable-commit chain the guard advances (D3) — this class never writes them
 * itself beyond seeding them to 0 on first creation.
 *
 * Liveness: the LeaseMonitor's periodic probe IS `heartbeat()` (see `node.ts`) — one round-trip
 * serves liveness-probe + TTL maintenance + fence verification, per D2. `heartbeat()` returning 0
 * rows means this node's epoch has been superseded (fenced) even though its connection is still
 * alive — a DEFINITIVE loss, distinct from the probe-miss tolerance used for transient blips.
 */
export class LeaseManager {
  private readonly client: PgClient;
  private readonly advertiseUrl: string;
  private readonly applicationName: string | null;
  private readonly retryMs: number;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  /** The epoch this node most recently acquired, updated on every successful `tryAcquire()` —
   *  including the ones `acquireLoop`'s retries and a later re-promotion drive. Read live by the
   *  commit guard and the heartbeat probe (`node.ts`) so both always fence against the CURRENT
   *  epoch, not a snapshot taken at boot. `null` until this node has ever acquired the lease. */
  private lastEpoch: bigint | null = null;

  constructor(client: PgClient, opts: LeaseManagerOptions) {
    this.client = client;
    this.advertiseUrl = opts.advertiseUrl;
    this.applicationName = opts.applicationName ?? null;
    this.retryMs = opts.retryMs ?? DEFAULT_RETRY_MS;
  }

  /** Idempotent DDL: creates shard_leases if it doesn't already exist. */
  async setup(): Promise<void> {
    await this.client.query(`
      CREATE TABLE IF NOT EXISTS shard_leases (
        shard_id        TEXT PRIMARY KEY,
        epoch           BIGINT NOT NULL,
        writer_url      TEXT,
        writer_app_name TEXT,
        expires_at      TIMESTAMPTZ NOT NULL,
        frontier_ts     BIGINT NOT NULL DEFAULT 0,
        prev_ts         BIGINT NOT NULL DEFAULT 0
      )
    `);
  }

  /**
   * The epoch this node most recently acquired (via `tryAcquire`), or `null` if it never has.
   * Read live — not a boot-time snapshot — by the commit guard and the heartbeat probe, so a
   * re-promotion's epoch bump (another `tryAcquire` call) is picked up automatically with no
   * extra threading between `prepareFleetNode`/`startFleetNode`/`promoteFleetNode`.
   */
  currentEpoch(): bigint | null {
    return this.lastEpoch;
  }

  /**
   * One non-blocking attempt: takes the advisory lock (fast path); on success, runs the fencing
   * upsert against `shard_leases` (bumping `epoch`, recording this node's URL/app-name, extending
   * `expires_at`) and returns the new state. On failure to take the lock, returns null.
   * `frontier_ts`/`prev_ts` are seeded to 0 on first creation only — an `ON CONFLICT` re-acquisition
   * (including promotion) leaves them untouched, so the durable-commit chain survives across
   * epochs (D3 depends on this: frontier must never reset just because the writer changed).
   */
  async tryAcquire(): Promise<LeaseState | null> {
    const acquired = await this.client.tryAcquireWriterLock();
    if (!acquired) return null;

    const rows = await this.client.query(
      `INSERT INTO shard_leases (shard_id, epoch, writer_url, writer_app_name, expires_at, frontier_ts, prev_ts)
       VALUES ($1, 1, $2, $3, now() + interval '${LEASE_TTL_SECONDS} seconds', 0, 0)
       ON CONFLICT (shard_id) DO UPDATE SET
         epoch = shard_leases.epoch + 1,
         writer_url = $2,
         writer_app_name = $3,
         expires_at = now() + interval '${LEASE_TTL_SECONDS} seconds'
       RETURNING epoch, writer_url`,
      [SHARD_ID, this.advertiseUrl, this.applicationName],
    );
    const row = rows[0];
    if (!row) throw new Error("shard_leases upsert returned no row");
    const state: LeaseState = { epoch: row.epoch as bigint, writerUrl: row.writer_url as string };
    this.lastEpoch = state.epoch;
    return state;
  }

  /**
   * Extend `expires_at` for this node's `epoch` — the LeaseMonitor's periodic probe (D2: one
   * round-trip serves liveness-probe + TTL maintenance + fence verification). Returns the number
   * of rows updated: 1 = still this node's epoch (TTL extended), 0 = fenced — some other node has
   * bumped the epoch (a D4 eviction) and this node no longer holds the lease, even though its
   * connection never dropped. Callers (see `node.ts`) treat 0 as definitive lease loss.
   */
  async heartbeat(epoch: bigint): Promise<number> {
    const rows = await this.client.query(
      `UPDATE shard_leases SET expires_at = now() + interval '${LEASE_TTL_SECONDS} seconds'
       WHERE shard_id = $1 AND epoch = $2
       RETURNING epoch`,
      [SHARD_ID, epoch],
    );
    return rows.length;
  }

  /** Loop tryAcquire() every retryMs until it succeeds, then invoke onAcquired once. stop() cancels. */
  acquireLoop(onAcquired: (s: LeaseState) => void): void {
    this.stopped = false;

    const attempt = () => {
      if (this.stopped) return;
      void this.tryAcquire()
        .then((state) => {
          if (this.stopped) return;
          if (state) {
            onAcquired(state);
            return;
          }
          this.timer = setTimeout(attempt, this.retryMs);
        })
        .catch(() => {
          // Transient error (e.g. a dropped connection) — keep retrying rather than dying silently.
          if (this.stopped) return;
          this.timer = setTimeout(attempt, this.retryMs);
        });
    };

    this.timer = setTimeout(attempt, this.retryMs);
  }

  /** Cancels any pending acquireLoop() retry. */
  stop(): void {
    this.stopped = true;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  /** Reads the current lease row (discovery for forwarding, plus the full fencing/frontier state);
   *  null if none exists yet. */
  async read(): Promise<LeaseRow | null> {
    const rows = await this.client.query(
      `SELECT epoch, writer_url, writer_app_name, expires_at, frontier_ts, prev_ts
       FROM shard_leases WHERE shard_id = $1`,
      [SHARD_ID],
    );
    const row = rows[0];
    if (!row) return null;
    return rowToLeaseRow(row);
  }
}
