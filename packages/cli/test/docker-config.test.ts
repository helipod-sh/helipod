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
  it("the runtime image links workspace @stackbase/* packages into node_modules for bind-mounted apps", () => {
    // A bind-mounted /app/convex resolves bare `@stackbase/*` imports up to /app/node_modules;
    // turbo-prune keeps workspace links nested per-package, so without these root symlinks every
    // app's schema.ts `import "@stackbase/values"` fails at load (verified via real docker compose up).
    expect(dockerfile).toMatch(/node_modules\/@stackbase/);
    expect(dockerfile).toMatch(/symlinkSync/);
  });
  it("the runtime image makes the deploy scratch dir writable by the non-root user", () => {
    // `stackbase deploy` writes the pushed tree under /app/.stackbase-deploy; /app's dir node is
    // root-owned (COPY chowns only its contents), so the runner stage must chown /app + create the
    // deploy dir before USER bun — else deploy fails with EACCES (verified via real docker deploy).
    expect(dockerfile).toMatch(/\.stackbase-deploy/);
    expect(dockerfile).toMatch(/chown bun:bun[^\n]*\/app/);
  });
  it("compose mounts the app dir and a data volume and requires the admin key", () => {
    expect(compose).toMatch(/\/app\/stackbase/);
    expect(compose).toMatch(/STACKBASE_ADMIN_KEY/);
    expect(compose).toMatch(/serve/);
  });
});
