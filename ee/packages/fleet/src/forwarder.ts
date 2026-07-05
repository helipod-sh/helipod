/* Helipod Enterprise. Licensed under the Helipod Commercial License — see ee/LICENSE. */
/**
 * `WriteForwarder` — the non-owner side of the fleet write path. Implements the engine's
 * per-shard `WriteRouter` seam (B2b, D1): for any shard this node does NOT currently hold,
 * `forward()` POSTs the call to that shard's owner (`/_fleet/run`, discovered per-shard from the
 * `shard_leases` row) and returns its JSON result. `isLocalWriter(shardId)` is a live view of the
 * node's held-shard set (`LeaseManager.currentEpoch(shardId) !== null` — the SAME source of truth
 * `relinquish()` uses for its own idempotency check), so a shard acquired/relinquished mid-flight
 * (balancer rebalancing, failover) takes effect on the very next call — no caching, no stale role.
 *
 * The forwarder learns each shard's writer URL from that shard's `shard_leases` discovery row (via
 * `LeaseManager.read(shardId)`), never from static config — so a failover to a new owner is picked
 * up by re-reading the lease. `writerUrlFor(shardId)` caches per shard (one node normally forwards
 * the same shard repeatedly) and refreshes on a POST failure, retrying once — same shape as the
 * shipped single-shard `writerUrl()` this replaces, generalized per shard.
 *
 * Single-hop guard (B2b, D1 spec-review edit): every forward body carries `forwarded: true`. If it
 * lands on a node that is ALSO not the shard's owner (a point-in-time race during rebalance
 * convergence), the receiver's `/_fleet/run` handler rejects with a typed, retryable
 * `NotShardOwnerError` instead of re-forwarding itself (which would let a forward chase a moving
 * target unboundedly). `forward()` treats that ONE error shape like a transport failure — refresh
 * the shard's cached URL and retry once — then surfaces whatever the second attempt does. Any OTHER
 * typed `HelipodError` (an OCC conflict, a validation failure, …) means a LIVE owner answered
 * DEFINITIVELY and is re-thrown unchanged, exactly as before.
 *
 * Task 3 (read-your-own-writes): `/_fleet/run`'s response carries the write's `commitTs`
 * (stringified — bigints don't survive `JSON.stringify`). If a `ReplicaTailer` has been attached
 * via `attachTailer()` (this node is a fleet SYNC node reading off a local replica), `forward()`
 * waits for that replica's watermark to reach `commitTs` before resolving — otherwise a client that
 * just wrote through this node could immediately read its own write's absence off a replica that
 * hasn't caught up yet. `promote()` also releases any pending wait: once this node becomes the
 * writer, replica catch-up is no longer the right thing to block on.
 */
import type { WriteRouter, ClientReplay } from "@helipod/runtime-embedded";
import { DEFAULT_SHARD, type ShardId } from "@helipod/id-codec";
import type { JSONValue } from "@helipod/values";
import { isHelipodError, helipodErrorFromJSON, NOT_SHARD_OWNER_CODE, type HelipodErrorJSON } from "@helipod/errors";
import type { LeaseManager } from "./lease";
import type { ReplicaTailer } from "./replica-tailer";

/** Strip a single trailing slash so `${writerUrl}/_fleet/run` never doubles up (`//_fleet/run`). */
function trimTrailingSlash(url: string): string {
  return url.endsWith("/") ? url.slice(0, -1) : url;
}

export interface WriteForwarderOptions {
  /** Admin bearer token — the `/_fleet/run` endpoint authenticates with the deployment admin key. */
  adminKey: string;
  /** This node's own advertised URL (recorded on the lease when/if it becomes the writer). */
  selfUrl: string;
}

/** Milliseconds to wait for the local replica to catch up to a forwarded write's `commitTs`
 *  before giving up and serving the (possibly stale) read anyway. */
const RYOW_WAIT_MS = 5000;

/**
 * The narrow seam `WriteForwarder` needs from `ReplicaTailer` — declared locally (rather than
 * typing `attachTailer` as `ReplicaTailer` itself) so tests can pass a lightweight structural stub
 * instead of standing up a real tailer (which needs a live Postgres primary + replica store).
 * A real `ReplicaTailer` satisfies this trivially since it's a strict subset of its public API.
 */
