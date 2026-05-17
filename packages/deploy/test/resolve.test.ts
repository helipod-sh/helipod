import { describe, it, expect } from "vitest";
import { resolveDeploy } from "../src/resolve";

describe("resolveDeploy", () => {
  it("defaults to the serve target with production env when nothing is specified", () => {
    const r = resolveDeploy({ deploy: undefined });
    expect(r).toEqual({ targetName: "serve", provider: "serve", env: "production", settings: {} });
  });

  it("threads --url into the synthesized serve settings (back-compat)", () => {
    const r = resolveDeploy({ deploy: undefined, inlineUrl: "http://x:9" });
    expect(r).toMatchObject({ provider: "serve", settings: { url: "http://x:9" } });
  });

  it("uses deploy.defaultTarget when --target is omitted", () => {
    const r = resolveDeploy({ deploy: { defaultTarget: "cloudflare", targets: { cloudflare: { provider: "cloudflare" } } } });
    expect(r).toMatchObject({ targetName: "cloudflare", provider: "cloudflare" });
  });

  it("merges the env override over the shared settings", () => {
    const r = resolveDeploy({
      target: "cf",
      env: "staging",
      deploy: { targets: { cf: { provider: "cloudflare", region: "auto", environments: { staging: { wranglerEnv: "staging" } } } } },
    });
    expect(r).toMatchObject({ env: "staging", settings: { region: "auto", wranglerEnv: "staging" } });
    expect((r as { settings: Record<string, unknown> }).settings).not.toHaveProperty("environments");
    expect((r as { settings: Record<string, unknown> }).settings).not.toHaveProperty("provider");
  });

  it("errors on an unknown non-serve target", () => {
    const r = resolveDeploy({ target: "ghost", deploy: { targets: {} } });
    expect(r).toEqual({ error: expect.stringContaining('unknown deploy target "ghost"') });
  });
});
