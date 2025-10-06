/* Stackbase Enterprise. Licensed under the Stackbase Commercial License — see ee/LICENSE. */
/**
 * Shards B2b (Task 4) — rendezvous hashing + the `ShardLeaseBalancer`, exercised against a real
 * `PostgresDocStore`/`LeaseManager` over PGlite (real Postgres semantics, single in-process
 * connection). PGlite has no commit pool, so per-slot advisory locks fall back to the always-true
 * single-writer lock — that's fine here: these tests prove the PLACEMENT semantics (who is a
 * rendezvous participant, which shards a node targets, acquire-orphaned / never-steal-live / graceful
 * release / damping), which are connection-agnostic. Genuine cross-connection concurrency + real
 * multi-node failover are the fleet-e2e's job.
 *
 * Multi-"node" scenarios share ONE PgliteClient (one database) with several `LeaseManager`s at
 * different advertise URLs — the shared `shard_leases`/`fleet_nodes` rows are the coordination
 * substrate, exactly as they are across real nodes' separate connections.
 */
import { describe, it, expect, vi } from "vitest";
import { shardIdList, DEFAULT_SHARD, type ShardId } from "@stackbase/id-codec";
import { PostgresDocStore } from "@stackbase/docstore-postgres";
import { LeaseManager } from "../src/lease";
import { relinquish } from "../src/node";
import { ShardLeaseBalancer } from "../src/balancer";
import { rendezvousOwner } from "../src/rendezvous";
import { PgliteClient } from "./pglite-client";

const N = 8;
const SHARDS = shardIdList(N);

/** The rendezvous share of `url` over `urls` at `numShards` — the shards HRW assigns to it. */
function shareOf(url: string, urls: readonly string[], numShards = N): ShardId[] {
  return shardIdList(numShards).filter((s) => rendezvousOwner(s, urls) === url);
}

function uniq(urls: readonly string[]): string[] {
  return [...new Set(urls)];
}

/** One shared-database harness: a `PostgresDocStore` (for schema/sequence) + a `LeaseManager` per URL. */
async function makeFleet(): Promise<{
  client: PgliteClient;
  pgStore: PostgresDocStore;
  leaseFor: (url: string) => LeaseManager;
  close: () => Promise<void>;
}> {
  const client = new PgliteClient();
  const pgStore = new PostgresDocStore(client);
  await pgStore.setupSchema(); // documents/indexes/persistence_globals + the stackbase_ts sequence
  const leases = new Map<string, LeaseManager>();
  let setupDone = false;
  const leaseFor = (url: string): LeaseManager => {
    let l = leases.get(url);
    if (!l) {
      l = new LeaseManager(client, { advertiseUrl: url });
      leases.set(url, l);
    }
    return l;
  };
  // shard_leases/fleet_nodes are shared — set up once via any lease.
  const bootstrapLease = leaseFor("__bootstrap__");
  if (!setupDone) {
    await bootstrapLease.setup();
    setupDone = true;
  }
  leases.delete("__bootstrap__");
  return { client, pgStore, leaseFor, close: () => client.close() };
}

/** Real acquire/release/promotion thunks over a lease — mirrors `node.ts`'s balancer wiring so the
 *  point-in-time release path (self-fence → relinquish-unwind) is exercised for real. */
function makeThunks(lease: LeaseManager, client: PgliteClient) {
  const tryAcquireShard = async (shardId: ShardId): Promise<boolean> => {
    const slot = SHARDS.indexOf(shardId);
    if (slot < 0) return false;
    const state = await lease.tryAcquire(shardId, slot, true);
    if (state) return true;
    if (await lease.isExpired(shardId)) {
      const { fenced, oldAppName } = await lease.evictExpired(shardId);
      if (fenced && oldAppName !== null) await lease.terminateBackend(oldAppName);
      return (await lease.tryAcquire(shardId, slot, true)) !== null;
    }
    return false;
  };
  const releaseShard = async (shardId: ShardId): Promise<void> => {
    // Point-in-time exclusion is a no-op mutex here (no real transactor); self-fence then unwind.
    await lease.selfFence(shardId);
    relinquish({ lease, client, shards: SHARDS }, shardId, "balancer graceful release", {});
  };
  return { tryAcquireShard, releaseShard };
}

