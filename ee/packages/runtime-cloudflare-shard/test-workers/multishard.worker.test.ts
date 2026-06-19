/* Stackbase Enterprise. Licensed under the Stackbase Commercial License — see ee/LICENSE. */

/**
 * The M1 scale-out proof inside REAL Durable Objects (workerd) — the highest fidelity achievable
 * without a Cloudflare account. Drives the full stack through `SELF.fetch` (the Worker's multi-shard
 * router → the owning shard-DO), proving:
 *   1. writes to DIFFERENT shard keys land in DIFFERENT DOs — a write to key "A" is INVISIBLE to a
 *      query on key "B"'s DO (physical isolation, not a leak);
 *   2. each shard's reactive subscribe → commit → push works, and the reactivity is shard-ISOLATED
 *      (a commit on B's DO does NOT wake a subscriber on A's DO);
 *   3. a cross-shard fan-out against this mode-"key" fixture is REJECTED with the typed
 *      `FANOUT_REQUIRES_FIXED_SHARDS` (mode "key" addresses a new DO per key value with no enumerable
 *      shard set, so "all shards" is undefined here — never served partial data), and a `.shardBy`
 *      mutation missing its key is `SHARD_KEY_REQUIRED`. (fanOut SUCCEEDING against a fixed-shard-count
 *      mode-"hash" deployment is proven separately, in `fanout.worker.test.ts`.)
 *   4. two writes to two different shard keys commit independently (separate single-threaded DOs =
 *      the actual N× write scale-out claim).
 *
 * What this tier does NOT cover (needs a real `wrangler deploy`, which this worktree has no Cloudflare
 * login for): cross-datacenter routing latency and real hibernation eviction across shards. See
 * ./README for the human-run multi-shard deploy E2E.
 */
import { describe, it, expect } from "vitest";
import { SELF } from "cloudflare:test";
import { shardDoName } from "../src/canonical";

