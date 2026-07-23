/**
 * helipod's own version, read from this package's manifest at runtime — never
 * `process.env.npm_package_version`, which reports whichever app's package.json
 * the user happened to run `bun run` from (the TUI header showed a chat example's
 * "0.0.2" before this).
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

function read(): string {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    // dist/ -> package root; src/ -> package root (both are one level down)
    for (const rel of ["../package.json", "../../package.json"]) {
      try {
        const pkg = JSON.parse(readFileSync(join(here, rel), "utf8")) as { name?: string; version?: string };
        if (pkg.name === "@helipod/cli" && pkg.version) return pkg.version;
      } catch {
        /* try the next candidate */
      }
    }
  } catch {
    /* fall through */
  }
  return "dev";
}

export const CLI_VERSION: string = read();
