import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeSqliteAdapter, SqliteDocStore } from "../src/index";
import { newDocumentId, encodeStorageTableId } from "@stackbase/id-codec";
import type { DocumentLogEntry, InternalDocumentId } from "@stackbase/docstore";

const TABLE = 10002;
const TABLE_ID = encodeStorageTableId(TABLE);

function tmpFile(): string {
  const dir = mkdtempSync(join(tmpdir(), "docstore-close-"));
  return join(dir, "store.sqlite");
}

function makeStore(path: string): SqliteDocStore {
  return new SqliteDocStore(new NodeSqliteAdapter({ path }));
}

function rev(id: InternalDocumentId, ts: bigint, prevTs: bigint | null, body: string | null): DocumentLogEntry {
  return {
    ts,
    id,
    prev_ts: prevTs,
    value: body === null ? null : { id, value: { body, n: ts } },
  };
}

describe("SqliteDocStore.close", () => {
  it("closes the underlying adapter; a write after close throws", async () => {
    const store = makeStore(tmpFile());
    await store.setupSchema();
    const id = newDocumentId(TABLE);
    await store.write([rev(id, 1n, null, "v1")], [], "Error");

    expect(() => store.close()).not.toThrow();

    // the underlying db is gone — a subsequent operation must reject/throw, not silently succeed.
    await expect(store.write([rev(id, 2n, 1n, "v2")], [], "Error")).rejects.toThrow();
  });

  it("data written before close is durable — reopen the same file sees it", async () => {
    const path = tmpFile();
    const s1 = makeStore(path);
    await s1.setupSchema();
    const id = newDocumentId(TABLE);
    await s1.write([rev(id, 1n, null, "durable")], [], "Error");
    s1.close();

    const s2 = makeStore(path);
    const doc = await s2.get(id);
    expect(doc).not.toBeNull();
    expect(doc!.value.value.body).toBe("durable");
    expect(await s2.count(TABLE_ID)).toBe(1);
    s2.close();
  });
});
