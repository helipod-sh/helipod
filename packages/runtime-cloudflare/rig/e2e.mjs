#!/usr/bin/env node
/**
 * The flagship real-Cloudflare E2E (§6.2) — the honest gate. This worktree has NO Cloudflare login,
 * so it is DEPLOY-READY-BUT-UNRUN: a human runs the deploy (see ./README.md) and then this script
 * against the resulting `*.workers.dev` URL. It does NOT fake a deploy.
 *
 * Usage:
 *   node e2e.mjs --url https://stackbase-do-fixture.<subdomain>.workers.dev --admin-key <KEY>
 *
 * Proves, against a REAL DO on real Cloudflare:
 *   1. GET /api/health → 200
 *   2. open a real WebSocket to /api/sync; subscribe to messages:list(c1)
 *   3. a SECOND client POSTs /api/run a mutation writing that table
 *   4. ASSERT client 1 receives the reactive Transition (the write it did not make) — reactivity across a DO
 *   5. MEASURE write latency = POST /api/run → committed MutationResponse, reported for comparison vs
 *      the container→R2 number (~1.5s WAN-measured; the honest in-CF number is what this finally lands)
 *   6. ASSERT persistence: read the row back (DO-SQLite is durable)
 *   7. (manual, documented in README) hibernation-resume: stay SILENT, then commit and assert the
 *      hibernated socket wakes with its read-set rehydrated from the attachment
 *
 * Requires `ws` (already a repo devDep). Run from the repo root or this dir with node ≥18.
 */
import WebSocket from "ws";

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : fallback;
}

const URL = arg("url");
const ADMIN_KEY = arg("admin-key", process.env.STACKBASE_ADMIN_KEY);
if (!URL) {
  console.error("usage: node e2e.mjs --url https://<app>.workers.dev [--admin-key <KEY>]");
  process.exit(2);
}
const wsUrl = URL.replace(/^http/, "ws") + "/api/sync";
const CONV = "e2e-" + Date.now();

function waitFor(cond, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const iv = setInterval(() => {
      if (cond()) {
        clearInterval(iv);
        resolve();
      } else if (Date.now() - t0 > timeoutMs) {
        clearInterval(iv);
        reject(new Error("waitFor timed out"));
      }
    }, 50);
  });
}

async function main() {
  // 1. health
  const health = await fetch(`${URL}/api/health`);
  if (health.status !== 200) throw new Error(`health ${health.status}`);
  console.log("✓ health ok:", await health.json());

  // 2/3/4. subscribe over a real WS, commit from a second client, assert the push
  const frames = [];
  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => {
    ws.on("open", res);
    ws.on("error", rej);
  });
  ws.on("message", (d) => frames.push(d.toString()));
  ws.send(JSON.stringify({ type: "ModifyQuerySet", add: [{ queryId: 1, udfPath: "messages:list", args: { conversationId: CONV } }], remove: [] }));
  await waitFor(() => frames.some((f) => f.includes("Transition")));
  console.log("✓ subscribed (initial Transition received)");

  const before = frames.length;
  const t0 = performance.now();
  const run = await fetch(`${URL}/api/run`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path: "messages:send", args: { conversationId: CONV, body: "e2e-reactive" } }),
  });
  const latencyMs = performance.now() - t0;
  if (run.status !== 200) throw new Error(`run ${run.status}`);
  console.log(`✓ committed mutation via /api/run — write latency ${latencyMs.toFixed(1)}ms (compare: container→R2 ≈1500ms WAN)`);

  await waitFor(() => frames.length > before && frames.join("").includes("e2e-reactive"));
  console.log("✓ reactive push received across the DO (a write client 1 did not make)");

  // 6. persistence read-back
  const read = await fetch(`${URL}/api/run`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path: "messages:list", args: { conversationId: CONV } }),
  });
  const rows = (await read.json()).value;
  if (!Array.isArray(rows) || !rows.some((r) => r.body === "e2e-reactive")) throw new Error("read-back missing the row");
  console.log("✓ persistence read-back ok:", rows.length, "row(s)");

  ws.close();
  console.log("\nALL PASS. Note: for the hibernation-resume sub-test, keep a socket subscribed, stay");
  console.log("SILENT ~60s (let the DO hibernate), then commit from a second client and re-run the");
  console.log("push assertion — the silence is the test (see README).");
  console.log(`\nMEASURED write latency (in-CF): ${latencyMs.toFixed(1)}ms`);
}

main().catch((e) => {
  console.error("✗ E2E FAILED:", e.message);
  process.exit(1);
});
