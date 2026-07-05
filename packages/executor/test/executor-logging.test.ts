// packages/executor/test/executor-logging.test.ts
import { describe, it, expect } from "vitest";
import { SqliteDocStore, NodeSqliteAdapter } from "@helipod/docstore-sqlite";
import { MonotonicTimestampOracle } from "@helipod/docstore";
import { SingleWriterTransactor } from "@helipod/transactor";
import { QueryRuntime } from "@helipod/query-engine";
import { InlineUdfExecutor, InMemoryLogSink, SimpleIndexCatalog, query } from "../src/index";

async function harness() {
  const store = new SqliteDocStore(new NodeSqliteAdapter());
  await store.setupSchema();
  const transactor = new SingleWriterTransactor(store, new MonotonicTimestampOracle());
  const queryRuntime = new QueryRuntime(store);
  const sink = new InMemoryLogSink();
  let clock = 100;
  const now = () => (clock += 5); // start=105, end=110 → duration 5
  const executor = new InlineUdfExecutor({ transactor, queryRuntime, catalog: new SimpleIndexCatalog(), logSink: sink, now });
  return { executor, sink };
}

describe("executor logging", () => {
  it("records an ok entry with the path, kind, and duration", async () => {
    const { executor, sink } = await harness();
    const ping = query(async () => 42);
    await executor.run(ping, {}, { path: "util:ping" });

    const [entry] = sink.query();
    expect(entry).toMatchObject({ path: "util:ping", kind: "query", status: "ok", durationMs: 5 });
  });

  it("records an error entry and rethrows", async () => {
    const { executor, sink } = await harness();
    const boom = query(async () => {
      throw new Error("kaboom");
    });
    await expect(executor.run(boom, {}, { path: "util:boom" })).rejects.toThrow("kaboom");
    expect(sink.query({ status: "error" })[0]).toMatchObject({ path: "util:boom", error: "kaboom" });
  });
});