/** Read a shard_leases row's coordination fields. */
async function readRow(client: PgliteClient, shardId: ShardId) {
  const rows = await client.query(
    `SELECT epoch, writer_url, frontier_ts FROM shard_leases WHERE shard_id = $1`,
    [shardId],
  );
  const r = rows[0];
  return r
    ? { epoch: r.epoch as bigint, writerUrl: (r.writer_url as string | null) ?? null, frontierTs: r.frontier_ts as bigint }
    : null;
}

/* ========================================================================== */
/* Rendezvous — pure hashing properties                                        */
/* ========================================================================== */

describe("rendezvousOwner (B2b, D3)", () => {
  it("is a pure, order-independent function — every node computes the same owner", () => {
    const urls = ["http://a:1", "http://b:1", "http://c:1", "http://d:1"];
    for (const s of shardIdList(32)) {
      const owner = rendezvousOwner(s, urls);
      // owner is one of the candidates
      expect(urls).toContain(owner);
      // permuting the candidate array does not change the winner (agreement across nodes, whose
      // liveNodes() may return the set in any order)
      expect(rendezvousOwner(s, [...urls].reverse())).toBe(owner);
      expect(rendezvousOwner(s, [urls[2]!, urls[0]!, urls[3]!, urls[1]!])).toBe(owner);
    }
  });

  it("covers every shard over 1..4 urls, and a single node owns everything", () => {
    // single node → sole owner of all shards (the single-node byte-identity premise)
    for (const s of SHARDS) expect(rendezvousOwner(s, ["http://solo:1"])).toBe("http://solo:1");
    expect(shareOf("http://solo:1", ["http://solo:1"]).length).toBe(N);

    // 2..4 urls: every shard still has exactly one owner from the set, and the load spreads
    for (const k of [2, 3, 4]) {
      const urls = Array.from({ length: k }, (_, i) => `http://n${i}:1`);
      const owners = shardIdList(32).map((s) => rendezvousOwner(s, urls));
      for (const o of owners) expect(urls).toContain(o);
      // distributed across MORE THAN ONE node (not a degenerate all-to-one assignment)
      expect(new Set(owners).size).toBeGreaterThan(1);
    }
  });

  it("moves only the minimal set on join (a new node steals only its own share)", () => {
    const before = ["http://a:1", "http://b:1", "http://c:1"];
    const after = [...before, "http://d:1"];
    for (const s of shardIdList(32)) {
      const oldOwner = rendezvousOwner(s, before);
      const newOwner = rendezvousOwner(s, after);
      // HRW minimality: adding D only ever moves a shard TO D, never reshuffles among {A,B,C}
      expect(newOwner === oldOwner || newOwner === "http://d:1").toBe(true);
    }
  });

  it("moves only the minimal set on leave (only the departed node's shards move)", () => {
    const before = ["http://a:1", "http://b:1", "http://c:1"];
    const after = ["http://a:1", "http://b:1"]; // C left
    for (const s of shardIdList(32)) {
      const oldOwner = rendezvousOwner(s, before);
      const newOwner = rendezvousOwner(s, after);
      // a shard NOT owned by the departed C keeps its owner; only C's shards move
      if (oldOwner !== "http://c:1") expect(newOwner).toBe(oldOwner);
    }
  });
});

/* ========================================================================== */
/* Bootstrap regression — the spec-review deadlock                             */
/* ========================================================================== */