export type ReplicaWaiter = Pick<ReplicaTailer, "waitFor" | "release">;

export class WriteForwarder implements WriteRouter {
  private tailer: ReplicaWaiter | undefined;
  /** Guard each distinct malformed-response warning to once per process (independently — an absent
   *  commitTs and an unparseable one are different failure modes and each deserves its own log
   *  line) so a bad/old writer response doesn't spam the log on every subsequent forwarded write. */
  private warnedMissingCommitTs = false;
  private warnedUnparseableCommitTs = false;
  /** Per-shard writer-URL cache (B2b, T2): populated on first forward for a shard, refreshed on a
   *  POST failure (transport error OR a not-the-owner rejection) and retried once. A node normally
   *  forwards the same shard repeatedly, so caching avoids a `shard_leases` read on every call. */
  private readonly writerUrlCache = new Map<ShardId, string>();

  constructor(
    private readonly lease: LeaseManager,
    private readonly opts: WriteForwarderOptions,
  ) {}

  /** Attach the local `ReplicaTailer` this node reads off, enabling the read-your-own-writes wait
   *  in `forward()`. Fleet WRITER nodes never call this — they have no replica to wait on. */
  attachTailer(t: ReplicaWaiter): void {
    this.tailer = t;
  }

  /** Called on promotion (sync → writer-ish). Releases any read-your-own-writes wait in flight —
   *  this node no longer serves reads off a replica for its own forwarded writes, so waiting on
   *  catch-up would only add latency. `isLocalWriter` itself needs no flip here: it already reads
   *  the live `LeaseManager` state directly (see below), which promotion's `tryAcquire` calls
   *  update as a side effect.
   *
   *  NOTE (Fleet B3): a HYBRID promotion (multi-writer) does NOT call this — a hybrid keeps its
   *  replica + tailer running past promotion and STILL serves reads (and forwarded writes to shards
   *  it doesn't own) off the replica, so releasing the RYOW waits would be wrong. Only the
   *  single-writer failover promotion (`promoteFleetNode`, no replica read path afterward) calls it. */
  promote(): void {
    this.tailer?.release();
  }

  /**
   * Fleet B3 (D2) — the HYBRID own-commit RYOW gate. Wired as the runtime's `beforeNotify` drain
   * hook: awaited before a LOCALLY-committed mutation's subscription re-runs fire, so those re-runs
   * (which read this node's replica, via the hybrid query path) don't observe the commit's absence on
   * a replica that hasn't applied it yet. Delegates to the SAME attached `ReplicaTailer.waitFor` the
   * forwarded-write RYOW uses (`attachTailer`), so local and forwarded writes share one catch-up
   * primitive. No-op when no tailer is attached (a single-writer node with no replica, or before the
   * tailer exists) or when nothing committed (`0n`). A timeout is swallowed — reactivity is
   * best-effort; the read path stays correct regardless (the re-run just fires against a replica that
   * is still catching up, no worse than the pre-gate behavior).
   */
  async waitForReplica(commitTs: bigint): Promise<void> {
    if (!this.tailer || commitTs === 0n) return;
    await this.tailer.waitFor(commitTs, RYOW_WAIT_MS);
  }

  /**
   * True iff this node currently holds `shardId`'s write lease (B2b, D1: per-shard membership, not
   * a whole-node binary role). `LeaseManager.currentEpoch(shardId) !== null` is the SAME live
   * held-set accessor `relinquish()` uses as its own idempotency check (`node.ts`) — so this can
   * never disagree with what the commit guard / relinquish dispatcher consider "held". Consulted
   * fresh on every call (never cached): a shard acquired or relinquished mid-flight (balancer
   * rebalance, failover, promotion) takes effect on the very next mutation.
   */
  isLocalWriter(shardId: ShardId = DEFAULT_SHARD): boolean {
    return this.lease.currentEpoch(shardId) !== null;
  }

