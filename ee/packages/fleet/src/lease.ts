/* Stackbase Enterprise. Licensed under the Stackbase Commercial License — see ee/LICENSE. */
import type { PgClient, PgRow, PgValue } from "@stackbase/docstore-postgres";
import { DEFAULT_SHARD, type ShardId } from "@stackbase/id-codec";
import type { JSONValue } from "@stackbase/values";

/** The default shard every single-shard caller (B1 tests, the writer-election loop) targets when
 *  no explicit `shardId` is passed. B2a generalizes the per-row methods below to any shard id —
 *  the `shardId` params all DEFAULT to this, so a B1 call site (`tryAcquire()`, `heartbeat(epoch)`,
 *  `seedFrontier(epoch, maxTs)`, …) is byte-identical to before. */
const SHARD_ID: ShardId = DEFAULT_SHARD;

/** Default TTL a fresh acquisition/heartbeat extends `expires_at` by, in ms. The LeaseMonitor's
 *  probe cadence is derived proportionally (ttl/3 → the historical 5s at this default), leaving
 *  headroom for several missed round-trips before a fencer considers this node wedged (D4). A
 *  deployment can shorten it via `STACKBASE_FLEET_LEASE_TTL_MS` (ops/test tuning) — see
 *  `prepareFleetNode` in `node.ts` for the threading. */
const DEFAULT_LEASE_TTL_MS = 15_000;

/**
 * Non-blocking per-shard commit-mutex seam (see `Transactor.tryRunExclusiveOnShard` /
 * `EmbeddedRuntime.tryRunExclusiveOnShard`): run `fn` under shard `shardId`'s commit mutex if it is
 * free right now (returns `true`), else skip without running it (returns `false`). `closeIdleFrontiers`
 * takes this so each idle shard's frontier bump is mutually exclusive with that shard's own commits —
 * the fix for the frontier-inversion race (an idle-closer publishing a frontier ahead of an in-flight
 * commit's not-yet-landed rows). The writer owns both the closer and every shard's commits, so this
 * single-process mutex is airtight for B2a; cross-node closing of a held shard is impossible by design
 * (only the lease holder closes its own held shards).
 */
export type TryRunExclusiveOnShard = (shardId: ShardId, fn: () => Promise<void>) => Promise<boolean>;

/** The current fleet writer lease: which epoch is live and which node holds it. */
export interface LeaseState {
  epoch: bigint;
  writerUrl: string;
  /** The row's fenced-frontier high-water mark at acquisition time (Fleet B3). On an `ON CONFLICT`
   *  re-acquire the upsert leaves `frontier_ts` untouched, so this returns the value an INTERIM owner
   *  advanced it to while this node didn't hold the shard — the exact floor the caller feeds to
   *  `runtime.observeWriteTimestamp` so a re-acquired shard's write snapshot never sits stale. */
  frontierTs: bigint;
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
  /** How long a fresh acquisition/heartbeat extends `expires_at` by, in ms. Default 15000ms. The
   *  whole failover clock scales with this: a wedged writer's lease expires this long after its last
   *  heartbeat, so a follower's eviction can't fire before then. Shortened by
   *  `STACKBASE_FLEET_LEASE_TTL_MS` for the wedged-writer E2E (and available to operators as tuning);
   *  the LeaseMonitor's probe cadence is derived from it so a live writer always renews in time. */
  ttlMs?: number;
}

const DEFAULT_RETRY_MS = 2000;

/** Effectively-once forwarding (Fleet B3, D3): the `fleet_idempotency.value_json` cap. A recorded
 *  mutation result larger than this is NOT stored — the row keeps `value_json = NULL` and
 *  `oversized = true` instead, so a replay reports `valueMissing: true` rather than growing this
 *  control table unboundedly on a large mutation return value. The WRITE itself is unaffected
 *  either way (this cap only governs the best-effort RESULT-VALUE cache, not the commit). */
export const IDEMPOTENCY_VALUE_CAP_BYTES = 64 * 1024;

/** How long a `fleet_idempotency` row survives before the sweep reclaims it (Fleet B3, D3) — a
 *  retry arriving after this window re-executes rather than replaying (documented boundary;
 *  retries are seconds-scale in practice, so 1h is generous headroom). */
const IDEMPOTENCY_TTL_INTERVAL = "1 hour";

/** A `fleet_idempotency` row read back for replay (Fleet B3, D3). `hasValue` distinguishes a
 *  genuinely-recorded value (including a mutation that legitimately returned JSON `null`, which is
 *  still stored as the TEXT `"null"`) from `value_json` being SQL NULL — the crash-window
 *  (commit landed, the post-run value UPDATE never ran) and the oversized-cap cases both leave
 *  `value_json` SQL NULL, and both replay as `valueMissing: true` uniformly. */
export interface IdempotencyReplay {
  commitTs: bigint;
  hasValue: boolean;
  value: JSONValue | null;
  oversized: boolean;
}

function toBigIntOrZero(v: PgValue | undefined): bigint {
  if (v === null || v === undefined) return 0n;
  return typeof v === "bigint" ? v : BigInt(v as number | string);
}

/**
 * True if `e` is a Postgres lock-acquisition timeout (`lock_timeout` fired). `evictExpired`'s
 * `SELECT ... FOR UPDATE` runs under `SET LOCAL lock_timeout='2s'`, so if a wedged writer is mid-
 * commit and still holds the row lock, the fencer waits at most 2s and then this fires — treated as
 * "couldn't fence this tick, retry next tick" rather than an error surfaced to the acquire loop.
 * SQLSTATE `55P03` is `lock_not_available`; the message match is a belt-and-braces fallback.
 */
