/**
 * The stateless Worker router (§1.4). It holds NO state: it terminates the HTTP/WS request and
 * forwards it to the single-shard Durable Object addressed by a fixed name (`idFromName("default")`
 * — one shard for Slice 3). WebSocket upgrades forward through the DO stub's `fetch` too (workerd
 * carries the `Upgrade` through), so the DO owns the `WebSocketPair` + hibernation. The DO returns
 * the shipped `port: 0` sentinel from its `ServerHandle`; the Worker owns ingress.
 *
 * This mirrors Concave's `getConcaveNamespace`/`getSyncNamespace` binding shape collapsed to a single
 * namespace — the transactor-DO/sync-DO split is deferred to Slice 6 (decision 1).
 */
import { DEPLOYMENT_LOCATION_HINT_ENV, isValidLocationHint, LOCATION_HINTS } from "./location";

/** The minimal structural surface of a `DurableObjectNamespace` binding the router drives. A real
 *  workerd `DurableObjectNamespace` satisfies this by width — declared inline so the package needs no
 *  `@cloudflare/workers-types` runtime dependency (same discipline as `cf-types.ts`). */
export interface DurableObjectNamespaceLike {
  idFromName(name: string): DurableObjectIdLike;
  /** `get(id)` returns the stub for the object; the optional options bag carries `locationHint` to
   *  place a NEWLY-created DO near a region (honored only on the FIRST `get()` for that id — a DO is
   *  single-homed and pinned thereafter). Omitting the bag is byte-identical to the pre-hint call. */
  get(id: DurableObjectIdLike, options?: DurableObjectGetOptions): DurableObjectStubLike;
}
/** The options bag `DurableObjectNamespace.get(id, opts)` accepts. Only `locationHint` is used here. */
export interface DurableObjectGetOptions {
  locationHint?: string;
}
export interface DurableObjectIdLike {
  toString(): string;
}
export interface DurableObjectStubLike {
  fetch(request: Request): Promise<Response>;
}

/** The DO name for the single Slice-3 shard. Sharding (many names / a shard router) is Slice 6. */
export const DEFAULT_SHARD_NAME = "default";

export interface WorkerHandler {
  fetch(request: Request, env: Record<string, unknown>): Promise<Response>;
}

/**
 * Build the stateless Worker `fetch` handler. `bindingName` is the `durable_objects` binding declared
 * in `wrangler.jsonc` (e.g. `"HELIPOD_DO"`). Every request — HTTP and WS upgrade alike — forwards
 * to the single DO instance.
 *
 * Placement: the deployment can pin its ONE DO's home region with `HELIPOD_DO_LOCATION_HINT` (e.g.
 * a US-centric app sets `enam`). The hint is read from `env` per request and passed to `get(id, …)` —
 * only the FIRST `get()` for the `"default"` id is honored (the DO is single-homed thereafter), so a
 * stable env value places the DO deterministically. Unset ⇒ no options bag, byte-identical to the
 * pre-hint behavior (Cloudflare places the DO near the first requester). An INVALID hint is a loud 500
 * at the edge, never silently passed — a bad hint would mis-place the DO permanently.
 */
export function createWorkerHandler(bindingName: string): WorkerHandler {
  return {
    async fetch(request: Request, env: Record<string, unknown>): Promise<Response> {
      const ns = env[bindingName] as DurableObjectNamespaceLike | undefined;
      if (!ns || typeof ns.idFromName !== "function") {
        return jsonError(500, `helipod: Durable Object binding "${bindingName}" is not configured in wrangler.jsonc`);
      }
      const rawHint = env[DEPLOYMENT_LOCATION_HINT_ENV];
      let locationHint: string | undefined;
      if (typeof rawHint === "string" && rawHint.length > 0) {
        if (!isValidLocationHint(rawHint)) {
          return jsonError(
            500,
            `helipod: ${DEPLOYMENT_LOCATION_HINT_ENV}="${rawHint}" is not a valid Durable Object location hint. ` +
              `Valid hints: ${LOCATION_HINTS.join(", ")}.`,
          );
        }
        locationHint = rawHint;
      }
      const id = ns.idFromName(DEFAULT_SHARD_NAME);
      // Byte-identical to the pre-hint call when there is no hint (no options bag at all).
      const stub = locationHint ? ns.get(id, { locationHint }) : ns.get(id);
      return stub.fetch(request);
    },
  };
}

function jsonError(status: number, message: string): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { "content-type": "application/json" },
  });
}
