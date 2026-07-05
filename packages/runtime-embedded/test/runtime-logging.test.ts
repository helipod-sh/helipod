import { describe, it, expect } from "vitest";
import { SqliteDocStore, NodeSqliteAdapter } from "@helipod/docstore-sqlite";
import { InMemoryLogSink, SimpleIndexCatalog, query } from "@helipod/executor";
import { EmbeddedRuntime } from "../src/index";

describe("runtime logging", () => {
  it("logs the function path for runtime.run()", async () => {
    const sink = new InMemoryLogSink();
    const runtime = await EmbeddedRuntime.create({
      store: new SqliteDocStore(new NodeSqliteAdapter()),
      catalog: new SimpleIndexCatalog(),
      modules: { "util:ping": query(async () => "pong") },
      logSink: sink,
    });
    await runtime.run("util:ping", {});
    expect(sink.query()[0]).toMatchObject({ path: "util:ping", kind: "query", status: "ok" });
  });
});
