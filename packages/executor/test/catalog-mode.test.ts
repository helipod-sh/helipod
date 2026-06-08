import { describe, it, expect } from "vitest";
import { SimpleIndexCatalog } from "../src/catalog";

describe("TableMeta.mode", () => {
  it("derives root / shard / global", () => {
    const c = new SimpleIndexCatalog();
    c.addTable("plain", 1, undefined, true, null, false);
    c.addTable("sharded", 2, undefined, true, "room", false);
    c.addTable("glob", 3, undefined, true, null, true);
    expect(c.getTable("plain")!.mode).toBe("root");
    expect(c.getTable("sharded")!.mode).toBe("shard");
    expect(c.getTable("glob")!.mode).toBe("global");
  });
  it("defaults to root when global/shardKey omitted (back-compat call)", () => {
    const c = new SimpleIndexCatalog();
    c.addTable("t", 1); // 2-arg call from addIndex auto-add
    expect(c.getTable("t")!.mode).toBe("root");
  });
});
