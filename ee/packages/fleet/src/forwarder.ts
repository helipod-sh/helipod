/* Stackbase Enterprise. Licensed under the Stackbase Commercial License — see ee/LICENSE. */
/**
 * `WriteForwarder` — the non-writer side of the fleet write path. Implements the engine's
 * `WriteRouter` seam: when this node is NOT the writer, every mutation/action entry point calls
 * `forward()`, which POSTs the call to whichever node currently holds the write lease
 * (`/_fleet/run`) and returns its JSON result. On promotion the node flips to `role="writer"` via
 * `promote()` and `isLocalWriter()` starts returning true, so writes execute locally instead.
 *
 * The forwarder learns the writer's URL from the `fleet_lease` discovery row (via `LeaseManager`),
 * never from static config — so a failover to a new writer is picked up by re-reading the lease.
 *
 * Task 3 (read-your-own-writes): `/_fleet/run`'s response now carries the write's `commitTs`
 * (stringified — bigints don't survive `JSON.stringify`). If a `ReplicaTailer` has been attached
 * via `attachTailer()` (this node is a fleet SYNC node reading off a local replica), `forward()`
 * waits for that replica's watermark to reach `commitTs` before resolving — otherwise a client that
 * just wrote through this node could immediately read its own write's absence off a replica that
 * hasn't caught up yet. `promote()` also releases any pending wait: once this node becomes the
 * writer, replica catch-up is no longer the right thing to block on.
 */
import type { WriteRouter } from "@stackbase/runtime-embedded";
import type { JSONValue } from "@stackbase/values";
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
  private role: "sync" | "writer" = "sync";
  private tailer: ReplicaWaiter | undefined;
  /** Guards the "missing commitTs" warning to once per process — a malformed/old-writer response
   *  shape shouldn't spam the log on every subsequent forwarded write. */
  private warnedMissingCommitTs = false;

  constructor(
    private readonly lease: LeaseManager,
    private readonly opts: WriteForwarderOptions,
  ) {}

  /** Attach the local `ReplicaTailer` this node reads off, enabling the read-your-own-writes wait
   *  in `forward()`. Fleet WRITER nodes never call this — they have no replica to wait on. */
  attachTailer(t: ReplicaWaiter): void {
    this.tailer = t;
  }

  /** Flip to writer: subsequent writes execute locally (isLocalWriter → true). Called on promotion. */
  promote(): void {
    this.role = "writer";
    // Any read-your-own-writes wait in flight is now moot — this node no longer serves reads off a
    // replica for its own forwarded writes, so waiting on catch-up would only add latency.
    this.tailer?.release();
  }

  isLocalWriter(): boolean {
    return this.role === "writer";
  }

  async forward(
    kind: "mutation" | "action",
    path: string,
    args: JSONValue,
    identity: string | null,
  ): Promise<JSONValue> {
    const body = { path, args, identity, kind };
    const first = await this.writerUrl();
    let result: { value: JSONValue; commitTs?: string };
    try {
      result = await this.post(first, body);
    } catch (firstErr) {
      // The writer may have changed (failover) OR the connection blipped — re-read the lease and
      // retry exactly once against the (possibly new) writer URL. The second attempt's error, if
      // any, propagates with the writer's own error message.
      let second: string;
      try {
        second = await this.writerUrl();
      } catch {
        throw firstErr;
      }
      result = await this.post(second, body);
    }
    await this.waitForReplicaCatchUp(path, result.commitTs);
    return result.value;
  }

  /** Discover the current writer URL from the lease discovery row. */
  private async writerUrl(): Promise<string> {
    const state = await this.lease.read();
    if (!state) throw new Error("fleet: no writer lease found — cannot forward write");
    return state.writerUrl;
  }

  private async post(
    writerUrl: string,
    body: { path: string; args: JSONValue; identity: string | null; kind: "mutation" | "action" },
  ): Promise<{ value: JSONValue; commitTs?: string }> {
    const res = await fetch(`${trimTrailingSlash(writerUrl)}/_fleet/run`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${this.opts.adminKey}` },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    let parsed: { value?: JSONValue; error?: string; commitTs?: string };
    try {
      parsed = text ? (JSON.parse(text) as { value?: JSONValue; error?: string; commitTs?: string }) : {};
    } catch {
      parsed = {};
    }
    if (!res.ok) throw new Error(parsed.error ?? `fleet: writer /_fleet/run returned HTTP ${res.status}`);
    if (parsed.error !== undefined) throw new Error(parsed.error);
    return { value: parsed.value ?? null, commitTs: parsed.commitTs };
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
      if (!this.warnedMissingCommitTs) {
        this.warnedMissingCommitTs = true;
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
