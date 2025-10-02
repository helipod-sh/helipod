import { describe, it, expect } from "vitest";
import { v, defineSchema, defineTable } from "@stackbase/values";
import { validateShardByDeclarations, assertShardByDeclarations, type ShardByDeclaration } from "../src/index";

const schema = defineSchema({
  // Sharded by `channelId` (string) — the common case a `shardBy: "channelId"` mutation cross-checks against.
  messages: defineTable({ channelId: v.string(), body: v.string() }).shardKey("channelId"),
  // A second table sharded by a DIFFERENT field name, so `channelId`-only checks stay unambiguous.
  reactions: defineTable({ emoji: v.string() }).shardKey("emoji"),
  // Unsharded — never matched by the ambiguity/type-match step.
  notes: defineTable({ text: v.string() }),
}).export();

describe("validateShardByDeclarations (Shards B2a, D7)", () => {
  it("passes for a shardBy arg that exists, is required, and matches the sharded table's field type", () => {
    const decls: ShardByDeclaration[] = [
      { functionPath: "messages:send", argName: "channelId", argsJson: v.object({ channelId: v.string(), body: v.string() }).toJSON() },
    ];
    expect(validateShardByDeclarations(schema, decls)).toEqual([]);
  });

  it("errors when the mutation declares no args validator at all", () => {
    const decls: ShardByDeclaration[] = [{ functionPath: "messages:send", argName: "channelId", argsJson: undefined }];
    const errors = validateShardByDeclarations(schema, decls);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/no args validator/);
    expect(errors[0]).toContain("messages:send");
    expect(errors[0]).toContain("channelId");
  });

  it("errors when the named arg is not among the declared args", () => {
    const decls: ShardByDeclaration[] = [
      { functionPath: "messages:send", argName: "channelId", argsJson: v.object({ body: v.string() }).toJSON() },
    ];
    const errors = validateShardByDeclarations(schema, decls);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/not one of its declared args/);
  });

  it("errors when the named arg is declared optional", () => {
    const decls: ShardByDeclaration[] = [
      {
        functionPath: "messages:send",
        argName: "channelId",
        argsJson: v.object({ channelId: v.optional(v.string()), body: v.string() }).toJSON(),
      },
    ];
    const errors = validateShardByDeclarations(schema, decls);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/v\.optional/);
  });

  it("errors on a type mismatch against the ONE table sharded by the same field name", () => {
    const decls: ShardByDeclaration[] = [
      // `messages.channelId` is v.string(); this mutation declares it as v.number() instead.
      { functionPath: "messages:send", argName: "channelId", argsJson: v.object({ channelId: v.number(), body: v.string() }).toJSON() },
    ];
    const errors = validateShardByDeclarations(schema, decls);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/type number.*table "messages".*type string/s);
  });

  it("skips the type-match check when NO table shards by that field name (ambiguity — falls through to kernel guards)", () => {
    const decls: ShardByDeclaration[] = [
      // "roomId" names no table's shardKey — codegen can't know what type it "should" be.
      { functionPath: "rooms:send", argName: "roomId", argsJson: v.object({ roomId: v.number() }).toJSON() },
    ];
    expect(validateShardByDeclarations(schema, decls)).toEqual([]);
  });

  it("skips the type-match check when MORE THAN ONE table shards by the same field name (ambiguous)", () => {
    const ambiguousSchema = defineSchema({
      a: defineTable({ key: v.string() }).shardKey("key"),
      b: defineTable({ key: v.number() }).shardKey("key"), // same field name, different type — deliberately ambiguous
    }).export();
    const decls: ShardByDeclaration[] = [{ functionPath: "x:y", argName: "key", argsJson: v.object({ key: v.boolean() }).toJSON() }];
    expect(validateShardByDeclarations(ambiguousSchema, decls)).toEqual([]);
  });

  it("multiple violations are all reported, not just the first", () => {
    const decls: ShardByDeclaration[] = [
      { functionPath: "messages:send", argName: "channelId", argsJson: undefined },
      { functionPath: "messages:other", argName: "channelId", argsJson: v.object({ channelId: v.number() }).toJSON() },
    ];
    expect(validateShardByDeclarations(schema, decls)).toHaveLength(2);
  });
});

describe("assertShardByDeclarations", () => {
  it("is a no-op when there are no violations", () => {
    const decls: ShardByDeclaration[] = [
      { functionPath: "messages:send", argName: "channelId", argsJson: v.object({ channelId: v.string() }).toJSON() },
    ];
    expect(() => assertShardByDeclarations(schema, decls)).not.toThrow();
  });

  it("throws one Error combining every violation when there are any", () => {
    const decls: ShardByDeclaration[] = [{ functionPath: "messages:send", argName: "channelId", argsJson: undefined }];
    expect(() => assertShardByDeclarations(schema, decls)).toThrow(/invalid shardBy declaration/);
  });
});
