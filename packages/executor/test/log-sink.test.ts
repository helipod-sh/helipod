import { describe, it, expect } from "vitest";
import { InMemoryLogSink, NoopLogSink } from "../src/log-sink";

describe("InMemoryLogSink", () => {
  it("assigns increasing ids and queries newest-first with filters", () => {
    const sink = new InMemoryLogSink();
    sink.push({ path: "messages:list", kind: "query", ts: 1, durationMs: 2, status: "ok" });
    sink.push({ path: "messages:send", kind: "mutation", ts: 3, durationMs: 4, status: "error", error: "boom" });

    const all = sink.query();
    expect(all.map((e) => e.id)).toEqual([2, 1]); // newest-first
    expect(sink.query({ status: "error" }).map((e) => e.path)).toEqual(["messages:send"]);
    expect(sink.query({ kind: "query" }).map((e) => e.path)).toEqual(["messages:list"]);
    expect(sink.query({ since: 1 }).map((e) => e.id)).toEqual([2]); // id > since
  });

  it("caps results with limit (after newest-first ordering)", () => {
    const sink = new InMemoryLogSink();
    for (let i = 0; i < 3; i++) sink.push({ path: "f", kind: "query", ts: i, durationMs: 0, status: "ok" });
    expect(sink.query({ limit: 2 }).map((e) => e.id)).toEqual([3, 2]); // newest 2, newest-first
  });

  it("evicts oldest beyond capacity", () => {
    const sink = new InMemoryLogSink(2);
    for (let i = 0; i < 3; i++) sink.push({ path: "f", kind: "query", ts: i, durationMs: 0, status: "ok" });
    expect(sink.size()).toBe(2);
    expect(sink.query().map((e) => e.id)).toEqual([3, 2]); // id 1 evicted
  });

  it("NoopLogSink stores nothing", () => {
    const sink = new NoopLogSink();
    sink.push({ path: "f", kind: "query", ts: 0, durationMs: 0, status: "ok" });
    expect(sink.size()).toBe(0);
  });
});
