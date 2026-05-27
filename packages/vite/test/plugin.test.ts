import { describe, it, expect } from "vitest";
import { stackbase } from "../src/index";

describe("stackbase() plugin — config hook", () => {
  it("injects the engine-owned proxy entries at the resolved port, with ws on /api", async () => {
    const plugin = stackbase({ port: 4567 });
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
    const plugin = stackbase();
    expect(plugin.name).toBe("stackbase");
    expect(plugin.configureServer).toBeTypeOf("function");
  });
});
