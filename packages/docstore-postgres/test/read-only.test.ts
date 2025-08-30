import { describe, it, expect, beforeEach } from "vitest";
import { PostgresDocStore } from "../src/postgres-docstore";
import { ReadOnlyStoreError } from "../src/index";
import { PgliteClient } from "./pglite-client";
import { newDocumentId } from "@stackbase/id-codec";
import type { DocumentLogEntry, InternalDocumentId } from "@stackbase/docstore";

const TABLE = 10001;
function rev(id: InternalDocumentId, ts: bigint, prevTs: bigint | null, body: string | null): DocumentLogEntry {
  return { ts, id, prev_ts: prevTs, value: body === null ? null : { id, value: { body, n: ts } } };
}

describe("read-only store mode", () => {
  let store: PostgresDocStore;
  let client: PgliteClient;

  beforeEach(async () => {
    client = new PgliteClient();
    store = new PostgresDocStore(client, { readOnly: true });
    await store.setupSchema();
  });

  it("rejects write() with ReadOnlyStoreError while readOnly", async () => {
    const id = newDocumentId(TABLE);
    await expect(store.write([rev(id, 1n, null, "v1")], [], "Error")).rejects.toBeInstanceOf(ReadOnlyStoreError);
  });

  it("accepts write() after setWritable() promotes the store", async () => {
    const id = newDocumentId(TABLE);
    store.setWritable();
    await store.write([rev(id, 1n, null, "v1")], [], "Error");
    expect((await store.get(id))!.value.value.body).toBe("v1");
  });

  it("tryAcquireWriterLock() resolves true on PGlite (single-connection, contention unobservable)", async () => {
    await expect(client.tryAcquireWriterLock()).resolves.toBe(true);
  });
});
