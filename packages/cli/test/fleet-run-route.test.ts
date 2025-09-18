import { describe, it, expect } from "vitest";
import { SqliteDocStore, NodeSqliteAdapter } from "@stackbase/docstore-sqlite";
import { InMemoryLogSink, SimpleIndexCatalog, mutation, action } from "@stackbase/executor";
import { EmbeddedRuntime } from "@stackbase/runtime-embedded";
import { handleHttpRequest, type FleetHandles } from "../src/http-handler";

// Fleet's WriteForwarder (ee/packages/fleet/src/forwarder.ts, Task 3) needs `/_fleet/run`'s 200
// response to carry the write's `commitTs` (stringified, since bigints don't JSON.stringify) so it
// can wait for a local replica to catch up before resolving a forwarded write — read-your-own-
// writes. This is a focused unit test of that response shape, not a fleet E2E (no real Postgres
// primary/replica, no live fleet node) — mirrors admin-routes.test.ts's handleHttpRequest-direct
// style rather than spinning a container.

const fleetHandles: FleetHandles = {
  role: () => "writer",
  writerUrl: async () => "http://self:4000",
  onPromoted: () => {},
  stop: async () => {},
};

async function setup() {
  const store = new SqliteDocStore(new NodeSqliteAdapter());
  const catalog = new SimpleIndexCatalog();
  catalog.addTable("notes", 10001);
  const logSink = new InMemoryLogSink();
  const runtime = await EmbeddedRuntime.create({
    store,
    catalog,
    logSink,
    modules: {
      "notes:add": mutation(async (ctx, a: { title: string }) => ctx.db.insert("notes", a)),
      "notes:noop": mutation(async () => null),
      "notes:actAdd": action(async (ctx: any, a: { title: string }) => ctx.runMutation("notes:add", { title: a.title })),
    },
  });
  const info = { functions: ["notes:add", "notes:noop", "notes:actAdd"], tables: ["notes"] };
  return { runtime, admin: { api: undefined as never, key: "k" }, info };
}

describe("/_fleet/run response shape", () => {
  it("200 response includes a stringified commitTs alongside value", async () => {
    const { runtime, admin, info } = await setup();
    const res = await handleHttpRequest(
      runtime,
      {
        method: "POST",
        path: "/_fleet/run",
        body: JSON.stringify({ path: "notes:add", args: { title: "hi" }, identity: null, kind: "mutation" }),
        authorization: "Bearer k",
      },
      info,
      admin,
      undefined,
      undefined,
      fleetHandles,
    );
    expect(res.status).toBe(200);
    const body = JSON.parse(res.body) as { value: unknown; commitTs: string };
    expect(typeof body.commitTs).toBe("string");
    // A committing mutation's commitTs is a positive integer string (never "0", never a bigint
    // literal — bigints don't survive JSON.stringify, which is exactly why this is stringified).
    expect(BigInt(body.commitTs)).toBeGreaterThan(0n);
  });

  it("kind=action that commits via ctx.runMutation surfaces a non-\"0\" stringified commitTs (RYOW for actions)", async () => {
    const { runtime, admin, info } = await setup();
    const res = await handleHttpRequest(
      runtime,
      {
        method: "POST",
        path: "/_fleet/run",
        body: JSON.stringify({ path: "notes:actAdd", args: { title: "hi" }, identity: null, kind: "action" }),
        authorization: "Bearer k",
      },
      info,
      admin,
      undefined,
      undefined,
      fleetHandles,
    );
    expect(res.status).toBe(200);
    const body = JSON.parse(res.body) as { value: unknown; commitTs: string };
    // An action's `oplog` is always null (see http-handler.ts's fallback) — this proves the
    // `result.commitTs` fallback (the executor's max-inner-commitTs tracking) is what surfaces here.
    expect(body.commitTs).not.toBe("0");
    expect(BigInt(body.commitTs)).toBeGreaterThan(0n);
  });

  it("401 without the admin key — never reachable unauthenticated", async () => {
    const { runtime, admin, info } = await setup();
    const res = await handleHttpRequest(
      runtime,
      {
        method: "POST",
        path: "/_fleet/run",
        body: JSON.stringify({ path: "notes:add", args: {}, identity: null, kind: "mutation" }),
      },
      info,
      admin,
      undefined,
      undefined,
      fleetHandles,
    );
    expect(res.status).toBe(401);
  });
});
