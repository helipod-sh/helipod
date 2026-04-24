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

/** The minimal structural surface of a `DurableObjectNamespace` binding the router drives. A real
 *  workerd `DurableObjectNamespace` satisfies this by width — declared inline so the package needs no
 *  `@cloudflare/workers-types` runtime dependency (same discipline as `cf-types.ts`). */
export interface DurableObjectNamespaceLike {
  idFromName(name: string): DurableObjectIdLike;
  get(id: DurableObjectIdLike): DurableObjectStubLike;
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
 * in `wrangler.jsonc` (e.g. `"STACKBASE_DO"`). Every request — HTTP and WS upgrade alike — forwards
 * to the single DO instance.
 */
export function createWorkerHandler(bindingName: string): WorkerHandler {
  return {
    async fetch(request: Request, env: Record<string, unknown>): Promise<Response> {
      const ns = env[bindingName] as DurableObjectNamespaceLike | undefined;
      if (!ns || typeof ns.idFromName !== "function") {
        return new Response(
          JSON.stringify({ error: `stackbase: Durable Object binding "${bindingName}" is not configured in wrangler.jsonc` }),
          { status: 500, headers: { "content-type": "application/json" } },
        );
      }
      const stub = ns.get(ns.idFromName(DEFAULT_SHARD_NAME));
      return stub.fetch(request);
    },
  };
}
