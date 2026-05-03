/* Stackbase Enterprise. Licensed under the Stackbase Commercial License — see ee/LICENSE. */
import { describe, it, expect } from "vitest";
import type { LoadedProject } from "@stackbase/cli/project";
import { resolveShard } from "../src/route";
import { shardDoName, DEFAULT_SHARD_DO_NAME } from "../src/canonical";
import { SHARD_KEY_REQUIRED, CROSS_SHARD_UNSUPPORTED, INVALID_REGION_HINT } from "../src/errors";

// A minimal LoadedProject whose only job is to expose function metadata to the derive path. `schema`
// is unused by routing, so a cast is honest here.
const loaded = {
  schema: {} as never,
  modules: {
    messages: {
      // Sharded mutation: shardBy is the arg name "roomId".
      send: { type: "mutation", shardBy: "roomId", handler: () => {} },
      // Sharded mutation with a resolver function.
      sendResolved: { type: "mutation", shardBy: (a: { rid: string }) => a.rid, handler: () => {} },
      // Unsharded mutation.
      touch: { type: "mutation", handler: () => {} },
      // A query (never declares shardBy).
      list: { type: "query", handler: () => {} },
    },
  },
} as unknown as LoadedProject;

function get(path: string, headers: Record<string, string> = {}): Request {
  return new Request(`https://do.test${path}`, { method: "GET", headers });
}
function run(bodyObj: unknown, headers: Record<string, string> = {}): Request {
  return new Request("https://do.test/api/run", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(bodyObj),
  });
}

describe("resolveShard — default routing", () => {
  it("routes a request with no shard signal to the default DO", async () => {
    const r = await resolveShard(get("/api/health"));
    expect(r).toEqual({ kind: "shard", name: DEFAULT_SHARD_DO_NAME });
  });

  it("routes an unsharded mutation (no shardBy) to the default DO", async () => {
    const r = await resolveShard(run({ path: "messages:touch", args: {} }), { loaded });
    expect(r).toEqual({ kind: "shard", name: DEFAULT_SHARD_DO_NAME });
  });
});

describe("resolveShard — explicit envelope key (source #1)", () => {
  it("routes by the X-Stackbase-Shard header", async () => {
    const r = await resolveShard(get("/api/sync", { "x-stackbase-shard": "roomA" }));
    expect(r).toEqual({ kind: "shard", name: shardDoName("roomA") });
  });

  it("routes by the ?shard= query param (the WebSocket-upgrade path)", async () => {
    const r = await resolveShard(get("/api/sync?shard=roomB"));
    expect(r).toEqual({ kind: "shard", name: shardDoName("roomB") });
  });

  it("two different keys resolve to two different DO names", async () => {
    const a = await resolveShard(get("/api/sync?shard=roomA"));
    const b = await resolveShard(get("/api/sync?shard=roomB"));
    expect((a as { name: string }).name).not.toBe((b as { name: string }).name);
  });

  it("header wins over query param", async () => {
    const r = await resolveShard(get("/api/sync?shard=roomB", { "x-stackbase-shard": "roomA" }));
    expect((r as { name: string }).name).toBe(shardDoName("roomA"));
  });
});

describe("resolveShard — derive from POST /api/run args (source #2)", () => {
  it("derives a sharded mutation's key from a string shardBy arg", async () => {
    const r = await resolveShard(run({ path: "messages:send", args: { roomId: "roomA", body: "hi" } }), { loaded });
    expect((r as { name: string }).name).toBe(shardDoName("roomA"));
  });

  it("derives from a shardBy RESOLVER function", async () => {
    const r = await resolveShard(run({ path: "messages:sendResolved", args: { rid: "roomZ" } }), { loaded });
    expect((r as { name: string }).name).toBe(shardDoName("roomZ"));
  });

  it("derived name equals the explicit-envelope name for the SAME value", async () => {
    const derived = await resolveShard(run({ path: "messages:send", args: { roomId: "roomA" } }), { loaded });
    const explicit = await resolveShard(get("/api/sync?shard=roomA"));
    expect((derived as { name: string }).name).toBe((explicit as { name: string }).name);
  });

  it("rejects a sharded mutation whose args omit the shard key (SHARD_KEY_REQUIRED)", async () => {
    const r = await resolveShard(run({ path: "messages:send", args: { body: "no room" } }), { loaded });
    expect(r.kind).toBe("error");
    if (r.kind === "error") {
      expect(r.status).toBe(400);
      expect(r.body.error.code).toBe(SHARD_KEY_REQUIRED);
    }
  });

  it("an explicit key overrides derivation (skips the body read)", async () => {
    const r = await resolveShard(
      run({ path: "messages:send", args: { roomId: "roomA" } }, { "x-stackbase-shard": "roomB" }),
      { loaded },
    );
    expect((r as { name: string }).name).toBe(shardDoName("roomB"));
  });

  it("without a loaded project, a run request falls back to the default DO", async () => {
    const r = await resolveShard(run({ path: "messages:send", args: { roomId: "roomA" } }));
    expect((r as { name: string }).name).toBe(DEFAULT_SHARD_DO_NAME);
  });
});