function post(path: string, bodyObj: unknown, headers: Record<string, string> = {}): Request {
  return new Request(`https://w.test${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(bodyObj),
  });
}
function send(roomId: string, body: string): Request {
  return post("/api/run", { path: "messages:send", args: { roomId, body } });
}
/** A list query carries its shard key explicitly (queries declare no shardBy). */
function list(roomId: string, shardKey: string): Request {
  return post(`/api/run?shard=${encodeURIComponent(shardKey)}`, { path: "messages:list", args: { roomId } });
}

async function bodies(res: Response): Promise<string[]> {
  const rows = ((await res.json()) as { value: Array<{ body: string }> }).value;
  return rows.map((r) => r.body);
}

describe("M1 multi-shard on REAL workerd", () => {
  it("routes distinct shard keys to distinct DOs — a write to A is invisible to B's DO", async () => {
    // Sanity: the router computes distinct DO names for the two keys.
    expect(shardDoName("roomA")).not.toBe(shardDoName("roomB"));

    // Two writes, routed by derive-from-args to two different shard-DOs.
    expect((await SELF.fetch(send("roomA", "hello-A"))).status).toBe(200);
    expect((await SELF.fetch(send("roomB", "hello-B"))).status).toBe(200);

    // Each shard's own query sees only its own data.
    expect(await bodies(await SELF.fetch(list("roomA", "roomA")))).toEqual(["hello-A"]);
    expect(await bodies(await SELF.fetch(list("roomB", "roomB")))).toEqual(["hello-B"]);

    // The load-bearing isolation assertion: query roomA's data but ROUTED to roomB's DO → empty.
    // roomA's write physically lives in roomA's DO-SQLite; roomB's DO never saw it.
    expect(await bodies(await SELF.fetch(list("roomA", "roomB")))).toEqual([]);
  });

  it("rejects a cross-shard fan-out with the typed error, serving no data (mode \"key\" has no fixed shard set)", async () => {
    const res = await SELF.fetch(post("/api/run?fanout=1", { path: "messages:list", args: { roomId: "roomA" } }));
    expect(res.status).toBe(400);
    const j = (await res.json()) as { error?: { code?: string }; value?: unknown };
    expect(j.error?.code).toBe("FANOUT_REQUIRES_FIXED_SHARDS");
    expect(j.value).toBeUndefined();
  });

  it("rejects a sharded mutation missing its shard key (SHARD_KEY_REQUIRED)", async () => {
    const res = await SELF.fetch(post("/api/run", { path: "messages:send", args: { body: "no room" } }));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("SHARD_KEY_REQUIRED");
  });

  it("fans a commit out to a shard-scoped WebSocket, and the reactivity is shard-ISOLATED", async () => {
    // Open a real WebSocket routed (by ?shard) to roomR's DO, through the multi-shard router.
    const upgrade = await SELF.fetch(
      new Request("https://w.test/api/sync?shard=roomR", { headers: { Upgrade: "websocket" } }),
    );
    expect(upgrade.status).toBe(101);
    const ws = upgrade.webSocket!;
    ws.accept();
    const received: string[] = [];
    ws.addEventListener("message", (e: MessageEvent) => {
      received.push(typeof e.data === "string" ? e.data : "");
    });

    ws.send(JSON.stringify({ type: "ModifyQuerySet", add: [{ queryId: 1, udfPath: "messages:list", args: { roomId: "roomR" } }], remove: [] }));
    await waitFor(() => received.some((m) => m.includes("Transition")));

    // A commit on roomR's OWN DO → the subscriber gets the reactive push.
    const before = received.length;
    await SELF.fetch(send("roomR", "reactive-in-R"));
    await waitFor(() => received.length > before && received.join("").includes("reactive-in-R"));
    expect(received.join("")).toContain("reactive-in-R");

    // A commit on a DIFFERENT shard's DO (roomOther) must NOT wake the roomR subscriber — reactivity
    // does not cross the DO boundary. We wait out a window and assert no roomOther push arrived.
    const afterR = received.length;
    await SELF.fetch(send("roomOther", "reactive-in-Other"));
    await sleep(300);
    expect(received.length).toBe(afterR);
    expect(received.join("")).not.toContain("reactive-in-Other");
    ws.close();
  });

  it("accepts an explicit ?region= placement hint end-to-end (the DO still serves correctly)", async () => {
    // A single vantage cannot OBSERVE which data center workerd placed the DO in, so this proves what
    // IS provable in real workerd: a hinted request threads through the router → get(id, {locationHint})
    // → the owning shard-DO and serves correctly. (The router-called-get-with-{locationHint} assertion
    // itself is pinned by the Node spy suite; true cross-region latency needs the deploy-pending rig.)
    expect((await SELF.fetch(post("/api/run?region=enam", { path: "messages:send", args: { roomId: "roomHinted", body: "hi-hinted" } }))).status).toBe(200);
    expect(await bodies(await SELF.fetch(list("roomHinted", "roomHinted")))).toEqual(["hi-hinted"]);
  });

  it("rejects an INVALID region hint at the edge (400), serving no data", async () => {
    const res = await SELF.fetch(post("/api/run?region=atlantis", { path: "messages:send", args: { roomId: "roomBad", body: "x" } }));
    expect(res.status).toBe(400);
    const j = (await res.json()) as { error?: { code?: string }; value?: unknown };
    expect(j.error?.code).toBe("INVALID_REGION_HINT");
    expect(j.value).toBeUndefined();
  });

  it("commits two different shard keys independently (separate single-threaded DOs = N× scale-out)", async () => {
    // Fire both concurrently: they hit two distinct DOs, each its own single thread, so neither
    // serializes behind the other. Both must commit and be independently readable.
    const [ra, rb] = await Promise.all([
      SELF.fetch(send("roomP", "P1")),
      SELF.fetch(send("roomQ", "Q1")),
    ]);
    expect(ra.status).toBe(200);
    expect(rb.status).toBe(200);
    expect(await bodies(await SELF.fetch(list("roomP", "roomP")))).toEqual(["P1"]);
    expect(await bodies(await SELF.fetch(list("roomQ", "roomQ")))).toEqual(["Q1"]);
  });
});

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
async function waitFor(cond: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
    await sleep(10);
  }
}
