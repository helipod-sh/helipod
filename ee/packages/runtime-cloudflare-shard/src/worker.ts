/* Stackbase Enterprise. Licensed under the Stackbase Commercial License — see ee/LICENSE. */

/**
 * The multi-shard stateless Worker router (M1). The DO-native analog of `ee/fleet` for the portable
 * path — but a SIBLING, not a consumer: Cloudflare's native `namespace.getByName(shardKey)` addressing
 * replaces the lease/forwarder mechanism entirely. This handler holds NO state; it resolves the ONE
 * owning shard-DO name from the request envelope (`resolveShard`) and forwards the ORIGINAL request to
 * it. Each shard-DO is an UNMODIFIED `StackbaseDurableObject` from the FREE `@stackbase/runtime-cloudflare`
 * package (reused verbatim — N distinct keys ⇒ N distinct DOs ⇒ N× the single-DO write ceiling AND
 * N×10 GB storage). No engine change: a shard-DO differs from Slice 3 in nothing.
 *
 * Licensing (locked): this package DEPENDS ON the free single-shard host and reuses its DO class;
 * nothing in `@stackbase/runtime-cloudflare` imports back into here. The single-shard vs multi-shard
 * choice is made at the APP'S Worker entry (which handler it `export default`s), never by a runtime
 * gate — so a free single-node deploy never statically links this ee code.
 */
import {
  DEFAULT_SHARD_NAME,
  type WorkerHandler,
  type DurableObjectNamespaceLike,
} from "@stackbase/runtime-cloudflare";
import { resolveShard, type ShardRoutingOptions } from "./route";

// Re-export the Slice-3 default name so an app/rig references one symbol. `getByName(name)` (CF's
// sugar, changelog 2025-08-21) is exactly `get(idFromName(name))`; we use the `idFromName`+`get`
// spelling the free host already proves in workerd, and which the `DurableObjectNamespaceLike` seam
// declares. They resolve the SAME globally-unique object for a name.
export { DEFAULT_SHARD_NAME };

/**
 * Build the multi-shard Worker `fetch` handler. `bindingName` is the shard-DO `durable_objects`
 * binding in `wrangler.jsonc` (e.g. `"STACKBASE_DO"`); `opts` selects the routing mode and — for the
 * derive-from-args convenience — the bundled `loaded` app.
 */
export function createShardWorkerHandler(bindingName: string, opts: ShardRoutingOptions = {}): WorkerHandler {
  return {
    async fetch(request: Request, env: Record<string, unknown>): Promise<Response> {
      const ns = env[bindingName] as DurableObjectNamespaceLike | undefined;
      if (!ns || typeof ns.idFromName !== "function") {
        return json(500, {
          error: `stackbase: Durable Object binding "${bindingName}" is not configured in wrangler.jsonc`,
        });
      }
      const resolution = await resolveShard(request, opts);
      if (resolution.kind === "error") {
        return json(resolution.status, resolution.body);
      }
      if (resolution.kind === "fanout") {
        return fanOut(ns, resolution.shardIds, request);
      }
      const id = ns.idFromName(resolution.name);
      // Place a NEWLY-created shard-DO near its audience (source a/b/c). Only the FIRST `get()` for this
      // id honors the hint — a DO is single-homed and pinned thereafter — so the router derives the SAME
      // hint per key where possible (explicit/prefix are stable; cf-origin is first-requester-wins). No
      // hint ⇒ `get(id)` with no options bag: byte-identical to the pre-hint forward.
      const stub = resolution.locationHint
        ? ns.get(id, { locationHint: resolution.locationHint })
        : ns.get(id);
      return stub.fetch(request);
    },
  };
}

function json(status: number, value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** Bounded-concurrency in-flight cap on the fan-out pool (§ below) — a fixed, deliberately small
 *  ceiling so a wide `numShards` deployment can't open hundreds of simultaneous subrequests from one
 *  Worker invocation. */
const FANOUT_CONCURRENCY = 8;
/** Per-shard fetch timeout — a single slow/hung shard-DO must not hang the whole fan-out; it is
 *  recorded as a failed shard instead (failures-as-data, never a thrown fan-out failure). */
const FANOUT_SHARD_TIMEOUT_MS = 10_000;

/**
 * Fan `request` out to every DO named in `shardIds`, concatenate each shard's `{ value: [...] }`
 * array, and return ONE merged `Response`. A shard that throws, times out, responds non-200, or
 * returns a non-array `value` becomes a `failedShard` entry — failures-as-data, never a thrown
 * fan-out failure — so a slow or broken shard degrades the result instead of failing the whole read.
 *
 * Concurrency is bounded by a simple index-cursor worker pool (`FANOUT_CONCURRENCY` workers each
 * pulling the next `shardIds` index) rather than `Promise.all`-ing every shard at once, so the number
 * of simultaneously in-flight subrequests is capped regardless of `shardIds.length`.
 *
 * v1 concat: no global result limit is applied here. Each shard already applies its own query's
 * `.take(n)` inside its own engine (the fanned-out request is byte-identical per shard), so the
 * concatenation is naturally capped at `shardIds.length * n`. A caller that needs a hard GLOBAL cap
 * slices the returned `value` client-side; threading a `?fanoutLimit=` router param is left for a
 * later slice if this proves insufficient in practice.
 */
async function fanOut(ns: DurableObjectNamespaceLike, shardIds: string[], request: Request): Promise<Response> {
  const value: unknown[] = [];
  const failedShards: Array<{ shardId: string; error: string }> = [];

  let cursor = 0;
  async function worker(): Promise<void> {
    for (;;) {
      const i = cursor++;
      if (i >= shardIds.length) return;
      const shardId = shardIds[i]!;
      try {
        const stub = ns.get(ns.idFromName(shardId));
        const res = await withTimeout(stub.fetch(request.clone()), FANOUT_SHARD_TIMEOUT_MS);
        if (!res.ok) {
          failedShards.push({ shardId, error: `shard responded ${res.status}` });
          continue;
        }
        const body = (await res.json()) as { value?: unknown };
        if (!Array.isArray(body.value)) {
          failedShards.push({
            shardId,
            error: "shard result is not an array (fanOut requires a query returning a list)",
          });
          continue;
        }
        value.push(...body.value);
      } catch (e) {
        failedShards.push({ shardId, error: e instanceof Error ? e.message : String(e) });
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(FANOUT_CONCURRENCY, shardIds.length) }, () => worker()));

  return json(200, failedShards.length ? { value, partial: { failedShards } } : { value });
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`shard fetch timed out after ${ms}ms`)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}
