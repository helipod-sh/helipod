/**
 * Durable Object geographic PLACEMENT — the shared, host-agnostic knowledge of Cloudflare's
 * `locationHint` set. A Durable Object is single-homed: it is pinned to ONE data center at creation
 * (near the FIRST `get()` requester by default) and does not move. `get(id, { locationHint })`
 * overrides that placement — but ONLY the first `get()` for a given DO is honored; it is pinned
 * thereafter (https://developers.cloudflare.com/durable-objects/reference/data-location/).
 *
 * This module is the ONE source of truth for the valid hint set, shared by BOTH the free single-shard
 * host (which pins its one DO via `STACKBASE_DO_LOCATION_HINT`) and the ee multi-shard router (which
 * places each shard-DO near its audience). It lives in the FREE package so the ee package can reuse it
 * WITHOUT the free package ever importing back into ee — the licensing edge stays one-way.
 *
 * NOTE: `locationHint` values are NOT jurisdictions. Jurisdictions (`eu`/`fedramp`) are a separate,
 * stronger mechanism (`namespace.jurisdiction("eu")`) with hard placement + compliance guarantees, and
 * are addressed on `idFromName`, not passed as a `locationHint`. Cloudflare's own docs are explicit:
 * "Unlike with jurisdictions, Durable Objects will not necessarily be instantiated in the hinted
 * location." Jurisdictions are out of scope for this hint-threading seam; only the 11 region hints
 * below are valid values for `get(id, { locationHint })`.
 */

/** The env var the free single-shard host reads to pin its ONE Durable Object's home region. Unset ⇒
 *  no hint (Cloudflare places the DO near the first requester — the pre-hint default behavior). */
export const DEPLOYMENT_LOCATION_HINT_ENV = "STACKBASE_DO_LOCATION_HINT";

/**
 * The complete set of `locationHint` values Cloudflare accepts, verified against the current
 * "Data location — Provide a location hint" reference table (2026-06). Sub-region `apac-ne`/`apac-se`
 * were added 2025-05-15. A value OUTSIDE this set passed to `get(id, { locationHint })` would silently
 * mis-place (or fail to place) a DO PERMANENTLY — hence every hint is validated against this set before
 * it reaches `get()`.
 */
export const LOCATION_HINTS = [
  "wnam", // Western North America
  "enam", // Eastern North America
  "sam", // South America
  "weur", // Western Europe
  "eeur", // Eastern Europe
  "apac", // Asia-Pacific
  "apac-ne", // Northeast Asia-Pacific
  "apac-se", // Southeast Asia-Pacific
  "oc", // Oceania
  "afr", // Africa
  "me", // Middle East
] as const;

export type LocationHint = (typeof LOCATION_HINTS)[number];

/** O(1)-membership set for fast validation (no array scan per request). */
export const KNOWN_LOCATION_HINTS: ReadonlySet<string> = new Set(LOCATION_HINTS);

/** True iff `value` is one of the 11 Cloudflare `locationHint` region codes. */
export function isValidLocationHint(value: string): value is LocationHint {
  return KNOWN_LOCATION_HINTS.has(value);
}
