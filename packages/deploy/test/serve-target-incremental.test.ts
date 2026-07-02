import { describe, it, expect, afterEach } from "vitest";
import { createServer, type Server } from "node:http";
import { serveTarget } from "../src/targets/serve";
import { sha256Hex } from "../src/module-hash";
import type { DeployContext } from "../src/types";

/** A configurable fake server recording the deploy POST body and controlling the GET + POST responses. */
function fakeServer(opts: {
  modules?: Record<string, string> | 404;
  postSequence: Array<{ status: number; body: unknown }>;
}) {
  const posts: unknown[] = [];
  const server = createServer((req, res) => {
    const send = (status: number, body: unknown) => { res.statusCode = status; res.setHeader("content-type", "application/json"); res.end(JSON.stringify(body)); };
    if (req.method === "GET" && req.url === "/_admin/deploy/modules") {
      if (opts.modules === 404 || opts.modules === undefined) return send(404, {});
      return send(200, opts.modules);
    }
    if (req.method === "POST" && req.url === "/_admin/deploy") {
      let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => { posts.push(JSON.parse(b)); const next = opts.postSequence.shift()!; send(next.status, next.body); });
      return;
    }
    send(404, {});
  });
  return { server, posts };
}

function ctxFor(port: number, files: Array<{ path: string; code: string }>): DeployContext {
  return {
    cwd: "/x", functionsDir: "/x/stackbase", env: "production",
    target: { targetName: "serve", provider: "serve", env: "production", settings: { url: `http://127.0.0.1:${port}`, adminKey: "k" } },
    interactive: false, spawn: { run: async () => ({ code: 0, stdout: "", stderr: "" }) }, log: () => {},
    packageApp: async () => ({ files }),
    codegen: async () => {},
  };
}

describe("serveTarget incremental push", () => {
  let server: Server | undefined;
  afterEach(() => { server?.close(); server = undefined; });

  it("delta-posts only changed modules when the server returns hashes", async () => {
    const files = [{ path: "a.js", code: "A" }, { path: "b.js", code: "B2" }];
    const fk = fakeServer({ modules: { "a.js": sha256Hex("A"), "b.js": sha256Hex("B1") }, postSequence: [{ status: 200, body: { ok: true, rev: "r1", functions: 2 } }] });
    server = fk.server; await new Promise<void>((r) => server!.listen(0, r));
    const port = (server.address() as { port: number }).port;
    const result = await serveTarget.push(ctxFor(port, files));
    expect(result.ok).toBe(true);
    expect(fk.posts[0]).toEqual({ changed: [{ path: "b.js", code: "B2" }], unchanged: [{ path: "a.js", sha256: sha256Hex("A") }] });
  });

  it("full-pushes {files} when the modules endpoint 404s (old server / disabled)", async () => {
    const files = [{ path: "a.js", code: "A" }];
    const fk = fakeServer({ modules: 404, postSequence: [{ status: 200, body: { ok: true, rev: "r1", functions: 1 } }] });
    server = fk.server; await new Promise<void>((r) => server!.listen(0, r));
    const port = (server.address() as { port: number }).port;
    const result = await serveTarget.push(ctxFor(port, files));
    expect(result.ok).toBe(true);
    expect(fk.posts[0]).toEqual({ files: [{ path: "a.js", code: "A" }] });
  });

  it("retries as a full push when the delta POST returns stale-base", async () => {
    const files = [{ path: "a.js", code: "A" }];
    const fk = fakeServer({
      modules: { "a.js": sha256Hex("OLD") },
      postSequence: [
        { status: 409, body: { ok: false, kind: "stale-base", error: "stale-base: ..." } },
        { status: 200, body: { ok: true, rev: "r2", functions: 1 } },
      ],
    });
    server = fk.server; await new Promise<void>((r) => server!.listen(0, r));
    const port = (server.address() as { port: number }).port;
    const result = await serveTarget.push(ctxFor(port, files));
    expect(result.ok).toBe(true);
    expect(fk.posts).toEqual([
      { changed: [{ path: "a.js", code: "A" }], unchanged: [] }, // first: delta (a.js differs from OLD)
      { files: [{ path: "a.js", code: "A" }] }, // retry: full push
    ]);
  });
});
