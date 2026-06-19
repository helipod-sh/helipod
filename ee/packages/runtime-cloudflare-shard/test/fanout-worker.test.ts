/* Stackbase Enterprise. Licensed under the Stackbase Commercial License — see ee/LICENSE. */
import { describe, it, expect } from "vitest";
import { createShardWorkerHandler } from "../src/worker";

/** A fake DO namespace whose `get(id).fetch` returns a scripted per-shard `Response`, driven by a
 *  `Map<shardId, () => Promise<Response>>` script. `idFromName` returns the name verbatim as the id
 *  (matching worker.test.ts's fakeNamespace convention), so the script can be keyed by shard name. */
function scriptedNamespace(script: Record<string, () => Promise<Response> | Response>) {
  const calls: string[] = [];
  const ns = {
    idFromName(name: string) {
      return name;
    },
    get(id: string) {
      return {
        async fetch(_req: Request): Promise<Response> {
          calls.push(id);
          const entry = script[id];
          if (!entry) throw new Error(`scriptedNamespace: no script entry for shard "${id}"`);
          const res = entry();
          return res instanceof Promise ? res : res;
        },
      };
    },
  };
  return { ns, calls };
}

const jsonRes = (status: number, value: unknown) =>
  new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });

const fanoutReq = () =>
  new Request("https://w.test/api/run?fanout=1", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path: "reports:allUsers", args: {} }),
  });

describe("createShardWorkerHandler — fanOut", () => {
  it("concatenates two shards' arrays, no partial", async () => {
    const rowA = { _id: "a", n: 1 };
    const rowB = { _id: "b", n: 2 };
    const { ns } = scriptedNamespace({
      default: () => jsonRes(200, { value: [rowA] }),
      s1: () => jsonRes(200, { value: [rowB] }),
    });
    const handler = createShardWorkerHandler("STACKBASE_DO", { mode: "hash", numShards: 2 });
    const res = await handler.fetch(fanoutReq(), { STACKBASE_DO: ns });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { value: unknown[]; partial?: unknown };
    expect(body.value).toEqual([rowA, rowB]);
    expect(body.partial).toBeUndefined();
  });

  it("a throwing shard becomes a failedShard; survivors still returned", async () => {
    const rowA = { _id: "a", n: 1 };
    const { ns } = scriptedNamespace({
      default: () => jsonRes(200, { value: [rowA] }),
      s1: () => {
        throw new Error("boom");
      },
    });
    const handler = createShardWorkerHandler("STACKBASE_DO", { mode: "hash", numShards: 2 });
    const res = await handler.fetch(fanoutReq(), { STACKBASE_DO: ns });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      value: unknown[];
      partial?: { failedShards: Array<{ shardId: string; error: string }> };
    };
    expect(body.value).toEqual([rowA]);
    expect(body.partial).toBeDefined();
    expect(body.partial!.failedShards).toHaveLength(1);
    expect(body.partial!.failedShards[0]!.shardId).toBe("s1");
    expect(body.partial!.failedShards[0]!.error).toContain("boom");
  });

  it("a non-200 shard response becomes a failedShard", async () => {
    const rowA = { _id: "a", n: 1 };
    const { ns } = scriptedNamespace({
      default: () => jsonRes(200, { value: [rowA] }),
      s1: () => jsonRes(500, { error: "internal" }),
    });
    const handler = createShardWorkerHandler("STACKBASE_DO", { mode: "hash", numShards: 2 });
    const res = await handler.fetch(fanoutReq(), { STACKBASE_DO: ns });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      value: unknown[];
      partial?: { failedShards: Array<{ shardId: string; error: string }> };
    };
    expect(body.value).toEqual([rowA]);
    expect(body.partial!.failedShards[0]!.shardId).toBe("s1");
  });

  it("a shard returning a non-array value is recorded as a failed shard, not thrown", async () => {
    const rowA = { _id: "a", n: 1 };
    const { ns } = scriptedNamespace({
      default: () => jsonRes(200, { value: [rowA] }),
      s1: () => jsonRes(200, { value: { not: "an array" } }),
    });
    const handler = createShardWorkerHandler("STACKBASE_DO", { mode: "hash", numShards: 2 });
    const res = await handler.fetch(fanoutReq(), { STACKBASE_DO: ns });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      value: unknown[];
      partial?: { failedShards: Array<{ shardId: string; error: string }> };
    };
    expect(body.value).toEqual([rowA]);
    expect(body.partial).toBeDefined();
    expect(body.partial!.failedShards).toHaveLength(1);
    expect(body.partial!.failedShards[0]!.shardId).toBe("s1");
    expect(body.partial!.failedShards[0]!.error).toContain("not an array");
  });

  it("does not exceed the concurrency cap in-flight (bounded pool over many shards)", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const N = 20;
    const script: Record<string, () => Promise<Response>> = {};
    for (let i = 0; i < N; i++) {
      const shardId = i === 0 ? "default" : `s${i}`;
      script[shardId] = async () => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((r) => setTimeout(r, 5));
        inFlight--;
        return jsonRes(200, { value: [{ _id: shardId }] });
      };
    }
    const { ns } = scriptedNamespace(script);
    const handler = createShardWorkerHandler("STACKBASE_DO", { mode: "hash", numShards: N });
    const res = await handler.fetch(fanoutReq(), { STACKBASE_DO: ns });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { value: unknown[] };
    expect(body.value).toHaveLength(N);
    expect(maxInFlight).toBeLessThanOrEqual(8); // FANOUT_CONCURRENCY
  });
});
