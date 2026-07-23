#!/usr/bin/env bun
/**
 * WARNING: this OVERWRITES the files it vendors, including local patches. Some
 * components carry helipod fixes (see the "helipod patch" comments — Card's
 * unapplied `width`, Sidebar's global key handler). After re-running this,
 * `git diff` and restore those hunks.
 *
 * Vendors termcn (https://termcn.dev) OpenTUI components into src/ — the shadcn
 * "own your code" model, resolved from the registry non-interactively so the
 * vendored set is reproducible. Re-run to refresh; review the diff like any code.
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

const BASE = "https://www.termcn.dev/r";
const ROOT = new URL("../src", import.meta.url).pathname;
const WANT = [
  "opentui/types", "opentui/theme-provider", "opentui/theme-default",
  "opentui/badge", "opentui/spinner",
  "opentui/key-value", "opentui/info-box", "opentui/log",
  "opentui/app-shell", "opentui/dither-sparkline", "opentui/dither-bar-chart",
  "opentui/table", "opentui/card", "opentui/panel",
  "opentui/tabs", "opentui/progress-bar", "opentui/definition", "opentui/tree",
  "opentui/sidebar", "opentui/command-palette", "opentui/pagination", "opentui/breadcrumb",
  "opentui/bar-chart", "opentui/line-chart", "opentui/gauge", "opentui/dither-area-chart", "opentui/dither-line-chart",
];

const seen = new Set();
async function vendor(name) {
  if (seen.has(name)) return;
  seen.add(name);
  const res = await fetch(`${BASE}/${name}.json`);
  if (!res.ok) throw new Error(`${name}: HTTP ${res.status}`);
  const item = await res.json();
  for (const dep of item.registryDependencies ?? []) {
    const m = String(dep).match(/\/r\/(.+)\.json$/);
    await vendor(m ? m[1] : dep);
  }
  for (const f of item.files ?? []) {
    const target = join(ROOT, f.target ?? f.path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, f.content);
    console.log(`vendored ${name} -> ${f.target ?? f.path}`);
  }
}
for (const n of WANT) await vendor(n);
console.log(`done: ${seen.size} registry items`);
