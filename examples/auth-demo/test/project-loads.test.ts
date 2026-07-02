/**
 * Integration check: the auth-demo project loads correctly via the CLI's config+project utilities.
 *
 * Two complementary assertions:
 *
 * 1. loadConfig(exampleRoot) → components includes the auth component (name === "auth").
 *    This proves stackbase.config.ts is read and the `auth` component is declared.
 *
 * 2. loadProject(handBuiltProject, [auth]) → moduleMap contains "auth:signIn" and "whoami:get",
 *    and componentNames contains "auth". This proves the composition that stackbase dev performs
 *    would expose the right functions.
 *
 * We don't use loadConvexDir here because dynamic-importing .ts files from a vitest test running
 * under Node requires the experimental strip-types loader; the `loadProject` path is runtime-neutral
 * and fully covers the composition logic.
 */
import { describe, it, expect } from "vitest";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { query } from "@stackbase/executor";
import { defineSchema } from "@stackbase/values";
import { loadConfig, loadProject } from "@stackbase/cli";
import { auth } from "@stackbase/auth";

const exampleRoot = resolve(fileURLToPath(import.meta.url), "../../");

describe("auth-demo project loads", () => {
  it("loadConfig reads stackbase.config.ts and reports the auth component", async () => {
    const cfg = await loadConfig(exampleRoot);
    const names = cfg.components.map((c) => c.name);
    expect(names).toContain("auth");
  });

  it("loadProject with [auth] + whoami module: moduleMap contains auth:signIn and whoami:get", () => {
    const appSchema = defineSchema({});

    // Reproduce what loadConvexDir + loadProject does for this project:
    // one module file "whoami" exporting a query named "get" (mirrors stackbase/whoami.ts).
    const whoamiGet = query(
      async (ctx) =>
        (ctx as unknown as { auth: { getUserId(): Promise<string | null> } }).auth.getUserId(),
    );

    const loaded = {
      schema: appSchema,
      modules: { whoami: { get: whoamiGet } },
    };

    const artifacts = loadProject(loaded, [auth]);

    // Component name registered.
    expect([...artifacts.componentNames]).toContain("auth");

    // Auth component functions present in composed module map.
    expect(Object.keys(artifacts.moduleMap)).toContain("auth:signIn");
    expect(Object.keys(artifacts.moduleMap)).toContain("auth:signUp");
    expect(Object.keys(artifacts.moduleMap)).toContain("auth:signOut");

    // App function present.
    expect(Object.keys(artifacts.moduleMap)).toContain("whoami:get");

    // Context providers include auth.
    expect(artifacts.contextProviders.map((cp) => cp.name)).toContain("auth");
  });
});
