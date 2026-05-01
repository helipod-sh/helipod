/* Stackbase Enterprise. Licensed under the Stackbase Commercial License — see ee/LICENSE. */

/**
 * The stateless shard-routing decision (M1) — pure, host-agnostic, unit-testable under plain Node.
 * Given a request, decide the ONE owning shard-DO name (or a typed rejection). The Worker
 * (`worker.ts`) wraps this and forwards to `env[binding].get(idFromName(name))`.
 *
 * How a request's shard key is sourced, in precedence order (spec §1.2 — the shard key rides the
 * ENVELOPE, Lunora's model, so routing is a pure Worker concern and the DO never parses a row to learn
 * its own name):
 *
 *   1. **Explicit** — an `X-Stackbase-Shard: <value>` header or a `?shard=<value>` query param. This
 *      is the primary mechanism and the ONLY one that works for a WebSocket upgrade (which has no
 *      readable body) and for a query (which declares no `shardBy`). A room/tenant/user socket opens
 *      `…/api/sync?shard=<roomId>`; every op on it runs on that room's DO.
 *   2. **Derived** — for `POST /api/run { path, args }`, if no explicit key is present, look the
 *      function up in the bundled `loaded` project and, if it is a mutation declaring `shardBy`,
 *      extract the shard-key value from `args` EXACTLY as the executor does
 *      (`packages/executor/src/executor.ts` — a string names an arg, a function is a resolver). This
 *      reuses the engine's own convention verbatim, so the edge and the kernel agree on the key.
 *   3. **Default** — no key ⇒ the `"default"` DO (unsharded tables + no-`shardBy` mutations), exactly
 *      Slice 3.
 *
 * Cross-shard is REFUSED, never fanned out (M1 non-goal, §2.1): an explicit fan-out flag
 * (`X-Stackbase-Fanout: true` / `?fanout=1`) or a multi-valued shard key (a comma) is a typed
 * `CROSS_SHARD_UNSUPPORTED` 400. A `.shardBy` mutation whose args omit the key is `SHARD_KEY_REQUIRED`.
 */
import type { LoadedProject } from "@stackbase/cli/project";
import { shardDoName, DEFAULT_SHARD_DO_NAME, type ShardRoutingMode } from "./canonical";
import { SHARD_KEY_REQUIRED, CROSS_SHARD_UNSUPPORTED, routingError, type ShardRoutingErrorBody } from "./errors";

export interface ShardRoutingOptions {
  /** Routing mode: "key" (A, default — one DO per key) or "hash" (B — fixed-N jump-hash). §1.1. */
  mode?: ShardRoutingMode;
  /** For mode "hash": the fixed shard count N (≥ 1). Ignored in mode "key". */
  numShards?: number;
  /**
   * The bundled app, used ONLY to DERIVE a mutation's shard key from `POST /api/run` args (source #2).
   * Optional: omit it and routing falls back to the explicit envelope key + default (still correct;
   * derivation is a convenience so a client need not know each mutation's shard-key field name).
   */
  loaded?: LoadedProject;
}

export type ShardResolution =
  | { kind: "shard"; name: string }
  | { kind: "error"; status: number; body: ShardRoutingErrorBody };

const SHARD_HEADER = "x-stackbase-shard";
const FANOUT_HEADER = "x-stackbase-fanout";

/** Truthy fan-out signal: header `true`/`1`, or `?fanout=true`/`1`. */
function isFanoutRequested(url: URL, headers: Headers): boolean {
  const h = headers.get(FANOUT_HEADER);
  if (h && (h === "true" || h === "1")) return true;
  const q = url.searchParams.get("fanout");
  return q === "true" || q === "1";
}

/** The explicit envelope shard key, if any (header wins over query param). Empty string counts as
 *  "not provided" so a stray `?shard=` never routes an unsharded request off the default DO. */
function explicitShardKey(url: URL, headers: Headers): string | null {
  const h = headers.get(SHARD_HEADER);
  if (h && h.length > 0) return h;
  const q = url.searchParams.get("shard");
  if (q && q.length > 0) return q;
  return null;
}

/** Split a `path:name` function path into its `[modulePath, name]`, honoring nested module paths
 *  (`foo/bar:baz`). Returns null if the path has no `:` separator. */
function splitFunctionPath(path: string): [string, string] | null {
  const i = path.lastIndexOf(":");
  if (i <= 0 || i === path.length - 1) return null;
  return [path.slice(0, i), path.slice(i + 1)];
}

