import { describe, it, expect } from "vitest";
import {
  MemoryTableRegistry,
  isSystemTableName,
  getFullTableName,
  parseFullTableName,
  USER_TABLE_NUMBER_START,
  STORAGE_TABLE_NUMBER,
  DEFAULT_SHARD,
  DefaultShardKeyResolver,
  FieldShardKeyResolver,
  SimpleShardRouter,
  encodeStorageIndexId,
  decodeStorageIndexId,
} from "../src/index";

describe("MemoryTableRegistry", () => {
  it("allocates user tables from 10001 and is idempotent", () => {
    const reg = new MemoryTableRegistry();
    const messages = reg.allocate("messages");
    const users = reg.allocate("users");
    expect(messages.tableNumber).toBe(USER_TABLE_NUMBER_START);
    expect(users.tableNumber).toBe(USER_TABLE_NUMBER_START + 1);
    expect(reg.allocate("messages")).toBe(messages); // idempotent
    expect(reg.getByName("messages")).toBe(messages);
    expect(reg.getByNumber(messages.tableNumber)).toBe(messages);
  });

  it("allocates system tables in the 1–9999 range", () => {
    const reg = new MemoryTableRegistry();
    const sys = reg.allocate("_scheduled");
    expect(sys.visibility).toBe("system");
    expect(sys.tableNumber).toBeLessThan(10000);
    expect(reg.allocate("messages").tableNumber).toBeGreaterThanOrEqual(USER_TABLE_NUMBER_START);
  });

  it("stores the shard key on the table (seam #1)", () => {
    const reg = new MemoryTableRegistry();
    const messages = reg.allocate("messages", { shardKey: "conversationId" });
    expect(messages.shardKey).toBe("conversationId");
  });

  it("preassign seeds a known number, is idempotent, and never collides with later allocate()", () => {
    const reg = new MemoryTableRegistry();
    const jobs = reg.preassign("scheduler/jobs", 10002);
    expect(jobs.tableNumber).toBe(10002);
    expect(jobs.visibility).toBe("user");
    expect(reg.getByName("scheduler/jobs")).toBe(jobs);
    expect(reg.getByNumber(10002)).toBe(jobs);

    // idempotent: re-preassigning the same name with a different number is a no-op.
    expect(reg.preassign("scheduler/jobs", 99999)).toBe(jobs);
    expect(jobs.tableNumber).toBe(10002);

    // a NEW name allocated afterward gets a number above the seeded max — no collision.
    const tags = reg.allocate("tags");
    expect(tags.tableNumber).toBeGreaterThan(10002);
    expect(tags.tableNumber).not.toBe(10002);
  });

  it("preassign bumps the system counter too, and defaults visibility from the name", () => {
    const reg = new MemoryTableRegistry();
    const sys = reg.preassign("_scheduled", 42);
    expect(sys.visibility).toBe("system");
    const nextSys = reg.allocate("_other");
    expect(nextSys.tableNumber).toBeGreaterThan(42);
  });
});

describe("reserved system tables (_storage)", () => {
  it("classifies _storage as a system table", () => {
    expect(isSystemTableName("_storage")).toBe(true);
  });

  it("has a stable reserved number that preassign pins deterministically", () => {
    expect(STORAGE_TABLE_NUMBER).toBe(20);

    // Seeding a fresh registry with the reserved number is stable and idempotent regardless of
    // what else has been allocated — a persisted Id<"_storage"> must always decode to 20.
    const reg = new MemoryTableRegistry();
    const storage = reg.preassign("_storage", STORAGE_TABLE_NUMBER);
    expect(storage.tableNumber).toBe(20);
    expect(storage.visibility).toBe("system");
    expect(reg.getByNumber(20)).toBe(storage);
    expect(reg.preassign("_storage", 999)).toBe(storage); // first-wins
    expect(storage.tableNumber).toBe(20);
  });
});

describe("table name helpers", () => {
  it("recognizes system tables and component-qualified names", () => {
    expect(isSystemTableName("_scheduled")).toBe(true);
    expect(isSystemTableName("messages")).toBe(false);
    expect(getFullTableName("messages", "chat")).toBe("chat/messages");
    expect(parseFullTableName("chat/messages")).toEqual({ componentPath: "chat", name: "messages" });
    expect(parseFullTableName("messages")).toEqual({ componentPath: "", name: "messages" });
  });
});

describe("storage index ids", () => {
  it("round-trips table number and index name", () => {
    const id = encodeStorageIndexId(10001, "by_conversation");
    expect(decodeStorageIndexId(id)).toEqual({ tableNumber: 10001, indexName: "by_conversation" });
  });
});

describe("sharding seam (Tier 0)", () => {
  it("DefaultShardKeyResolver never shards", () => {
    expect(new DefaultShardKeyResolver().resolve()).toBeNull();
  });

  it("FieldShardKeyResolver extracts the configured field", () => {
    const resolver = new FieldShardKeyResolver(new Map([["messages", "conversationId"]]));
    expect(resolver.resolve({ table: "messages", document: { conversationId: "c1", body: "hi" } })).toBe("c1");
    expect(resolver.resolve({ table: "users", document: { name: "x" } })).toBeNull();
    expect(resolver.resolve({ table: "messages", document: { body: "hi" } })).toBeNull();
  });

  it("SimpleShardRouter always returns the default shard", () => {
    const router = new SimpleShardRouter();
    expect(router.getShardForKey("c1")).toBe(DEFAULT_SHARD);
    expect(router.getShardForDocument("messages", "c1")).toBe(DEFAULT_SHARD);
    expect(router.getSyncNodeId("client-123")).toBe("local");
  });
});
