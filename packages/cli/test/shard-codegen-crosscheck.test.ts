/**
 * Shards B2a, Task 5 — the codegen-time shardBy cross-check (D7), wired into `loadProject`/`push`
 * (packages/cli/src/project.ts): every mutation whose `shardBy` is a plain arg-name STRING is
 * validated against the schema at push time (dev boot + every hot reload + `helipod codegen`).
 */
import { describe, it, expect } from "vitest";
import { v, defineSchema, defineTable } from "@helipod/values";
import { mutation, query } from "@helipod/executor";
import { push, type LoadedProject } from "../src/index";

const schema = defineSchema({
  messages: defineTable({ channelId: v.string(), body: v.string() })
    .index("by_channel", ["channelId"])
    .shardKey("channelId"),
});

describe("push — shardBy codegen cross-check", () => {
  it("a valid shardBy declaration (arg exists, required, type matches) does not throw", () => {
    const messages = {
      send: mutation({
        args: { channelId: v.string(), body: v.string() },
        shardBy: "channelId",
        handler: (ctx: unknown, args: { channelId: string; body: string }) => args,
      }),
    };
    const loaded: LoadedProject = { schema, modules: { messages } };
    expect(() => push(loaded)).not.toThrow();
  });

  it("throws when shardBy names an arg that isn't declared", () => {
    const messages = {
      send: mutation({
        args: { body: v.string() },
        shardBy: "channelId",
        handler: (ctx: unknown, args: { body: string }) => args,
      }),
    };
    const loaded: LoadedProject = { schema, modules: { messages } };
    expect(() => push(loaded)).toThrow(/not one of its declared args/);
  });

  it("throws when shardBy's arg type disagrees with the sharded table's shard-key field type", () => {
    const messages = {
      send: mutation({
        args: { channelId: v.number(), body: v.string() }, // table's channelId is v.string()
        shardBy: "channelId",
        handler: (ctx: unknown, args: { channelId: number; body: string }) => args,
      }),
    };
    const loaded: LoadedProject = { schema, modules: { messages } };
    expect(() => push(loaded)).toThrow(/invalid shardBy declaration/);
  });

  it("throws when the mutation declares no args validator at all", () => {
    const messages = {
      send: mutation({
        shardBy: "channelId",
        handler: (ctx: unknown, args: { channelId: string; body: string }) =>
          args,
      }),
    };
    const loaded: LoadedProject = { schema, modules: { messages } };
    expect(() => push(loaded)).toThrow(/no args validator/);
  });

  it("a resolver-function shardBy is opaque to codegen (dynamic fallthrough) — never throws, regardless of args", () => {
    const messages = {
      // No `channelId` arg at all — a static string-name check would reject this, but a resolver
      // function has no static arg name for codegen to check; it falls through to the kernel
      // guards at runtime (D7 scope-down).
      send: mutation({
        args: { body: v.string() },
        shardBy: (args: { body: string }) => args.body,
        handler: (ctx: unknown, args: { body: string }) => args,
      }),
    };
    const loaded: LoadedProject = { schema, modules: { messages } };
    expect(() => push(loaded)).not.toThrow();
  });

  it("a mutation with no shardBy at all is untouched by the check", () => {
    const messages = {
      list: query({ handler: () => [] }),
    };
    const loaded: LoadedProject = { schema, modules: { messages } };
    expect(() => push(loaded)).not.toThrow();
  });

  it("skips the type-match check (but still requires the arg to exist+be required) when the schema has no table sharding by that field name", () => {
    const unrelatedSchema = defineSchema({ notes: defineTable({ text: v.string() }) });
    const notes = {
      send: mutation({
        args: { roomId: v.number() },
        shardBy: "roomId",
        handler: (ctx: unknown, args: { roomId: number }) => args,
      }),
    };
    const loaded: LoadedProject = { schema: unrelatedSchema, modules: { notes } };
    expect(() => push(loaded)).not.toThrow();
  });
});
