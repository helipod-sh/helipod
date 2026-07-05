import { describe, it, expect, vi, afterEach } from "vitest";
import { SqliteDocStore, NodeSqliteAdapter } from "@helipod/docstore-sqlite";
import { InMemoryLogSink, SimpleIndexCatalog } from "@helipod/executor";
import { EmbeddedRuntime } from "@helipod/runtime-embedded";
import { handleHttpRequest, type FleetHandles } from "../src/http-handler";
import type { ResolvedRoute } from "../src/project";

// A fleet SYNC node proxies public httpAction requests to the writer verbatim (http-handler.ts's
// `fleet.role() === "sync"` branch — see its doc comment: "the writer's Response (status/headers/
// body) is streamed back verbatim"). C3: a handful of response headers must NOT be relayed
// verbatim — `undici`'s `fetch` already transparently decompressed the writer's body, so copying
// `content-encoding`/`content-length` through would describe bytes that no longer match what we
// actually send; `transfer-encoding`/`connection` are hop-by-hop and never meaningful to forward.
// Every OTHER header (e.g. an app-set `x-custom`) must still come through untouched.

const syncFleetHandles: FleetHandles = {
  role: () => "sync",
  writerUrl: async () => "http://writer:4000",
  onPromoted: () => {},
  stop: async () => {},
};

const routes: ResolvedRoute[] = [{ method: "GET", path: "/hook", handlerPath: "http:hook" }];

async function setup() {
  const store = new SqliteDocStore(new NodeSqliteAdapter());
  const catalog = new SimpleIndexCatalog();
  const logSink = new InMemoryLogSink();
  const runtime = await EmbeddedRuntime.create({ store, catalog, logSink, modules: {} });
  const info = { functions: [], tables: [] };
  return { runtime, info };
}

describe("fleet sync-node httpAction proxy — hop-by-hop response headers (C3)", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("strips content-encoding/content-length/transfer-encoding/connection, keeps everything else", async () => {
    const { runtime, info } = await setup();
    globalThis.fetch = vi.fn(
      async () =>
        new Response("hi", {
          status: 200,
          headers: {
            "content-encoding": "gzip",
            "content-length": "999",
            "transfer-encoding": "chunked",
            connection: "keep-alive",
            "x-custom": "keep",
          },
        }),
    );

    const res = await handleHttpRequest(
      runtime,
      { method: "GET", path: "/hook" },
      info,
      undefined,
      routes,
      undefined,
      syncFleetHandles,
    );

    expect(res.status).toBe(200);
    expect(res.headers["content-encoding"]).toBeUndefined();
    expect(res.headers["content-length"]).toBeUndefined();
    expect(res.headers["transfer-encoding"]).toBeUndefined();
    expect(res.headers["connection"]).toBeUndefined();
    expect(res.headers["x-custom"]).toBe("keep");
  });
});
