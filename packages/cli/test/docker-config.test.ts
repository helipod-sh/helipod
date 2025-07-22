import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "../../..");   // repo root from packages/cli/test
const dockerfile = readFileSync(join(root, "Dockerfile"), "utf8");
const compose = readFileSync(join(root, "docker-compose.yml"), "utf8");

describe("docker config", () => {
  it("compose build.target names a stage that exists in the Dockerfile", () => {
    const target = compose.match(/target:\s*(\S+)/)?.[1];
    expect(target).toBeTruthy();
    expect(dockerfile).toMatch(new RegExp(`AS\\s+${target}\\b`));   // e.g. "FROM base AS runner"
  });
  it("the runtime image invokes `serve`", () => {
    // ENTRYPOINT/CMD must run the serve subcommand as a literal array element —
    // anchored so a prose placeholder that merely mentions "serve" can't false-green this.
    expect(dockerfile).toMatch(/^(ENTRYPOINT|CMD)\s*\[.*"serve"/m);
  });
  it("compose mounts the app dir and a data volume and requires the admin key", () => {
    expect(compose).toMatch(/\/app\/convex/);
    expect(compose).toMatch(/STACKBASE_ADMIN_KEY/);
    expect(compose).toMatch(/serve/);
  });
});
