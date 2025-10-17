/**
 * Fleet B4, Task 4 — `/api/health`'s `fleet.groupCommit` field. Nested inside the same `fleet` gate
 * `frontierStats` already uses (see `http-handler.ts`'s doc comment): zeroed (not absent) when the
 * counters are wired but the flag is off, absent when `groupCommitStats` isn't wired at all (an
 * older/stub `FleetHandles`) or no frontier reading exists yet. Mirrors `fleet-run-route.test.ts`'s
 * handleHttpRequest-direct style — no real fleet node needed for this shape assertion.
 */
import { describe, it, expect } from "vitest";
import { SqliteDocStore, NodeSqliteAdapter } from "@stackbase/docstore-sqlite";
import { SimpleIndexCatalog, mutation } from "@stackbase/executor";
import { createEmbeddedRuntime } from "@stackbase/runtime-embedded";
import { handleHttpRequest, type FleetHandles, type ServerInfo } from "../src/http-handler";

const info: ServerInfo = { functions: [], tables: [] };

const baseFleet = {
  role: () => "writer" as const,
  writerUrl: async () => "http://self:4000",
  onPromoted: () => {},
  stop: async () => {},
};

async function makeRuntime(groupCommit: boolean) {
  const store = new SqliteDocStore(new NodeSqliteAdapter());
  const catalog = new SimpleIndexCatalog();
  catalog.addTable("notes", 10001);
  return createEmbeddedRuntime({
    store,
    catalog,
    modules: { "notes:add": mutation(async (ctx, a: { title: string }) => ctx.db.insert("notes", a)) },
    groupCommit,
  });
}

async function health(fleet: FleetHandles): Promise<{ status: string; fleet?: Record<string, unknown> }> {
  const res = await handleHttpRequest(
    await makeRuntime(false),
    { method: "GET", path: "/api/health" },
    info,
    undefined,
    undefined,
    undefined,
    fleet,
  );
  expect(res.status).toBe(200);
  return JSON.parse(res.body) as { status: string; fleet?: Record<string, unknown> };
}

describe("/api/health — fleet.groupCommit", () => {
  it("absent when the fleet handle has no frontierStats reading (fleet section itself absent)", async () => {
    const fleet: FleetHandles = { ...baseFleet, groupCommitStats: () => ({ lastBatchSize: 3, maxBatchSize: 9, flushCount: 4, flushesPerSec: 1 }) };
    const body = await health(fleet);
    expect(body.fleet).toBeUndefined();
  });

  it("absent when groupCommitStats isn't wired (older/stub FleetHandles), even with a frontier reading", async () => {
    const fleet: FleetHandles = { ...baseFleet, frontierStats: () => ({ frontier: 5n, lagMs: 0, pinningShard: "default" }) };
    const body = await health(fleet);
    expect(body.fleet).toBeDefined();
    expect(body.fleet?.groupCommit).toBeUndefined();
  });

  it("zeroed (present, not absent) when groupCommitStats is wired but the flag is off", async () => {
    const fleet: FleetHandles = {
      ...baseFleet,
      frontierStats: () => ({ frontier: 5n, lagMs: 0, pinningShard: "default" }),
      groupCommitStats: () => ({ lastBatchSize: 0, maxBatchSize: 0, flushCount: 0, flushesPerSec: 0 }),
    };
    const body = await health(fleet);
    expect(body.fleet?.groupCommit).toEqual({ lastBatchSize: 0, maxBatchSize: 0, flushCount: 0, flushesPerSec: 0 });
  });

  it("real counters surface verbatim when the flag is on and batching has engaged", async () => {
    const fleet: FleetHandles = {
      ...baseFleet,
      frontierStats: () => ({ frontier: 5n, lagMs: 0, pinningShard: "default" }),
      groupCommitStats: () => ({ lastBatchSize: 7, maxBatchSize: 12, flushCount: 40, flushesPerSec: 2.5 }),
    };
    const body = await health(fleet);
    expect(body.fleet?.groupCommit).toEqual({ lastBatchSize: 7, maxBatchSize: 12, flushCount: 40, flushesPerSec: 2.5 });
  });
});
