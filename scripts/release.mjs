#!/usr/bin/env bun
/**
 * Release: publish every workspace package whose current version is not yet on
 * the registry, in dependency order, then create changeset git tags.
 *
 * Safe to re-run: already-published versions are skipped, so a release that
 * fails halfway can simply be run again.
 *
 * Auth model — OIDC primary, token only as a bootstrap crutch:
 *   - Each package publishes via npm **trusted publishing (OIDC)** first, which
 *     is tokenless and needs no secret in the environment.
 *   - A brand-NEW package has no trusted publisher configured on npm yet, so
 *     OIDC can't authenticate it (chicken-and-egg). If OIDC fails and
 *     HELIPOD_NPM_FALLBACK_TOKEN is set (CI: the NPM_TOKEN secret), we retry
 *     that one package with token auth. Existing packages never touch the token.
 *   The token is passed as its own env var — NOT as NPM_TOKEN — so the
 *   changesets action doesn't switch every package to token auth and OIDC stays
 *   primary. After the new package's first publish, run
 *   scripts/trust-publishers.sh to give it a trusted publisher; the token is
 *   then unused again.
 */
import { execFileSync } from "node:child_process";
import { writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { publishablePackages } from "./list-publishable.mjs";

// Shared with scripts/trust-publishers.sh so the published set and the
// trusted-publisher set can never drift.
const pkgs = new Map(); // name -> { dir, version, deps }
for (const p of publishablePackages()) {
  pkgs.set(p.name, { dir: p.dir, version: p.version, deps: p.deps });
}

async function published(name, version) {
  const res = await fetch(
    `https://registry.npmjs.org/${encodeURIComponent(name).replace("%40", "@")}`,
  );
  if (res.status === 404) return false;
  const doc = await res.json();
  return Boolean(doc.versions?.[version]);
}

// topological order (parents before dependents)
const order = [];
const placed = new Set();
while (order.length < pkgs.size) {
  let progress = false;
  for (const [name, info] of [...pkgs.entries()].sort()) {
    if (placed.has(name)) continue;
    if ([...info.deps].every((d) => placed.has(d) || !pkgs.has(d))) {
      order.push([name, info]);
      placed.add(name);
      progress = true;
    }
  }
  if (!progress) throw new Error(`dependency cycle among: ${[...pkgs.keys()].filter((n) => !placed.has(n))}`);
}

let publishedCount = 0;
const failures = [];
for (const [name, { dir, version }] of order) {
  if (await published(name, version)) {
    console.log(`skip ${name}@${version} (already on registry)`);
    continue;
  }
  console.log(`publish ${name}@${version} ...`);
  // Pack with bun (rewrites workspace:* ranges to real versions), then publish
  // the tarball with npm.
  let tarball;
  try {
    const packOut = execFileSync("bun", ["pm", "pack"], { cwd: dir, encoding: "utf8" });
    tarball = packOut
      .split("\n")
      .map((l) => l.trim())
      .findLast((l) => l.endsWith(".tgz"));
    if (!tarball) throw new Error(`could not find tarball name in bun pm pack output`);
  } catch (err) {
    failures.push(name);
    console.error(`PACK FAILED ${name}@${version}: ${err.message ?? err}`);
    continue;
  }

  const publishArgs = ["publish", tarball, "--access", "public"];
  if (process.env.NPM_CONFIG_PROVENANCE === "true") publishArgs.push("--provenance");

  try {
    // Primary: OIDC trusted publishing (tokenless). Works for every package that
    // already has a trusted publisher configured on npm.
    execFileSync("npm", publishArgs, { cwd: dir, stdio: "inherit" });
    publishedCount++;
  } catch (oidcErr) {
    // OIDC couldn't authenticate — the usual cause is a brand-new package with
    // no trusted publisher yet. Retry once with the bootstrap token if present.
    const token = process.env.HELIPOD_NPM_FALLBACK_TOKEN;
    if (!token) {
      failures.push(name);
      console.error(
        `PUBLISH FAILED ${name}@${version} (OIDC failed, no HELIPOD_NPM_FALLBACK_TOKEN): ${oidcErr.message ?? oidcErr}`,
      );
      continue;
    }
    const rc = join(tmpdir(), `helipod-publish-${process.pid}.npmrc`);
    try {
      writeFileSync(rc, `//registry.npmjs.org/:_authToken=${token}\n`, { mode: 0o600 });
      console.log(`  OIDC failed; retrying ${name} with the bootstrap token …`);
      execFileSync("npm", [...publishArgs, "--userconfig", rc], { cwd: dir, stdio: "inherit" });
      publishedCount++;
    } catch (tokenErr) {
      failures.push(name);
      console.error(`PUBLISH FAILED ${name}@${version} (token fallback): ${tokenErr.message ?? tokenErr}`);
    } finally {
      rmSync(rc, { force: true });
    }
  }
}

console.log(`published ${publishedCount} package(s)`);
if (failures.length > 0) {
  console.error(`FAILED (${failures.length}): ${failures.join(", ")}`);
}
if (publishedCount > 0) {
  execFileSync("bunx", ["changeset", "tag"], { stdio: "inherit" });
}
if (failures.length > 0) process.exit(1);
