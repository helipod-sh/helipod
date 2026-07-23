#!/usr/bin/env node
/**
 * Single source of truth for "which workspace packages get published to npm".
 *
 * Both the release path (`scripts/release.mjs`) and the trusted-publisher setup
 * (`scripts/trust-publishers.sh`) consume this, so the set of packages we PUBLISH
 * and the set we CONFIGURE OIDC FOR can never drift apart — the whole class of
 * "added a package, forgot to set up its trusted publisher" bugs is designed out.
 *
 * Run directly to print one package name per line:
 *   node scripts/list-publishable.mjs
 */
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

const list = (base) => {
  const abs = join(repoRoot, base);
  return existsSync(abs) ? readdirSync(abs).map((d) => join(base, d)) : [];
};

/**
 * @returns {{ name: string, dir: string, version: string, deps: Set<string> }[]}
 * The workspace dirs scanned here MUST match `scripts/release.mjs` exactly.
 */
export function publishablePackages() {
  const dirs = [
    ...list("packages"),
    ...list("components"),
    ...list("ee/packages"),
    "apps/dashboard",
  ].sort();

  const pkgs = [];
  for (const dir of dirs) {
    const pj = join(repoRoot, dir, "package.json");
    if (!existsSync(pj)) continue;
    const p = JSON.parse(readFileSync(pj, "utf8"));
    if (p.private) continue;
    if (p.name !== "helipod" && !p.name?.startsWith("@helipod/")) continue;
    const deps = new Set();
    for (const k of ["dependencies", "devDependencies", "peerDependencies"]) {
      for (const d of Object.keys(p[k] ?? {})) {
        if (d === "helipod" || d.startsWith("@helipod/")) deps.add(d);
      }
    }
    pkgs.push({ name: p.name, dir, version: p.version, deps });
  }
  return pkgs;
}

// When run directly, print the names (consumed by trust-publishers.sh).
if (import.meta.url === `file://${process.argv[1]}`) {
  for (const { name } of publishablePackages()) console.log(name);
}
