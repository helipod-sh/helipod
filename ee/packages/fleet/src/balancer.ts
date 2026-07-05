/* Helipod Enterprise. Licensed under the Helipod Commercial License — see ee/LICENSE. */
/**
 * `ShardLeaseBalancer` — the deterministic, coordinator-free shard placement loop (B2b, D3).
 *
 * Every fleet node (writer OR sync) runs one. Each ~2s beat:
 *   1. HEARTBEAT this node's `fleet_nodes` presence row (its liveness signal — the balancer is the
 *      presence heartbeat for a shardless SYNC node, which has no `shard_leases` row and no
 *      LeaseMonitor; a writer node's LeaseMonitor probe also heartbeats presence, redundantly and
 *      harmlessly).
 *   2. READ the live node set (`fleet_nodes` ∪ live `shard_leases` holders) and compute this node's
 *      rendezvous TARGET shards — the shards HRW assigns to `myUrl` over that set. Every node derives
 *      the same assignment from the same rows (`rendezvous.ts`), so there is nothing to negotiate.
 *   3. If this node is a pure SYNC node (`!isWriterish()`) and any NON-default target is currently
 *      acquirable (orphaned/expired/missing) — a peer released it, or its holder died — request the
 *      shipped whole-node PROMOTION (sync → writer-ish); a promoted node then acquires on the next
 *      steps. (The DEFAULT shard has its own shipped election path — `LeaseManager.acquireLoop` — so
 *      it is not a promotion trigger here; that avoids a redundant second promotion driver racing the
 *      election.)
 *   4. Writer-ish node: ACQUIRE any target shard it does not hold that is acquirable (orphaned/
 *      expired/missing). This is failover — un-damped and prompt; it NEVER touches a live non-target
 *      holder's row (advisory locks + fencing already guarantee at most one holder, so acquisition is
 *      always safe).
 *   5. Writer-ish node, under DAMPING (live set identical for ≥2 consecutive beats): gracefully
 *      RELEASE any held shard NOT in its target set — a point-in-time self-fence (`releaseShard`, wired
 *      in `node.ts`) that hands the shard to its rightful owner, which acquires it on its own next
 *      beat (~2s), no TTL wait, no failover event. Damping keeps a flapping membership from thrashing
 *      placement; acquisition (step 4) is intentionally NOT damped so a real death recovers promptly.
 *
 * The balancer owns ZERO SQL beyond the three lease reads — all acquire/release/promote effects are
 * injected thunks (`node.ts` wires them over `LeaseManager`/the runtime), so this class is a pure
 * orchestrator and unit-testable with lightweight fakes.
 */
import { DEFAULT_SHARD, shardIdList, type ShardId } from "@helipod/id-codec";
import { rendezvousOwner } from "./rendezvous";

/** The narrow slice of `LeaseManager` the balancer reads — a structural interface so tests can pass a
 *  fake, and so the balancer never reaches past these three reads into the lease's write surface. */
export interface BalancerLease {
  /** Upsert this node's `fleet_nodes` presence row, extending `expires_at` by the lease TTL. */
  heartbeatPresence(): Promise<void>;
  /** Distinct unexpired advertise URLs — `fleet_nodes` ∪ live `shard_leases.writer_url` holders. */
  liveNodes(): Promise<string[]>;
  /** Per-shard ownership snapshot: for each existing `shard_leases` row, its `writer_url` (null =
   *  orphaned) and whether it has expired per the DB clock. A shard with NO row is absent from the map
   *  (treated as acquirable). */
  readShardOwnership(): Promise<Map<ShardId, { writerUrl: string | null; expired: boolean }>>;
}