describe("ShardLeaseBalancer — bootstrap regression (the fleet_nodes presence fix)", () => {
  it("a shardless node's presence row makes it a live rendezvous participant that receives targets", async () => {
    const f = await makeFleet();
    const urlW = "http://writer:9001";
    const urlN = "http://newcomer:9002";
    const leaseW = f.leaseFor(urlW);
    const leaseN = f.leaseFor(urlN);
    try {
      // W is the incumbent writer holding ALL shards; N is a fresh node with NO shard_leases row.
      for (let slot = 0; slot < N; slot++) await leaseW.tryAcquire(SHARDS[slot]!, slot, true);

      // N's ONLY footprint is its presence row (the fix). It holds no shard lease.
      await leaseN.heartbeatPresence();

      const live = await leaseW.liveNodes();
      expect(live).toContain(urlN); // <-- visible to the incumbent despite holding zero shards
      expect(live).toContain(urlW);

      // Because N is now a live candidate, rendezvous hands it a NON-EMPTY, DISJOINT share...
      const candidates = uniq([...live, urlN]);
      const targetsN = shareOf(urlN, candidates);
      const targetsW = shareOf(urlW, candidates);
      expect(targetsN.length).toBeGreaterThan(0); // N receives targets
      expect(targetsW.length).toBeLessThan(N); // ...and W no longer targets everything
      expect(targetsN.filter((s) => targetsW.includes(s))).toHaveLength(0); // disjoint

      // WITHOUT the presence union (simulate: delete N's fleet_nodes row; it holds no shard_leases):
      await f.client.query(`DELETE FROM fleet_nodes WHERE advertise_url = $1`, [urlN]);
      const liveNo = await leaseW.liveNodes();
      expect(liveNo).not.toContain(urlN); // invisible — the mutual-invisibility deadlock
      // W now computes over a set WITHOUT N → it targets ALL shards → it would release nothing → N
      // would never receive a shard. Scale-out never happens. That is the bug the fix prevents.
      expect(shareOf(urlW, uniq([...liveNo, urlW])).length).toBe(N);
    } finally {
      await f.close();
    }
  });
});

/* ========================================================================== */
/* Balancer tick / acquireTargetsNow behaviors                                 */
/* ========================================================================== */

