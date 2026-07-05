/* Helipod Enterprise. Licensed under the Helipod Commercial License — see ee/LICENSE. */

/**
 * Per-shard placement-hint derivation (`src/location.ts`) — the precedence (a) explicit → (b) opt-in
 * region-prefixed key → (c) cf-origin → (d) default, plus the continent→hint map. These are pure
 * functions (no workerd), so they are exhaustively unit-testable under Node — the honest home for the
 * cf-origin mapping proof (a single vantage cannot force workerd to report a foreign continent).
 */
import { describe, it, expect } from "vitest";
import { deriveLocationHint, continentToHint, CONTINENT_TO_HINT } from "../src/location";

function url(path: string): URL {
  return new URL(`https://do.test${path}`);
}
function headers(h: Record<string, string> = {}): Headers {
  return new Headers(h);
}

describe("continentToHint — the origin map (source c)", () => {
  it("maps every supported continent to a valid nearby hint", () => {
    expect(continentToHint("NA")).toBe("enam");
    expect(continentToHint("EU")).toBe("weur");
    expect(continentToHint("AS")).toBe("apac");
    expect(continentToHint("OC")).toBe("oc");
    expect(continentToHint("SA")).toBe("sam");
    expect(continentToHint("AF")).toBe("afr");
  });

  it("is case-insensitive on the continent code", () => {
    expect(continentToHint("na")).toBe("enam");
    expect(continentToHint("eu")).toBe("weur");
  });

  it("returns undefined for Antarctica, unknown codes, and nullish input", () => {
    expect(continentToHint("AN")).toBeUndefined();
    expect(continentToHint("XX")).toBeUndefined();
    expect(continentToHint(undefined)).toBeUndefined();
    expect(continentToHint(null)).toBeUndefined();
    expect(continentToHint("")).toBeUndefined();
  });

  it("only ever maps to valid location hints", () => {
    // Every value in the map must be a real hint (guarded against a typo mis-placing a DO).
    const valid = new Set(["wnam", "enam", "sam", "weur", "eeur", "apac", "apac-ne", "apac-se", "oc", "afr", "me"]);
    for (const hint of Object.values(CONTINENT_TO_HINT)) expect(valid.has(hint)).toBe(true);
  });
});

describe("deriveLocationHint — precedence a → d", () => {
  it("(a) explicit ?region= wins and is returned verbatim", () => {
    const r = deriveLocationHint({ url: url("/api/sync?shard=roomA&region=weur"), headers: headers() });
    expect(r).toEqual({ ok: true, hint: "weur" });
  });

  it("(a) explicit X-Helipod-Region header wins over the query param", () => {
    const r = deriveLocationHint({
      url: url("/api/sync?region=weur"),
      headers: headers({ "x-helipod-region": "enam" }),
    });
    expect(r).toEqual({ ok: true, hint: "enam" });
  });

  it("(a) an INVALID explicit hint is a typed rejection, not silently dropped", () => {
    const r = deriveLocationHint({ url: url("/api/sync?region=atlantis"), headers: headers() });
    expect(r).toEqual({ ok: false, invalidRegion: "atlantis" });
  });

  it("(a) explicit beats a region-prefixed key AND cf-origin", () => {
    const r = deriveLocationHint({
      url: url("/api/sync?region=me"),
      headers: headers(),
      shardKeyValue: "enam:room1",
      regionPrefixedKeys: true,
      cf: { continent: "EU" },
    });
    expect(r).toEqual({ ok: true, hint: "me" });
  });

  it("(b) region-prefixed key derives the hint from the prefix — only when opted in", () => {
    const on = deriveLocationHint({
      url: url("/api/sync"),
      headers: headers(),
      shardKeyValue: "apac-ne:room1",
      regionPrefixedKeys: true,
    });
    expect(on).toEqual({ ok: true, hint: "apac-ne" });

    // Same key, opt-out (default): the prefix is NOT read; no hint from (b).
    const off = deriveLocationHint({ url: url("/api/sync"), headers: headers(), shardKeyValue: "apac-ne:room1" });
    expect(off).toEqual({ ok: true, hint: undefined });
  });

  it("(b) a non-hint prefix or a non-string key yields no prefix hint", () => {
    expect(
      deriveLocationHint({ url: url("/api/sync"), headers: headers(), shardKeyValue: "tenant42:room1", regionPrefixedKeys: true }),
    ).toEqual({ ok: true, hint: undefined });
    expect(
      deriveLocationHint({ url: url("/api/sync"), headers: headers(), shardKeyValue: 12345, regionPrefixedKeys: true }),
    ).toEqual({ ok: true, hint: undefined });
  });

  it("(b) beats cf-origin when both are present", () => {
    const r = deriveLocationHint({
      url: url("/api/sync"),
      headers: headers(),
      shardKeyValue: "enam:room1",
      regionPrefixedKeys: true,
      cf: { continent: "EU" },
    });
    expect(r).toEqual({ ok: true, hint: "enam" });
  });

  it("(c) cf-origin maps the request's continent when no explicit/prefix hint", () => {
    const r = deriveLocationHint({ url: url("/api/sync"), headers: headers(), cf: { continent: "EU" } });
    expect(r).toEqual({ ok: true, hint: "weur" });
  });

  it("(d) default — no signal at all ⇒ no hint (byte-identical forward)", () => {
    const r = deriveLocationHint({ url: url("/api/sync"), headers: headers() });
    expect(r).toEqual({ ok: true, hint: undefined });
  });
});
