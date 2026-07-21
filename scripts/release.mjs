#!/usr/bin/env bun
/**
 * Release: publish every workspace package whose current version is not yet on
 * the registry, in dependency order, then create changeset git tags.
 *
 * Safe to re-run: already-published versions are skipped, so a release that
 * fails halfway can simply be run again.
 *
 * Auth: expects NPM_CONFIG_TOKEN in the environment (CI: the NPM_TOKEN secret).
 */
import { execFileSync } from "node:child_process";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

const list = (base) =>
  existsSync(base) ? readdirSync(base).map((d) => join(base, d)) : [];
const dirs = [
  ...list("packages"),
  ...list("components"),
  ...list("ee/packages"),
  "apps/dashboard",
].sort();

const pkgs = new Map(); // name -> { dir, version, deps }
for (const dir of dirs) {
  const pj = join(dir, "package.json");
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
  pkgs.set(p.name, { dir, version: p.version, deps });
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
for (const [name, { dir, version }] of order) {
  if (await published(name, version)) {
    console.log(`skip ${name}@${version} (already on registry)`);
    continue;
  }
  console.log(`publish ${name}@${version} ...`);
  execFileSync("bun", ["publish"], { cwd: dir, stdio: "inherit" });
  publishedCount++;
}

console.log(`published ${publishedCount} package(s)`);
if (publishedCount > 0) {
  execFileSync("bunx", ["changeset", "tag"], { stdio: "inherit" });
}
