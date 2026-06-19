import { describe, it, expect } from "vitest";
import { resolveShard } from "../src/route";

const runReq = (q = "", body: unknown = { path: "reports:allUsers", args: {} }, method = "POST", path = "/api/run") =>
  new Request(`https://w.test${path}${q}`, { method, headers: { "content-type": "application/json" }, body: method === "POST" ? JSON.stringify(body) : undefined });

describe("resolveShard fanOut", () => {
  it("mode hash + ?fanout=1 of a QUERY (no shard key) → fanout resolution over shardIdList(N)", async () => {
    // C1: fanOut is allowed ONLY for a resolved `query`, so the happy path now needs a `loaded`
    // module set the router can classify `reports:allUsers` from.
    const loaded = { modules: { reports: { allUsers: { type: "query" } } } } as never;
    const r = await resolveShard(runReq("?fanout=1"), { mode: "hash", numShards: 4, loaded });
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
  it("fanOut of a .shardBy MUTATION → rejected (fanOut is a read) [subsumed under FANOUT_NOT_A_QUERY]", async () => {
    // `loaded` with a sharded mutation named `msgs:send`. The dedicated `.shardBy`-mutation check has
    // been subsumed by the general query-only guard (C1) — still a 400, now under FANOUT_NOT_A_QUERY.
    const loaded = { modules: { msgs: { send: { type: "mutation", shardBy: "roomId" } } } } as never;
    const r = await resolveShard(runReq("?fanout=1", { path: "msgs:send", args: { roomId: "x" } }), { mode: "hash", numShards: 2, loaded });
    expect(r.kind).toBe("error");
    if (r.kind === "error") {
      expect(r.status).toBe(400);
      expect(r.body.error.code).toBe("FANOUT_NOT_A_QUERY");
    }
  });
  it("fanOut of a non-sharded MUTATION → FANOUT_NOT_A_QUERY [C1 regression — previously fell through to fanout]", async () => {
    const loaded = { modules: { notes: { add: { type: "mutation" } } } } as never;
    const r = await resolveShard(runReq("?fanout=1", { path: "notes:add", args: { text: "hi" } }), { mode: "hash", numShards: 2, loaded });
    expect(r.kind).toBe("error");
    if (r.kind === "error") expect(r.body.error.code).toBe("FANOUT_NOT_A_QUERY");
  });
  it("fanOut of an ACTION → FANOUT_NOT_A_QUERY [C1 regression]", async () => {
    const loaded = { modules: { jobs: { run: { type: "action" } } } } as never;
    const r = await resolveShard(runReq("?fanout=1", { path: "jobs:run", args: {} }), { mode: "hash", numShards: 2, loaded });
    expect(r.kind).toBe("error");
    if (r.kind === "error") expect(r.body.error.code).toBe("FANOUT_NOT_A_QUERY");
  });
  it("fanOut of a QUERY → still resolves to fanout resolution [C1 happy path]", async () => {
    const loaded = { modules: { reports: { allUsers: { type: "query" } } } } as never;
    const r = await resolveShard(runReq("?fanout=1", { path: "reports:allUsers", args: {} }), { mode: "hash", numShards: 2, loaded });
    expect(r.kind).toBe("fanout");
    if (r.kind === "fanout") expect(r.shardIds).toEqual(["default", "s1"]);
  });
  it("fanOut with NO `loaded` module set → FANOUT_NOT_A_QUERY (fail-closed) [C1]", async () => {
    // The target's type cannot be classified with no loaded module set to consult, so the request
    // must be rejected rather than assumed to be a query and fanned out.
    const r = await resolveShard(runReq("?fanout=1"), { mode: "hash", numShards: 4 });
    expect(r.kind).toBe("error");
    if (r.kind === "error") {
      expect(r.status).toBe(400);
      expect(r.body.error.code).toBe("FANOUT_NOT_A_QUERY");
    }
  });
  it("no fanout flag → unchanged (default/derived/explicit routing) [regression]", async () => {
    const r = await resolveShard(runReq("?shard=roomA"), { mode: "hash", numShards: 4 });
    expect(r.kind).toBe("shard");
  });
});
