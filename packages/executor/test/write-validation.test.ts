import { describe, it, expect, beforeEach } from "vitest";
import { SqliteDocStore, NodeSqliteAdapter } from "@stackbase/docstore-sqlite";
import { MonotonicTimestampOracle, type DocumentValue } from "@stackbase/docstore";
import { SingleWriterTransactor } from "@stackbase/transactor";
import { QueryRuntime } from "@stackbase/query-engine";
import { InlineUdfExecutor, SimpleIndexCatalog, query, mutation } from "../src/index";
import { v } from "@stackbase/values";

// --- functions (what a user would write in convex/) ---
const insDocs = mutation<{ n: unknown; extra?: boolean }, string>({
  handler: (ctx, a) => ctx.db.insert("docs", a as unknown as DocumentValue),
});
const insLoose = mutation<{ n: unknown }, string>({
  handler: (ctx, a) => ctx.db.insert("loose", a as unknown as DocumentValue),
});
const insBlobs = mutation<{ data: unknown }, string>({
  handler: (ctx, a) => ctx.db.insert("blobs", a as unknown as DocumentValue),
});
const getDoc = query<{ id: string }, unknown>({
  handler: (ctx, { id }) => ctx.db.get(id),
});
const repDoc = mutation<{ id: string; doc: unknown }, void>({
  handler: (ctx, { id, doc }) => ctx.db.replace(id, doc as unknown as DocumentValue),
});

let exec: InlineUdfExecutor;
beforeEach(async () => {
  const store = new SqliteDocStore(new NodeSqliteAdapter());
  await store.setupSchema();
  const transactor = new SingleWriterTransactor(store, new MonotonicTimestampOracle());
  const catalog = new SimpleIndexCatalog()
    .addTable("docs", 7, v.object({ n: v.number() }).toJSON(), true) // validated
    .addTable("loose", 8, v.object({ n: v.number() }).toJSON(), false) // schemaValidation off
    .addTable("blobs", 9, v.object({ data: v.any() }).toJSON(), true); // v.any() field
  exec = new InlineUdfExecutor({ transactor, queryRuntime: new QueryRuntime(store), catalog });
});

describe("write-path document validation", () => {
  it("rejects an insert whose value violates the schema", async () => {
    await expect(exec.run(insDocs, { n: "not-a-number" })).rejects.toThrow(/does not match schema/);
  });

  it("accepts a valid insert", async () => {
    await expect(exec.run(insDocs, { n: 1 })).resolves.toBeTruthy();
  });

  it("rejects an insert with an extra field", async () => {
    await expect(exec.run(insDocs, { n: 1, extra: true })).rejects.toThrow(/does not match schema/);
  });

  it("rejects a replace whose value violates the schema, but ignores system fields", async () => {
    const id = (await exec.run<string>(insDocs, { n: 1 })).value;
    const cur = (await exec.run<Record<string, unknown>>(getDoc, { id })).value;
    // replace with a doc that still carries _id/_creationTime (as from a get) + a valid n -> OK
    await expect(exec.run(repDoc, { id, doc: { ...cur, n: 2 } })).resolves.toBeDefined();
    // replace with a bad n -> rejects
    await expect(exec.run(repDoc, { id, doc: { ...cur, n: "x" } })).rejects.toThrow(/does not match schema/);
  });

  it("does not validate when schemaValidation is off", async () => {
    await expect(exec.run(insLoose, { n: "x" })).resolves.toBeTruthy();
  });

  it("accepts anything for a v.any() field", async () => {
    await expect(exec.run(insBlobs, { data: { arbitrary: [1, "two"] } })).resolves.toBeTruthy();
  });
});