describe("ShardLeaseBalancer — placement", () => {
  it("single-node fleet: acquireTargetsNow acquires ALL shards (byte-identity with B2a acquire-all)", async () => {
    const f = await makeFleet();
    const url = "http://solo:9001";
    const lease = f.leaseFor(url);
    try {
      await lease.heartbeatPresence();
      const b = new ShardLeaseBalancer({
        lease,
        myUrl: url,
        numShards: N,
        isHeld: (s) => lease.currentEpoch(s) !== null,
        isWriterish: () => true,
        ...makeThunks(lease, f.client),
        requestPromotion: async () => {},
      });
      await b.acquireTargetsNow();
      for (const s of SHARDS) {
        expect(lease.currentEpoch(s)).not.toBeNull(); // every shard held
        expect((await readRow(f.client, s))?.writerUrl).toBe(url); // and recorded to this node
      }
    } finally {
      await f.close();
    }
  });

  it("a writer-ish tick acquires its expired/orphaned/missing targets", async () => {
    const f = await makeFleet();
    const url = "http://solo:9001";
    const lease = f.leaseFor(url);
    try {
      await lease.heartbeatPresence();
      // Pre-seed two rows this node does NOT hold: one ORPHANED (writer_url NULL), one EXPIRED. The
      // rest of the 8 are MISSING. Sole live node → every shard is this node's target.
      await f.client.query(
        `INSERT INTO shard_leases (shard_id, epoch, writer_url, expires_at, frontier_ts, prev_ts)
         VALUES ('s1', 3, NULL, now() + interval '1 hour', 0, 0),
                ('s2', 4, 'http://dead:1', now() - interval '1 hour', 0, 0)`,
      );
      const b = new ShardLeaseBalancer({
        lease,
        myUrl: url,
        numShards: N,
        isHeld: (s) => lease.currentEpoch(s) !== null,
        isWriterish: () => true,
        ...makeThunks(lease, f.client),
        requestPromotion: async () => {},
      });
      await b.tick();
      // Every shard is now held by this node (orphaned adopted, expired evicted+taken, missing created).
      for (const s of SHARDS) {
        expect(lease.currentEpoch(s), `shard ${s} held`).not.toBeNull();
        expect((await readRow(f.client, s))?.writerUrl).toBe(url);
      }
    } finally {
      await f.close();
    }
  });

  it("never steals a shard held LIVE by a peer (acquire only touches orphaned/expired rows)", async () => {
    const f = await makeFleet();
    const urlW = "http://w:9001";
    const urlP = "http://p:9002";
    const leaseW = f.leaseFor(urlW);
    const leaseP = f.leaseFor(urlP);
    try {
      await leaseW.heartbeatPresence();
      await leaseP.heartbeatPresence();
      // Peer P holds ALL shards, LIVE (fresh, unexpired).
      for (let slot = 0; slot < N; slot++) await leaseP.tryAcquire(SHARDS[slot]!, slot, true);
      const before = new Map<ShardId, { epoch: bigint; writerUrl: string | null }>();
      for (const s of SHARDS) before.set(s, (await readRow(f.client, s))!);

      const b = new ShardLeaseBalancer({
        lease: leaseW,
        myUrl: urlW,
        numShards: N,
        isHeld: (s) => leaseW.currentEpoch(s) !== null,
        isWriterish: () => true,
        ...makeThunks(leaseW, f.client),
        requestPromotion: async () => {},
      });
      await b.tick();

      // W acquired NOTHING — every one of its targets is held LIVE by P, so none is acquirable. Each
      // row is byte-for-byte as P left it (same epoch, still writer_url=P). No fencing of a healthy peer.
      for (const s of SHARDS) {
        const now = (await readRow(f.client, s))!;
        expect(now.writerUrl).toBe(urlP);
        expect(now.epoch).toBe(before.get(s)!.epoch);
        expect(leaseW.currentEpoch(s)).toBeNull(); // W holds none of them
      }
    } finally {
      await f.close();
    }
  });

  it("releases a held non-target via the point-in-time path — self-fence observed, slot freed — and only on the SECOND stable beat (damping)", async () => {
    const f = await makeFleet();
    const urlW = "http://w:9001";
    const urlP = "http://p:9002";
    const leaseW = f.leaseFor(urlW);
    const leaseP = f.leaseFor(urlP);
    try {
      // W boots ALONE and holds all 8 (its whole rendezvous share when it is the only live node).
      await leaseW.heartbeatPresence();
      for (let slot = 0; slot < N; slot++) await leaseW.tryAcquire(SHARDS[slot]!, slot, true);

      const b = new ShardLeaseBalancer({
        lease: leaseW,
        myUrl: urlW,
        numShards: N,
        multiWriter: true, // graceful release is the opt-in multi-writer behavior
        isHeld: (s) => leaseW.currentEpoch(s) !== null,
        isWriterish: () => true,
        ...makeThunks(leaseW, f.client),
        requestPromotion: async () => {},
      });
      // Seed the damping baseline as the boot live set ([W]).
      await b.acquireTargetsNow();

      // Peer P joins (writes presence). Now the live set is [W, P] and rendezvous reassigns P's share.
      await leaseP.heartbeatPresence();
      const live = uniq([...(await leaseW.liveNodes()), urlW]);
      const pShare = shareOf(urlP, live);
      expect(pShare.length).toBeGreaterThan(0); // there IS something to hand off
      const handoff = pShare[0]!; // a shard W currently holds that now belongs to P
      const beforeEpoch = (await readRow(f.client, handoff))!.epoch;
      const beforeFrontier = (await readRow(f.client, handoff))!.frontierTs;

      // FIRST beat after the membership change: live set differs from the baseline → DAMPED, no release.
      await b.tick();
      expect(leaseW.currentEpoch(handoff), "still held after the first (unstable) beat").not.toBeNull();
      expect((await readRow(f.client, handoff))!.writerUrl).toBe(urlW);

      // SECOND beat: live set identical to the previous beat → damping satisfied → release the handoff.
      await b.tick();
      expect(leaseW.currentEpoch(handoff), "slot freed after the second (stable) beat").toBeNull();
      const after = (await readRow(f.client, handoff))!;
      expect(after.writerUrl).toBeNull(); // self-fenced: orphaned for P to acquire
      expect(after.epoch).toBe(beforeEpoch + 1n); // epoch bumped
      expect(after.frontierTs >= beforeFrontier).toBe(true); // frontier GREATEST-bumped (never regressed)

      // W still holds its OWN targets (only the handoff moved).
      for (const s of shareOf(urlW, live)) expect(leaseW.currentEpoch(s)).not.toBeNull();
    } finally {
      await f.close();
    }
  });

  it("single-writer mode (DEFAULT): a peer joining does NOT make the writer release anything — additional nodes stay read replicas", async () => {
    const f = await makeFleet();
    const urlW = "http://w:9001";
    const urlP = "http://p:9002";
    const leaseW = f.leaseFor(urlW);
    const leaseP = f.leaseFor(urlP);
    try {
      // Default `multiWriter: false` — the shipped single-writer/sync-replica behavior the existing
      // fleet E2E scenarios depend on. W holds all 8; P joins (writes presence, stays sync).
      await leaseW.heartbeatPresence();
      const b = new ShardLeaseBalancer({
        lease: leaseW,
        myUrl: urlW,
        numShards: N,
        isHeld: (s) => leaseW.currentEpoch(s) !== null,
        isWriterish: () => true,
        ...makeThunks(leaseW, f.client),
        requestPromotion: async () => {},
      });
      await b.acquireTargetsNow();
      await leaseP.heartbeatPresence();
      // Two stable beats — enough to trip damping IF release were enabled. It is not (single-writer).
      await b.tick();
      await b.tick();
      // W still holds ALL 8 shards; nothing was released to the joining peer.
      for (const s of SHARDS) {
        expect(leaseW.currentEpoch(s)).not.toBeNull();
        expect((await readRow(f.client, s))!.writerUrl).toBe(urlW);
      }
    } finally {
      await f.close();
    }
  });
});

