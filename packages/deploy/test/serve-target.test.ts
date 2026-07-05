import { describe, it, expect, afterEach } from "vitest";
import { createServer, type Server } from "node:http";
import { serveTarget } from "../src/targets/serve";
import { DeployError } from "../src/types";
import type { DeployContext } from "../src/types";

function ctxWith(settings: Record<string, unknown>): DeployContext {
  return {
    cwd: "/tmp", functionsDir: "/tmp/helipod", env: "production",
    target: { targetName: "serve", provider: "serve", env: "production", settings },
    interactive: false,
    spawn: { run: async () => ({ code: 0, stdout: "", stderr: "" }) },
    log: () => {},
    packageApp: async () => ({ files: [{ path: "a.js", code: "export const x=1" }] }),
    codegen: async () => {},
  };
}

describe("serveTarget", () => {
  let server: Server | undefined;
  afterEach(() => { server?.close(); server = undefined; delete process.env.HELIPOD_ADMIN_KEY; delete process.env.HELIPOD_DEPLOY_URL; });

  it("preflight throws when url is missing", async () => {
    await expect(serveTarget.preflight(ctxWith({ adminKey: "k" }))).rejects.toBeInstanceOf(DeployError);
  });

  it("preflight throws when admin key is missing", async () => {
    await expect(serveTarget.preflight(ctxWith({ url: "http://x:1" }))).rejects.toBeInstanceOf(DeployError);
  });

  it("push POSTs the file tree to /_admin/deploy and reports success", async () => {
    let received: unknown;
    let auth: string | undefined;
    server = createServer((req, res) => {
      auth = req.headers.authorization;
      // Handle GET to /_admin/deploy/modules (from incremental push) — 404 it
      if (req.method === "GET" && req.url === "/_admin/deploy/modules") {
        res.statusCode = 404;
        res.setHeader("content-type", "application/json");
        return res.end(JSON.stringify({}));
      }
      // Handle POST to /_admin/deploy
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        received = JSON.parse(body);
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ ok: true, rev: "r1", functions: 3 }));
      });
    });
    await new Promise<void>((r) => server!.listen(0, r));
    const port = (server!.address() as { port: number }).port;
    const ctx = ctxWith({ url: `http://127.0.0.1:${port}`, adminKey: "secret" });

    await serveTarget.preflight(ctx);
    const result = await serveTarget.push(ctx);

    expect(result.ok).toBe(true);
    expect(result.detail).toContain("rev r1");
    expect(auth).toBe("Bearer secret");
    expect(received).toEqual({ files: [{ path: "a.js", code: "export const x=1" }] });
  });

  it("push reports the 'not enabled' error on 404", async () => {
    server = createServer((_req, res) => { res.statusCode = 404; res.end("{}"); });
    await new Promise<void>((r) => server!.listen(0, r));
    const port = (server!.address() as { port: number }).port;
    const result = await serveTarget.push(ctxWith({ url: `http://127.0.0.1:${port}`, adminKey: "k" }));
    expect(result.ok).toBe(false);
    expect(result.error).toContain("--allow-deploy");
  });
});
