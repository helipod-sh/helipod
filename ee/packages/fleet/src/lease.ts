/* Stackbase Enterprise. Licensed under the Stackbase Commercial License — see ee/LICENSE. */
import type { PgClient } from "@stackbase/docstore-postgres";

/** The current fleet writer lease: which epoch is live and which node holds it. */
export interface LeaseState {
  epoch: bigint;
  writerUrl: string;
}

export interface LeaseManagerOptions {
  /** URL this node advertises as the writer, recorded into fleet_lease on acquire. */
  advertiseUrl: string;
  /** Interval between tryAcquire() attempts inside acquireLoop(). Default 2000ms. */
  retryMs?: number;
}

const DEFAULT_RETRY_MS = 2000;

/**
 * Coordinates the single-writer lease across a fleet of nodes sharing one Postgres database.
 * The advisory lock (PgClient.tryAcquireWriterLock) is the actual mutual-exclusion primitive;
 * `fleet_lease` is a discovery row so any node (including read replicas forwarding writes) can
 * find the current writer's URL and epoch without holding the lock itself.
 */
export class LeaseManager {
  private readonly client: PgClient;
  private readonly advertiseUrl: string;
  private readonly retryMs: number;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;

  constructor(client: PgClient, opts: LeaseManagerOptions) {
    this.client = client;
    this.advertiseUrl = opts.advertiseUrl;
    this.retryMs = opts.retryMs ?? DEFAULT_RETRY_MS;
  }

  /** Idempotent DDL: creates fleet_lease if it doesn't already exist. */
  async setup(): Promise<void> {
    await this.client.query(`
      CREATE TABLE IF NOT EXISTS fleet_lease (
        id INTEGER PRIMARY KEY,
        epoch BIGINT NOT NULL,
        writer_url TEXT NOT NULL,
        acquired_at TIMESTAMPTZ NOT NULL
      )
    `);
  }

  /**
   * One non-blocking attempt: takes the advisory lock; on success, upserts fleet_lease
   * (incrementing epoch) and returns the new state. On failure to take the lock, returns null.
   */
  async tryAcquire(): Promise<LeaseState | null> {
    const acquired = await this.client.tryAcquireWriterLock();
    if (!acquired) return null;

    const rows = await this.client.query(
      `INSERT INTO fleet_lease (id, epoch, writer_url, acquired_at)
       VALUES (1, 1, $1, now())
       ON CONFLICT (id) DO UPDATE SET epoch = fleet_lease.epoch + 1, writer_url = $1, acquired_at = now()
       RETURNING epoch, writer_url`,
      [this.advertiseUrl],
    );
    const row = rows[0];
    if (!row) throw new Error("fleet_lease upsert returned no row");
    return { epoch: row.epoch as bigint, writerUrl: row.writer_url as string };
  }

  /** Loop tryAcquire() every retryMs until it succeeds, then invoke onAcquired once. stop() cancels. */
  acquireLoop(onAcquired: (s: LeaseState) => void): void {
    this.stopped = false;

    const attempt = () => {
      if (this.stopped) return;
      void this.tryAcquire().then((state) => {
        if (this.stopped) return;
        if (state) {
          onAcquired(state);
          return;
        }
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

  /** Reads the current lease row (discovery for forwarding); null if none exists yet. */
  async read(): Promise<LeaseState | null> {
    const rows = await this.client.query("SELECT epoch, writer_url FROM fleet_lease WHERE id = 1");
    const row = rows[0];
    if (!row) return null;
    return { epoch: row.epoch as bigint, writerUrl: row.writer_url as string };
  }
}