describe("resolveShard — cross-shard is refused, never fanned out (M1 non-goal)", () => {
  it("rejects an X-Stackbase-Fanout header", async () => {
    const r = await resolveShard(get("/api/run", { "x-stackbase-fanout": "true" }));
    expect(r.kind).toBe("error");
    if (r.kind === "error") expect(r.body.error.code).toBe(CROSS_SHARD_UNSUPPORTED);
  });

  it("rejects a ?fanout=1 query param", async () => {
    const r = await resolveShard(get("/api/run?fanout=1"));
    expect(r.kind).toBe("error");
    if (r.kind === "error") expect(r.body.error.code).toBe(CROSS_SHARD_UNSUPPORTED);
  });

  it("rejects a multi-valued (comma) shard key", async () => {
    const r = await resolveShard(get("/api/sync?shard=roomA,roomB"));
    expect(r.kind).toBe("error");
    if (r.kind === "error") expect(r.body.error.code).toBe(CROSS_SHARD_UNSUPPORTED);
  });
});

describe("resolveShard — mode 'hash'", () => {
  it("resolves to the portable ShardId string", async () => {
    const r = await resolveShard(get("/api/sync?shard=roomA"), { mode: "hash", numShards: 8 });
    expect((r as { name: string }).name).toBe(shardDoName("roomA", "hash", 8));
  });
});

describe("resolveShard — geographic placement hint (locationHint threading)", () => {
  it("threads an explicit ?region= hint onto the shard resolution, next to the (unchanged) name", async () => {
    const r = await resolveShard(get("/api/sync?shard=roomA&region=enam"));
    expect(r).toEqual({ kind: "shard", name: shardDoName("roomA"), locationHint: "enam" });
  });

  it("threads the X-Stackbase-Region header hint", async () => {
    const r = await resolveShard(get("/api/sync?shard=roomA", { "x-stackbase-region": "weur" }));
    expect(r).toEqual({ kind: "shard", name: shardDoName("roomA"), locationHint: "weur" });
  });

  it("rejects an INVALID explicit region hint (never mis-places a DO permanently)", async () => {
    const r = await resolveShard(get("/api/sync?shard=roomA&region=nowhere"));
    expect(r.kind).toBe("error");
    if (r.kind === "error") {
      expect(r.status).toBe(400);
      expect(r.body.error.code).toBe(INVALID_REGION_HINT);
    }
  });

  it("no region signal ⇒ NO locationHint key on the resolution (byte-identical to pre-hint)", async () => {
    const r = await resolveShard(get("/api/sync?shard=roomA"));
    expect(r).toEqual({ kind: "shard", name: shardDoName("roomA") });
    expect("locationHint" in r).toBe(false);
  });

  it("derives the hint from a region-prefixed key ONLY when opted in — key name unchanged either way", async () => {
    const req = () => get("/api/sync?shard=enam:roomA");
    const off = await resolveShard(req());
    expect(off).toEqual({ kind: "shard", name: shardDoName("enam:roomA") });

    const on = await resolveShard(req(), { regionPrefixedKeys: true });
    expect(on).toEqual({ kind: "shard", name: shardDoName("enam:roomA"), locationHint: "enam" });
    // The DO NAME is the full key value in both cases — the prefix is read for placement only.
    expect((on as { name: string }).name).toBe((off as { name: string }).name);
  });

  it("places the DERIVE-from-args path too (explicit region + a POST /api/run mutation)", async () => {
    const r = await resolveShard(
      run({ path: "messages:send", args: { roomId: "roomA" } }, { "x-stackbase-region": "apac-se" }),
      { loaded },
    );
    expect(r).toEqual({ kind: "shard", name: shardDoName("roomA"), locationHint: "apac-se" });
  });

  it("a cf-origin continent places a NEW shard when no explicit/prefix hint", async () => {
    // Simulate workerd's request.cf by attaching it to the Request object the router reads.
    const req = get("/api/sync?shard=roomA");
    Object.defineProperty(req, "cf", { value: { continent: "EU" }, configurable: true });
    const r = await resolveShard(req);
    expect(r).toEqual({ kind: "shard", name: shardDoName("roomA"), locationHint: "weur" });
  });
});

describe("resolveShard — O(1) statelessness (no shared shard bottleneck)", () => {
  it("resolving a key is independent of how many other keys were resolved before it", async () => {
    // The router holds NO shard map / coordinator / lock: the name is a pure function of the key. So the
    // resolution for a key must be identical whether it is the 1st or the 10,001st key routed — proving
    // routing cost does not grow with shard count (the no-shared-bottleneck guarantee).
    const alone = await resolveShard(get("/api/sync?shard=target"));
    const names = new Set<string>();
    for (let i = 0; i < 10_000; i++) {
      const r = await resolveShard(get(`/api/sync?shard=k${i}`));
      names.add((r as { name: string }).name);
    }
    expect(names.size).toBe(10_000); // every distinct key ⇒ a distinct DO, no collisions/coalescing
    const afterMany = await resolveShard(get("/api/sync?shard=target"));
    expect(afterMany).toEqual(alone); // identical resolution — no accumulated per-shard state
  });
});
