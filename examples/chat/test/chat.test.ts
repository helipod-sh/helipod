import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { SqliteDocStore, NodeSqliteAdapter } from "@stackbase/docstore-sqlite";
import { createEmbeddedRuntime, type EmbeddedRuntime } from "@stackbase/runtime-embedded";
import { StackbaseClient, loopbackTransport, anyApi } from "@stackbase/client";
import { loadProject, push, type LoadedProject } from "@stackbase/cli";
import schema from "../convex/schema";
import * as messages from "../convex/messages";

const loaded: LoadedProject = { schema, modules: { messages } };
const api = anyApi as {
  messages: { send: { __path: string }; list: { __path: string }; listPaginated: { __path: string } };
};

async function waitFor(cond: () => boolean, timeoutMs = 1500): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
}

let runtime: EmbeddedRuntime;
const client = (s: string) => new StackbaseClient(loopbackTransport(runtime.connect(s)));

beforeEach(async () => {
  const project = loadProject(loaded);
  runtime = await createEmbeddedRuntime({
    store: new SqliteDocStore(new NodeSqliteAdapter()),
    catalog: project.catalog,
    modules: project.moduleMap,
  });
});

describe("chat — reactive end to end", () => {
  it("two subscribed clients both receive a message pushed reactively", async () => {
    const a = client("a");
    const b = client("b");
    const aSeen: Array<Array<{ body: string }>> = [];
    const bSeen: Array<Array<{ body: string }>> = [];
    a.subscribe(api.messages.list, { conversationId: "c1" }, (v) => aSeen.push(v as Array<{ body: string }>));
    b.subscribe(api.messages.list, { conversationId: "c1" }, (v) => bSeen.push(v as Array<{ body: string }>));
    await waitFor(() => aSeen.length >= 1 && bSeen.length >= 1);

    await a.mutation(api.messages.send, { conversationId: "c1", author: "alice", body: "hello" });
    await waitFor(() => aSeen.length >= 2 && bSeen.length >= 2);

    expect(aSeen.at(-1)!.map((m) => m.body)).toEqual(["hello"]);
    expect(bSeen.at(-1)!.map((m) => m.body)).toEqual(["hello"]);
  });
});

describe("chat — the conversation is the shard key (seam #1)", () => {
  it("commits carry a shard id and the schema declares the shard key", async () => {
    const result = await runtime.run("messages:send", { conversationId: "c1", author: "a", body: "x" });
    expect(result.oplog?.shardId).toBe("default"); // Tier 0: one shard, threaded through the commit
    expect(schema.export().tables.messages?.shardKey).toBe("conversationId");
  });
});

describe("chat — paginated history is stable under head inserts", () => {
  it("does not skip or duplicate when new messages arrive while paginating", async () => {
    for (let i = 1; i <= 6; i++) await runtime.run("messages:send", { conversationId: "c1", author: "a", body: `m${i}` });

    const p1 = await runtime.run<{ page: Array<{ body: string }>; nextCursor: string | null }>("messages:listPaginated", {
      conversationId: "c1",
      pageSize: 2,
    });
    expect(p1.value.page.map((m) => m.body)).toEqual(["m6", "m5"]); // desc, newest first

    // New messages arrive at the head between pages.
    await runtime.run("messages:send", { conversationId: "c1", author: "a", body: "m7" });
    await runtime.run("messages:send", { conversationId: "c1", author: "a", body: "m8" });

    const p2 = await runtime.run<{ page: Array<{ body: string }> }>("messages:listPaginated", {
      conversationId: "c1",
      cursor: p1.value.nextCursor,
      pageSize: 2,
    });
    expect(p2.value.page.map((m) => m.body)).toEqual(["m4", "m3"]); // stable: no m7/m8, no dup
  });
});

describe("chat — ephemeral typing bypasses the engine", () => {
  it("reaches other clients without creating a document or a transition", async () => {
    const a = client("a");
    const b = client("b");
    const broadcasts: Array<{ topic: string; event: unknown }> = [];
    a.onBroadcast((topic, event) => broadcasts.push({ topic, event }));

    const aSeen: unknown[] = [];
    a.subscribe(api.messages.list, { conversationId: "c1" }, (v) => aSeen.push(v));
    await waitFor(() => aSeen.length >= 1);
    const updatesBefore = aSeen.length;

    b.publishEphemeral("typing", { user: "bob", conversationId: "c1" });
    await waitFor(() => broadcasts.length >= 1);

    expect(broadcasts[0]!.topic).toBe("typing");
    expect(broadcasts[0]!.event).toEqual({ user: "bob", conversationId: "c1" });
    expect(aSeen.length).toBe(updatesBefore); // no reactive transition (no write happened)

    const count = (await runtime.run<unknown[]>("messages:list", { conversationId: "c1" })).value.length;
    expect(count).toBe(0); // no message document was created
  });
});

describe("codegen — the committed _generated matches the schema", () => {
  it("convex/_generated is up to date (no drift)", () => {
    const { generated } = push(loaded);
    const dir = join(dirname(fileURLToPath(import.meta.url)), "../convex/_generated");
    for (const file of generated.files) {
      expect(readFileSync(join(dir, file.path), "utf8"), `${file.path} is stale — run \`bun run scripts/codegen.ts\``).toBe(
        file.content,
      );
    }
  });
});
