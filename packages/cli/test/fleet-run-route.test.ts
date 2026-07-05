import { describe, it, expect, vi } from "vitest";
import { SqliteDocStore, NodeSqliteAdapter } from "@helipod/docstore-sqlite";
import { InMemoryLogSink, SimpleIndexCatalog, mutation, action } from "@helipod/executor";
import { EmbeddedRuntime, type WriteRouter } from "@helipod/runtime-embedded";
import { systemModules } from "@helipod/admin";
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

// Shards B2b, Task 2: the `/_fleet/run` single-hop guard + `_system:*` forward routing. A "fake
// router spy" here is the RUNTIME's own `WriteRouter` (the receiving node's OWN `WriteForwarder` in
// production) — the whole point of the guard is that a forwarded call landing on a non-owner must
// reject WITHOUT ever reaching the runtime's mutation path (which would otherwise consult that
// router and potentially forward AGAIN, chasing a moving target unboundedly).

async function setupWithRouter(router: WriteRouter) {
  const store = new SqliteDocStore(new NodeSqliteAdapter());
  const catalog = new SimpleIndexCatalog();
  catalog.addTable("notes", 10001);
  const runtime = await EmbeddedRuntime.create({
    store,
    catalog,
    modules: { "notes:add": mutation(async (ctx, a: { title: string }) => ctx.db.insert("notes", a)) },
    writeRouter: router,
  });
  const info = { functions: ["notes:add"], tables: ["notes"] };
  return { runtime, admin: { api: undefined as never, key: "k" }, info };
}

function fleetHandlesWithOwnership(isLocalWriter: (shardId: string) => boolean): FleetHandles {
  return {
    role: () => "writer",
    writerUrl: async () => "http://self:4000",
    onPromoted: () => {},
    isLocalWriter,
    stop: async () => {},
  };
}

describe("/_fleet/run single-hop guard (Task 2, test b)", () => {
  it("forwarded:true on a NON-owner returns a retryable NOT_SHARD_OWNER error and never runs the mutation (forward spy untouched)", async () => {
    const forward = vi.fn(async () => ({ value: "should-never-run" }));
    const router: WriteRouter = { isLocalWriter: () => false, forward }; // this node owns nothing
    const { runtime, admin, info } = await setupWithRouter(router);
    const fleet = fleetHandlesWithOwnership(() => false);

    const res = await handleHttpRequest(
      runtime,
      {
        method: "POST",
        path: "/_fleet/run",
        body: JSON.stringify({ path: "notes:add", args: { title: "x" }, identity: null, kind: "mutation", shardId: "default", forwarded: true }),
        authorization: "Bearer k",
      },
      info,
      admin,
      undefined,
      undefined,
      fleet,
    );

    expect(res.status).toBe(409);
    const body = JSON.parse(res.body) as { code: string; error: string; errorJson: { retryable: boolean } };
    expect(body.code).toBe("NOT_SHARD_OWNER");
    expect(body.errorJson.retryable).toBe(true);
    expect(forward).not.toHaveBeenCalled(); // never re-forwarded — the receiver rejected outright
  });

  it("forwarded:true on the OWNER runs the mutation locally (never calls the runtime's own router.forward)", async () => {
    const forward = vi.fn(async () => ({ value: "should-never-run" }));
    const router: WriteRouter = { isLocalWriter: () => true, forward }; // this node IS the owner
    const { runtime, admin, info } = await setupWithRouter(router);
    const fleet = fleetHandlesWithOwnership(() => true);

    const res = await handleHttpRequest(
      runtime,
      {
        method: "POST",
        path: "/_fleet/run",
        body: JSON.stringify({ path: "notes:add", args: { title: "y" }, identity: null, kind: "mutation", shardId: "default", forwarded: true }),
        authorization: "Bearer k",
      },
      info,
      admin,
      undefined,
      undefined,
      fleet,
    );

    expect(res.status).toBe(200);
    // `notes:add`'s handler is `ctx.db.insert(...)`, which resolves to the new document's id.
    const body = JSON.parse(res.body) as { value: string };
    expect(typeof body.value).toBe("string");
    expect(forward).not.toHaveBeenCalled(); // ran locally — isLocalWriter(shardId) was true
  });

  it("omitting `forwarded` skips the guard entirely, even against a non-owner fleet handle (only the forwarder itself ever sets it)", async () => {
    const forward = vi.fn(async () => ({ value: "should-never-run" }));
    const router: WriteRouter = { isLocalWriter: () => true, forward };
    const { runtime, admin, info } = await setupWithRouter(router);
    const fleet = fleetHandlesWithOwnership(() => false); // would reject if the guard fired

    const res = await handleHttpRequest(
      runtime,
      {
        method: "POST",
        path: "/_fleet/run",
        body: JSON.stringify({ path: "notes:add", args: { title: "z" }, identity: null, kind: "mutation" }),
        authorization: "Bearer k",
      },
      info,
      admin,
      undefined,
      undefined,
      fleet,
    );

    expect(res.status).toBe(200); // the guard is opt-in via `forwarded`, matching every non-forwarding caller
  });
});

describe("/_fleet/run routes forwarded _system:* doc mutations via runSystem (Task 2, _system forward test)", () => {
  async function setupSystem() {
    const store = new SqliteDocStore(new NodeSqliteAdapter());
    const catalog = new SimpleIndexCatalog();
    catalog.addTable("notes", 10001);
    const runtime = await EmbeddedRuntime.create({
      store,
      catalog,
      modules: {},
      systemModules: systemModules(),
    });
    const info = { functions: [], tables: ["notes"] };
    return { runtime, admin: { api: undefined as never, key: "k" }, info };
  }

  it("a forwarded _system:insertDocument reaches the doc mutation (runtime.run's public gate would FunctionNotFoundError on an underscore path)", async () => {
    const { runtime, admin, info } = await setupSystem();
    const fleet = fleetHandlesWithOwnership(() => true); // this node owns the resolved shard

    const res = await handleHttpRequest(
      runtime,
      {
        method: "POST",
        path: "/_fleet/run",
        body: JSON.stringify({
          path: "_system:insertDocument",
          args: { table: "notes", fields: { title: "from-dashboard" } },
          identity: null,
          kind: "mutation",
          shardId: "default",
          forwarded: true,
        }),
        authorization: "Bearer k",
      },
      info,
      admin,
      undefined,
      undefined,
      fleet,
    );

    expect(res.status).toBe(200);
    const body = JSON.parse(res.body) as { value: { title: string } };
    expect(body.value.title).toBe("from-dashboard");
  });

  it("the single-hop guard still applies to a forwarded _system:* mutation on a non-owner", async () => {
    const { runtime, admin, info } = await setupSystem();
    const fleet = fleetHandlesWithOwnership(() => false);

    const res = await handleHttpRequest(
      runtime,
      {
        method: "POST",
        path: "/_fleet/run",
        body: JSON.stringify({
          path: "_system:insertDocument",
          args: { table: "notes", fields: { title: "x" } },
          identity: null,
          kind: "mutation",
          shardId: "s3",
          forwarded: true,
        }),
        authorization: "Bearer k",
      },
      info,
      admin,
      undefined,
      undefined,
      fleet,
    );

    expect(res.status).toBe(409);
    const body = JSON.parse(res.body) as { code: string };
    expect(body.code).toBe("NOT_SHARD_OWNER");
  });
});