function isLockTimeoutError(e: unknown): boolean {
  if (e && typeof e === "object") {
    if ((e as { code?: unknown }).code === "55P03") return true;
    const msg = (e as { message?: unknown }).message;
    if (typeof msg === "string" && /lock[_ ]?timeout|lock_not_available/i.test(msg)) return true;
  }
  return false;
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
  /** This node's advertised URL, recorded onto `shard_leases`/`fleet_nodes`. Public so the balancer
   *  can use it as this node's rendezvous identity (`ShardLeaseBalancer.myUrl`) without threading it
   *  separately through `startFleetNode`. */
  readonly advertiseUrl: string;
  private readonly applicationName: string | null;
  private readonly retryMs: number;
  /** The lease TTL in ms this manager stamps onto `expires_at`. Public so the LeaseMonitor can
   *  derive its probe cadence from the SAME knob (see `startFleetNode`) — a live writer must renew
   *  well within the TTL. */
  readonly ttlMs: number;
  /** `ttlMs` as a whole-ms integer, ready to interpolate into the `interval '<n> milliseconds'` SQL
   *  below. Integer-coerced (never a fraction/NaN) so the interpolation can't produce invalid SQL. */
  private readonly ttlMsSql: number;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  /** Per-shard epoch map: `shardId → the epoch this node most recently acquired for it`. B1 tracked
   *  ONE `lastEpoch` (default shard only); B2a's writer holds N shards, each fenced against its own
   *  epoch, so the commit guard/heartbeat/idle-closer look up `currentEpoch(shardId)`. Updated on
   *  every successful per-shard `tryAcquire(shardId)` (including re-promotion's epoch bumps) so the
   *  guard always fences against the CURRENT epoch, not a boot snapshot. A shard absent from the
   *  map is one this node has never acquired. */
  private readonly lastEpochByShard = new Map<ShardId, bigint>();

  constructor(client: PgClient, opts: LeaseManagerOptions) {
    this.client = client;
    this.advertiseUrl = opts.advertiseUrl;
    this.applicationName = opts.applicationName ?? null;
    this.retryMs = opts.retryMs ?? DEFAULT_RETRY_MS;
    this.ttlMs = opts.ttlMs ?? DEFAULT_LEASE_TTL_MS;
    // Guard the SQL-interpolated value: a whole positive integer of ms. A non-positive/NaN TTL would
    // produce a lease that's born already-expired (or invalid SQL), so clamp to the default instead.
    const rounded = Math.round(this.ttlMs);
    this.ttlMsSql = Number.isFinite(rounded) && rounded > 0 ? rounded : DEFAULT_LEASE_TTL_MS;
  }

  /**
   * Idempotent DDL: creates shard_leases if it doesn't already exist, and — when `shardIds` is
   * non-empty — pre-seeds a row for every shard in the list (Fleet B3, D4: the concurrent-boot
   * count-gate fix, reversing B2a's "no pre-seeding" call).
   *
   * B2a originally left this deliberately EMPTY (no pre-seeded rows): a bare `frontier_ts = 0` row
   * created at DDL time, on a database that already held documents (a pre-`--fleet` upgrade), would
   * be momentarily visible at `frontier_ts = 0` to a concurrently-booting sync node — `count(*) = N`
   * AND `min(frontier_ts) = 0` would fake-report ready with an EMPTY replica (the F1×N hole,
   * recurring ×N). That is why row existence used to be tied to a REAL, frontier-seeded acquisition
   * (`tryAcquire`) rather than to `setup()`.
   *
   * The reversal here is safe ONLY because the seed now travels WITH the row: `documentsExist` (the
   * caller's `documentsTableExists` probe, run BEFORE calling this) selects the exact same
   * `frontierSeedExpr` fragment `tryAcquire` uses — `0` on a fresh database (no `documents` table
   * yet: correct, there is no history to protect against), or `(SELECT COALESCE(MAX(ts), 0) FROM
   * documents)` on an upgrade (`documents` already exists: correct, the row is born at the true
   * high-water mark, never momentarily at 0). A pre-seeded row is created UNACQUIRED — `epoch = 0`,
   * `writer_url = NULL`, already-expired `expires_at` — so the FIRST real `tryAcquire` still lands on
   * its `ON CONFLICT` branch and bumps `epoch` from 0 to 1, byte-identical to a fresh INSERT's
   * `epoch = 1`; every existing epoch/ownership assertion in the test suite is unaffected. Idempotent
   * (`ON CONFLICT (shard_id) DO NOTHING`): a row already created by a peer's concurrent `setup()` or
   * by a real acquisition is left untouched — this can only ever RAISE a row into existence, never
   * clobber one. With every shard row present immediately, the tailer's `count(*) < NUM_SHARDS →
   * not-ready` gate is satisfied the instant `setup()` returns — a concurrent multi-writer boot no
   * longer stalls waiting for a writer to finish its acquire-all pass. See `node.ts`'s
   * `prepareFleetNode` for the `documentsTableExists` probe + call site, and `replica-tailer.ts`'s
   * `readFrontier` for the count gate.
   */
  async setup(shardIds: readonly ShardId[] = [], documentsExist = false): Promise<void> {
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
    // `fleet_nodes` presence table (B2b, D3 — the bootstrap-deadlock fix). Every fleet node, INCLUDING
    // a shardless sync node that appears in no `shard_leases` row, heartbeats its row here, so it is
    // visible in every peer's live set and thus a rendezvous participant. Without this table a
    // shardless node is invisible → never assigned a shard → never holds one → scale-out never
    // happens (and the incumbent, not seeing the newcomer, releases nothing). Run as its own statement
    // (single-statement drivers like PGlite), mirroring the schema discipline in `docstore-postgres`.
    await this.client.query(`
      CREATE TABLE IF NOT EXISTS fleet_nodes (
        advertise_url TEXT PRIMARY KEY,
        epoch         BIGINT NOT NULL,
        expires_at    TIMESTAMPTZ NOT NULL
      )
    `);
    // `fleet_idempotency` (B3, D3 — effectively-once forwarding): one row per forwarded logical
    // write, INSERTed by the commit guard (`node.ts`'s `installCommitGuard`) INSIDE the same
    // transaction as the commit itself — atomic by construction, so a `key` PK collision aborts
    // the whole commit (the concurrent-duplicate race's loser path). `value_json` is filled in by
    // `recordIdempotencyValue` AFTER the run completes (the value isn't known inside the commit
    // txn) — best-effort, so a crash between commit and that UPDATE leaves it NULL; `oversized`
    // distinguishes "too big to cache" from "not recorded yet", though both replay as
    // `valueMissing: true` (see `IdempotencyReplay`). `created_at` drives the 1h sweep
    // (`sweepIdempotency`), run on the balancer beat.
    await this.client.query(`
      CREATE TABLE IF NOT EXISTS fleet_idempotency (
        key        TEXT PRIMARY KEY,
        commit_ts  BIGINT NOT NULL,
        value_json TEXT,
        oversized  BOOLEAN NOT NULL DEFAULT false,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);

    if (shardIds.length === 0) return;
    // Batched pre-seed, one row per shard, all sharing the SAME `frontierSeedExpr` snapshot (the
    // subquery is re-evaluated per VALUES row within the one statement's snapshot, so every row gets
    // an identical seed). `epoch = 0`/`writer_url = NULL`/already-expired `expires_at` mark the row as
    // UNACQUIRED — see the class doc comment above for why the first real `tryAcquire` still bumps
    // epoch 0 -> 1, byte-identical to a fresh INSERT. `ON CONFLICT DO NOTHING`: idempotent against a
    // concurrent peer's `setup()` (same shard list) or a row a real acquisition already created.
    const frontierSeed = this.frontierSeedExpr(documentsExist);
    const params: string[] = [];
    const values = shardIds.map((shardId, i) => {
      params.push(shardId);
      return `($${i + 1}, 0, NULL, NULL, now(), ${frontierSeed}, 0)`;
    });
    await this.client.query(
      `INSERT INTO shard_leases (shard_id, epoch, writer_url, writer_app_name, expires_at, frontier_ts, prev_ts)
       VALUES ${values.join(", ")}
       ON CONFLICT (shard_id) DO NOTHING`,
      params,
    );
  }

  /**
   * The `frontier_ts` seed SQL fragment shared by `setup()`'s row pre-seed and `tryAcquire()`'s
   * first-creation INSERT (Fleet B3, D4 — the one place this reasoning is written down): `0` when the
   * caller has verified `documents` does not exist yet (a fresh database — no history to protect
   * against), else `(SELECT COALESCE(MAX(ts), 0) FROM documents)` (an upgrade — the row is born at the
   * store's true high-water mark, never momentarily visible below it). Both call sites gate this on
   * the SAME `documentsTableExists` probe (`node.ts`), so a row is never seeded incorrectly regardless
   * of which of the two code paths creates it first.
   */
  private frontierSeedExpr(documentsExist: boolean): string {
    return documentsExist ? `(SELECT COALESCE(MAX(ts), 0) FROM documents)` : `0`;
  }

  /**
   * Upsert this node's `fleet_nodes` presence row (B2b, D3), extending `expires_at` by the lease TTL.
   * Called at boot (BEFORE the writer-election `tryAcquire`, so a losing node is already visible when
   * it boots sync) and on every balancer beat / writer probe — the node's liveness signal now. A node
   * whose process dies stops heartbeating; its row expires after the TTL and it drops out of every
   * survivor's `liveNodes()`, re-converging the rendezvous assignment. `epoch` increments per beat —
   * carried only for observability/debugging (which incarnation of a node the row belongs to); the
   * live-set membership check keys off `expires_at`, not `epoch`.
   */
  async heartbeatPresence(): Promise<void> {
    await this.client.query(
      `INSERT INTO fleet_nodes (advertise_url, epoch, expires_at)
       VALUES ($1, 1, now() + interval '${this.ttlMsSql} milliseconds')
       ON CONFLICT (advertise_url) DO UPDATE SET
         epoch = fleet_nodes.epoch + 1,
         expires_at = now() + interval '${this.ttlMsSql} milliseconds'`,
      [this.advertiseUrl],
    );
  }

  /**
   * The live fleet node set (B2b, D3): distinct unexpired `fleet_nodes` advertise URLs, UNION the live
   * `shard_leases` writer URLs (belt-and-braces — a writer whose presence heartbeat momentarily lapsed
   * but whose shard lease is still live is unambiguously alive). Every node computes rendezvous over
   * this set, so they all derive the same shard→owner assignment. Expiry is `expires_at >= now()` per
   * the DB's OWN clock, authoritative against host clock skew.
   */
  async liveNodes(): Promise<string[]> {
    const rows = await this.client.query(
      `SELECT advertise_url AS url FROM fleet_nodes WHERE expires_at >= now()
       UNION
       SELECT writer_url AS url FROM shard_leases WHERE writer_url IS NOT NULL AND expires_at >= now()`,
    );
    return rows.map((r) => r.url as string).filter((u): u is string => typeof u === "string" && u.length > 0);
  }

  /**
   * Per-shard ownership snapshot for the balancer (B2b, D3): for each EXISTING `shard_leases` row, its
   * `writer_url` (null = orphaned) and whether it has expired per the DB clock. A shard with no row is
   * simply absent from the map — the balancer treats an absent shard as acquirable (never created, or
   * fully reaped), the same as an orphaned one. Read-only; the balancer decides acquire/release from it.
   */
  async readShardOwnership(): Promise<Map<ShardId, { writerUrl: string | null; expired: boolean }>> {
    const rows = await this.client.query(
      `SELECT shard_id, writer_url, (expires_at < now()) AS expired FROM shard_leases`,
    );
    const map = new Map<ShardId, { writerUrl: string | null; expired: boolean }>();
    for (const r of rows) {
      map.set(r.shard_id as ShardId, {
        writerUrl: (r.writer_url as string | null | undefined) ?? null,
        expired: r.expired === true,
      });
    }
    return map;
  }

  /**
   * Self-fence a shard this node currently holds, for a GRACEFUL balancer release (B2b, D3): bump the
   * epoch (so this node's own subsequent commit/heartbeat on the now-stale epoch fences cleanly),
   * clear `writer_url` (so the shard reads as orphaned and its rightful rendezvous owner acquires it),
   * and GREATEST-bump `frontier_ts` from the shared sequence (so F never regresses across the handoff).
   * Predicated on this node's currently-held epoch — a silent no-op if the shard is already fenced/
   * relinquished (`currentEpoch === null`). The caller runs this UNDER the shard's commit mutex
   * (`runtime.tryRunExclusiveOnShard`) so no in-flight commit's frontier write races it — a mutation
   * mid-execute at release time simply hits `FencedError` at its own commit (OCC-retryable, the
   * forwarder re-routes the retry to the new owner). Mirrors `evictExpired`'s frontier-bump SQL, but
   * unconditional on expiry (this is a voluntary handoff, not an eviction of a wedged peer).
   */
  async selfFence(shardId: ShardId): Promise<void> {
    const epoch = this.currentEpoch(shardId);
    if (epoch === null) return;
    await this.client.query(
      `UPDATE shard_leases SET
         epoch = epoch + 1,
         writer_url = NULL,
         writer_app_name = NULL,
         frontier_ts = GREATEST(frontier_ts, (SELECT nextval('stackbase_ts')))
       WHERE shard_id = $1 AND epoch = $2`,
      [shardId, epoch],
    );
  }

  /**
   * The epoch this node most recently acquired for `shardId` (via `tryAcquire`), or `null` if it
   * never has. Read live — not a boot-time snapshot — by the commit guard and the heartbeat probe,
   * so a re-promotion's epoch bump (another `tryAcquire` call) is picked up automatically with no
   * extra threading between `prepareFleetNode`/`startFleetNode`/`promoteFleetNode`. Defaults to the
   * default shard so B1 call sites (`currentEpoch()`) are unchanged.
   */
  currentEpoch(shardId: ShardId = SHARD_ID): bigint | null {
    return this.lastEpochByShard.get(shardId) ?? null;
  }

  /** The (shard, epoch) pairs this node currently holds — the input to the batched heartbeat,
   *  all-rows seed, and idle-shard closer (all fence per-row against the epoch on file). A snapshot
   *  of the live per-shard epoch map, so it reflects any re-promotion's epoch bumps. */
  heldPairs(): Array<{ shardId: ShardId; epoch: bigint }> {
    return [...this.lastEpochByShard].map(([shardId, epoch]) => ({ shardId, epoch }));
  }

  /**
   * Drop `shardId` from this node's held-epoch map (Fenced Frontier B2b, D2 — per-shard relinquish).
   * After this call `currentEpoch(shardId)` returns `null`, so:
   *  - the commit guard's "no acquired epoch" branch fences any straggler commit on `shardId`
   *    cleanly (rather than a stale epoch happening to still match a row some other node has since
   *    re-fenced and moved on from);
   *  - `heldPairs()` (and therefore `heartbeatAll()`/`closeIdleFrontiers()`/`seedFrontierAll()`) stop
   *    including this shard.
   * Idempotent: forgetting a shard this node doesn't currently hold is a silent no-op — the
   * relinquish dispatcher (`node.ts`) relies on exactly this for ITS OWN idempotency, via
   * `currentEpoch(shardId) === null` as its "already relinquished" check. Deliberately does NOT touch
   * the `shard_leases` ROW — only the caller's advisory-lock release (`PgClient.releaseShardLock`) and
   * this in-memory forget are relinquish's job; the row itself was already epoch-bumped by whoever
   * fenced this node (or will lapse via TTL), and a future re-acquire (`tryAcquire`) is a fresh INSERT/
   * ON CONFLICT UPDATE regardless of what this map remembers.
   */
  forgetShard(shardId: ShardId): void {
    this.lastEpochByShard.delete(shardId);
  }

  /**
   * One non-blocking attempt: takes the advisory lock (fast path); on success, runs the fencing
   * upsert against `shard_leases` (bumping `epoch`, recording this node's URL/app-name, extending
   * `expires_at`) and returns the new state. On failure to take the lock, returns null.
   * `prev_ts` is seeded to 0 on first creation only, and `frontier_ts` to either 0 or the store's
   * current `MAX(ts)` (see `seedFrontierFromDocuments`) — an `ON CONFLICT` re-acquisition (including
   * promotion) leaves BOTH untouched, so the durable-commit chain survives across epochs (D3 depends
   * on this: frontier must never reset just because the writer changed).
   *
   * `seedFrontierFromDocuments` (the F1×N residual-window fix): when a row is FIRST created, seed its
   * `frontier_ts` to `MAX(ts)` from the `documents` log inside the same INSERT — atomically, so the
   * row is NEVER momentarily visible at `frontier_ts = 0` on a pre-loaded store (which would let a
   * concurrently-booting sync node pass its `count == N ∧ min-F` ready gate with an empty replica).
   * Pass `true` only when the `documents` table is known to exist (post-`setupSchema`, or a pre-loaded
   * store) — the caller guards this; `false` (the default, and the only safe value pre-DDL on a fresh
   * database) creates the row at `frontier_ts = 0`, which is correct precisely because a fresh store
   * holds no data. `seedFrontierAll` remains the idempotent belt-and-braces second pass.
   */
  async tryAcquire(
    shardId: ShardId = SHARD_ID,
    slot = 0,
    seedFrontierFromDocuments = false,
  ): Promise<LeaseState | null> {
    // Per-slot advisory lock (B2a, D1 hazard (c)): each slot's lock is taken on THAT shard's
    // dedicated commit connection (`tryAcquireShardLock(slot)`), so the connection's death releases
    // exactly that slot. The two-int lock space is disjoint from the legacy single-int writer lock,
    // so slot locks never collide with it. When the client has no pool (a single-node `NodePgClient`
    // or the PGlite test double), fall back to the legacy `tryAcquireWriterLock()` — one lock guards
    // the whole (single) writer, exactly B1's behavior.
    const acquired = this.client.tryAcquireShardLock
      ? await this.client.tryAcquireShardLock(slot)
      : await this.client.tryAcquireWriterLock();
    if (!acquired) return null;

    // Seed a FIRST-creation frontier from the store's current max (atomic with the INSERT) when the
    // caller vouches `documents` exists; else 0. The `frontier_ts < $N`-style guards elsewhere and
    // `GREATEST` on every later write mean this only ever RAISES the seed, never regresses it.
    const frontierSeed = this.frontierSeedExpr(seedFrontierFromDocuments);
    const rows = await this.client.query(
      `INSERT INTO shard_leases (shard_id, epoch, writer_url, writer_app_name, expires_at, frontier_ts, prev_ts)
       VALUES ($1, 1, $2, $3, now() + interval '${this.ttlMsSql} milliseconds', ${frontierSeed}, 0)
       ON CONFLICT (shard_id) DO UPDATE SET
         epoch = shard_leases.epoch + 1,
         writer_url = $2,
         writer_app_name = $3,
         expires_at = now() + interval '${this.ttlMsSql} milliseconds'
       RETURNING epoch, writer_url, frontier_ts`,
      [shardId, this.advertiseUrl, this.applicationName],
    );
    const row = rows[0];
    if (!row) throw new Error("shard_leases upsert returned no row");
    const state: LeaseState = {
      epoch: row.epoch as bigint,
      writerUrl: row.writer_url as string,
      // On a re-acquire this is the frontier an interim owner left; on a fresh INSERT it's the seed
      // (`frontierSeed` — store max or 0). Feeds `runtime.observeWriteTimestamp` at every acquisition.
      frontierTs: toBigIntOrZero(row.frontier_ts as PgValue | undefined),
    };
    this.lastEpochByShard.set(shardId, state.epoch);
    return state;
  }

  /**
   * Extend `expires_at` for this node's `epoch` — the LeaseMonitor's periodic probe (D2: one
   * round-trip serves liveness-probe + TTL maintenance + fence verification). Returns the number
   * of rows updated: 1 = still this node's epoch (TTL extended), 0 = fenced — some other node has
   * bumped the epoch (a D4 eviction) and this node no longer holds the lease, even though its
   * connection never dropped. Callers (see `node.ts`) treat 0 as definitive lease loss.
   */
  async heartbeat(epoch: bigint, shardId: ShardId = SHARD_ID): Promise<number> {
    const rows = await this.client.query(
      `UPDATE shard_leases SET expires_at = now() + interval '${this.ttlMsSql} milliseconds'
       WHERE shard_id = $1 AND epoch = $2
       RETURNING epoch`,
      [shardId, epoch],
    );
    return rows.length;
  }

  /**
   * Batched heartbeat over EVERY (shard, epoch) pair this node holds — one UPDATE per beat (B2a):
   * the writer holds N leases and must renew all of them in a single round-trip, not N. Returns
   * `{ updated, expected, fencedShardIds }` where `expected` is how many pairs this node believes it
   * holds, `updated` is how many rows actually matched, and `fencedShardIds` (B2b, D2) is PRECISELY
   * which held shards did NOT match — diffing the `RETURNING shard_id` rows against the held set —
   * so the caller can relinquish exactly those shards rather than treat `updated < expected` as an
   * undifferentiated whole-node signal. `updated < expected` (equivalently `fencedShardIds.length >
   * 0`) means at least one shard's epoch was superseded; `fencedShardIds` is always `[]` when this
   * node holds nothing (never a writer) — see the early return. The `(shard_id, epoch) IN ((..),(..))`
   * tuple form fences per row.
   */
  async heartbeatAll(): Promise<{ updated: number; expected: number; fencedShardIds: ShardId[] }> {
    const pairs = this.heldPairs();
    if (pairs.length === 0) return { updated: 0, expected: 0, fencedShardIds: [] };
    const { clause, params } = this.tupleInClause(pairs, 0);
    const rows = await this.client.query(
      `UPDATE shard_leases SET expires_at = now() + interval '${this.ttlMsSql} milliseconds'
       WHERE (shard_id, epoch) IN (${clause})
       RETURNING shard_id`,
      params,
    );
    const renewedIds = new Set(rows.map((r) => r.shard_id as ShardId));
    const fencedShardIds = pairs.filter((p) => !renewedIds.has(p.shardId)).map((p) => p.shardId);
    return { updated: rows.length, expected: pairs.length, fencedShardIds };
  }

  /**
   * Read-only expiry check: does the lease row exist AND is `expires_at` in the past, per the DB's
   * OWN clock? Used as the acquire loop's per-tick pre-gate before the heavier `evictExpired`
   * transaction — a healthy (live) lease must NOT make every follower take the row lock every tick and
   * contend with the writer's commit guard, so the common case stays a single cheap SELECT. The
   * comparison is `now()` in SQL (not `read().expiresAt` in JS) so it's authoritative against clock
   * skew between a follower's host and Postgres.
   */
  async isExpired(shardId: ShardId = SHARD_ID): Promise<boolean> {
    const rows = await this.client.query(
      `SELECT 1 FROM shard_leases WHERE shard_id = $1 AND expires_at < now()`,
      [shardId],
    );
    return rows.length > 0;
  }

  /**
   * Fencing-first eviction of an EXPIRED lease (Fenced Frontier B1, D4). Bumps `epoch` (fencing the
   * wedged holder — its next commit guard / heartbeat now matches 0 rows), clears `writer_url`/
   * `writer_app_name`, and advances `frontier_ts`, all predicated on the lease actually being
   * expired. Returns `{ fenced: true, oldAppName }` capturing the evicted holder's `writer_app_name`
   * (so the acquire loop can `pg_terminate_backend` its lingering connection); `{ fenced: false }`
   * when the row is live (no-op) OR the row lock couldn't be taken within `lock_timeout` (retry next
   * tick — never throws that to the loop).
   *
   * Why a `SELECT ... FOR UPDATE` then a separate `UPDATE`, NOT a single `UPDATE ... RETURNING (SELECT
   * writer_app_name FROM cte)`: on Postgres, RETURNING — and the inlined CTE subquery it evaluates —
   * sees the NEW (already-nulled) row, so a single statement reads back NULL for the old app name
   * (verified on PGlite; a `MATERIALIZED` CTE with its own `FOR UPDATE` instead collides with the
   * same-statement UPDATE's row lock and yields zero rows). The two-statement form captures the old
   * value cleanly, and the `FOR UPDATE` takes the very row lock a concurrent commit-guard UPDATE
   * contends on — serializing eviction against an in-flight commit. That contention is single-
   * connection-untestable and covered E2E only (see the test header).
   */
  async evictExpired(shardId: ShardId = SHARD_ID): Promise<{ fenced: boolean; oldAppName: string | null }> {
    try {
      return await this.client.transaction(async (tx) => {
        // `lock_timeout` scoped to THIS transaction (auto-reset at COMMIT/ROLLBACK): if the wedged
        // holder is mid-commit and still holds the row lock, wait at most 2s, then the FOR UPDATE
        // below fires a lock_timeout error → caught outside → {fenced:false}, retry next tick.
        await tx.query(`SET LOCAL lock_timeout = '2s'`);
        const sel = await tx.query(
          `SELECT writer_app_name FROM shard_leases WHERE shard_id = $1 AND expires_at < now() FOR UPDATE`,
          [shardId],
        );
        if (sel.length === 0) return { fenced: false, oldAppName: null }; // live (or gone) — no-op
        const oldAppName = (sel[0]!.writer_app_name as string | null | undefined) ?? null;
        // BINDING HANDOFF (Task 1 review): `frontier_ts` MUST stay inside the GREATEST —
        // `frontier_ts = GREATEST(frontier_ts, (SELECT nextval('stackbase_ts')))`, NEVER `nextval`
        // alone. `frontier_ts` is the true high-water mark (the commit guard maintains it >= every
        // committed ts), while the `stackbase_ts` sequence can LAG reality in a mixed
        // write()/commitWrite store. Architectural invariant: the production primary is pure-
        // commitWrite, so the sequence never lags maxTimestamp there; `frontier_ts` in this GREATEST
        // is what makes eviction safe even if that ever changes. The row is already locked by the
        // SELECT FOR UPDATE above, so the bare shard_id WHERE targets exactly that expired row.
        await tx.query(
          `UPDATE shard_leases SET
             epoch = epoch + 1,
             writer_url = NULL,
             writer_app_name = NULL,
             frontier_ts = GREATEST(frontier_ts, (SELECT nextval('stackbase_ts')))
           WHERE shard_id = $1`,
          [shardId],
        );
        return { fenced: true, oldAppName };
      });
    } catch (e) {
      // A lock_timeout (couldn't take the row lock in 2s) is expected under contention — surface it as
      // a no-op-this-tick, not an error. The transaction() wrapper has already ROLLBACK'd.
      if (isLockTimeoutError(e)) return { fenced: false, oldAppName: null };
      throw e;
    }
  }

  /**
   * Kill the evicted holder's lingering Postgres backend(s) by `application_name` so its session-level
   * advisory writer lock is released and the NEXT acquire tick can win. Matches the fleet E2E's query
   * shape exactly, including the `pid <> pg_backend_pid()` self-exclusion (the fencer never terminates
   * its own connection — its app name differs anyway, so this is belt-and-braces). Best-effort: if the
   * backend is already gone, the query simply affects zero rows.
   */
  async terminateBackend(appName: string): Promise<void> {
    // B2a: also terminate the wedged holder's PER-SHARD commit-pool backends. Those connections
    // (`<appName>-commit-<shard>`, see `NodePgClient`'s pool) hold the per-slot advisory locks — the
    // exact locks a survivor's acquire-all needs. Terminating ONLY the pinned backend (`= $1`) would
    // release the writer-election lock but leave the shard locks held by the SIGSTOP'd process's
    // still-alive commit connections, so the survivor would spin forever unable to acquire slots
    // 1…N-1. Matching `$1` OR `$1 || '-commit-%'` frees every one of the wedged node's locks at once.
    // (`writer_app_name` records the BASE name; the suffix is appended per shard by the pool.)
    await this.client.query(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
       WHERE (application_name = $1 OR application_name LIKE $1 || '-commit-%') AND pid <> pg_backend_pid()`,
      [appName],
    );
  }

  /**
   * A tick observed the advisory-lock try FAIL — another backend still holds the writer lock. If the
   * lease has ALSO expired, that holder is wedged (its heartbeat stopped) while its connection lingers
   * (a hung/paused process still owns the advisory lock, so no other node can acquire). Fence it
   * (`evictExpired` bumps the epoch) then terminate its backend to release the lock; the next tick's
   * advisory try then succeeds → normal acquisition → promotion. No-op when the lease is still live.
   */
  private async maybeEvictWedged(): Promise<void> {
    if (!(await this.isExpired())) return;
    const { fenced, oldAppName } = await this.evictExpired();
    // Skip termination when there's no recorded app name — nothing to target (and a null-name lease
    // predates app-name stamping / was hand-written). The epoch bump alone already fenced the holder.
    if (fenced && oldAppName !== null) await this.terminateBackend(oldAppName);
  }

  /** Loop tryAcquire() every retryMs until it succeeds, then invoke onAcquired once. stop() cancels.
   *  On a tick where the advisory try fails AND the lease has expired, the wedged holder is fenced +
   *  its backend terminated (`maybeEvictWedged`) so a later tick can take over. */
  acquireLoop(onAcquired: (s: LeaseState) => void): void {
    this.stopped = false;

    const schedule = () => {
      if (this.stopped) return;
      this.timer = setTimeout(attempt, this.retryMs);
    };

    const attempt = (): void => {
      if (this.stopped) return;
      void (async () => {
        try {
          const state = await this.tryAcquire();
          if (this.stopped) return;
          if (state) {
            onAcquired(state);
            return; // acquired — the loop is done (no reschedule)
          }
          // Advisory try failed this tick: if the lease has expired, fence + evict the wedged holder
          // so the next tick can win. Any error here falls through to the catch → reschedule.
          await this.maybeEvictWedged();
        } catch {
          // Transient error (dropped connection, eviction/terminate race) — never let the loop die;
          // just retry next tick.
        }
        schedule();
      })();
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

  /**
   * F1 fix (Fenced Frontier B1 whole-branch review, BLOCKER): seed `frontier_ts` up to at least
   * `maxTs` — the writer-BOOT step that closes the "pre-loaded database" hole. `tryAcquire()` only
   * seeds `frontier_ts` to 0 on the row's FIRST creation (see above); a single-node Postgres `serve`
   * that accumulates real data BEFORE `--fleet` is ever turned on has no `shard_leases` row at all,
   * so the first `tryAcquire()` after enabling `--fleet` creates one at `frontier_ts=0` even though
   * the store already holds history. Because the tailer targets `F=frontier_ts` (not
   * `primary.maxTimestamp()`, see `replica-tailer.ts`'s D5), a fresh sync node's ready gate
   * (`wm=0 < target=0`) is then a silent no-op — it reports ready with an EMPTY replica while the
   * primary holds everything. Callers must invoke this at WRITER BOOT, after this node's own
   * `setupSchema()` has definitely run (the `documents` table this reads may not exist before
   * that — see `prepareFleetNode`/`startFleetNode`'s boot ordering) and BEFORE the node is reported
   * ready; a later promotion does NOT need to call this — by then `frontier_ts` is already live,
   * tracking every commit via the guard installed by `installCommitGuard`.
   *
   * `GREATEST` makes this a no-op on an already-live fleet (frontier already tracks every commit)
   * and on re-acquisition — never regresses `frontier_ts`. Epoch-fenced like every other
   * `shard_leases` write: a stale `epoch` here (this node lost the writer race to someone else
   * between its `tryAcquire()` and this call) affects 0 rows rather than clobbering the new
   * writer's state — that writer's own commit guard is the source of truth for `frontier_ts` going
   * forward regardless. Deliberately does NOT touch `prev_ts`: this is a seed of the high-water
   * mark, not a commit, so there is no new "previous commit" to record — the next REAL commit's
   * guard sets `prev_ts := frontier_ts` (now the seeded value) exactly as it always does.
   */
  async seedFrontier(epoch: bigint, maxTs: bigint, shardId: ShardId = SHARD_ID): Promise<void> {
    await this.client.query(
      `UPDATE shard_leases SET frontier_ts = GREATEST(frontier_ts, $1) WHERE shard_id = $2 AND epoch = $3`,
      [maxTs, shardId, epoch],
    );
  }

  /**
   * All-rows frontier seed (B2a — the F1×N fix): seed EVERY shard this node holds up to `maxTs` in
   * ONE batched, per-row-epoch-fenced UPDATE, run at writer boot BEFORE the node reports ready. The
   * same reasoning as single-shard `seedFrontier` applies to every row at once: any future commit on
   * any shard takes a later `nextval`, so seeding all held frontiers to the store's current max can
   * never over-shoot a real commit, and `GREATEST` keeps it a no-op on an already-live fleet.
   * Epoch-fenced per pair (`(shard_id, epoch) IN (...)`), so a shard this node lost between acquiring
   * it and this call is simply skipped rather than clobbered. See `node.ts`'s writer boot.
   */
  async seedFrontierAll(maxTs: bigint): Promise<void> {
    const pairs = this.heldPairs();
    if (pairs.length === 0) return;
    const { clause, params } = this.tupleInClause(pairs, 1);
    await this.client.query(
      `UPDATE shard_leases SET frontier_ts = GREATEST(frontier_ts, $1) WHERE (shard_id, epoch) IN (${clause})`,
      [maxTs, ...params],
    );
  }

  /**
   * Per-shard idle-shard frontier closing (B2a, D5 — needed the moment N>1: an idle shard pins the
   * fleet's `F = min(frontier_ts)`). Allocate a single fresh `nextval` `N` from the shared
   * `stackbase_ts` sequence per beat, then for EACH held shard advance its frontier up to `N` —
   * `UPDATE ... SET frontier_ts = GREATEST(frontier_ts, $N) WHERE shard_id=$s AND epoch=$e AND
   * frontier_ts < $N` — but run each shard's UPDATE UNDER THAT SHARD'S COMMIT MUTEX
   * (`runExclusiveOnShard`), skipping any shard currently mid-commit (mutex busy → left for the next
   * beat). Returns the `nextval` used (the ceiling this beat closed idle shards up to).
   *
   * Why per-shard-mutex, not the old bare batched UPDATE (the frontier-inversion fix): the commit
   * guard writes `frontier_ts := commitTs` for a commit that drew its ts `T` from the SAME sequence,
   * *inside* the commit transaction — which runs under the shard's commit mutex. If the closer drew
   * `N > T` and bare-wrote `frontier_ts = N` while that commit's rows had not yet landed, a tailer
   * could read `F ≥ N`, pull `(watermark, N]`, and MISS `T`'s rows when they land afterward (silent
   * replica miss), or the guard's later write of `T` would trip a frontier-regression assert. Taking
   * the shard's commit mutex makes the closer and that shard's commits mutually exclusive on this
   * (single, writer-owned) node: a commit that started BEFORE the draw holds the mutex → skipped
   * this beat; a commit that starts AFTER the closer releases acquires the mutex afterward and its
   * `T` (drawn later) is `> N`, so `GREATEST` keeps `frontier_ts ≥ N` with no regression and nothing
   * in-flight ever sits below `N`. Cross-node closing of a held shard is impossible by design (only
   * the lease holder closes its own held shards; orphan bumping via `evictExpired` targets
   * writer-less rows, where no commit can be in flight). Epoch-fenced per pair. No-op (returns the
   * allocated ts anyway) when this node holds nothing.
   */
  async closeIdleFrontiers(runExclusiveOnShard: TryRunExclusiveOnShard): Promise<bigint> {
    const pairs = this.heldPairs();
    // ONE ceiling per beat. Drawn OUTSIDE any shard mutex — a bare `nextval` is monotone and the
    // `frontier_ts < $N` + `GREATEST` guards below tolerate it lagging or leading a concurrent commit.
    const tsRows = await this.client.query(`SELECT nextval('stackbase_ts') AS ts`);
    const newTs = toBigIntOrZero(tsRows[0]?.ts as PgValue | undefined);
    for (const { shardId, epoch } of pairs) {
      // Skip-if-busy: an in-flight commit on this shard holds its mutex, so `runExclusiveOnShard`
      // returns false and we leave the shard for the next beat — that commit will itself set
      // `frontier_ts` to its own (later) commit ts, which is `≥ N` anyway.
      await runExclusiveOnShard(shardId, async () => {
        await this.client.query(
          `UPDATE shard_leases SET frontier_ts = GREATEST(frontier_ts, $1)
           WHERE shard_id = $2 AND epoch = $3 AND frontier_ts < $1`,
          [newTs, shardId, epoch],
        );
      });
    }
    return newTs;
  }

  /**
   * Orphan frontier bumping (B2b, D4): advance the frontier of every WRITER-LESS shard row
   * (`writer_url IS NULL`) that lags `ceiling`, so an unassigned/relinquished/expired shard never
   * pins the fleet's `F = min(frontier_ts)` below the live commit position. Runs on the WRITER beat
   * alongside `closeIdleFrontiers` (which only ever touches THIS node's OWN held rows via
   * `heldPairs()` and so structurally cannot un-pin a shard nobody holds).
   *
   * Safe with NO commit mutex, unlike `closeIdleFrontiers`: a writer-less shard has no in-flight
   * commit by construction — its last writer was fenced (epoch-bumped, `writer_url` nulled) BEFORE
   * the row became orphaned, so nothing can be mid-commit writing `frontier_ts` on it. The `UPDATE`'s
   * own row lock serializes any two writers racing this bump, and `GREATEST` + `frontier_ts < ceiling`
   * keep it monotone regardless. Reuses the SAME `ceiling` (one `nextval` per beat) the idle closer
   * drew, so a beat costs one sequence draw, not two.
   */
  async bumpOrphanFrontiers(ceiling: bigint): Promise<void> {
    await this.client.query(
      `UPDATE shard_leases SET frontier_ts = GREATEST(frontier_ts, $1)
       WHERE writer_url IS NULL AND frontier_ts < $1`,
      [ceiling],
    );
  }

  /** Reads the current lease row for `shardId` (discovery for forwarding, plus the full fencing/
   *  frontier state); null if none exists yet. Defaults to the default shard (B1 call sites). */
  async read(shardId: ShardId = SHARD_ID): Promise<LeaseRow | null> {
    const rows = await this.client.query(
      `SELECT epoch, writer_url, writer_app_name, expires_at, frontier_ts, prev_ts
       FROM shard_leases WHERE shard_id = $1`,
      [shardId],
    );
    const row = rows[0];
    if (!row) return null;
    return rowToLeaseRow(row);
  }

  /** All shard rows' `(shard_id, frontier_ts)` — the fleet-wide frontier picture the writer's
   *  frontier-lag monitor reads to compute `min(frontier_ts)` + which shard is pinning it (D5's
   *  health observability). Ordered by frontier ascending so `rows[0]` is the pinning shard. */
  async readAllFrontiers(): Promise<Array<{ shardId: ShardId; frontierTs: bigint }>> {
    const rows = await this.client.query(
      `SELECT shard_id, frontier_ts FROM shard_leases ORDER BY frontier_ts ASC, shard_id ASC`,
    );
    return rows.map((r) => ({ shardId: r.shard_id as ShardId, frontierTs: toBigIntOrZero(r.frontier_ts) }));
  }

  /**
   * Read back `key`'s `fleet_idempotency` row for a replay decision (Fleet B3, D3), or `null` if no
   * such key has ever committed (a genuine miss — proceed to run). Called by `packages/cli`'s
   * `/_fleet/run` handler BOTH before running (the SELECT-first check) and after catching a
   * unique_violation on this table (the concurrent-duplicate race's loser re-selecting the
   * winner's row). See `IdempotencyReplay` for what `hasValue`/`oversized` distinguish.
   */
  async lookupIdempotency(key: string): Promise<IdempotencyReplay | null> {
    const rows = await this.client.query(
      `SELECT commit_ts, value_json, oversized FROM fleet_idempotency WHERE key = $1`,
      [key],
    );
    const row = rows[0];
    if (!row) return null;
    const raw = row.value_json as string | null | undefined;
    return {
      commitTs: toBigIntOrZero(row.commit_ts as PgValue | undefined),
      hasValue: raw !== null && raw !== undefined,
      value: raw !== null && raw !== undefined ? (JSON.parse(raw) as JSONValue) : null,
      oversized: row.oversized === true,
    };
  }

  /**
   * Best-effort post-run recording of a forwarded mutation's return VALUE onto its already-committed
   * `fleet_idempotency` row (Fleet B3, D3) — the value isn't known inside the commit transaction (the
   * guard only sees `commitTs`), so this runs AFTER `runtime.run`/`runAction`/`runSystem` returns,
   * from `packages/cli`'s `/_fleet/run` handler. Over `IDEMPOTENCY_VALUE_CAP_BYTES` → `value_json`
   * stays/goes NULL and `oversized = true` instead of storing it (a replay then reports
   * `valueMissing: true`, same as the crash-window case where this UPDATE never ran at all). A
   * missing row (no matching `key` — e.g. a no-op mutation that staged nothing, so the guard never
   * ran) silently affects 0 rows; the caller doesn't need to check for that itself.
   */
  async recordIdempotencyValue(key: string, value: JSONValue): Promise<void> {
    const json = JSON.stringify(value ?? null);
    if (Buffer.byteLength(json, "utf8") > IDEMPOTENCY_VALUE_CAP_BYTES) {
      await this.client.query(
        `UPDATE fleet_idempotency SET value_json = NULL, oversized = true WHERE key = $1`,
        [key],
      );
      return;
    }
    await this.client.query(
      `UPDATE fleet_idempotency SET value_json = $1, oversized = false WHERE key = $2`,
      [json, key],
    );
  }

  /**
   * Reclaim `fleet_idempotency` rows older than the TTL (Fleet B3, D3) — a cheap indexed (PK-only
   * table, no index needed at this scale) delete run on the balancer beat of every WRITER-ish node
   * (see `ShardLeaseBalancerDeps.sweepIdempotency` / `node.ts`'s wiring). A retry arriving after a
   * row has been swept simply re-executes (documented boundary — retries are seconds-scale, the
   * sweep window is 1h).
   */
  async sweepIdempotency(): Promise<void> {
    await this.client.query(`DELETE FROM fleet_idempotency WHERE created_at < now() - interval '${IDEMPOTENCY_TTL_INTERVAL}'`);
  }

  /**
   * Build a `(shard_id, epoch) IN ((...),(...))` VALUES-list clause + its flat params array for a
   * batched per-row-fenced statement, with placeholder numbers starting AFTER `offset` positional
   * params the caller already consumed (e.g. a leading `$1 = maxTs`). Returns `{ clause, params }`
   * where `params` is `[shardA, epochA, shardB, epochB, …]` in placeholder order.
   */
  private tupleInClause(
    pairs: ReadonlyArray<{ shardId: ShardId; epoch: bigint }>,
    offset: number,
  ): { clause: string; params: PgValue[] } {
    const tuples: string[] = [];
    const params: PgValue[] = [];
    for (const { shardId, epoch } of pairs) {
      const a = offset + params.length + 1;
      const b = offset + params.length + 2;
      tuples.push(`($${a}, $${b})`);
      params.push(shardId, epoch);
    }
    return { clause: tuples.join(", "), params };
  }
}