interface DerivedShard {
  /** The function declared `shardBy` (a "sharded mutation"). */
  sharded: boolean;
  /** The shard-key value, present only when `sharded` and the args carried it. */
  value?: unknown;
  hasValue: boolean;
}

/** Mirror the executor's shard resolution (`executor.ts` run()): a mutation with a `shardBy` string
 *  reads the named arg; a `shardBy` resolver function is called with the args. Anything else (a query,
 *  a no-`shardBy` mutation, an unknown path) is not a sharded op. Never throws — a resolver that throws
 *  is treated as "no value" so the caller surfaces `SHARD_KEY_REQUIRED`, not a 500. */
function deriveShardFromRun(loaded: LoadedProject, path: string, args: unknown): DerivedShard {
  const split = splitFunctionPath(path);
  if (!split) return { sharded: false, hasValue: false };
  const [modulePath, name] = split;
  const fn = loaded.modules[modulePath]?.[name] as
    | { type?: unknown; shardBy?: unknown }
    | undefined;
  if (!fn || fn.type !== "mutation" || fn.shardBy === undefined) return { sharded: false, hasValue: false };
  const shardBy = fn.shardBy;
  let value: unknown;
  if (typeof shardBy === "string") {
    value = (args as Record<string, unknown> | null | undefined)?.[shardBy];
  } else if (typeof shardBy === "function") {
    try {
      value = (shardBy as (a: unknown) => unknown)(args);
    } catch {
      value = undefined;
    }
  }
  return { sharded: true, value, hasValue: value !== undefined && value !== null };
}

/**
 * Resolve the owning shard-DO name for a request (or a typed rejection). Reads the request body only
 * when needed (a `POST /api/run` with no explicit key + a `loaded` project); callers MUST forward the
 * ORIGINAL request, never the clone this reads.
 */
export async function resolveShard(request: Request, opts: ShardRoutingOptions = {}): Promise<ShardResolution> {
  const mode = opts.mode ?? "key";
  const numShards = opts.numShards ?? 1;
  const url = new URL(request.url);
  const headers = request.headers;

  // Fan-out / cross-shard is refused up front (M1 non-goal). A caller that wants to span shards gets a
  // clear code, never a silently-partial merge.
  if (isFanoutRequested(url, headers)) {
    return {
      kind: "error",
      status: 400,
      body: routingError(
        CROSS_SHARD_UNSUPPORTED,
        "cross-shard fan-out is not supported in this deployment: a query or mutation must be scoped to a single shard key. " +
          "Move genuinely-global data to a `.global()` table, or issue one request per shard key.",
      ),
    };
  }

  // (1) Explicit envelope key.
  const explicit = explicitShardKey(url, headers);
  if (explicit !== null) {
    // A comma-separated key is an attempt to address several shards at once — refuse it.
    if (explicit.includes(",")) {
      return {
        kind: "error",
        status: 400,
        body: routingError(
          CROSS_SHARD_UNSUPPORTED,
          `a request may name exactly one shard key; received a multi-valued key ("${explicit}"). ` +
            "M1 supports only shard-scoped operations.",
        ),
      };
    }
    return { kind: "shard", name: shardDoName(explicit, mode, numShards) };
  }

  // (2) Derive from a POST /api/run body when we have the bundled app to consult.
  if (opts.loaded && request.method === "POST" && url.pathname === "/api/run") {
    let body: { path?: unknown; args?: unknown } | undefined;
    try {
      body = (await request.clone().json()) as { path?: unknown; args?: unknown };
    } catch {
      body = undefined; // let the DO produce its own parse error; route to default.
    }
    if (body && typeof body.path === "string") {
      const derived = deriveShardFromRun(opts.loaded, body.path, body.args);
      if (derived.sharded) {
        if (!derived.hasValue) {
          return {
            kind: "error",
            status: 400,
            body: routingError(
              SHARD_KEY_REQUIRED,
              `mutation "${body.path}" is sharded but its arguments do not carry the shard key. ` +
                "Include the shard-key field in the arguments, or pass it as an `X-Stackbase-Shard` header.",
            ),
          };
        }
        return { kind: "shard", name: shardDoName(derived.value, mode, numShards) };
      }
    }
  }

  // (3) Default DO — unsharded / no-`shardBy` / non-run requests.
  return { kind: "shard", name: DEFAULT_SHARD_DO_NAME };
}