  async forward(
    kind: "mutation" | "action",
    path: string,
    args: JSONValue,
    identity: string | null,
    shardId: ShardId = DEFAULT_SHARD,
    dedup?: { clientId: string; seq: number },
  ): Promise<{ value: JSONValue; commitTs?: number; shardId?: string; replay?: ClientReplay }> {
    // `forwarded: true` (B2b, D1 spec-review edit — the single-hop guard): tells the receiver this
    // is a fleet-internal hop, so IT must check ownership itself rather than trust the caller and
    // potentially re-forward unboundedly. `shardId` is what the receiver resolves the current owner
    // (and checks itself against) from.
    //
    // `idempotencyKey` (Fleet B3, D3 — effectively-once forwarding): minted ONCE, here, per LOGICAL
    // write — BEFORE the first attempt — and reused verbatim across the retry-once (a transport
    // failure or a stale-owner rejection) and the eventual re-routed POST. The receiving `/_fleet/
    // run` handler uses it to make a duplicate delivery replay rather than re-execute: two attempts
    // that both carry this SAME key can only ever land ONE durable write (see node.ts's commit guard
    // + packages/cli's http-handler catch-and-replay). A fresh UUID per `forward()` CALL (not
    // per-POST) is what makes this "one key per logical write" rather than "one key per HTTP hop".
    // `clientId`/`seq` (Receipted Outbox): the durable client dedup key rides the forward so the
    // OWNER classifies it (verdict §(c) repair 3) — coexists with the per-hop `idempotencyKey` (the
    // two are disjoint dedup mechanisms; the owner's classification runs BEFORE the fleet pre-select,
    // Risk R2). Absent for a non-outbox mutation, bit-for-bit today's body.
    const body = {
      path,
      args,
      identity,
      kind,
      shardId,
      forwarded: true,
      idempotencyKey: crypto.randomUUID(),
      ...(dedup ? { clientId: dedup.clientId, seq: dedup.seq } : {}),
    };
    const first = await this.writerUrlFor(shardId);
    let result: { value: JSONValue; commitTs?: string; shardId?: string; clientReplay?: ClientReplay };
    try {
      result = await this.post(first, body);
    } catch (firstErr) {
      // A HelipodError here means a LIVE node answered DEFINITIVELY. Two cases:
      //  - `NOT_SHARD_OWNER_CODE` (the single-hop guard's answer): the cached URL is stale — this is
      //    exactly a transport-style failure from the forwarder's perspective, worth ONE retry
      //    against a freshly-read (hopefully current) owner.
      //  - any OTHER typed error (an OCC conflict, a validation failure, the shard guard, …): the
      //    mutation reached an owner and it DECIDED. Re-forwarding would only re-run it against the
      //    same target, so propagate the typed error UNCHANGED (its status/code/retryable survive).
      // A non-HelipodError (fetch rejected: the owner may have failed over or the connection
      // blipped) is the original TRANSPORT-failure retry case, unchanged from before.
      const shouldRetry = !isHelipodError(firstErr) || firstErr.code === NOT_SHARD_OWNER_CODE;
      if (!shouldRetry) throw firstErr;
      let second: string;
      try {
        second = await this.refreshWriterUrlFor(shardId);
      } catch {
        throw firstErr;
      }
      result = await this.post(second, body);
    }
    // Owner-side client-dedup replay (Receipted Outbox): the owner classified this dedup forward as a
    // replay of a recorded verdict — surface it up so the sync node builds a `MutationReplay` instead
    // of a fresh ack. No replica RYOW wait: a replay committed nothing this call.
    if (result.clientReplay) {
      return { value: result.clientReplay.value ?? null, replay: result.clientReplay };
    }
    await this.waitForReplicaCatchUp(path, result.commitTs);
    return {
      value: result.value,
      // `commitTs` is stringified over the wire (bigints don't survive JSON) — coerced to `number`
      // here to match the `WriteRouter` seam's contract (consistent with how every other commitTs
      // consumer at this precision layer already converts, e.g. `Number(r.oplog?.commitTs ?? 0)` in
      // `runtime-embedded`'s sync path). The RYOW wait above already parsed the STRING via `BigInt`
      // directly, so full precision was preserved for the one place that actually needs it.
      commitTs: result.commitTs !== undefined ? Number(result.commitTs) : undefined,
      shardId: result.shardId,
    };
  }

  /** Discover shard `shardId`'s current writer URL — cached after the first read. */
  private async writerUrlFor(shardId: ShardId): Promise<string> {
    const cached = this.writerUrlCache.get(shardId);
    if (cached !== undefined) return cached;
    return this.refreshWriterUrlFor(shardId);
  }

