/**
 * Fleet B4, Task 4 — `STACKBASE_GROUP_COMMIT` env parsing (`groupCommitEnabled`, boot.ts) and its
 * threading into `bootLoaded` (non-fleet path — the fleet path threads its own already-resolved
 * value via `opts.fleet.groupCommit`, covered at the `@stackbase/fleet` level). Default OFF at this
 * task; mirrors `@stackbase/fleet`'s `fleetMultiWriterEnabled` boolean-env shape.
 */
import { describe, it, expect, afterEach } from "vitest";
import { rmSync } from "node:fs";
import { groupCommitEnabled, resolveGroupCommit, bootLoaded } from "../src/boot";
import { loadConvexDir } from "../src/load-modules";

describe("groupCommitEnabled", () => {
  it("true for 1 / true / yes, case-insensitive", () => {
    expect(groupCommitEnabled("1")).toBe(true);
    expect(groupCommitEnabled("true")).toBe(true);
    expect(groupCommitEnabled("True")).toBe(true);
    expect(groupCommitEnabled("TRUE")).toBe(true);
    expect(groupCommitEnabled("yes")).toBe(true);
    expect(groupCommitEnabled("YES")).toBe(true);
  });

  it("false for unset/blank/anything else — default OFF", () => {
    expect(groupCommitEnabled(undefined)).toBe(false);
    expect(groupCommitEnabled("")).toBe(false);
    expect(groupCommitEnabled("0")).toBe(false);
    expect(groupCommitEnabled("false")).toBe(false);
    expect(groupCommitEnabled("no")).toBe(false);
    expect(groupCommitEnabled("on")).toBe(false);
    expect(groupCommitEnabled("garbage")).toBe(false);
  });
});

describe("resolveGroupCommit — store-conditional default (single-node)", () => {
  const PG = "postgres://u:p@h:5432/db";
  const PGQL = "postgresql://u:p@h/db";

  it("unset env → ON for Postgres, OFF for SQLite (no url)", () => {
    expect(resolveGroupCommit({ envRaw: undefined, databaseUrl: PG })).toBe(true);
    expect(resolveGroupCommit({ envRaw: undefined, databaseUrl: PGQL })).toBe(true);
    expect(resolveGroupCommit({ envRaw: undefined, databaseUrl: undefined })).toBe(false);
    expect(resolveGroupCommit({ envRaw: undefined, databaseUrl: "/tmp/db.sqlite" })).toBe(false);
  });

  it("empty env string is treated as unset → store-conditional", () => {
    expect(resolveGroupCommit({ envRaw: "", databaseUrl: PG })).toBe(true);
    expect(resolveGroupCommit({ envRaw: "", databaseUrl: undefined })).toBe(false);
  });

  it("explicit env always wins, overriding the store default either direction", () => {
    // explicit OFF on Postgres
    expect(resolveGroupCommit({ envRaw: "0", databaseUrl: PG })).toBe(false);
    expect(resolveGroupCommit({ envRaw: "false", databaseUrl: PG })).toBe(false);
    // explicit ON on SQLite
    expect(resolveGroupCommit({ envRaw: "1", databaseUrl: undefined })).toBe(true);
    expect(resolveGroupCommit({ envRaw: "yes", databaseUrl: "/tmp/db.sqlite" })).toBe(true);
  });
});

describe("bootLoaded — STACKBASE_GROUP_COMMIT threads into the runtime (non-fleet)", () => {
  const DATA_DIR = "./.tmp-groupcommit-boot";
  const DATA = `${DATA_DIR}/db.sqlite`;
  const ENV_KEY = "STACKBASE_GROUP_COMMIT";
  const savedEnv = process.env[ENV_KEY];

  afterEach(() => {
    rmSync(DATA_DIR, { recursive: true, force: true });
    if (savedEnv === undefined) delete process.env[ENV_KEY];
    else process.env[ENV_KEY] = savedEnv;
  });

  it("absent + SQLite store: runtime.groupCommitStats() stays all-zero after a committing mutation (store-conditional default → OFF for SQLite)", async () => {
    delete process.env[ENV_KEY];
    const loaded = await loadConvexDir("test/fixtures/shard-dev/convex");
    const { runtime, store } = await bootLoaded({ loaded, components: [], dataPath: DATA, adminKey: "k" });
    await runtime.run("messages:send", { channelId: "c1", body: "hi" });
    expect(runtime.groupCommitStats()).toEqual({ lastBatchSize: 0, maxBatchSize: 0, flushCount: 0 });
    store.close();
  });

  it("STACKBASE_GROUP_COMMIT=1: a committing mutation flushes through the grouped path", async () => {
    process.env[ENV_KEY] = "1";
    const loaded = await loadConvexDir("test/fixtures/shard-dev/convex");
    const { runtime, store } = await bootLoaded({ loaded, components: [], dataPath: DATA, adminKey: "k" });
    await runtime.run("messages:send", { channelId: "c1", body: "hi" });
    const stats = runtime.groupCommitStats();
    expect(stats.flushCount).toBe(1);
    expect(stats.lastBatchSize).toBe(1);
    store.close();
  });

  it("STACKBASE_GROUP_COMMIT=0: byte-identical to absent — all-zero counters", async () => {
    process.env[ENV_KEY] = "0";
    const loaded = await loadConvexDir("test/fixtures/shard-dev/convex");
    const { runtime, store } = await bootLoaded({ loaded, components: [], dataPath: DATA, adminKey: "k" });
    await runtime.run("messages:send", { channelId: "c1", body: "hi" });
    expect(runtime.groupCommitStats()).toEqual({ lastBatchSize: 0, maxBatchSize: 0, flushCount: 0 });
    store.close();
  });
});
