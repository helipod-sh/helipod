/* Helipod Enterprise. Licensed under the Helipod Commercial License — see ee/LICENSE. */

/**
 * The M2d fanOut ship gate — the multi-shard router's cross-shard READ path proven on REAL Durable
 * Objects (workerd), against the mode-"hash" fixture (`test-worker-hash.ts`, `numShards: 4`, own
 * project — `vitest.workers.hash.config.ts` / `wrangler.hash.jsonc`). Proves:
 *
 *   1. writes to keys hashing to DIFFERENT shards, followed by `POST /api/run?fanout=1` on a
 *      shard-key-less query, return the CONCATENATED UNION across every shard-DO (order-agnostic) —
 *      the fan-out-and-concat path (`worker.ts`'s `fanOut`) end to end, not mocked.
 *   2. `fanOut` + an explicit `?shard=` is rejected `FANOUT_WITH_SHARD_KEY` (target one shard OR fan
 *      out, never both).
 *   3. `fanOut` on the WebSocket `/api/sync` upgrade is rejected `FANOUT_NOT_SUBSCRIBABLE` (fanOut is
 *      a non-reactive one-shot read).
 *   4. a genuine single-shard failure (one shard-DO's OWN query handler throws — not a mocked
 *      namespace) degrades to failures-as-data: the surviving shards' rows plus a
 *      `partial.failedShards` entry naming the failed shard, status still 200. The Node-level
 *      `fanout-worker.test.ts` unit suite covers the throw/500/non-array taxonomy exhaustively against
 *      a scripted fake namespace; this proves the SAME contract holds when the "throw" is a real
 *      handler exception inside a real Durable Object.
 *
 * `mode: "key"`'s fan-out rejection (`FANOUT_REQUIRES_FIXED_SHARDS` — mode "key" has no enumerable
 * shard set) is proven in `multishard.worker.test.ts`, not here.
 */
import { describe, it, expect } from "vitest";
import { SELF } from "cloudflare:test";

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
function fanOutListAll(): Request {
  return post("/api/run?fanout=1", { path: "messages:listAll", args: {} });
}
function fanOutListAllStrict(): Request {
  return post("/api/run?fanout=1", { path: "messages:listAllStrict", args: {} });
}

async function jsonBody(res: Response): Promise<{
  value?: Array<{ body: string }>;
  partial?: { failedShards: Array<{ shardId: string; error: string }> };
  error?: { code?: string };
}> {
  return (await res.json()) as never;
}

describe("M2d fanOut on REAL workerd (mode \"hash\", numShards: 4)", () => {
  it("concatenates the union of rows written across ALL 4 shards", async () => {
    // Four room keys, each landing on a DIFFERENT one of shardIdList(4) = ["default","s1","s2","s3"]
    // (computed via shardIdForKeyValue — pinned here as fixture data, not recomputed at test time, so
    // the test documents the mapping it depends on):
    //   roomB -> "default", room1 -> "s1", roomA -> "s2", roomD -> "s3"
    const rooms: Array<[roomId: string, body: string]> = [
      ["roomB", "msg-default"],
      ["room1", "msg-s1"],
      ["roomA", "msg-s2"],
      ["roomD", "msg-s3"],
    ];
    for (const [roomId, body] of rooms) {
      expect((await SELF.fetch(send(roomId, body))).status).toBe(200);
    }

    const res = await SELF.fetch(fanOutListAll());
    expect(res.status).toBe(200);
    const body = await jsonBody(res);
    expect(body.partial).toBeUndefined();
    const bodies = (body.value ?? []).map((r) => r.body);
    // Order-agnostic: the union across shards, not any particular shard's ordering.
    expect(bodies).toEqual(expect.arrayContaining(["msg-default", "msg-s1", "msg-s2", "msg-s3"]));
  });

  it("rejects fanOut + an explicit shard key (FANOUT_WITH_SHARD_KEY)", async () => {
    const res = await SELF.fetch(post("/api/run?fanout=1&shard=roomA", { path: "messages:listAll", args: {} }));
    expect(res.status).toBe(400);
    const body = await jsonBody(res);
    expect(body.error?.code).toBe("FANOUT_WITH_SHARD_KEY");
    expect(body.value).toBeUndefined();
  });

  it("rejects fanOut on the WebSocket /api/sync upgrade (FANOUT_NOT_SUBSCRIBABLE)", async () => {
    const res = await SELF.fetch(new Request("https://w.test/api/sync?fanout=1", { headers: { Upgrade: "websocket" } }));
    expect(res.status).toBe(400);
    const body = await jsonBody(res);
    expect(body.error?.code).toBe("FANOUT_NOT_SUBSCRIBABLE");
    expect(body.value).toBeUndefined();
  });

  it("a REAL single-shard failure (the shard's own handler throws) degrades to failures-as-data", async () => {
    // roomSurv1 -> "s1", roomSurv2 -> "s2", roomSurv3 -> "default", roomBoom -> "s3" (same shard-id
    // mapping pinned above). Seed one survivor row per non-"s3" shard plus the "BOOM" sentinel row on
    // "s3" — `messages:listAllStrict` throws inside ANY shard whose own data contains "BOOM", so this
    // makes s3's shard-DO genuinely fail its `/api/run` call (a real thrown Error inside real workerd,
    // not a scripted namespace), while the other three shards still answer normally.
    for (const [roomId, body] of [
      ["roomSurv1", "surv-s1"],
      ["roomSurv2", "surv-s2"],
      ["roomSurv3", "surv-default"],
      ["roomBoom", "BOOM"],
    ] as const) {
      expect((await SELF.fetch(send(roomId, body))).status).toBe(200);
    }

    const res = await SELF.fetch(fanOutListAllStrict());
    expect(res.status).toBe(200); // fanOut never fails the whole request for one bad shard
    const body = await jsonBody(res);
    const bodies = (body.value ?? []).map((r) => r.body);
    expect(bodies).toEqual(expect.arrayContaining(["surv-s1", "surv-s2", "surv-default"]));
    expect(bodies).not.toContain("BOOM"); // s3's whole response was dropped, not filtered client-side
    expect(body.partial).toBeDefined();
    expect(body.partial!.failedShards).toHaveLength(1);
    expect(body.partial!.failedShards[0]!.shardId).toBe("s3");
  });
});