export interface ShardLeaseBalancerDeps {
  lease: BalancerLease;
  /** This node's advertised URL — its identity in the rendezvous candidate set. */
  myUrl: string;
  /** Shard count (the fleet's fixed NUM_SHARDS). Drives the `shardIdList` this balancer ranges over. */
  numShards: number;
  /** Live per-shard held-set membership (`LeaseManager.currentEpoch(shardId) !== null`). */
  isHeld(shardId: ShardId): boolean;
  /** Is this node writer-ish (has completed promotion / booted as the writer)? A pure sync node only
   *  heartbeats presence and may request promotion; it never acquires/releases. */
  isWriterish(): boolean;
  /** Acquire `shardId`'s lease (+ its per-slot advisory lock), evicting a wedged expired holder if
   *  needed. Returns whether the shard is now held. One tick's attempt — a miss retries next beat. */
  tryAcquireShard(shardId: ShardId): Promise<boolean>;
  /** Gracefully release a held shard (point-in-time self-fence under the shard's commit mutex, then
   *  the T3 relinquish-unwind) so its rightful owner can acquire it. */
  releaseShard(shardId: ShardId): Promise<void>;
  /** Run the shipped whole-node promotion (sync → writer-ish). Idempotent at the node level. */
  requestPromotion(): Promise<void>;
  /**
   * Fleet B3, D3 (effectively-once forwarding): reclaim `fleet_idempotency` rows older than the
   * TTL — a cheap indexed delete, run on every WRITER-ish beat (see `LeaseManager.sweepIdempotency`).
   * Optional so an older/stub `ShardLeaseBalancerDeps` (and every existing balancer test) needs no
   * change; a pure sync node never has this called regardless (see `tick()`).
   */
  sweepIdempotency?(): Promise<void>;
  /**
   * Multi-writer scale-out mode (B2b, D3 — the "writer nodes vs sync nodes" scaling knob, off by
   * default). When OFF (the default, and the shipped single-writer behavior): this node's target set is
   * EVERY shard (the sole writer owns them all), the balancer NEVER gracefully releases a live-held
   * shard to a peer, and a pure sync node is NEVER auto-promoted by rendezvous — additional nodes stay
   * READ REPLICAS (sync), reading off their local replica whose tailer sees every shard's commits.
   * Failover acquisition (picking up an orphaned/expired shard) and presence heartbeating are ON
   * regardless. When ON: full rendezvous distribution — each live node owns and writes its HRW share,
   * peers gracefully release a newcomer's share, and a sync node promotes to claim an orphaned share.
   * (Enabling it makes a joining node a CO-WRITER, whose own subscriptions do not yet receive
   * cross-writer reactivity for shards it doesn't hold — that is T6's proving ground.)
   */
  multiWriter?: boolean;
  /** Beat interval (ms). Default 2000. */
  beatMs?: number;
  /** Structured-log seam for a tick error, defaults to `console.error`. */
  log?: (msg: string) => void;
}

const DEFAULT_BEAT_MS = 2000;

export class ShardLeaseBalancer {
  private readonly shards: ShardId[];
  private readonly multiWriter: boolean;
  private readonly beatMs: number;
  private readonly log: (msg: string) => void;
  private timer: ReturnType<typeof setInterval> | null = null;
  private stopped = false;
  private running = false;
  /** Canonical (sorted, comma-joined) live set from the PREVIOUS beat — damping compares against it:
   *  a RELEASE only fires when the current live set equals this (identical for ≥2 consecutive beats). */
  private previousLiveSet: string | null = null;

  constructor(private readonly deps: ShardLeaseBalancerDeps) {
    this.shards = shardIdList(deps.numShards);
    this.multiWriter = deps.multiWriter ?? false;
    this.beatMs = deps.beatMs ?? DEFAULT_BEAT_MS;
    this.log = deps.log ?? ((m: string) => console.error(m));
  }

  /** Begin the periodic beat. The FIRST beat fires after `beatMs` (never synchronously) — prompt boot
   *  acquisition is done explicitly via `acquireTargetsNow()`, not the periodic loop. Idempotent. */
  start(): void {
    if (this.timer !== null || this.stopped) return;
    this.timer = setInterval(() => void this.tick(), this.beatMs);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Resolve the live candidate set for a beat: the DB's live nodes ∪ this node itself (a node is
   *  always live to itself — belt-and-braces so its own boot never depends on its presence row having
   *  landed/propagated yet). Returns both the URL array (rendezvous input) and its canonical form. */
  private async liveCandidates(): Promise<{ urls: string[]; canonical: string }> {
    const live = await this.deps.lease.liveNodes();
    const set = new Set(live);
    set.add(this.deps.myUrl);
    const urls = [...set];
    return { urls, canonical: [...set].sort().join(",") };
  }

  /** This node's target shards. In single-writer mode (the default) the sole writer's targets are ALL
   *  shards — byte-identical to B2a's acquire-all — so a joining node never steals a share. In
   *  multi-writer mode it is this node's rendezvous (HRW) share over `liveUrls`. */
  private targetsFor(liveUrls: readonly string[]): Set<ShardId> {
    if (!this.multiWriter) return new Set(this.shards);
    const targets = new Set<ShardId>();
    for (const s of this.shards) {
      if (rendezvousOwner(s, liveUrls) === this.deps.myUrl) targets.add(s);
    }
    return targets;
  }

