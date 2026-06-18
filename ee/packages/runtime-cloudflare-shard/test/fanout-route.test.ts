import { describe, it, expect } from "vitest";
import { resolveShard } from "../src/route";

const runReq = (q = "", body: unknown = { path: "reports:allUsers", args: {} }, method = "POST", path = "/api/run") =>
  new Request(`https://w.test${path}${q}`, { method, headers: { "content-type": "application/json" }, body: method === "POST" ? JSON.stringify(body) : undefined });

describe("resolveShard fanOut", () => {
  it("mode hash + ?fanout=1 (no shard key) → fanout resolution over shardIdList(N)", async () => {
    const r = await resolveShard(runReq("?fanout=1"), { mode: "hash", numShards: 4 });
    expect(r.kind).toBe("fanout");
    if (r.kind === "fanout") expect(r.shardIds).toEqual(["default", "s1", "s2", "s3"]);
  });
  it("mode key + ?fanout=1 → FANOUT_REQUIRES_FIXED_SHARDS", async () => {
    const r = await resolveShard(runReq("?fanout=1"), { mode: "key" });
    expect(r.kind).toBe("error");
    if (r.kind === "error") { expect(r.status).toBe(400); expect(r.body.error.code).toBe("FANOUT_REQUIRES_FIXED_SHARDS"); }
  });
  it("fanOut + a shard key → FANOUT_WITH_SHARD_KEY", async () => {
    const r = await resolveShard(runReq("?fanout=1&shard=roomA"), { mode: "hash", numShards: 2 });
    expect(r.kind).toBe("error");
    if (r.kind === "error") expect(r.body.error.code).toBe("FANOUT_WITH_SHARD_KEY");
  });
  it("fanOut on /api/sync (WS) → FANOUT_NOT_SUBSCRIBABLE", async () => {
    const req = new Request("https://w.test/api/sync?fanout=1", { headers: { Upgrade: "websocket" } });
    const r = await resolveShard(req, { mode: "hash", numShards: 2 });
    expect(r.kind).toBe("error");
    if (r.kind === "error") expect(r.body.error.code).toBe("FANOUT_NOT_SUBSCRIBABLE");
  });
  it("fanOut of a .shardBy MUTATION → rejected (fanOut is a read)", async () => {
    // `loaded` with a sharded mutation named `msgs:send`
    const loaded = { modules: { msgs: { send: { type: "mutation", shardBy: "roomId" } } } } as never;
    const r = await resolveShard(runReq("?fanout=1", { path: "msgs:send", args: { roomId: "x" } }), { mode: "hash", numShards: 2, loaded });
    expect(r.kind).toBe("error");
    // code: reuse FANOUT_WITH_SHARD_KEY or a dedicated "fanOut is read-only" message — assert it's a 400 error, not a fanout resolution
    if (r.kind === "error") expect(r.status).toBe(400);
  });
  it("no fanout flag → unchanged (default/derived/explicit routing) [regression]", async () => {
    const r = await resolveShard(runReq("?shard=roomA"), { mode: "hash", numShards: 4 });
    expect(r.kind).toBe("shard");
  });
});
