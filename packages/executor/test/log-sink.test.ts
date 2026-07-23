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

describe("InMemoryLogSink — ring buffer (O(1) eviction)", () => {
  it("evicts oldest past capacity while preserving newest-first order and ids", () => {
    const sink = new InMemoryLogSink(3);
    for (let i = 1; i <= 5; i++) {
      sink.push({ path: `p${i}`, kind: "query", ts: i, durationMs: 1, status: "ok" });
    }
    // Capacity 3 → only the last three survive; ids keep climbing.
    expect(sink.size()).toBe(3);
    const q = sink.query();
    expect(q.map((e) => e.id)).toEqual([5, 4, 3]); // newest-first
    expect(q.map((e) => e.path)).toEqual(["p5", "p4", "p3"]);
    // The evicted ids are gone.
    expect(sink.query({ since: 10 })).toEqual([]);
    expect(sink.query({ since: 3 }).map((e) => e.id)).toEqual([5, 4]);
  });

  it("limit short-circuits and applies to the filtered, newest-first result", () => {
    const sink = new InMemoryLogSink(100);
    for (let i = 1; i <= 50; i++) {
      sink.push({ path: "x", kind: i % 2 ? "query" : "mutation", ts: i, durationMs: 1, status: "ok" });
    }
    expect(sink.query({ limit: 5 }).map((e) => e.id)).toEqual([50, 49, 48, 47, 46]);
    // filter then limit
    const q = sink.query({ kind: "mutation", limit: 3 });
    expect(q.every((e) => e.kind === "mutation")).toBe(true);
    expect(q.map((e) => e.id)).toEqual([50, 48, 46]);
  });

  it("clear() resets the buffer without leaking stale entries", () => {
    const sink = new InMemoryLogSink(4);
    for (let i = 0; i < 6; i++) sink.push({ path: "x", kind: "query", ts: i, durationMs: 1, status: "ok" });
    sink.clear();
    expect(sink.size()).toBe(0);
    expect(sink.query()).toEqual([]);
    sink.push({ path: "y", kind: "query", ts: 99, durationMs: 1, status: "ok" });
    expect(sink.query().map((e) => e.path)).toEqual(["y"]);
  });

  it("push stays O(1) past capacity (no O(n) reindex per call)", () => {
    const sink = new InMemoryLogSink(1000);
    const time = (n: number) => {
      const t0 = performance.now();
      for (let i = 0; i < n; i++) sink.push({ path: "x", kind: "query", ts: i, durationMs: 1, status: "ok" });
      return performance.now() - t0;
    };
    time(1000); // fill to capacity
    const perFullBuffer = time(20_000) / 20_000; // all evicting
    // A per-push cost that scales with buffer size (the old shift) would be
    // orders of magnitude slower; O(1) slot-overwrite is well under this bound.
    expect(perFullBuffer).toBeLessThan(0.02); // < 20µs/push, generous for CI
  });
});
