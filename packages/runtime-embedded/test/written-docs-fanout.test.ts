/**
 * §DLR 2a plumbing proof: a commit's `WrittenDoc[]` rides the in-process fan-out —
 * `ShardWriter.commit` → `OplogDelta.writtenDocs` → `EmbeddedWriteFanout` →
 * `EmbeddedWriteFanoutPayload.writtenDocs` → the runtime drain queue → `handler.notifyWrites` —
 * with no re-read of the store along the way. This is pure plumbing (Task 2 of DLR Stage 2a);
 * nothing consumes `writtenDocs` yet, so this test only proves it arrives, populated and correct.
 */
import { describe, it, expect, vi } from "vitest";
import { SqliteDocStore, NodeSqliteAdapter } from "@stackbase/docstore-sqlite";
import { encodeStorageIndexId } from "@stackbase/id-codec";
import { SimpleIndexCatalog, query, mutation, type RegisteredFunction } from "@stackbase/executor";
import type { IndexSpec } from "@stackbase/query-engine";
import type { ServerMessage, WriteInvalidation } from "@stackbase/sync";
import { createEmbeddedRuntime } from "../src/index";

const NOTES = 10001;
const byOwner: IndexSpec = {
  table: "notes",
  tableNumber: NOTES,
  index: "by_owner",
  fields: ["owner"],
  indexId: encodeStorageIndexId(NOTES, "by_owner"),
};

const modules: Record<string, RegisteredFunction> = {
  "notes:add": mutation<{ owner: string; body: string }, string>({
    handler: (ctx, { owner, body }) => ctx.db.insert("notes", { owner, body }),
  }),
};

async function makeRuntime() {
  const store = new SqliteDocStore(new NodeSqliteAdapter());
  const catalog = new SimpleIndexCatalog().addIndex(byOwner);
  return createEmbeddedRuntime({ store, catalog, modules });
}

type MutationResponse = Extract<ServerMessage, { type: "MutationResponse"; success: true }>;

async function waitFor(cond: () => boolean, timeoutMs = 1000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe("written docs ride the in-process commit fan-out (§DLR 2a)", () => {
  it("a committed by-id insert reaches handler.notifyWrites with writtenDocs populated", async () => {
    const runtime = await makeRuntime();

    // Spy on the real handler's notifyWrites — vi.spyOn calls through to the original
    // implementation by default, so the actual reactive path (Transition delivery) is unaffected;
    // it just lets us inspect the `WriteInvalidation` the drain actually handed it.
    const spy = vi.spyOn(runtime.handler, "notifyWrites");

    const conn = runtime.connect("sA");
    const received: ServerMessage[] = [];
    conn.onMessage((m) => received.push(m));

    await conn.send({ type: "Mutation", requestId: "r1", udfPath: "notes:add", args: { owner: "u1", body: "hello" } });
    const resp = received.find((m) => m.type === "MutationResponse") as MutationResponse;
    expect(resp.success).toBe(true);
    expect(resp.ts).toBeGreaterThan(0);

    // The fan-out drain runs async (after the current call stack) — wait for it to reach notifyWrites.
    await waitFor(() => spy.mock.calls.length > 0);

    expect(spy.mock.calls).toHaveLength(1);
    const invalidation = spy.mock.calls[0]![0] as WriteInvalidation;
    expect(invalidation.commitTs).toBe(resp.ts);
    expect(invalidation.writtenDocs).toBeDefined();
    expect(invalidation.writtenDocs).toHaveLength(1);

    const doc = invalidation.writtenDocs![0]!;
    expect(doc.wasPresent).toBe(false);
    expect(doc.keyspace.startsWith("table:")).toBe(true);
    expect(doc.ts).toBe(resp.ts);
    expect(doc.newRow).toMatchObject({ owner: "u1", body: "hello" });
    expect(typeof doc.key).toBe("string");
    expect(typeof doc.docId).toBe("string");
  });
});