  /** Force a fresh `shard_leases` read for `shardId`, overwriting any cached URL — the refresh half
   *  of `writerUrlFor`'s cache, also used directly by `forward()`'s retry-once path. */
  private async refreshWriterUrlFor(shardId: ShardId): Promise<string> {
    const state = await this.lease.read(shardId);
    if (!state) throw new Error(`fleet: no writer lease found for shard '${shardId}' — cannot forward write`);
    this.writerUrlCache.set(shardId, state.writerUrl);
    return state.writerUrl;
  }

  private async post(
    writerUrl: string,
    body: {
      path: string;
      args: JSONValue;
      identity: string | null;
      kind: "mutation" | "action";
      shardId: ShardId;
      forwarded: boolean;
      idempotencyKey: string;
      clientId?: string;
      seq?: number;
    },
  ): Promise<{ value: JSONValue; commitTs?: string; shardId?: string; clientReplay?: ClientReplay }> {
    const res = await fetch(`${trimTrailingSlash(writerUrl)}/_fleet/run`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${this.opts.adminKey}` },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    let parsed: {
      value?: JSONValue;
      error?: string;
      errorJson?: HelipodErrorJSON;
      commitTs?: string;
      shardId?: string;
      /** Effectively-once forwarding (Fleet B3, D3): true when the receiver replayed a
       *  previously-committed write instead of re-executing. Informational only here — `forward()`
       *  surfaces `value`/`commitTs` uniformly regardless of whether this hop was a replay. */
      replayed?: boolean;
      /** Set instead of `value` when the replayed row's value wasn't recorded (the crash-window or
       *  oversized-cap case) — `parsed.value ?? null` below already surfaces this as `value: null`. */
      valueMissing?: boolean;
      /** Receipted Outbox: the owner classified this dedup forward as a client-verdict replay — a
       *  distinct field from the fleet `replayed`/`valueMissing` per-hop idempotency replay above. */
      clientReplay?: ClientReplay;
    };
    try {
      parsed = text ? (JSON.parse(text) as typeof parsed) : {};
    } catch {
      parsed = {};
    }
    if (!res.ok || parsed.error !== undefined) {
      // Rehydrate the writer's TYPED error when it serialized one (`errorJson`), so its
      // status/code/retryable identity survives the hop — the sync node's `/api/run` then maps it to
      // the same 4xx/5xx the writer would have returned locally. Falls back to a plain Error (an old
      // writer without `errorJson`, or a non-JSON body) so a mixed-version fleet still surfaces the
      // message.
      if (parsed.errorJson) throw helipodErrorFromJSON(parsed.errorJson);
      throw new Error(parsed.error ?? `fleet: writer /_fleet/run returned HTTP ${res.status}`);
    }
    return { value: parsed.value ?? null, commitTs: parsed.commitTs, shardId: parsed.shardId, clientReplay: parsed.clientReplay };
  }

  /** Waits for the local replica to observe `commitTsStr`, when a tailer is attached. No-op on a
   *  fleet WRITER node (no tailer attached) or when the write committed nothing (`0`/absent). */
  private async waitForReplicaCatchUp(path: string, commitTsStr: string | undefined): Promise<void> {
    if (!this.tailer) return;
    if (commitTsStr === undefined) {
      if (!this.warnedMissingCommitTs) {
        this.warnedMissingCommitTs = true;
        console.warn(
          `fleet: writer's /_fleet/run response for ${path} had no commitTs — skipping read-your-own-writes wait`,
        );
      }
      return;
    }
    let commitTs: bigint;
    try {
      commitTs = BigInt(commitTsStr);
    } catch {
      if (!this.warnedUnparseableCommitTs) {
        this.warnedUnparseableCommitTs = true;
        console.warn(
          `fleet: writer's /_fleet/run response for ${path} had an unparseable commitTs ${JSON.stringify(commitTsStr)} — skipping read-your-own-writes wait`,
        );
      }
      return;
    }
    if (commitTs === 0n) return; // nothing committed (e.g. a read-only/no-op run) — nothing to wait for

    const outcome = await this.tailer.waitFor(commitTs, RYOW_WAIT_MS);
    if (outcome === "timeout") {
      console.warn(
        `fleet: read-your-own-writes wait timed out after ${RYOW_WAIT_MS}ms for ${path} at commitTs ${commitTs}`,
      );
    }
  }
}
