/**
 * Shards B2a, Task 5 — NUM_SHARDS first-boot config: `HELIPOD_FLEET_SHARDS` env parsing,
 * persist-once via `writeGlobalIfAbsent`, and the boot-fails-fast-on-mismatch story.
 */
import { describe, it, expect, afterEach } from "vitest";
import { rmSync } from "node:fs";
import type { JSONValue } from "@helipod/values";
import {
  parseNumShards,
  resolveNumShards,
  numShardsMismatchError,
  DEFAULT_NUM_SHARDS,
  NUM_SHARDS_GLOBAL_KEY,
  bootLoaded,
} from "../src/boot";
import { loadFunctionsDir } from "../src/load-modules";

describe("parseNumShards", () => {
  it("parses a positive integer string", () => {
    expect(parseNumShards("8")).toBe(8);
    expect(parseNumShards("1")).toBe(1);
    expect(parseNumShards("32")).toBe(32);
  });

  it("returns undefined for unset/blank/invalid values", () => {
    expect(parseNumShards(undefined)).toBeUndefined();
    expect(parseNumShards("")).toBeUndefined();
    expect(parseNumShards("   ")).toBeUndefined();
    expect(parseNumShards("0")).toBeUndefined();
    expect(parseNumShards("-1")).toBeUndefined();
    expect(parseNumShards("3.5")).toBeUndefined();
    expect(parseNumShards("not-a-number")).toBeUndefined();
  });
});

/** Minimal in-memory `getGlobal`/`writeGlobalIfAbsent` fake — mirrors the real
 *  SQLite/Postgres `persistence_globals` KV contract without any I/O. */
class FakeGlobalsStore {
  private readonly globals = new Map<string, JSONValue>();
  async getGlobal(key: string): Promise<JSONValue | null> {
    return this.globals.has(key) ? this.globals.get(key)! : null;
  }
  async writeGlobalIfAbsent(key: string, value: JSONValue): Promise<boolean> {
    if (this.globals.has(key)) return false;
    this.globals.set(key, value);
    return true;
  }
}

describe("resolveNumShards", () => {
  it("first boot, no env: persists and returns the default (8)", async () => {
    const store = new FakeGlobalsStore();
    const n = await resolveNumShards(store, undefined);
    expect(n).toBe(DEFAULT_NUM_SHARDS);
    expect(await store.getGlobal(NUM_SHARDS_GLOBAL_KEY)).toBe(String(DEFAULT_NUM_SHARDS));
  });

  it("first boot, env set: persists and returns the env value", async () => {
    const store = new FakeGlobalsStore();
    const n = await resolveNumShards(store, 16);
    expect(n).toBe(16);
    expect(await store.getGlobal(NUM_SHARDS_GLOBAL_KEY)).toBe("16");
  });

  it("later boot, no env: returns the persisted value unchanged", async () => {
    const store = new FakeGlobalsStore();
    await resolveNumShards(store, 4);
    const n = await resolveNumShards(store, undefined);
    expect(n).toBe(4);
  });

  it("later boot, env agrees with the persisted value: returns it", async () => {
    const store = new FakeGlobalsStore();
    await resolveNumShards(store, 8);
    await expect(resolveNumShards(store, 8)).resolves.toBe(8);
  });

  it("later boot, env disagrees with the persisted value: fails fast naming both", async () => {
    const store = new FakeGlobalsStore();
    await resolveNumShards(store, 8);
    await expect(resolveNumShards(store, 4)).rejects.toThrow(/8/);
    await expect(resolveNumShards(store, 4)).rejects.toThrow(/4/);
    await expect(resolveNumShards(store, 4)).rejects.toThrow(/immutable/);
  });

  it("numShardsMismatchError names both values and mentions resharding", () => {
    const err = numShardsMismatchError(3, 8);
    expect(err.message).toContain("3");
    expect(err.message).toContain("8");
    expect(err.message.toLowerCase()).toContain("reshard");
  });

  it("a lost first-boot race adopts the value that actually landed, still enforcing the mismatch check", async () => {
    const store = new FakeGlobalsStore();
    // Simulate a peer that already won the race before we ever read.
    await store.writeGlobalIfAbsent(NUM_SHARDS_GLOBAL_KEY, "8");
    // Our own attempt disagrees with what landed — env still fails fast.
    await expect(resolveNumShards(store, 4)).rejects.toThrow(/8/);
    // No env opinion — adopts whatever won.
    await expect(resolveNumShards(store, undefined)).resolves.toBe(8);
  });
});

describe("bootLoaded — NUM_SHARDS persists across boots (non-fleet)", () => {
  const DATA_DIR = "./.tmp-numshards-boot";
  const DATA = `${DATA_DIR}/db.sqlite`;
  const ENV_KEY = "HELIPOD_FLEET_SHARDS";
  const savedEnv = process.env[ENV_KEY];

  afterEach(() => {
    rmSync(DATA_DIR, { recursive: true, force: true });
    if (savedEnv === undefined) delete process.env[ENV_KEY];
    else process.env[ENV_KEY] = savedEnv;
  });

  it("persists the resolved count at first boot and reuses it on a later boot with no env override", async () => {
    delete process.env[ENV_KEY];
    const loaded = await loadFunctionsDir("test/fixtures/shard-dev/helipod");

    const first = await bootLoaded({ loaded, components: [], dataPath: DATA, adminKey: "k" });
    expect(await first.store.getGlobal(NUM_SHARDS_GLOBAL_KEY)).toBe(String(DEFAULT_NUM_SHARDS));
    first.store.close();

    // Re-open the SAME sqlite file — a second boot must see the persisted value, not re-decide.
    const second = await bootLoaded({ loaded, components: [], dataPath: DATA, adminKey: "k" });
    expect(await second.store.getGlobal(NUM_SHARDS_GLOBAL_KEY)).toBe(String(DEFAULT_NUM_SHARDS));
    second.store.close();
  });

  it("a later boot with a disagreeing HELIPOD_FLEET_SHARDS fails fast, naming both values", async () => {
    delete process.env[ENV_KEY];
    const loaded = await loadFunctionsDir("test/fixtures/shard-dev/helipod");
    const first = await bootLoaded({ loaded, components: [], dataPath: DATA, adminKey: "k" });
    first.store.close();

    process.env[ENV_KEY] = "3"; // disagrees with the persisted default (8)
    await expect(bootLoaded({ loaded, components: [], dataPath: DATA, adminKey: "k" })).rejects.toThrow(/8/);
  });

  it("a later boot with an AGREEING HELIPOD_FLEET_SHARDS boots normally", async () => {
    delete process.env[ENV_KEY];
    const loaded = await loadFunctionsDir("test/fixtures/shard-dev/helipod");
    const first = await bootLoaded({ loaded, components: [], dataPath: DATA, adminKey: "k" });
    first.store.close();

    process.env[ENV_KEY] = String(DEFAULT_NUM_SHARDS);
    const second = await bootLoaded({ loaded, components: [], dataPath: DATA, adminKey: "k" });
    expect(typeof second.runtime.run).toBe("function");
    second.store.close();
  });
});