/* ========================================================================== */
/* Sync-node promotion trigger                                                 */
/* ========================================================================== */

describe("ShardLeaseBalancer — generalized promotion trigger", () => {
  it("a sync node requests promotion when a NON-default rendezvous target is orphaned; not for default alone", async () => {
    const f = await makeFleet();
    const url = "http://sync:9003";
    const lease = f.leaseFor(url);
    try {
      await lease.heartbeatPresence();
      const requestPromotion = vi.fn(async () => {});
      const b = new ShardLeaseBalancer({
        lease,
        myUrl: url,
        numShards: N,
        multiWriter: true, // sync→writer rendezvous promotion is opt-in
        isHeld: (s) => lease.currentEpoch(s) !== null,
        isWriterish: () => false, // pure sync node
        ...makeThunks(lease, f.client),
        requestPromotion,
      });

      // Sole live node → all shards are its rendezvous targets, all MISSING (acquirable). A non-default
      // target is orphaned → a sync node must promote (whole-node) so it can then hold that shard.
      await b.tick();
      expect(requestPromotion).toHaveBeenCalledTimes(1);

      // A sync node holds/acquires NOTHING directly (it only heartbeats presence + may promote).
      for (const s of SHARDS) expect(lease.currentEpoch(s)).toBeNull();
    } finally {
      await f.close();
    }
  });

  it("does NOT request promotion when the only free target is the default shard (its own election path)", async () => {
    const f = await makeFleet();
    const urlSync = "http://sync:9003";
    const urlPeer = "http://peer:9004";
    const leaseSync = f.leaseFor(urlSync);
    const leasePeer = f.leaseFor(urlPeer);
    try {
      await leaseSync.heartbeatPresence();
      await leasePeer.heartbeatPresence();
      // Peer holds every NON-default shard LIVE; default is left orphaned. So the sync node's only
      // acquirable target could be default — which is excluded (the acquireLoop election owns it).
      for (let slot = 1; slot < N; slot++) await leasePeer.tryAcquire(SHARDS[slot]!, slot, true);

      const requestPromotion = vi.fn(async () => {});
      const b = new ShardLeaseBalancer({
        lease: leaseSync,
        myUrl: urlSync,
        numShards: N,
        multiWriter: true,
        isHeld: (s) => leaseSync.currentEpoch(s) !== null,
        isWriterish: () => false,
        ...makeThunks(leaseSync, f.client),
        requestPromotion,
      });
      await b.tick();
      // Any non-default target the sync node has is held LIVE by the peer (not acquirable); default is
      // excluded → no promotion. (If rendezvous gives this node zero non-default targets, also none.)
      const live = uniq([...(await leaseSync.liveNodes()), urlSync]);
      const nonDefaultTargets = shareOf(urlSync, live).filter((s) => s !== DEFAULT_SHARD);
      // every non-default target is held live by the peer → not acquirable
      for (const s of nonDefaultTargets) {
        expect((await readRow(f.client, s))!.writerUrl).toBe(urlPeer);
      }
      expect(requestPromotion).not.toHaveBeenCalled();
    } finally {
      await f.close();
    }
  });
});
