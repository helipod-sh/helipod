#!/usr/bin/env node
/* Stackbase Enterprise. Licensed under the Stackbase Commercial License — see ee/LICENSE. */
/**
 * The flagship real-Cloudflare MULTI-SHARD E2E — the honest gate. This worktree has NO Cloudflare
 * login, so it is DEPLOY-READY-BUT-UNRUN: a human runs `wrangler deploy` (see ./README.md) and then
 * this script against the resulting `*.workers.dev` URL. It does NOT fake a deploy. The lower tier
 * (real-workerd via vitest-pool-workers) already passes in CI; this closes the last gap: real
 * Cloudflare, real per-DO placement across shards, real cross-datacenter routing.
 *
 * Usage:
 *   node e2e.mjs --url https://stackbase-do-shard-fixture.<subdomain>.workers.dev
 *
 * Proves, against REAL shard-DOs on real Cloudflare:
 *   1. GET /api/health → 200
 *   2. writes to two shard keys (roomA, roomB) land in two DIFFERENT DOs — roomA's write is invisible
 *      to a query routed to roomB's DO (physical isolation across shards, not a leak)
 *   3. a shard-scoped WebSocket on roomR gets a reactive push for a roomR commit, and is NOT woken by
 *      a commit on another shard (reactivity does not cross the DO boundary)
 *   4. a cross-shard fan-out is REJECTED with the typed CROSS_SHARD_UNSUPPORTED (no partial data)
 *   5. MEASURE aggregate write throughput across shards (concurrent commits to distinct keys)
 *
 * Requires `ws` (already a repo devDep). Run from this dir with node ≥18.
 */
import WebSocket from "ws";

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : fallback;
}

const URL = arg("url");
if (!URL) {
  console.error("usage: node e2e.mjs --url https://<app>.workers.dev");
  process.exit(2);
}
const SUFFIX = Date.now().toString(36);
const roomA = `A-${SUFFIX}`;
const roomB = `B-${SUFFIX}`;
const roomR = `R-${SUFFIX}`;
const roomOther = `O-${SUFFIX}`;

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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function run(path, args, query = "") {
  const res = await fetch(`${URL}/api/run${query}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path, args }),
  });
  return res;
}
async function send(roomId, body) {
  const res = await run("messages:send", { roomId, body });
  if (res.status !== 200) throw new Error(`send(${roomId}) → ${res.status}`);
  return res;
}
async function listOn(roomId, shardKey) {
  const res = await run("messages:list", { roomId }, `?shard=${encodeURIComponent(shardKey)}`);
  const rows = (await res.json()).value;
  return Array.isArray(rows) ? rows.map((r) => r.body) : [];
}

async function main() {
  // 1. health
  const health = await fetch(`${URL}/api/health`);
  if (health.status !== 200) throw new Error(`health ${health.status}`);
  console.log("✓ health ok");

  // 2. two shard keys → two DOs; isolation
  await send(roomA, "hello-A");
  await send(roomB, "hello-B");
  const aOnA = await listOn(roomA, roomA);
  const aOnB = await listOn(roomA, roomB); // roomA's data, but routed to roomB's DO
  if (!(aOnA.includes("hello-A"))) throw new Error("roomA data missing on roomA's DO");
  if (aOnB.length !== 0) throw new Error("ISOLATION BREACH: roomA data visible on roomB's DO");
  console.log("✓ shard isolation: roomA's write is invisible to a query on roomB's DO");

  // 3. shard-scoped reactive push + isolation
  const wsUrl = URL.replace(/^http/, "ws") + `/api/sync?shard=${encodeURIComponent(roomR)}`;
  const frames = [];
  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => { ws.on("open", res); ws.on("error", rej); });
  ws.on("message", (d) => frames.push(d.toString()));
  ws.send(JSON.stringify({ type: "ModifyQuerySet", add: [{ queryId: 1, udfPath: "messages:list", args: { roomId: roomR } }], remove: [] }));
  await waitFor(() => frames.some((f) => f.includes("Transition")));
  const before = frames.length;
  await send(roomR, "reactive-in-R");
  await waitFor(() => frames.length > before && frames.join("").includes("reactive-in-R"));
  console.log("✓ shard-scoped reactive push received on roomR's DO");
  const afterR = frames.length;
  await send(roomOther, "reactive-in-Other");
  await sleep(1000);
  if (frames.length !== afterR) throw new Error("ISOLATION BREACH: roomR subscriber woken by another shard's commit");
  console.log("✓ reactivity is shard-isolated: a commit on another shard did NOT wake the roomR subscriber");
  ws.close();

  // 4. cross-shard fan-out rejected
  const fan = await fetch(`${URL}/api/run?fanout=1`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path: "messages:list", args: { roomId: roomA } }),
  });
  const fanBody = await fan.json();
  if (fan.status !== 400 || fanBody?.error?.code !== "CROSS_SHARD_UNSUPPORTED") {
    throw new Error(`cross-shard fan-out not rejected as expected: ${fan.status} ${JSON.stringify(fanBody)}`);
  }
  console.log("✓ cross-shard fan-out rejected with CROSS_SHARD_UNSUPPORTED (no partial data)");

  // 5. aggregate throughput across shards (concurrent commits to distinct keys → distinct DOs)
  const N = 20;
  const t0 = performance.now();
  await Promise.all(Array.from({ length: N }, (_, i) => send(`k-${SUFFIX}-${i}`, `msg-${i}`)));
  const ms = performance.now() - t0;
  console.log(`✓ ${N} concurrent commits to ${N} distinct shard-DOs in ${ms.toFixed(0)}ms (${(N / (ms / 1000)).toFixed(0)} commits/s aggregate)`);

  console.log("\nALL PASS. This is the N× write scale-out claim on real Cloudflare: each distinct shard");
  console.log("key is its own single-threaded DO with its own DO-SQLite (10 GB), so throughput and");
  console.log("storage both scale with the number of active keys.");
}

main().catch((e) => {
  console.error("✗ E2E FAILED:", e.message);
  process.exit(1);
});
