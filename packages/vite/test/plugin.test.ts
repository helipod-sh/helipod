import { describe, it, expect } from "vitest";
import { helipod, DEFAULT_FUNCTIONS_DIR } from "../src/index";

describe("helipod() plugin — config hook", () => {
  it("injects the engine-owned proxy entries at the resolved port, with ws on /api", async () => {
    const plugin = helipod({ port: 4567 });
    // `config` may be a function; call it to get the partial config it contributes.
    const configHook =
      typeof plugin.config === "function"
        ? plugin.config
        : (plugin.config as { handler: (c: unknown, e: unknown) => unknown } | undefined)?.handler;
    const cfg = (await (configHook as (c: unknown, e: unknown) => unknown)({}, { command: "serve" })) as {
      server: { proxy: Record<string, { target: string; ws?: boolean }> };
    };
    const proxy = cfg.server.proxy;
    expect(proxy["/api"]).toMatchObject({ target: "http://127.0.0.1:4567", ws: true });
    expect(proxy["/_dashboard"]).toMatchObject({ target: "http://127.0.0.1:4567" });
    expect(proxy["/_admin"]).toMatchObject({ target: "http://127.0.0.1:4567" });
    // Only the engine prefixes — nothing else.
    expect(Object.keys(proxy).sort()).toEqual(["/_admin", "/_dashboard", "/api"]);
  });

  it("has the plugin name and a configureServer hook", () => {
    const plugin = helipod();
    expect(plugin.name).toBe("helipod");
    expect(plugin.configureServer).toBeTypeOf("function");
  });
});

describe("DEFAULT_FUNCTIONS_DIR guard", () => {
  // 30s timeout: this dynamic import pulls the whole CLI dependency graph, which on a
  // cold-cache CI runner legitimately exceeds vitest's 5s default.
  it("the module-local literal (deliberately not imported, see src/index.ts) has not drifted from @helipod/cli's own constant", { timeout: 30_000 }, async () => {
    // A test file may import @helipod/cli freely — only the shipped proxy path (src/index.ts)
    // must avoid a static top-level import of it, to preserve the optional-peer-dependency
    // contract for proxy-mode-only consumers. See packages/vite/src/index.ts's DEFAULT_FUNCTIONS_DIR
    // comment and embed.ts's dynamic import for the two ways this package reaches the real value.
    const { DEFAULT_FUNCTIONS_DIR: cliDefault } = await import("@helipod/cli");
    expect(DEFAULT_FUNCTIONS_DIR).toBe(cliDefault);
    expect(DEFAULT_FUNCTIONS_DIR).toBe("helipod");
  });
});
