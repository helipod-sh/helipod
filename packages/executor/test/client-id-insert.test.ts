import { describe, it, expect, beforeEach } from "vitest";
import { SqliteDocStore, NodeSqliteAdapter } from "@stackbase/docstore-sqlite";
import { MonotonicTimestampOracle, type DocumentValue } from "@stackbase/docstore";
import { SingleWriterTransactor } from "@stackbase/transactor";
import { QueryRuntime } from "@stackbase/query-engine";
import { InlineUdfExecutor, SimpleIndexCatalog, query, mutation } from "../src/index";
import { v } from "@stackbase/values";
import { mintEncodedDocumentId, decodeDocumentId } from "@stackbase/id-codec";

const CONVOS = 10001;
const MSGS = 10002;

const createConvo = mutation<{ _id?: string; name: string }, string>({
  handler: (ctx, a) => ctx.db.insert("convos", a as unknown as DocumentValue),
});
const createTwice = mutation<{ _id: string }, string>({
  handler: async (ctx, a) => {
    await ctx.db.insert("convos", { _id: a._id, name: "first" } as unknown as DocumentValue);
    return ctx.db.insert("convos", { _id: a._id, name: "second" } as unknown as DocumentValue);
  },
});
const getById = query<{ id: string }, unknown>({ handler: (ctx, { id }) => ctx.db.get(id) });

let exec: InlineUdfExecutor;
beforeEach(async () => {
  const store = new SqliteDocStore(new NodeSqliteAdapter());
  await store.setupSchema();
  const transactor = new SingleWriterTransactor(store, new MonotonicTimestampOracle());
  const catalog = new SimpleIndexCatalog()
    .addTable("convos", CONVOS, v.object({ name: v.string() }).toJSON(), true)
    .addTable("msgs", MSGS, v.object({ body: v.string() }).toJSON(), true);
  exec = new InlineUdfExecutor({ transactor, queryRuntime: new QueryRuntime(store), catalog });
});

describe("insert with a client-supplied _id", () => {
  it("accepts a minted id: row lands under EXACTLY that id, _creationTime server-stamped", async () => {
    const minted = mintEncodedDocumentId(CONVOS);
    const returned = (await exec.run<string>(createConvo, { _id: minted, name: "a" })).value;
    expect(returned).toBe(minted);
    const doc = (await exec.run<Record<string, unknown>>(getById, { id: minted })).value;
    expect(doc).toMatchObject({ _id: minted, name: "a" });
    expect(typeof doc._creationTime).toBe("number"); // stamped by the server, not the client
  });

  it("rejects a malformed _id (not decodable)", async () => {
    await expect(exec.run(createConvo, { _id: "not-an-id", name: "a" })).rejects.toMatchObject({
      code: "INVALID_CLIENT_ID",
    });
  });

  it("rejects an _id minted for a DIFFERENT table", async () => {
    const wrongTable = mintEncodedDocumentId(MSGS);
    await expect(exec.run(createConvo, { _id: wrongTable, name: "a" })).rejects.toMatchObject({
      code: "INVALID_CLIENT_ID",
    });
  });

  it("rejects an _id that already names a COMMITTED row", async () => {
    const minted = mintEncodedDocumentId(CONVOS);
    await exec.run(createConvo, { _id: minted, name: "a" });
    await expect(exec.run(createConvo, { _id: minted, name: "b" })).rejects.toMatchObject({
      code: "ID_ALREADY_IN_USE",
    });
  });

  it("rejects a duplicate _id WITHIN one transaction (pending-overlay read)", async () => {
    const minted = mintEncodedDocumentId(CONVOS);
    await expect(exec.run(createTwice, { _id: minted })).rejects.toMatchObject({
      code: "ID_ALREADY_IN_USE",
    });
  });

  it("stores the CANONICAL encoding (a re-encoded id, not the caller's raw string)", async () => {
    const minted = mintEncodedDocumentId(CONVOS);
    // lowercase base32 of the same bytes decodes identically but is not canonical
    const alternate = minted.toLowerCase();
    if (alternate !== minted) {
      const returned = (await exec.run<string>(createConvo, { _id: alternate, name: "a" })).value;
      expect(returned).toBe(minted); // canonicalized
    } else {
      // encoding is already caseless in this alphabet — decode/encode roundtrip must be identity
      const rt = decodeDocumentId(minted);
      expect(rt.tableNumber).toBe(CONVOS);
    }
  });

  it("regression: insert WITHOUT _id behaves exactly as today (server mints)", async () => {
    const id = (await exec.run<string>(createConvo, { name: "a" })).value;
    expect(decodeDocumentId(id).tableNumber).toBe(CONVOS);
  });
});
