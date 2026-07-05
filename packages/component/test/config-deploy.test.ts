import { describe, it, expect, afterEach } from "vitest";
import { defineConfig, env, type HelipodConfig } from "../src/index";

describe("defineConfig deploy block", () => {
  it("carries a deploy block through unchanged", () => {
    const cfg: HelipodConfig = defineConfig({
      components: [],
      deploy: { defaultTarget: "cloudflare", targets: { cloudflare: { provider: "cloudflare" } } },
    });
    expect(cfg.deploy?.defaultTarget).toBe("cloudflare");
    expect(cfg.deploy?.targets?.cloudflare?.provider).toBe("cloudflare");
  });
});

describe("env()", () => {
  const KEY = "SB_TEST_ENV_VAR";
  afterEach(() => { delete process.env[KEY]; });

  it("returns a set non-empty value", () => { process.env[KEY] = "abc"; expect(env(KEY)).toBe("abc"); });
  it("treats empty-string as unset and uses the fallback", () => { process.env[KEY] = ""; expect(env(KEY, "fb")).toBe("fb"); });
  it("returns empty string when unset with no fallback", () => { expect(env(KEY)).toBe(""); });
});
