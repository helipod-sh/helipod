/**
 * The shared location-hint knowledge (`src/location.ts`). This is the ONE source of truth for the
 * valid Cloudflare `locationHint` set, reused by both the free host and the ee shard router — so a
 * regression here (a dropped or invented hint) would mis-place DOs on BOTH hosts. The set is pinned
 * to Cloudflare's current "Provide a location hint" reference table (11 region codes; `apac-ne`/
 * `apac-se` added 2026-06). Jurisdictions (`eu`/`fedramp`) are deliberately NOT here — they are a
 * separate mechanism, not `locationHint` values.
 */
import { describe, it, expect } from "vitest";
import { LOCATION_HINTS, KNOWN_LOCATION_HINTS, isValidLocationHint, DEPLOYMENT_LOCATION_HINT_ENV } from "../src/location";

describe("location hints — the validated set", () => {
  it("is exactly the 11 Cloudflare region codes", () => {
    expect([...LOCATION_HINTS].sort()).toEqual(
      ["afr", "apac", "apac-ne", "apac-se", "eeur", "enam", "me", "oc", "sam", "weur", "wnam"].sort(),
    );
    expect(KNOWN_LOCATION_HINTS.size).toBe(11);
  });

  it("accepts every valid hint, including the apac sub-regions", () => {
    for (const h of LOCATION_HINTS) expect(isValidLocationHint(h)).toBe(true);
    expect(isValidLocationHint("apac-ne")).toBe(true);
    expect(isValidLocationHint("apac-se")).toBe(true);
  });

  it("rejects jurisdictions (they are NOT location hints) and garbage", () => {
    // Jurisdictions are a separate, stronger mechanism — never a locationHint value.
    expect(isValidLocationHint("eu")).toBe(false);
    expect(isValidLocationHint("us")).toBe(false);
    expect(isValidLocationHint("fedramp")).toBe(false);
    // Garbage / casing / regions that don't exist.
    expect(isValidLocationHint("ENAM")).toBe(false);
    expect(isValidLocationHint("moon")).toBe(false);
    expect(isValidLocationHint("")).toBe(false);
  });

  it("names the deployment-level env var", () => {
    expect(DEPLOYMENT_LOCATION_HINT_ENV).toBe("HELIPOD_DO_LOCATION_HINT");
  });
});
