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
import {
  SHARD_KEY_REQUIRED,
  CROSS_SHARD_UNSUPPORTED,
  INVALID_REGION_HINT,
  FANOUT_REQUIRES_FIXED_SHARDS,
  FANOUT_WITH_SHARD_KEY,
  FANOUT_NOT_SUBSCRIBABLE,
  FANOUT_NOT_A_QUERY,
  routingError,
  type ShardRoutingErrorBody,
} from "./errors";
import { deriveLocationHint } from "./location";
import { LOCATION_HINTS } from "@stackbase/runtime-cloudflare";
import { shardIdList } from "@stackbase/id-codec";

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
  /**
   * Opt-in placement source (b): read a `"<hint>:<rest>"` region prefix off the shard-key value to
   * derive the DO's `locationHint` (e.g. `"enam:room123"` → `enam`). OFF by default — an app that does
   * not want a key format is never forced into one. The prefix is only READ for placement; the full
   * key value still names the DO.
   */
  regionPrefixedKeys?: boolean;
}

export type ShardResolution =
  | {
      kind: "shard";
      name: string;
      /** The geographic `locationHint` to place a NEWLY-created shard-DO near its audience (source
       *  a/b/c). Absent ⇒ the router forwards with NO options bag (byte-identical to the pre-hint
       *  behavior; Cloudflare places the DO near the first requester). */
      locationHint?: string;
    }
  | {
      kind: "fanout";
      /** Every shard-DO name to fan this request out to (mode "hash" only — the enumerable
       *  `shardIdList(numShards)`, e.g. `["default", "s1", "s2", …]`). */
      shardIds: string[];
    }
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

/** Classify a `path:name` function's declared `type` (`"query"` / `"mutation"` / `"action"` / …) from
 *  the loaded module set — the SAME lookup `deriveShardFromRun` uses (split the path, index into
 *  `loaded.modules`), reused here so fanOut's read-only guard agrees with the shard-key deriver about
 *  what a "sharded mutation" even is. Returns `undefined` when the type cannot be determined (a
 *  malformed path or an unknown function) — callers MUST treat `undefined` as "not a query" (fail
 *  closed), never as "assume query". */
function classifyFunctionType(loaded: LoadedProject, path: string): string | undefined {
  const split = splitFunctionPath(path);
  if (!split) return undefined;
  const [modulePath, name] = split;
  const fn = loaded.modules[modulePath]?.[name] as { type?: unknown } | undefined;
  return typeof fn?.type === "string" ? fn.type : undefined;
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
  const cf = (request as { cf?: { continent?: string } }).cf;

  /** Attach the placement hint (sources a/b/c) to a resolved shard name, or surface an invalid explicit
   *  region as a typed 400. `shardKeyValue` feeds the opt-in region-prefix source; `undefined` on the
   *  default DO. Kept as a single tail so every shard branch derives the hint identically. */
  const finish = (name: string, shardKeyValue: unknown): ShardResolution => {
    const derived = deriveLocationHint({
      url,
      headers,
      cf,
      shardKeyValue,
      regionPrefixedKeys: opts.regionPrefixedKeys,
    });
    if (!derived.ok) {
      return {
        kind: "error",
        status: 400,
        body: routingError(
          INVALID_REGION_HINT,
          `region hint "${derived.invalidRegion}" is not a valid Durable Object location hint. ` +
            `Use one of: ${LOCATION_HINTS.join(", ")}.`,
        ),
      };
    }
    return derived.hint !== undefined ? { kind: "shard", name, locationHint: derived.hint } : { kind: "shard", name };
  };

  // Fan-out (M2d): a non-reactive one-shot read across every shard of a fixed-shard-count (mode
  // "hash") deployment. Guarded up front, before the explicit/derived/default branches below, since
  // fan-out addresses ALL shards rather than resolving to exactly one.
  if (isFanoutRequested(url, headers)) {
    // fanOut needs an enumerable shard set — only mode "hash" (a fixed numShards) has one.
    if (mode !== "hash") {
      return {
        kind: "error",
        status: 400,
        body: routingError(
          FANOUT_REQUIRES_FIXED_SHARDS,
          "fanOut requires a fixed-shard-count deployment (routing mode \"hash\"); this deployment addresses a Durable Object per key value with no enumerable shard set.",
        ),
      };
    }
    // fanOut + a shard key is contradictory — target one shard OR fan out all, not both.
    if (explicitShardKey(url, headers) !== null) {
      return {
        kind: "error",
        status: 400,
        body: routingError(
          FANOUT_WITH_SHARD_KEY,
          "a request may either fan out across all shards or name one shard key, not both.",
        ),
      };
    }
    // fanOut is non-reactive — a WebSocket subscribe can't fan out.
    if (url.pathname === "/api/sync" || headers.get("upgrade")?.toLowerCase() === "websocket") {
      return {
        kind: "error",
        status: 400,
        body: routingError(
          FANOUT_NOT_SUBSCRIBABLE,
          "fanOut is a non-reactive one-shot read and cannot be used on a WebSocket (/api/sync) subscription.",
        ),
      };
    }
    // fanOut is READ-ONLY (C1): reject anything that isn't a resolved `query` — a plain mutation, a
    // `.shardBy` sharded mutation, or an action would otherwise fall through here and get fanned out
    // to every shard-DO, each of which RUNS AND COMMITS it via the unmodified DO — turning one
    // logical write into N. Classify the target the same way `deriveShardFromRun` looks up the
    // function; a target whose type can't be PROVEN to be "query" (no `loaded`, an unparseable body,
    // a request shape other than `POST /api/run`, or an unknown path) fails CLOSED under the same
    // code — never fanned out on the assumption that it might be a query.
    let fanoutTargetType: string | undefined;
    let fanoutPath: string | undefined;
    if (opts.loaded && request.method === "POST" && url.pathname === "/api/run") {
      let body: { path?: unknown; args?: unknown } | undefined;
      try {
        body = (await request.clone().json()) as { path?: unknown; args?: unknown };
      } catch {
        body = undefined;
      }
      if (body && typeof body.path === "string") {
        fanoutPath = body.path;
        fanoutTargetType = classifyFunctionType(opts.loaded, body.path);
      }
    }
    if (fanoutTargetType !== "query") {
      return {
        kind: "error",
        status: 400,
        body: routingError(
          FANOUT_NOT_A_QUERY,
          fanoutPath !== undefined
            ? `"${fanoutPath}" is not a query (fanOut is read-only; only queries may fan out across shards).`
            : "fanOut requires a POST /api/run request naming a resolvable query function; the target's type could not be determined.",
        ),
      };
    }
    return { kind: "fanout", shardIds: shardIdList(numShards) };
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
    return finish(shardDoName(explicit, mode, numShards), explicit);
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
        return finish(shardDoName(derived.value, mode, numShards), derived.value);
      }
    }
  }

  // (3) Default DO — unsharded / no-`shardBy` / non-run requests.
  return finish(DEFAULT_SHARD_DO_NAME, undefined);
}
