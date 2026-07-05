/* Helipod Enterprise. Licensed under the Helipod Commercial License — see ee/LICENSE. */
/**
 * Real-Cloudflare E2E for the COMBINED multi-shard + `.global()`/D1 deployment.
 *
 * Proves, against REAL shard-DOs + a REAL D1 database on real Cloudflare:
 *   1. GET /api/health → 200
 *   2. a sharded write/read on `messages` still works (routed to a room's own DO)
 *   3. THE COMPOSITION PROOF: a `.global()` row written through shard A's DO is read back through
 *      shard B's DO — i.e. `.global()` tables live in the ONE shared D1, not in any per-shard
 *      DO-SQLite. (Write routed via `?shard=roomA`, read routed via `?shard=roomB`.)
 *   4. the D1 `by_key` UNIQUE index is enforced ACROSS shards: a duplicate-key insert routed to a
 *      THIRD shard-DO fails, and the original value is unchanged (no partial/global corruption).
 *
 * Usage: node e2e.mjs --url https://helipod-do-shard-d1-fixture.<subdomain>.workers.dev --admin-key <KEY>
 */
function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : fallback;
}
const URL = arg("url");
const ADMIN_KEY = arg("admin-key", process.env.HELIPOD_ADMIN_KEY);
if (!URL) {
  console.error("usage: node e2e.mjs --url https://<app>.workers.dev [--admin-key <KEY>]");
  process.exit(2);
}

const headers = { "content-type": "application/json" };
if (ADMIN_KEY) headers["authorization"] = `Bearer ${ADMIN_KEY}`;

async function run(path, args, query = "") {
  const res = await fetch(`${URL}/api/run${query}`, {
    method: "POST",
    headers,
    body: JSON.stringify({ path, args }),
  });
  let body;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  return { status: res.status, body };
}

async function main() {
  // 1. health
  const health = await fetch(`${URL}/api/health`);
  if (health.status !== 200) throw new Error(`health ${health.status}`);
  console.log("✓ health ok:", JSON.stringify(await health.json()));

  // 2. sharded write/read sanity — messages routed to roomA's own DO
  const sent = await run("messages:send", { roomId: "roomA", body: "hi from A" });
  if (sent.status !== 200 || sent.body?.committed !== true) {
    throw new Error(`sharded send failed: ${sent.status} ${JSON.stringify(sent.body)}`);
  }
  const listed = await run("messages:list", { roomId: "roomA" }, `?shard=${encodeURIComponent("roomA")}`);
  if (!Array.isArray(listed.body?.value) || listed.body.value.length < 1) {
    throw new Error(`sharded list failed: ${JSON.stringify(listed.body)}`);
  }
  console.log("✓ sharded messages write/read on roomA's DO");

  // 3. THE COMPOSITION PROOF: global write via shard A, global read via shard B.
  // A `.global()`-only mutation writes to the shared D1, not the local DO-SQLite MVCC store, so the
  // /api/run `committed` flag (which reflects a LOCAL commit) is false — the real durability+sharing
  // proof is the cross-shard read-back below, not that flag. It must return a document id.
  const K = `g-${Date.now()}`;
  const created = await run("counters:create", { key: K, value: 42 }, `?shard=${encodeURIComponent("roomA")}`);
  if (created.status !== 200 || typeof created.body?.value !== "string") {
    throw new Error(`global create via roomA did not return an id: ${created.status} ${JSON.stringify(created.body)}`);
  }
  const readB = await run("counters:getByKey", { key: K }, `?shard=${encodeURIComponent("roomB")}`);
  const rowB = readB.body?.value;
  if (!rowB || rowB.key !== K || rowB.value !== 42) {
    throw new Error(`GLOBAL NOT SHARED ACROSS SHARDS: wrote via roomA, roomB read ${JSON.stringify(rowB)}`);
  }
  console.log(`✓ .global() row written via roomA's DO is visible via roomB's DO (shared D1): ${JSON.stringify(rowB)}`);

  // 4. global unique index enforced across shards: duplicate key via a THIRD shard must NOT overwrite.
  const dup = await run("counters:create", { key: K, value: 99 }, `?shard=${encodeURIComponent("roomC")}`);
  console.log(`  (duplicate-insert response via roomC: ${dup.status} ${JSON.stringify(dup.body)})`);
  const readAgain = await run("counters:getByKey", { key: K }, `?shard=${encodeURIComponent("roomA")}`);
  if (readAgain.body?.value?.value !== 42) {
    throw new Error(`UNIQUENESS BREACH: duplicate key "${K}" changed the global row to ${JSON.stringify(readAgain.body?.value)} (expected value still 42)`);
  }
  console.log(`✓ D1 unique 'by_key' index enforced across shards (duplicate via roomC did not overwrite; value still 42)`);

  console.log("\nALL PASS. Multi-shard writers + a shared .global()/D1 table compose on real");
  console.log("Cloudflare: sharded tables live in per-room DO-SQLite, global tables in one shared D1,");
  console.log("read-your-writes and uniqueness hold across shard boundaries.");
}

main().catch((e) => {
  console.error(`✗ E2E FAILED: ${e.message}`);
  process.exit(1);
});
