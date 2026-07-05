/**
 * Tier 3 Slice 8 follow-on: replica write-forwarding. `helipod serve --object-store <url>
 * --replica --writer-url <url>` FORWARDS every mutation/action a caller sends to this replica
 * over to the writer node, instead of rejecting it (`boot.ts`'s `wrapReplicaWriteRejection` —
 * still the behavior when `--writer-url` is unset, unchanged/non-breaking).
 *
 * Implements the engine's CORE `WriteRouter` seam (`@helipod/executor`, re-exported by
 * `@helipod/runtime-embedded`) — the SAME seam `@helipod/fleet`'s `WriteForwarder` (ee)
 * implements for Tier 2 (see `ee/packages/fleet/src/forwarder.ts`), but deliberately simpler:
 * ONE fixed writer URL (no shard-lease discovery — the object-store substrate is single-shard-
 * node by construction, see `boot.ts`'s Tier 3 Slice 6/8 scope-boundary note), no idempotency
 * store. `isLocalWriter` always answers `false` — a replica is never the writer for ANY shard,
 * so `EmbeddedRuntime`'s ONE chokepoint (`executor.run()`'s per-shard mutation branch, plus
 * `EmbeddedRuntime.run`/`runAction`'s wholesale action-forward branch) forwards every mutation
 * and action it sees, regardless of origin (WS `Mutation`/`Action` messages, `POST /api/run`, or
 * an action's inner `ctx.runMutation`). Queries never touch this seam — reads stay local on the
 * replica, which is the whole point of a read replica; see `runtime.ts`'s own doc comment on
 * `WriteRouter` ("queries are never routed").
 *
 * Forwards to `${writerUrl}/api/run` — the writer's own public mutation/action entrypoint, not a
 * dedicated internal endpoint — carrying:
 *   - `identity` as `Authorization: Bearer <identity>` (mirrors how a public httpAction's raw
 *     bearer is passed straight through as `opts.identity`, per `docs/enduser/http-actions.md`'s
 *     convention; `http-handler.ts`'s `/api/run` handler derives `identity` the same way).
 *   - `forwarded: true` in the body — the single-hop guard. The WRITER never re-forwards: it
 *     boots with no `writeRouter` at all, so `runtime.run`/`runAction` execute locally
 *     unconditionally. A REPLICA that receives a `forwarded: true` request on its OWN
 *     `/api/run` (a misconfiguration — some caller's `--writer-url` points at this replica
 *     instead of the real writer) rejects it up front instead of silently forwarding again —
 *     see `http-handler.ts`'s `/api/run` guard (`replicaWriterUrl` param).
 *   - `dedup` (Receipted Outbox `clientId`/`seq`), when present — forwarded so the OWNER (the
 *     writer) classifies it, per the "classification runs where the commit runs" placement rule
 *     `runtime.ts`'s `syncExecutor.runMutation` already documents for the fleet case.
 */
import type { WriteRouter, ClientReplay } from "@helipod/runtime-embedded";
import type { ShardId } from "@helipod/id-codec";
import type { JSONValue } from "@helipod/values";

/** Strip a single trailing slash so `${writerUrl}/api/run` never doubles up (`//api/run`). */
function trimTrailingSlash(url: string): string {
  return url.endsWith("/") ? url.slice(0, -1) : url;
}

/** The writer's `/api/run` JSON response shape this forwarder parses. Additive fields only —
 *  `commitTs` and `clientReplay` are new/optional so an older writer (pre this feature) still
 *  parses fine (missing `commitTs` -> `undefined`, exactly `forwardedResult()`'s pre-existing
 *  hardcoded-0 fallback). */
interface WriterRunResponse {
  value?: JSONValue;
  error?: string;
  commitTs?: string;
  clientReplay?: ClientReplay;
}

export class ReplicaWriteForwarder implements WriteRouter {
  constructor(private readonly writerUrl: string) {}

  /** A replica is never the writer for any shard — every mutation/action forwards. Consulted
   *  fresh on every call (mirrors the fleet forwarder's own "never cached" contract) — cheap
   *  here since it's a constant, not a live lease read. */
  isLocalWriter(_shardId: ShardId): boolean {
    return false;
  }

  async forward(
    kind: "mutation" | "action",
    path: string,
    args: JSONValue,
    identity: string | null,
    _shardId: ShardId,
    dedup?: { clientId: string; seq: number },
  ): Promise<{ value: JSONValue; commitTs?: number; shardId?: string; replay?: ClientReplay }> {
    const body = {
      path,
      args,
      kind,
      forwarded: true,
      ...(dedup ? { clientId: dedup.clientId, seq: dedup.seq } : {}),
    };
    let res: Response;
    try {
      res = await fetch(`${trimTrailingSlash(this.writerUrl)}/api/run`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(identity !== null ? { authorization: `Bearer ${identity}` } : {}),
        },
        body: JSON.stringify(body),
      });
    } catch (e) {
      // A network-level failure (writer unreachable, DNS, connection refused, …) — surface a
      // clear, actionable error rather than an opaque fetch rejection or a silent success.
      throw new Error(
        `helipod: replica write-forward to writer "${this.writerUrl}" failed (unreachable) for ${kind} "${path}" — ${
          e instanceof Error ? e.message : String(e)
        }`,
      );
    }
    const text = await res.text();
    let parsed: WriterRunResponse = {};
    try {
      parsed = text ? (JSON.parse(text) as WriterRunResponse) : {};
    } catch {
      parsed = {};
    }
    if (!res.ok || parsed.error !== undefined) {
      throw new Error(
        parsed.error ??
          `helipod: replica write-forward to writer "${this.writerUrl}" returned HTTP ${res.status} for ${kind} "${path}"`,
      );
    }
    if (parsed.clientReplay) return { value: parsed.clientReplay.value ?? null, replay: parsed.clientReplay };
    return {
      value: parsed.value ?? null,
      commitTs: parsed.commitTs !== undefined ? Number(parsed.commitTs) : undefined,
    };
  }
}