  /** A shard is acquirable iff it has no row (absent from the map), is orphaned (`writer_url NULL`), or
   *  has expired — i.e. NOT held live by a peer. Acquisition only ever targets these; a live non-target
   *  holder is never fenced by the balancer (that's failover's job). */
  private acquirable(
    shardId: ShardId,
    ownership: Map<ShardId, { writerUrl: string | null; expired: boolean }>,
  ): boolean {
    const o = ownership.get(shardId);
    return o === undefined || o.writerUrl === null || o.expired;
  }

  /**
   * Un-damped acquire pass over this node's CURRENT rendezvous targets — called at writer boot and on
   * promotion so the node holds its share PROMPTLY (before the ready line / before the first periodic
   * beat), rather than waiting out a 2s tick. In a single-node fleet the target set is EVERY shard, so
   * this acquires all N — byte-identical steady state to B2a's acquire-all. Seeds `previousLiveSet` so
   * the first periodic beat treats the boot membership as the damping baseline.
   */
  async acquireTargetsNow(): Promise<void> {
    const { urls, canonical } = await this.liveCandidates();
    const ownership = await this.deps.lease.readShardOwnership();
    const targets = this.targetsFor(urls);
    for (const s of this.shards) {
      if (targets.has(s) && !this.deps.isHeld(s) && this.acquirable(s, ownership)) {
        await this.deps.tryAcquireShard(s);
      }
    }
    this.previousLiveSet = canonical;
  }

  /** One balancer beat (see the class doc for the five steps). Never throws — a tick error is logged
   *  and the loop continues; the next beat retries against fresh state. */
  async tick(): Promise<void> {
    if (this.stopped || this.running) return; // never overlap two beats
    this.running = true;
    try {
      await this.deps.lease.heartbeatPresence();
      const { urls, canonical } = await this.liveCandidates();
      const stable = canonical === this.previousLiveSet;
      this.previousLiveSet = canonical;

      const ownership = await this.deps.lease.readShardOwnership();
      const targets = this.targetsFor(urls);

      if (!this.deps.isWriterish()) {
        // Pure sync node: in MULTI-WRITER mode only, PROMOTE when a non-default target has come free (a
        // peer released it, or its holder died). The default shard is handled by the shipped acquire-
        // loop election, so it is excluded here. In single-writer mode a sync node stays a read replica
        // (only the election promotes it), so its reactivity keeps flowing through its replica tailer.
        if (this.multiWriter) {
          const wantsPromotion = [...targets].some(
            (s) => s !== DEFAULT_SHARD && this.acquirable(s, ownership),
          );
          if (wantsPromotion) await this.deps.requestPromotion();
        }
        return;
      }

      // Writer-ish: ACQUIRE acquirable targets not yet held (un-damped — prompt failover; ALWAYS on,
      // even in single-writer mode, so a sole writer picks up every orphaned/expired shard).
      for (const s of this.shards) {
        if (targets.has(s) && !this.deps.isHeld(s) && this.acquirable(s, ownership)) {
          await this.deps.tryAcquireShard(s);
        }
      }

      // RELEASE held non-targets — MULTI-WRITER only, and DAMPED (live set identical for ≥2 beats).
      // In single-writer mode `targets` is every shard, so there is nothing to release anyway; the
      // guard is belt-and-braces (and documents that graceful scale-out is the opt-in behavior).
      if (this.multiWriter && stable) {
        for (const s of this.shards) {
          if (this.deps.isHeld(s) && !targets.has(s)) {
            await this.deps.releaseShard(s);
          }
        }
      }

      // Fleet B3, D3: sweep expired `fleet_idempotency` rows on every writer-ish beat. Own try/catch
      // so a sweep hiccup never overshadows (or is overshadowed by) this beat's acquire/release work,
      // which has already completed by this point regardless.
      if (this.deps.sweepIdempotency) {
        try {
          await this.deps.sweepIdempotency();
        } catch (e) {
          this.log(`fleet: idempotency sweep failed: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
    } catch (e) {
      this.log(`fleet: balancer tick failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      this.running = false;
    }
  }
}
