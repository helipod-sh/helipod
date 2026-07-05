/* Helipod Enterprise. Licensed under the Helipod Commercial License — see ee/LICENSE. */

/**
 * Per-shard geographic PLACEMENT derivation (M1 locality). A Durable Object is single-homed — pinned
 * to ONE data center at creation and never moved — and by default lands near whoever FIRST `get()`s it.
 * `get(id, { locationHint })` overrides that, but ONLY the first `get()` for a given DO is honored.
 * This is precisely WHY sharding unlocks geographic scale-out: each shard-DO is a distinct object, so
 * each can be placed near ITS OWN audience. The router derives that hint, per request, from the
 * envelope — the same "the envelope is the source of truth" model the shard key itself rides.
 *
 * Precedence (spec-locked; each must be STABLE per shard key so the first `get()` — the only one that
 * counts — is deterministic wherever possible):
 *
 *   (a) EXPLICIT — a `?region=<hint>` param or an `X-Helipod-Region: <hint>` header. App-controlled
 *       and fully deterministic; mirrors how the shard key itself is taken from `?shard=`. An invalid
 *       explicit hint is a hard error (the caller asked for a specific placement and got it wrong).
 *   (b) REGION-PREFIXED KEY (opt-in) — if enabled and the shard-key VALUE is a string of the form
 *       `"<hint>:<rest>"` whose prefix is a known hint (e.g. `"enam:room123"`), derive the hint from
 *       the prefix. Deterministic per key. OFF by default so an app that doesn't want a key format
 *       isn't forced into one; the full key value is still what names the DO (the prefix is only read).
 *   (c) AUTO from origin — `request.cf.continent` mapped to the nearest hint. This places a NEW shard
 *       near the user who first creates it. That is ALSO Cloudflare's own default (place near the first
 *       requester), so this is a made-explicit convenience, not a new guarantee — and it is
 *       "first-requester-wins", NOT stable across requesters, which is acceptable and documented.
 *   (d) DEFAULT — no hint. `get(id)` with no options bag: byte-identical to the pre-hint behavior.
 */
import { isValidLocationHint } from "@helipod/runtime-cloudflare";

/** The explicit-region envelope sources, mirroring the shard-key `?shard=` / `X-Helipod-Shard` pair. */
const REGION_HEADER = "x-helipod-region";
const REGION_PARAM = "region";

/**
 * Map a Cloudflare `request.cf.continent` code (`AF`/`AN`/`AS`/`EU`/`NA`/`OC`/`SA`) to the nearest
 * `locationHint`. Continent granularity is deliberately coarse (source (c) is a convenience, not a
 * precision tool — an app that needs finer placement uses the explicit or prefixed sources). Antarctica
 * (`AN`) is intentionally absent ⇒ no hint (there is no sensible nearby DO region). North America maps
 * to `enam` and Europe to `weur` as the documented continent-level defaults; reach for `?region=wnam`/
 * `eeur`/`apac-ne`/… when a finer placement matters.
 */
export const CONTINENT_TO_HINT: Readonly<Record<string, string>> = {
  AF: "afr",
  AS: "apac",
  EU: "weur",
  NA: "enam",
  OC: "oc",
  SA: "sam",
};

/** Resolve a continent code to a hint, or `undefined` if it is unknown/unmapped. */
export function continentToHint(continent: string | undefined | null): string | undefined {
  if (!continent) return undefined;
  return CONTINENT_TO_HINT[continent.toUpperCase()];
}

/** The `cf` object workerd attaches to an inbound Request (only the fields we read, structurally). */
interface RequestCfLike {
  continent?: string;
}

/** The outcome of hint derivation: a (possibly absent) valid hint, or a typed rejection for an
 *  explicit-but-invalid region. `hint: undefined` is the DEFAULT case — the caller passes no options
 *  bag, byte-identical to the pre-hint behavior. */
export type HintDerivation =
  | { ok: true; hint: string | undefined }
  | { ok: false; invalidRegion: string };

export interface DeriveLocationHintInput {
  url: URL;
  headers: Headers;
  /** `request.cf` if present (workerd populates it; `undefined` under Node/tests). */
  cf?: RequestCfLike;
  /** The resolved shard-key VALUE, used ONLY by the opt-in region-prefix source (b). */
  shardKeyValue?: unknown;
  /** Enable source (b): read a `"<hint>:<rest>"` prefix off the shard-key value. Off by default. */
  regionPrefixedKeys?: boolean;
}

/** Read the explicit `?region=` / `X-Helipod-Region` hint, if any (header wins, mirroring the
 *  shard-key precedence). Empty string counts as "not provided". */
function explicitRegion(url: URL, headers: Headers): string | null {
  const h = headers.get(REGION_HEADER);
  if (h && h.length > 0) return h;
  const q = url.searchParams.get(REGION_PARAM);
  if (q && q.length > 0) return q;
  return null;
}

/** Extract a `"<hint>:<rest>"` region prefix from a string shard-key value, iff the prefix is a known
 *  hint. Returns the hint or `undefined`. Never throws; a non-string value yields `undefined`. */
function regionFromKeyPrefix(shardKeyValue: unknown): string | undefined {
  if (typeof shardKeyValue !== "string") return undefined;
  const i = shardKeyValue.indexOf(":");
  if (i <= 0) return undefined;
  const prefix = shardKeyValue.slice(0, i);
  return isValidLocationHint(prefix) ? prefix : undefined;
}

/**
 * Derive the placement hint for a request, in precedence order (a) → (d). Returns `{ ok: true, hint }`
 * (hint possibly `undefined`) or `{ ok: false, invalidRegion }` when an EXPLICIT region hint is invalid.
 */
export function deriveLocationHint(input: DeriveLocationHintInput): HintDerivation {
  // (a) Explicit — validated; a wrong explicit hint is a hard error, never silently dropped.
  const explicit = explicitRegion(input.url, input.headers);
  if (explicit !== null) {
    if (!isValidLocationHint(explicit)) return { ok: false, invalidRegion: explicit };
    return { ok: true, hint: explicit };
  }

  // (b) Region-prefixed key (opt-in).
  if (input.regionPrefixedKeys) {
    const prefixed = regionFromKeyPrefix(input.shardKeyValue);
    if (prefixed) return { ok: true, hint: prefixed };
  }

  // (c) Auto from origin — first-requester-wins, matches CF's own default.
  const origin = continentToHint(input.cf?.continent);
  if (origin) return { ok: true, hint: origin };

  // (d) Default — no hint.
  return { ok: true, hint: undefined };
}
