/* Stackbase Enterprise. Licensed under the Stackbase Commercial License — see ee/LICENSE. */
/**
 * Fleet slice ship gate: proves the EXACT production Tier-2 path — multiple REAL `stackbase serve
 * --fleet` processes (spawned under `bun`, the primary runtime, driving `packages/cli/dist/bin.js`)
 * over a REAL `postgres:16` Docker container. Nothing in-process: writer/sync roles, write
 * forwarding, cross-process reactive fan-out, and live failover are all exercised through the shipped
 * CLI entrypoint + real HTTP/WebSocket, mirroring `packages/cli/test/postgres-e2e.test.ts`.
 *
 * Proves, end to end:
 *   1. Symmetric boot elects one writer: node A (booted first) → `role: "writer"`, node B →
 *      `role: "sync"`; `shard_leases` reads `epoch=1, writer_url=A`.
 *   2. Write forwarding + cross-process fan-out: a mutation POSTed to the SYNC node B forwards to A,
 *      commits, and A's NOTIFY wakes B's ReplicaTailer, which re-runs a subscription opened on B —
 *      the reactive update crosses the process boundary.
 *   3. Live failover: SIGKILL A; B's lease acquire loop promotes it (`epoch=2, writer_url=B`); a
 *      mutation to B now commits LOCALLY and its own subscription fans out via the local writer path.
 *      Also covers the DOCUMENT-keyspace invalidation bridge: a `db.get(id)` subscription re-runs
 *      when that exact row is updated post-failover.
 *   4. Node join: a fresh node C boots as sync against the unchanged lease; a mutation to C forwards
 *      to the writer (B), and a query on C reads back the full row set (C serves reads locally).
 *
 * Skips the whole suite when `docker` isn't on PATH (so it doesn't hard-fail in a Docker-less CI).
 */
import { describe, it, expect, afterAll } from "vitest";
import { spawn, spawnSync, type ChildProcessByStdio } from "node:child_process";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer } from "node:net";
import type { Readable } from "node:stream";
import WebSocket from "ws";
import { Client } from "pg";
// Pure helper — reconstructs a node's `application_name` from its advertise URL, the exact
// discriminator `prepareFleetNode` stamps on that node's Postgres backends. Imported from `src`
// (not `dist`) only to compute the string in-test; the spawned `serve` children run the BUILT fleet
// code (via `packages/cli/dist/bin.js`), so both sides must agree — rebuild before running.
import { fleetApplicationName } from "../src/node";
// The exported shard router — the ONE source of truth both this test and the running engine share
// for mapping a shard-key value to its shard id. Imported from `@stackbase/id-codec`'s built `dist`
// (the spawned `serve` children run the same built code), so the shard a channelId routes to here is
// exactly the shard the kernel guards + commit pool route it to in the child processes.
import { shardIdForKeyValue } from "@stackbase/id-codec";

/* -------------------------------------------------------------------------- */
/* Docker availability + Postgres container lifecycle                          */
/* -------------------------------------------------------------------------- */

function dockerAvailable(): boolean {
  try {
    return spawnSync("docker", ["version", "--format", "{{.Server.Version}}"], { stdio: "ignore" }).status === 0;
  } catch {
    return false;
  }
}

const HAS_DOCKER = dockerAvailable();
const maybeDescribe = HAS_DOCKER ? describe : describe.skip;

const CONTAINER_NAME = `sb-fleet-e2e-${process.pid}`;

/** Module-level tracker for all spawned fleet serve processes — used by afterAll fallback to ensure
 *  cleanup even if a test hangs or errors out. Each process is pushed immediately on spawn. */
const allSpawnedProcesses: ServeProcess[] = [];

function runDocker(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync("docker", args, { encoding: "utf8" });
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

async function startPostgresContainer(): Promise<{ port: number }> {
  runDocker(["rm", "-f", CONTAINER_NAME]); // in case a previous run leaked it
  const run = runDocker([
    "run", "-d", "--name", CONTAINER_NAME,
    "-e", "POSTGRES_PASSWORD=postgres",
    "-p", "127.0.0.1::5432",
    "postgres:16",
  ]);
  if (run.status !== 0) throw new Error(`docker run failed: ${run.stderr}`);

  const portRes = runDocker(["port", CONTAINER_NAME, "5432/tcp"]);
  const line = portRes.stdout.trim().split("\n")[0] ?? "";
  const m = line.match(/:(\d+)$/);
  if (!m) throw new Error(`could not parse \`docker port\` output: ${JSON.stringify(portRes.stdout)}`);
  const port = Number(m[1]);

  const deadline = Date.now() + 60_000;
  for (;;) {
    if (runDocker(["exec", CONTAINER_NAME, "pg_isready", "-U", "postgres"]).status === 0) break;
    if (Date.now() > deadline) throw new Error("postgres container did not become ready within 60s");
    await new Promise<void>((r) => setTimeout(r, 500));
  }
  return { port };
}

function stopPostgresContainer(): void {
  runDocker(["rm", "-f", CONTAINER_NAME]);
}

/* -------------------------------------------------------------------------- */
/* Fixture app (schema + notes:add/list/get/update) — codegen committed        */
/* -------------------------------------------------------------------------- */

function fixtureConvexDir(): string {
  return resolve(new URL(".", import.meta.url).pathname, "fixtures", "app", "convex");
}

/* -------------------------------------------------------------------------- */
/* `serve --fleet` child-process lifecycle (spawned via `bun`)                 */
/* -------------------------------------------------------------------------- */

const CLI_BIN = resolve(new URL(".", import.meta.url).pathname, "../../../../packages/cli/dist/bin.js");
const ADMIN_KEY = "fleet-e2e-key";

type ServeProcess = ChildProcessByStdio<null, Readable, Readable>;

interface ReadyLine {
  url: string;
  role?: "sync" | "writer";
  fleet?: boolean;
}
type ReadyOrExit = { ready?: ReadyLine; exitCode?: number | null; stdout: string; stderr: string };

/** Wait for the `serve` ready JSON line on stdout (the first complete line that parses to an object
 *  with a `url`), or the process exiting first. Robust to any non-JSON log lines emitted before it.
 *  Times out after 60s with a clear message including captured stdout/stderr, preventing infinite hangs. */
function waitForReadyOrExit(proc: ServeProcess): Promise<ReadyOrExit> {
  return new Promise((resolvePromise, rejectPromise) => {
    let stdoutBuf = "";
    let stderrBuf = "";
    let settled = false;
    const timeoutMs = 60_000;
    const deadline = Date.now() + timeoutMs;
    const timeoutHandle = setTimeout(() => {
      if (settled) return;
      settled = true;
      proc.stdout.off("data", onStdout);
      proc.stderr.off("data", onStderr);
      proc.off("exit", onExit);
      rejectPromise(
        new Error(
          `waitForReadyOrExit timed out after ${timeoutMs}ms waiting for ready line. ` +
          `Last stdout: ${JSON.stringify(stdoutBuf)}, stderr: ${JSON.stringify(stderrBuf)}`,
        ),
      );
    }, timeoutMs);
    const finish = (result: ReadyOrExit) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutHandle);
      proc.stdout.off("data", onStdout);
      proc.stderr.off("data", onStderr);
      proc.off("exit", onExit);
      resolvePromise(result);
    };
    const onStdout = (chunk: Buffer) => {
      stdoutBuf += chunk.toString("utf8");
      let nl: number;
      while ((nl = stdoutBuf.indexOf("\n")) >= 0) {
        const line = stdoutBuf.slice(0, nl);
        stdoutBuf = stdoutBuf.slice(nl + 1);
        try {
          const parsed = JSON.parse(line) as ReadyLine;
          if (parsed && typeof parsed.url === "string") {
            finish({ ready: parsed, stdout: line, stderr: stderrBuf });
            return;
          }
        } catch {
          // Not the ready line (some other log) — keep scanning.
        }
      }
    };
    const onStderr = (chunk: Buffer) => {
      stderrBuf += chunk.toString("utf8");
    };
    const onExit = (code: number | null) => finish({ exitCode: code, stdout: stdoutBuf, stderr: stderrBuf });
    proc.stdout.on("data", onStdout);
    proc.stderr.on("data", onStderr);
    proc.once("exit", onExit);
  });
}

/** Allocate a free localhost TCP port by binding :0 and reading it back. Fleet advertise URLs must
 *  name the real bound port (peers forward writes to it), so `--port 0` won't do here. */
function freePort(): Promise<number> {
  return new Promise((resolvePromise, reject) => {
    const srv = createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      if (addr && typeof addr === "object") {
        const p = addr.port;
        srv.close(() => resolvePromise(p));
      } else {
        srv.close(() => reject(new Error("could not allocate a port")));
      }
    });
  });
}

/** Per-node data dirs — since slice 2 each SYNC node keeps its OWN local file-backed replica
 *  (`<dataDir>/fleet-replica.db`); nodes must not share a data dir (they'd stomp each other's
 *  replica), and a fresh dir per run prevents a stale replica from a prior run leaking rows into a
 *  new (empty) primary's subscriptions. Cleaned in afterAll. */
const spawnedDataDirs: string[] = [];

/** Filename of a sync node's local file-backed replica under its `--data-dir` (mirrors the fleet
 *  node's `REPLICA_DB_FILENAME`). Hardcoded rather than imported to keep this test black-box. */
const REPLICA_DB_FILENAME = "fleet-replica.db";

/** Spawn a `serve --fleet` child. A `dataDir` may be supplied to reuse an EXISTING data dir (the
 *  replica-persistence scenario restarts a node against the same dir so its on-disk replica resumes
 *  instead of replaying); when omitted, a fresh per-node dir is minted (nodes must not share one).
 *  Caller-provided dirs are the caller's to track/clean; freshly-minted ones are tracked here.
 *  `extraEnv` layers additional environment onto the child — the wedged-writer scenario passes
 *  `STACKBASE_FLEET_LEASE_TTL_MS` to shrink the failover clock; unset (the existing scenarios) is
 *  byte-for-byte the old behavior. */
function spawnFleetServe(
  databaseUrl: string,
  port: number,
  dataDir?: string,
  extraEnv?: Record<string, string>,
): ServeProcess {
  const advertiseUrl = `http://127.0.0.1:${port}`;
  if (dataDir === undefined) {
    dataDir = mkdtempSync(join(tmpdir(), "sb-fleet-node-"));
    spawnedDataDirs.push(dataDir);
  }
  const proc = spawn(
    "bun",
    [
      CLI_BIN, "serve",
      "--dir", fixtureConvexDir(),
      "--data", join(dataDir, "db.sqlite"),
      "--port", String(port),
      "--ip", "127.0.0.1",
      "--no-dashboard",
      "--database-url", databaseUrl,
      "--fleet",
      "--advertise-url", advertiseUrl,
    ],
    { env: { ...process.env, STACKBASE_ADMIN_KEY: ADMIN_KEY, ...extraEnv }, stdio: ["ignore", "pipe", "pipe"] },
  );
  allSpawnedProcesses.push(proc);
  return proc;
}

async function stopServe(proc: ServeProcess | undefined): Promise<void> {
  if (!proc || proc.exitCode !== null || proc.signalCode !== null) return;
  proc.kill("SIGTERM");
  await new Promise<void>((r) => proc.once("exit", () => r()));
}

/* -------------------------------------------------------------------------- */
/* HTTP + WebSocket helpers                                                     */
/* -------------------------------------------------------------------------- */

interface RunResult { status: number; body: { value?: unknown; committed?: boolean; error?: string } }

async function apiRun(url: string, path: string, args: Record<string, unknown>): Promise<RunResult> {
  const res = await fetch(`${url}/api/run`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path, args }),
  });
  const body = (await res.json()) as RunResult["body"];
  return { status: res.status, body };
}

/** A `/api/run` call bounded by an `AbortController` timeout. The offload proof needs this: with the
 *  primary paused, a mutation forwarded from a SYNC node reaches the writer, whose commit then hangs
 *  on the frozen Postgres TCP connection (the commit itself is unbounded — only the forwarder's
 *  lease-refresh/retry and the RYOW wait are bounded), so the sync node's `/api/run` never responds.
 *  We treat that timeout as a VISIBLE failure. Distinguishes: an HTTP response, a client-side abort
 *  (timeout), or a transport error. */
type BoundedRunOutcome =
  | { kind: "http"; status: number; body: RunResult["body"] }
  | { kind: "timeout" }
  | { kind: "error"; message: string };

async function apiRunBounded(
  url: string,
  path: string,
  args: Record<string, unknown>,
  timeoutMs: number,
): Promise<BoundedRunOutcome> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(`${url}/api/run`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path, args }),
      signal: ac.signal,
    });
    let body: RunResult["body"] = {};
    try {
      body = (await res.json()) as RunResult["body"];
    } catch {
      // Empty/non-JSON body — leave as {} (a mutation that failed to commit is still a visible fail).
    }
    return { kind: "http", status: res.status, body };
  } catch (e) {
    if (ac.signal.aborted) return { kind: "timeout" };
    return { kind: "error", message: e instanceof Error ? e.message : String(e) };
  } finally {
    clearTimeout(timer);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function openWs(url: string): Promise<WebSocket> {
  return new Promise((resolvePromise, reject) => {
    const ws = new WebSocket(url);
    ws.once("open", () => resolvePromise(ws));
    ws.once("error", reject);
  });
}

type ServerMsg = {
  type: string;
  modifications?: Array<{ type: string; queryId: number; value?: unknown; error?: string }>;
};

function collectMessages(ws: WebSocket): ServerMsg[] {
  const messages: ServerMsg[] = [];
  ws.on("message", (raw: Buffer) => {
    messages.push(JSON.parse(raw.toString("utf8")) as ServerMsg);
  });
  return messages;
}

function send(ws: WebSocket, msg: unknown): void {
  ws.send(JSON.stringify(msg));
}

async function waitFor(cond: () => boolean, timeoutMs = 20_000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
    await new Promise<void>((r) => setTimeout(r, 20));
  }
}

function latestMod(
  messages: ServerMsg[],
  queryId: number,
): { type: string; queryId: number; value?: unknown; error?: string } | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const mods = messages[i]?.modifications ?? [];
    for (let j = mods.length - 1; j >= 0; j--) {
      const m = mods[j];
      if (m !== undefined && m.queryId === queryId) return m;
    }
  }
  return undefined;
}

/** Open a live subscription for `udfPath(args)` on `wsUrl`, wait for its first QueryUpdated. */
async function subscribe(
  wsUrl: string,
  queryId: number,
  udfPath: string,
  args: Record<string, unknown>,
): Promise<{ ws: WebSocket; messages: ServerMsg[] }> {
  const ws = await openWs(wsUrl);
  const messages = collectMessages(ws);
  send(ws, { type: "ModifyQuerySet", add: [{ queryId, udfPath, args }], remove: [] });
  await waitFor(() => latestMod(messages, queryId)?.type === "QueryUpdated");
  return { ws, messages };
}

/* -------------------------------------------------------------------------- */
/* Lease inspection (direct `pg` client — observe election + failover)          */
/* -------------------------------------------------------------------------- */

async function readLease(pg: Client): Promise<{ epoch: number; writerUrl: string } | null> {
  const r = await pg.query("SELECT epoch, writer_url FROM shard_leases WHERE shard_id = 'default'");
  const row = r.rows[0] as { epoch: string; writer_url: string } | undefined;
  return row ? { epoch: Number(row.epoch), writerUrl: row.writer_url } : null;
}

async function waitForLease(
  pg: Client,
  pred: (l: { epoch: number; writerUrl: string }) => boolean,
  timeoutMs = 15_000,
): Promise<{ epoch: number; writerUrl: string }> {
  const start = Date.now();
  for (;;) {
    const l = await readLease(pg).catch(() => null);
    if (l && pred(l)) return l;
    if (Date.now() - start > timeoutMs) throw new Error(`lease predicate not met within ${timeoutMs}ms (last=${JSON.stringify(l)})`);
    await new Promise<void>((r) => setTimeout(r, 250));
  }
}

/**
 * The no-skipped-ts / density proof, straight off the primary's `documents` MVCC log via direct SQL:
 * for EVERY document (`table_id`, `internal_id`), ordering its revisions by `ts`, each revision's
 * `prev_ts` must equal its immediate predecessor's `ts` (and the first revision's `prev_ts` must be
 * NULL). A single window-function pass with `LAG(ts)` computes each row's predecessor ts;
 * `prev_ts IS DISTINCT FROM pred_ts` flags any break in the chain (NULL-safe, so an insert's
 * NULL/NULL is not a violation). Zero violations ⇒ not a single commit was skipped or reordered
 * across the whole run — the exact invariant the store-allocated ts (D1) + epoch-fenced commits (D3)
 * exist to guarantee, re-proven here end-to-end across the A-writer→fence→B-writer takeover. Also
 * returns how many documents carry >1 revision so the caller can assert the proof isn't vacuous. */
async function assertDenseChain(pg: Client): Promise<{ violations: number; multiRevDocs: number }> {
  const violations = await pg.query(`
    SELECT count(*)::int AS n FROM (
      SELECT prev_ts, LAG(ts) OVER (PARTITION BY table_id, internal_id ORDER BY ts) AS pred_ts
      FROM documents
    ) t
    WHERE prev_ts IS DISTINCT FROM pred_ts
  `);
  const multi = await pg.query(`
    SELECT count(*)::int AS n FROM (
      SELECT table_id, internal_id FROM documents GROUP BY table_id, internal_id HAVING count(*) > 1
    ) d
  `);
  return {
    violations: (violations.rows[0] as { n: number }).n,
    multiRevDocs: (multi.rows[0] as { n: number }).n,
  };
}

/* -------------------------------------------------------------------------- */
/* Sharded-scenario helpers (B2a cross-shard ship gate)                        */
/* -------------------------------------------------------------------------- */

/** NUM_SHARDS this suite's sharded scenario pins (via `STACKBASE_FLEET_SHARDS`) so the in-test
 *  router `shardIdForKeyValue(value, NUM_SHARDS)` agrees with the child processes' routing exactly,
 *  independent of the fleet default. Matches the fleet default (8) so the density/frontier shape is
 *  the real N-shard layout the existing scenarios exercise. */
const NUM_SHARDS = 8;

/** Find two channelId values that route to DIFFERENT non-"default" shards under `NUM_SHARDS`. Scans a
 *  small deterministic candidate space (`chan-0`, `chan-1`, …) — the jump-hash spread means a pair is
 *  found within the first handful. Throws (rather than silently degrading) if none is found, so a
 *  routing regression fails loudly instead of weakening the cross-shard proof. */
function pickTwoCrossShardKeys(numShards: number): { keyX: string; keyY: string; shardX: string; shardY: string } {
  let firstNonDefault: { key: string; shard: string } | undefined;
  for (let i = 0; i < 256; i++) {
    const key = `chan-${i}`;
    const shard = shardIdForKeyValue(key, numShards);
    if (shard === "default") continue;
    if (!firstNonDefault) {
      firstNonDefault = { key, shard };
      continue;
    }
    if (shard !== firstNonDefault.shard) {
      return { keyX: firstNonDefault.key, keyY: key, shardX: firstNonDefault.shard, shardY: shard };
    }
  }
  throw new Error(`could not find two channelId values routing to different non-default shards at numShards=${numShards}`);
}

/** Every `QueryUpdated` state pushed for `queryId`, in arrival order — the substrate for the
 *  monotonic-containment (never-regressing) subscription proof. */
function pushedQueryStates(messages: ServerMsg[], queryId: number): unknown[] {
  const states: unknown[] = [];
  for (const msg of messages) {
    for (const m of msg.modifications ?? []) {
      if (m.queryId === queryId && m.type === "QueryUpdated") states.push(m.value);
    }
  }
  return states;
}

/** Reduce a `messages:list` push value to the sorted set of its bodies. */
function bodiesOf(value: unknown): string[] {
  return Array.isArray(value)
    ? (value as Array<{ body?: string }>).map((m) => m.body ?? "").sort()
    : [];
}

/* -------------------------------------------------------------------------- */
/* Test                                                                        */
/* -------------------------------------------------------------------------- */

maybeDescribe("stackbase serve --fleet — Tier-2 ship gate (real containers, real processes, failover)", () => {
  afterAll(() => {
    // Belt-and-braces: kill any still-alive spawned processes BEFORE stopping the container.
    // This ensures cleanup even if the test hangs or errors out, bypassing the try/finally.
    for (const proc of allSpawnedProcesses) {
      if (proc.exitCode === null && proc.signalCode === null) {
        try {
          proc.kill("SIGKILL");
        } catch {
          // Ignore errors if process is already gone.
        }
      }
    }
    stopPostgresContainer();
    for (const dir of spawnedDataDirs) rmSync(dir, { recursive: true, force: true });
  });

  it(
    "elects a writer, forwards writes + fans out cross-process, fails over live, and admits a joining node",
    async () => {
      const { port: pgPort } = await startPostgresContainer();
      const databaseUrl = `postgres://postgres:postgres@127.0.0.1:${pgPort}/postgres`;

      const portA = await freePort();
      const portB = await freePort();
      const portC = await freePort();
      const advA = `http://127.0.0.1:${portA}`;
      const advB = `http://127.0.0.1:${portB}`;

      const pg = new Client({ connectionString: databaseUrl });
      await pg.connect();

      let nodeA: ServeProcess | undefined;
      let nodeB: ServeProcess | undefined;
      let nodeC: ServeProcess | undefined;
      let wsListB: WebSocket | undefined;
      let wsGetB: WebSocket | undefined;
      try {
        /* ---------------------------------------------------------------- */
        /* 1. Boot A (writer, first) then B (sync). Lease: epoch=1, url=A.    */
        /* ---------------------------------------------------------------- */
        nodeA = spawnFleetServe(databaseUrl, portA);
        const bootA = await waitForReadyOrExit(nodeA);
        if (!bootA.ready) throw new Error(`node A failed to boot: exit=${bootA.exitCode} stderr=${bootA.stderr}`);
        expect(bootA.ready.fleet).toBe(true);
        expect(bootA.ready.role).toBe("writer");
        const urlA = bootA.ready.url;

        nodeB = spawnFleetServe(databaseUrl, portB);
        const bootB = await waitForReadyOrExit(nodeB);
        if (!bootB.ready) throw new Error(`node B failed to boot: exit=${bootB.exitCode} stderr=${bootB.stderr}`);
        expect(bootB.ready.role).toBe("sync");
        const urlB = bootB.ready.url;

        const lease1 = await waitForLease(pg, (l) => l.epoch >= 1);
        expect(lease1.epoch).toBe(1);
        expect(lease1.writerUrl).toBe(advA);

        /* ---------------------------------------------------------------- */
        /* 2. Subscribe on the SYNC node B; a mutation POSTed to B forwards   */
        /*    to A, commits, and fans out back across the process boundary.  */
        /* ---------------------------------------------------------------- */
        const listSub = await subscribe(`${urlB.replace("http", "ws")}/api/sync`, 1, "notes:list", {});
        wsListB = listSub.ws;
        expect(latestMod(listSub.messages, 1)!.value).toEqual([]);

        const add1 = await apiRun(urlB, "notes:add", { box: "b1", text: "hello" });
        expect(add1.status).toBe(200);
        expect(add1.body.committed).toBe(true);
        const note1Id = add1.body.value as string;
        expect(typeof note1Id).toBe("string");

        await waitFor(() => {
          const m = latestMod(listSub.messages, 1);
          return m?.type === "QueryUpdated" && Array.isArray(m.value) && (m.value as unknown[]).length > 0;
        });
        expect(latestMod(listSub.messages, 1)!.value).toEqual([{ box: "b1", text: "hello" }]);

        /* ---------------------------------------------------------------- */
        /* 2b. Document-keyspace bridge: a `db.get(id)` subscription on B     */
        /*     re-runs when that exact row is written (via the writer).       */
        /* ---------------------------------------------------------------- */
        const getSub = await subscribe(`${urlB.replace("http", "ws")}/api/sync`, 2, "notes:get", { id: note1Id });
        wsGetB = getSub.ws;
        expect(latestMod(getSub.messages, 2)!.value).toEqual({ box: "b1", text: "hello" });

        const upd1 = await apiRun(urlB, "notes:update", { id: note1Id, text: "hello-v2" });
        expect(upd1.status).toBe(200);
        await waitFor(() => {
          const m = latestMod(getSub.messages, 2);
          return m?.type === "QueryUpdated" && (m.value as { text?: string } | null)?.text === "hello-v2";
        });

        /* ---------------------------------------------------------------- */
        /* 3. Live failover: SIGKILL A. B's acquire loop promotes it.         */
        /* ---------------------------------------------------------------- */
        nodeA.kill("SIGKILL");
        await new Promise<void>((r) => nodeA!.once("exit", () => r()));
        nodeA = undefined;

        const lease2 = await waitForLease(pg, (l) => l.epoch >= 2 && l.writerUrl === advB, 15_000);
        expect(lease2.epoch).toBe(2);
        expect(lease2.writerUrl).toBe(advB);

        // In-flight writes during the failover window may fail (client-retryable) — retry until the
        // now-local writer accepts it, within a small budget.
        const failoverAdd = await (async () => {
          const deadline = Date.now() + 15_000;
          for (;;) {
            const r = await apiRun(urlB, "notes:add", { box: "b2", text: "after-failover" }).catch(
              () => ({ status: 0, body: {} }) as RunResult,
            );
            if (r.status === 200 && r.body.committed === true) return r;
            if (Date.now() > deadline) throw new Error(`post-failover mutation never succeeded: ${JSON.stringify(r.body)}`);
            await new Promise<void>((res) => setTimeout(res, 300));
          }
        })();
        expect(failoverAdd.body.committed).toBe(true);

        // B is now the writer: its own commit fans out via the LOCAL writer path to B's subscription.
        await waitFor(() => {
          const m = latestMod(listSub.messages, 1);
          const v = m?.value as Array<{ box: string; text: string }> | undefined;
          return m?.type === "QueryUpdated" && Array.isArray(v) && v.some((n) => n.text === "after-failover");
        }, 15_000);

        /* ---------------------------------------------------------------- */
        /* 4. Node join: C boots sync against the unchanged (epoch=2) lease;  */
        /*    a mutation to C forwards to B; a query on C reads the full set. */
        /* ---------------------------------------------------------------- */
        nodeC = spawnFleetServe(databaseUrl, portC);
        const bootC = await waitForReadyOrExit(nodeC);
        if (!bootC.ready) throw new Error(`node C failed to boot: exit=${bootC.exitCode} stderr=${bootC.stderr}`);
        expect(bootC.ready.role).toBe("sync");
        const urlC = bootC.ready.url;

        const leaseAfterJoin = await readLease(pg);
        expect(leaseAfterJoin?.epoch).toBe(2); // joining a sync node does NOT bump the lease
        expect(leaseAfterJoin?.writerUrl).toBe(advB);

        const addViaC = await (async () => {
          const deadline = Date.now() + 10_000;
          for (;;) {
            const r = await apiRun(urlC, "notes:add", { box: "b3", text: "via-c" }).catch(
              () => ({ status: 0, body: {} }) as RunResult,
            );
            if (r.status === 200 && r.body.committed === true) return r;
            if (Date.now() > deadline) throw new Error(`mutation via C never succeeded: ${JSON.stringify(r.body)}`);
            await new Promise<void>((res) => setTimeout(res, 300));
          }
        })();
        expect(addViaC.body.committed).toBe(true);

        // C serves reads locally — the full row set (written across A, B, and forwarded via C) is present.
        const listViaC = await (async () => {
          const deadline = Date.now() + 10_000;
          for (;;) {
            const r = await apiRun(urlC, "notes:list", {});
            const v = r.body.value as Array<{ box: string; text: string }> | undefined;
            if (r.status === 200 && Array.isArray(v) && v.length === 3) return v;
            if (Date.now() > deadline) throw new Error(`query via C did not see all 3 rows: ${JSON.stringify(r.body.value)}`);
            await new Promise<void>((res) => setTimeout(res, 300));
          }
        })();
        const texts = listViaC.map((n) => n.text).sort();
        expect(texts).toEqual(["after-failover", "hello-v2", "via-c"]);
      } finally {
        wsListB?.close();
        wsGetB?.close();
        await pg.end().catch(() => {});
        await stopServe(nodeA);
        await stopServe(nodeB);
        await stopServe(nodeC);
        stopPostgresContainer();
      }
    },
    { timeout: 240_000 },
  );

  it(
    "serves read-your-own-writes, offloads reads while the primary is paused, and resumes the on-disk replica across a restart",
    async () => {
      const { port: pgPort } = await startPostgresContainer();
      const databaseUrl = `postgres://postgres:postgres@127.0.0.1:${pgPort}/postgres`;

      const portA = await freePort();
      const portB = await freePort();
      const advA = `http://127.0.0.1:${portA}`;

      // B's data dir is created by the test (not spawnFleetServe) so the restart step below can
      // re-open the SAME on-disk replica — proving resume-not-replay.
      const dataDirB = mkdtempSync(join(tmpdir(), "sb-fleet-nodeB-"));
      spawnedDataDirs.push(dataDirB);

      const pg = new Client({ connectionString: databaseUrl });
      await pg.connect();

      let nodeA: ServeProcess | undefined;
      let nodeB: ServeProcess | undefined;
      let nodeBRestart: ServeProcess | undefined;
      let wsB: WebSocket | undefined;
      let paused = false;
      try {
        /* ---------------------------------------------------------------- */
        /* Boot writer A (first) + sync B. Unlike the failover flow above, B  */
        /* stays SYNC for the whole test: its reads/subscriptions are served  */
        /* off its LOCAL replica, never Postgres — the offload proof needs a  */
        /* read path that survives the primary being frozen.                  */
        /* ---------------------------------------------------------------- */
        nodeA = spawnFleetServe(databaseUrl, portA);
        const bootA = await waitForReadyOrExit(nodeA);
        if (!bootA.ready) throw new Error(`node A failed to boot: exit=${bootA.exitCode} stderr=${bootA.stderr}`);
        expect(bootA.ready.role).toBe("writer");

        nodeB = spawnFleetServe(databaseUrl, portB, dataDirB);
        const bootB = await waitForReadyOrExit(nodeB);
        if (!bootB.ready) throw new Error(`node B failed to boot: exit=${bootB.exitCode} stderr=${bootB.stderr}`);
        expect(bootB.ready.role).toBe("sync");
        const urlB = bootB.ready.url;

        const lease1 = await waitForLease(pg, (l) => l.epoch >= 1 && l.writerUrl === advA);
        expect(lease1.epoch).toBe(1);

        // Live subscription on the sync node — its updates throughout the test implicitly prove the
        // replica tailer's tail -> verbatim-apply -> derive-invalidation -> fan-out pipeline.
        const sub = await subscribe(`${urlB.replace("http", "ws")}/api/sync`, 1, "notes:list", {});
        wsB = sub.ws;
        expect(latestMod(sub.messages, 1)!.value).toEqual([]);

        /* ---------------------------------------------------------------- */
        /* RYOW: mutate via B, then IMMEDIATELY (no sleep) query via B. The    */
        /* forwarder's post-commit wait for the replica watermark to reach     */
        /* this write's commitTs is what makes the immediate read see it.      */
        /* ---------------------------------------------------------------- */
        const ryowAdd = await apiRun(urlB, "notes:add", { box: "ryow", text: "ryow-1" });
        expect(ryowAdd.status).toBe(200);
        expect(ryowAdd.body.committed).toBe(true);

        const ryowRead = await apiRun(urlB, "notes:list", {}); // no sleep — RYOW must hold synchronously
        expect(ryowRead.status).toBe(200);
        expect(ryowRead.body.value).toEqual([{ box: "ryow", text: "ryow-1" }]);

        /* ---------------------------------------------------------------- */
        /* Offload proof: freeze the primary. B's reads + subscription must    */
        /* keep working off the replica (NO Postgres round-trip on the read     */
        /* path), while a WRITE fails visibly (the writer's commit hangs on the  */
        /* frozen connection) — not a silent success, not an unbounded hang.    */
        /* ---------------------------------------------------------------- */
        expect(runDocker(["pause", CONTAINER_NAME]).status).toBe(0);
        paused = true;

        // Read still answers 200 with correct data — served entirely from the local replica.
        const readDuringPause = await apiRunBounded(urlB, "notes:list", {}, 15_000);
        expect(readDuringPause.kind).toBe("http");
        if (readDuringPause.kind === "http") {
          expect(readDuringPause.status).toBe(200);
          expect(readDuringPause.body.value).toEqual([{ box: "ryow", text: "ryow-1" }]);
        }

        // The live subscription socket stays healthy (a paused primary must not tear it down).
        expect(wsB.readyState).toBe(WebSocket.OPEN);

        // A mutation fails visibly within a bounded window. The forwarded commit hangs on the frozen
        // primary, so B's `/api/run` never resolves and our AbortController trips — a timeout IS the
        // visible failure. Assert only that it did NOT silently commit; record the exact shape.
        const writeDuringPause = await apiRunBounded(urlB, "notes:add", { box: "paused", text: "during-pause" }, 8_000);
        const committedDuringPause =
          writeDuringPause.kind === "http" &&
          writeDuringPause.status === 200 &&
          writeDuringPause.body.committed === true;
        expect(committedDuringPause).toBe(false);

        // Unpause and reconverge: a fresh mutation commits and the subscription receives it.
        expect(runDocker(["unpause", CONTAINER_NAME]).status).toBe(0);
        paused = false;

        const reconverge = await (async () => {
          const deadline = Date.now() + 30_000;
          for (;;) {
            const r = await apiRun(urlB, "notes:add", { box: "rc", text: "reconverge" }).catch(
              () => ({ status: 0, body: {} }) as RunResult,
            );
            if (r.status === 200 && r.body.committed === true) return r;
            if (Date.now() > deadline) throw new Error(`post-unpause mutation never committed: ${JSON.stringify(r.body)}`);
            await sleep(300);
          }
        })();
        expect(reconverge.body.committed).toBe(true);

        await waitFor(() => {
          const m = latestMod(sub.messages, 1);
          const v = m?.value as Array<{ box: string; text: string }> | undefined;
          return m?.type === "QueryUpdated" && Array.isArray(v) && v.some((n) => n.text === "reconverge");
        }, 20_000);

        /* ---------------------------------------------------------------- */
        /* Replica persistence: the on-disk replica exists; restart B against  */
        /* the SAME data dir; it comes ready quickly (resume, not replay) and   */
        /* serves current data.                                                */
        /* ---------------------------------------------------------------- */
        const replicaPath = join(dataDirB, REPLICA_DB_FILENAME);
        expect(existsSync(replicaPath)).toBe(true);

        // Graceful stop (not the writer) so the replica file is closed cleanly, then restart it.
        await stopServe(nodeB);
        nodeB = undefined;

        const restartStart = Date.now();
        nodeBRestart = spawnFleetServe(databaseUrl, portB, dataDirB);
        const bootB2 = await waitForReadyOrExit(nodeBRestart);
        if (!bootB2.ready) throw new Error(`node B restart failed to boot: exit=${bootB2.exitCode} stderr=${bootB2.stderr}`);
        expect(bootB2.ready.role).toBe("sync");
        const restartMs = Date.now() - restartStart;
        // Resume seeds the tailer watermark from the replica's own maxTimestamp, so the ready gate
        // (catch-up to the primary) is near-instant — far under a cold from-scratch replay budget.
        expect(restartMs).toBeLessThan(30_000);
        const urlB2 = bootB2.ready.url;

        const afterRestart = await (async () => {
          const deadline = Date.now() + 15_000;
          for (;;) {
            const r = await apiRun(urlB2, "notes:list", {});
            const v = r.body.value as Array<{ box: string; text: string }> | undefined;
            if (
              r.status === 200 &&
              Array.isArray(v) &&
              v.some((n) => n.text === "ryow-1") &&
              v.some((n) => n.text === "reconverge")
            ) {
              return v;
            }
            if (Date.now() > deadline) throw new Error(`restarted B did not serve current data: ${JSON.stringify(r.body.value)}`);
            await sleep(300);
          }
        })();
        expect(afterRestart.some((n) => n.text === "ryow-1")).toBe(true);
        expect(afterRestart.some((n) => n.text === "reconverge")).toBe(true);
      } finally {
        wsB?.close();
        await pg.end().catch(() => {});
        if (paused) runDocker(["unpause", CONTAINER_NAME]); // never leave a paused container behind
        await stopServe(nodeA);
        await stopServe(nodeB);
        await stopServe(nodeBRestart);
        stopPostgresContainer();
      }
    },
    { timeout: 240_000 },
  );

  it(
    "forwards an action with read-your-own-writes, then self-exits the writer when its Postgres backends are severed and promotes the survivor",
    async () => {
      const { port: pgPort } = await startPostgresContainer();
      const databaseUrl = `postgres://postgres:postgres@127.0.0.1:${pgPort}/postgres`;

      const portA = await freePort();
      const portB = await freePort();
      const advA = `http://127.0.0.1:${portA}`;
      const advB = `http://127.0.0.1:${portB}`;
      // The exact `application_name` node A stamps on its Postgres backends — the failover trigger
      // targets ONLY this discriminator, so node B's backends are untouched.
      const writerAppName = fleetApplicationName(advA);

      const pg = new Client({ connectionString: databaseUrl });
      await pg.connect();

      let nodeA: ServeProcess | undefined;
      let nodeB: ServeProcess | undefined;
      let wsB: WebSocket | undefined;
      try {
        /* ---------------------------------------------------------------- */
        /* Boot writer A (first) + sync B; A stays writer until we sever it. */
        /* ---------------------------------------------------------------- */
        nodeA = spawnFleetServe(databaseUrl, portA);
        const bootA = await waitForReadyOrExit(nodeA);
        if (!bootA.ready) throw new Error(`node A failed to boot: exit=${bootA.exitCode} stderr=${bootA.stderr}`);
        expect(bootA.ready.role).toBe("writer");

        nodeB = spawnFleetServe(databaseUrl, portB);
        const bootB = await waitForReadyOrExit(nodeB);
        if (!bootB.ready) throw new Error(`node B failed to boot: exit=${bootB.exitCode} stderr=${bootB.stderr}`);
        expect(bootB.ready.role).toBe("sync");
        const urlB = bootB.ready.url;

        const lease1 = await waitForLease(pg, (l) => l.epoch >= 1 && l.writerUrl === advA);
        expect(lease1.epoch).toBe(1);

        // Live subscription on the sync node — must survive the writer's self-exit + B's promotion and
        // still fan out the post-recovery write.
        const sub = await subscribe(`${urlB.replace("http", "ws")}/api/sync`, 1, "notes:list", {});
        wsB = sub.ws;
        expect(latestMod(sub.messages, 1)!.value).toEqual([]);

        /* ---------------------------------------------------------------- */
        /* Scenario 1 — RYOW for ACTIONS: an action POSTed to the SYNC node B */
        /* forwards to the writer, runs a nested ctx.runMutation, and the      */
        /* writer surfaces that mutation's commitTs. The forwarder's replica   */
        /* catch-up wait covers actions too, so an IMMEDIATE read on B (no     */
        /* sleep) sees the row the action wrote.                               */
        /* ---------------------------------------------------------------- */
        const actAdd = await apiRun(urlB, "notes:addViaAction", { box: "act", text: "act-1" });
        expect(actAdd.status).toBe(200);
        expect(typeof actAdd.body.value).toBe("string"); // the action returns the inserted note id

        const actRead = await apiRun(urlB, "notes:list", {}); // no sleep — action RYOW must hold synchronously
        expect(actRead.status).toBe(200);
        expect(actRead.body.value).toEqual([{ box: "act", text: "act-1" }]);

        // The write also fans out cross-process to B's live subscription.
        await waitFor(() => {
          const m = latestMod(sub.messages, 1);
          const v = m?.value as Array<{ box: string; text: string }> | undefined;
          return m?.type === "QueryUpdated" && Array.isArray(v) && v.some((n) => n.text === "act-1");
        });

        /* ---------------------------------------------------------------- */
        /* Scenario 2 — writer self-exit: sever ONLY node A's Postgres backends */
        /* via pg_terminate_backend (its app_name discriminator). This kills   */
        /* A's pinned lease/lock connection, so its LeaseMonitor sees the       */
        /* connection-lost event and A self-exits(1) — fast (event path, not    */
        /* the 5s probe path). B's acquire loop then promotes it.              */
        /* ---------------------------------------------------------------- */
        // Sanity: A's backend(s) are present and identifiable before we sever them.
        const before = await pg.query(
          "SELECT pid FROM pg_stat_activity WHERE application_name = $1 AND pid <> pg_backend_pid()",
          [writerAppName],
        );
        expect(before.rows.length).toBeGreaterThan(0);

        // Arm the exit observation BEFORE severing — assert via the child-process handle, not lease state.
        const exitInfo = new Promise<{ code: number | null; signal: NodeJS.Signals | null; elapsedMs: number }>(
          (resolvePromise) => {
            const start = Date.now();
            nodeA!.once("exit", (code, signal) => resolvePromise({ code, signal, elapsedMs: Date.now() - start }));
          },
        );

        await pg.query(
          "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name = $1 AND pid <> pg_backend_pid()",
          [writerAppName],
        );

        // The writer must EXIT (self-terminate), and fast: the connection-lost event fires immediately,
        // well under the LeaseMonitor's 5s probe interval — proving the event path, not the probe backstop.
        const exit = await Promise.race([
          exitInfo,
          new Promise<never>((_, rej) => setTimeout(() => rej(new Error("writer did not self-exit within 15s")), 15_000)),
        ]);
        nodeA = undefined; // it's gone — don't SIGTERM a dead pid in finally
        expect(exit.code).toBe(1); // process.exit(1), not a signal — a genuine self-exit
        expect(exit.signal).toBeNull();
        expect(exit.elapsedMs).toBeLessThan(4000); // < probe interval ⇒ the connectionLost event path fired

        /* ---------------------------------------------------------------- */
        /* B's acquire loop promotes it: epoch bumps to 2, writer_url = B.     */
        /* ---------------------------------------------------------------- */
        const lease2 = await waitForLease(pg, (l) => l.epoch >= 2 && l.writerUrl === advB, 15_000);
        expect(lease2.epoch).toBe(2);
        expect(lease2.writerUrl).toBe(advB);

        /* ---------------------------------------------------------------- */
        /* Post-recovery: a mutation via the survivor B commits LOCALLY and    */
        /* fans out to the pre-existing subscription.                          */
        /* ---------------------------------------------------------------- */
        const recover = await (async () => {
          const deadline = Date.now() + 15_000;
          for (;;) {
            const r = await apiRun(urlB, "notes:add", { box: "post", text: "post-recovery" }).catch(
              () => ({ status: 0, body: {} }) as RunResult,
            );
            if (r.status === 200 && r.body.committed === true) return r;
            if (Date.now() > deadline) throw new Error(`post-recovery mutation never committed: ${JSON.stringify(r.body)}`);
            await sleep(300);
          }
        })();
        expect(recover.body.committed).toBe(true);

        await waitFor(() => {
          const m = latestMod(sub.messages, 1);
          const v = m?.value as Array<{ box: string; text: string }> | undefined;
          return m?.type === "QueryUpdated" && Array.isArray(v) && v.some((n) => n.text === "post-recovery");
        }, 15_000);
      } finally {
        wsB?.close();
        await pg.end().catch(() => {});
        await stopServe(nodeA);
        await stopServe(nodeB);
        stopPostgresContainer();
      }
    },
    { timeout: 240_000 },
  );

  it(
    "fences and takes over from a WEDGED (SIGSTOP'd) writer, the straggler self-exits on SIGCONT, and the MVCC log stays skip-free",
    async () => {
      const { port: pgPort } = await startPostgresContainer();
      const databaseUrl = `postgres://postgres:postgres@127.0.0.1:${pgPort}/postgres`;

      const portA = await freePort();
      const portB = await freePort();
      const portC = await freePort();
      const advA = `http://127.0.0.1:${portA}`;
      const advB = `http://127.0.0.1:${portB}`;

      // Shrink the whole failover clock so a wedged-writer fence + takeover completes in a test's
      // timescale: lease TTL 4s (⇒ probe ~1.33s, acquire-retry ~0.53s inside @stackbase/fleet). A
      // frozen writer's lease then expires ~3-4s after the freeze — comfortably before its own 5s
      // idle-in-transaction / 10s statement server timeouts, so the FOLLOWER's eviction is what fires,
      // never the writer self-releasing its advisory lock (which would take over with only ONE epoch
      // bump instead of the eviction-fence + acquisition pair this scenario proves).
      const FLEET_TTL = { STACKBASE_FLEET_LEASE_TTL_MS: "4000" };

      const pg = new Client({ connectionString: databaseUrl });
      await pg.connect();

      let nodeA: ServeProcess | undefined;
      let nodeB: ServeProcess | undefined;
      let nodeC: ServeProcess | undefined;
      let wsB: WebSocket | undefined;
      let loopRunning = true;
      let loopDone: Promise<void> | undefined;
      let contSent = false;
      try {
        /* ---------------------------------------------------------------- */
        /* Boot writer A (first) + sync B, both on the shortened TTL.        */
        /* ---------------------------------------------------------------- */
        nodeA = spawnFleetServe(databaseUrl, portA, undefined, FLEET_TTL);
        const bootA = await waitForReadyOrExit(nodeA);
        if (!bootA.ready) throw new Error(`node A failed to boot: exit=${bootA.exitCode} stderr=${bootA.stderr}`);
        expect(bootA.ready.role).toBe("writer");

        nodeB = spawnFleetServe(databaseUrl, portB, undefined, FLEET_TTL);
        const bootB = await waitForReadyOrExit(nodeB);
        if (!bootB.ready) throw new Error(`node B failed to boot: exit=${bootB.exitCode} stderr=${bootB.stderr}`);
        expect(bootB.ready.role).toBe("sync");
        const urlB = bootB.ready.url;

        const lease1 = await waitForLease(pg, (l) => l.epoch >= 1 && l.writerUrl === advA);
        expect(lease1.epoch).toBe(1);
        const startEpoch = lease1.epoch;

        /* ---------------------------------------------------------------- */
        /* A live subscription on the sync node — it must SURVIVE the writer  */
        /* freeze, the fence/takeover, and the straggler's exit, and still    */
        /* fan out a post-takeover write.                                     */
        /* ---------------------------------------------------------------- */
        const sub = await subscribe(`${urlB.replace("http", "ws")}/api/sync`, 1, "notes:list", {});
        wsB = sub.ws;
        expect(latestMod(sub.messages, 1)!.value).toEqual([]);

        // Seed a note (forwarded B→A, committed on A) whose id the background loop then UPDATES over
        // and over — building a multi-revision prev_ts chain, the substrate for the density proof.
        const seed = await apiRun(urlB, "notes:add", { box: "seed", text: "rev-0" });
        expect(seed.body.committed).toBe(true);
        const seedId = seed.body.value as string;
        expect(typeof seedId).toBe("string");

        /* ---------------------------------------------------------------- */
        /* Background mutation loop via B (every 300ms): updates the seed     */
        /* note (chain growth) with tolerated per-tick failures — writes      */
        /* forwarded to A will fail once A is frozen; they resume once B is    */
        /* the local writer.                                                  */
        /* ---------------------------------------------------------------- */
        let loopCounter = 0;
        let loopSuccesses = 0;
        loopDone = (async () => {
          while (loopRunning) {
            loopCounter += 1;
            const r = await apiRunBounded(urlB, "notes:update", { id: seedId, text: `rev-${loopCounter}` }, 2_000).catch(
              () => ({ kind: "error", message: "threw" }) as BoundedRunOutcome,
            );
            if (r.kind === "http" && r.status === 200) loopSuccesses += 1;
            await sleep(300);
          }
        })();

        // Let a few forwarded updates land cleanly on A before we wedge it.
        await waitFor(() => loopSuccesses >= 2, 15_000);

        /* ---------------------------------------------------------------- */
        /* WEDGE the writer: SIGSTOP freezes A's process — its TCP            */
        /* connections stay open (frozen), so this is NOT a connection-lost   */
        /* signal; the lease's expires_at lapsing is what drives the fence.   */
        /* ---------------------------------------------------------------- */
        const freezeAt = Date.now();
        nodeA.kill("SIGSTOP");

        /* ---------------------------------------------------------------- */
        /* Fence + takeover + promotion. B's acquire loop must run EVICTION   */
        /* (advisory-try fails against A's still-held lock, lease expired ⇒    */
        /* evictExpired bumps the epoch AND pg_terminate_backend frees A's     */
        /* backend) THEN acquisition — so the epoch climbs by >= 2 and the     */
        /* writer_url flips to B.                                              */
        /* ---------------------------------------------------------------- */
        const lease2 = await waitForLease(
          pg,
          (l) => l.epoch >= startEpoch + 2 && l.writerUrl === advB,
          30_000,
        );
        const takeoverMs = Date.now() - freezeAt;
        expect(lease2.writerUrl).toBe(advB);
        expect(lease2.epoch).toBeGreaterThanOrEqual(startEpoch + 2); // eviction-fence + acquisition

        /* ---------------------------------------------------------------- */
        /* Writes via B commit again (now the LOCAL writer) and fan out to    */
        /* the PRE-EXISTING subscription opened before the failover.          */
        /* ---------------------------------------------------------------- */
        const postTakeover = await (async () => {
          const deadline = Date.now() + 20_000;
          for (;;) {
            const r = await apiRun(urlB, "notes:add", { box: "after", text: "after-takeover" }).catch(
              () => ({ status: 0, body: {} }) as RunResult,
            );
            if (r.status === 200 && r.body.committed === true) return r;
            if (Date.now() > deadline) throw new Error(`post-takeover mutation never committed: ${JSON.stringify(r.body)}`);
            await sleep(300);
          }
        })();
        expect(postTakeover.body.committed).toBe(true);

        await waitFor(() => {
          const m = latestMod(sub.messages, 1);
          const v = m?.value as Array<{ box: string; text: string }> | undefined;
          return m?.type === "QueryUpdated" && Array.isArray(v) && v.some((n) => n.text === "after-takeover");
        }, 20_000);
        expect(wsB.readyState).toBe(WebSocket.OPEN); // the socket survived the whole failover

        /* ---------------------------------------------------------------- */
        /* SIGCONT the straggler: A thaws, discovers its backend was          */
        /* terminated (connection-lost) / its epoch superseded (heartbeat     */
        /* finds 0 rows ⇒ fenced), and self-exits(1) — it must NOT resume as  */
        /* a zombie writer. Assert via the child handle, not lease state.     */
        /* ---------------------------------------------------------------- */
        const exitInfo = new Promise<{ code: number | null; signal: NodeJS.Signals | null; elapsedMs: number }>(
          (resolvePromise) => {
            const start = Date.now();
            nodeA!.once("exit", (code, signal) => resolvePromise({ code, signal, elapsedMs: Date.now() - start }));
          },
        );
        contSent = true;
        nodeA.kill("SIGCONT");
        const exit = await Promise.race([
          exitInfo,
          new Promise<never>((_, rej) => setTimeout(() => rej(new Error("straggler did not self-exit within 20s of SIGCONT")), 20_000)),
        ]);
        expect(exit.code).toBe(1); // process.exit(1) — a genuine self-demotion, not a signal kill
        expect(exit.signal).toBeNull();
        nodeA = undefined; // it's gone — don't signal a dead pid in finally

        /* ---------------------------------------------------------------- */
        /* Stop the background loop and quiesce, then the NO-SKIPPED-TS proof: */
        /* the whole run's MVCC log is a dense prev_ts chain per document —    */
        /* nothing was skipped or reordered across the A→B takeover.           */
        /* ---------------------------------------------------------------- */
        loopRunning = false;
        await loopDone;
        loopDone = undefined;

        const chain = await assertDenseChain(pg);
        expect(chain.violations).toBe(0); // every revision's prev_ts == its predecessor's ts
        expect(chain.multiRevDocs).toBeGreaterThan(0); // the seed's update chain makes the proof non-vacuous

        /* ---------------------------------------------------------------- */
        /* Full-log density RE-PROOF: a FRESH sync node C (no replica file)    */
        /* bootstraps against writer B by re-tailing the ENTIRE log from ts 0  */
        /* — the tailer's own per-entry density assertions run over every      */
        /* revision written across the whole run. It comes ready (⇒ no         */
        /* DensityViolationError halted the catch-up) and serves current data. */
        /* (A fresh sync node with an empty replica is exactly the             */
        /* delete-the-replica-file-and-re-bootstrap path; B itself is the      */
        /* writer post-takeover and a writer never tails, so the tailer        */
        /* re-proof must run on a sync node.)                                  */
        /* ---------------------------------------------------------------- */
        nodeC = spawnFleetServe(databaseUrl, portC, undefined, FLEET_TTL);
        const bootC = await waitForReadyOrExit(nodeC);
        if (!bootC.ready) throw new Error(`node C failed to bootstrap-tail the full log: exit=${bootC.exitCode} stderr=${bootC.stderr}`);
        expect(bootC.ready.role).toBe("sync"); // B still holds the lease — C joins as sync
        const urlC = bootC.ready.url;

        const listViaC = await (async () => {
          const deadline = Date.now() + 20_000;
          for (;;) {
            const r = await apiRun(urlC, "notes:list", {});
            const v = r.body.value as Array<{ box: string; text: string }> | undefined;
            if (r.status === 200 && Array.isArray(v) && v.some((n) => n.text === "after-takeover") && v.some((n) => n.box === "seed")) {
              return v;
            }
            if (Date.now() > deadline) throw new Error(`fresh sync node C did not serve current data: ${JSON.stringify(r.body.value)}`);
            await sleep(300);
          }
        })();
        expect(listViaC.some((n) => n.text === "after-takeover")).toBe(true);
        expect(listViaC.some((n) => n.box === "seed")).toBe(true);

        // Surface the observed failover timing in the test log (the report records it too).
        // eslint-disable-next-line no-console
        console.log(`[wedged-writer] takeover ${takeoverMs}ms after SIGSTOP; straggler exit ${exit.elapsedMs}ms after SIGCONT; final epoch ${lease2.epoch}`);
      } finally {
        loopRunning = false;
        if (loopDone) await loopDone.catch(() => {});
        // If we SIGSTOP'd A but never got to SIGCONT it (a mid-scenario failure), thaw it so the
        // stopServe below can deliver a graceful SIGTERM — a stopped process defers non-KILL signals
        // until it's continued, so a frozen A would otherwise sit ignoring SIGTERM in cleanup.
        if (nodeA && !contSent) {
          try {
            nodeA.kill("SIGCONT");
          } catch {
            // already gone
          }
        }
        wsB?.close();
        await pg.end().catch(() => {});
        await stopServe(nodeA);
        await stopServe(nodeB);
        await stopServe(nodeC);
        stopPostgresContainer();
      }
    },
    { timeout: 240_000 },
  );

  it(
    "commits concurrent cross-shard writes independently, serves a consistent cross-shard subscription, enforces the shard guard through the real server, and stays dense at N shards",
    async () => {
      const { port: pgPort } = await startPostgresContainer();
      const databaseUrl = `postgres://postgres:postgres@127.0.0.1:${pgPort}/postgres`;

      const portA = await freePort();
      const portB = await freePort();
      const advA = `http://127.0.0.1:${portA}`;

      // Pin NUM_SHARDS explicitly so the in-test router matches the child processes' routing exactly.
      const SHARDS_ENV = { STACKBASE_FLEET_SHARDS: String(NUM_SHARDS) };

      // Two channelId values routing to DIFFERENT non-"default" shards — the whole point of this
      // scenario. Computed with the SAME exported router the engine uses (assert they differ; neither
      // is "default"), so the cross-shard claims below are grounded, not incidental.
      const { keyX, keyY, shardX, shardY } = pickTwoCrossShardKeys(NUM_SHARDS);
      expect(shardX).not.toBe(shardY);
      expect(shardX).not.toBe("default");
      expect(shardY).not.toBe("default");

      const pg = new Client({ connectionString: databaseUrl });
      await pg.connect();

      let nodeA: ServeProcess | undefined;
      let nodeB: ServeProcess | undefined;
      let wsList: WebSocket | undefined;
      try {
        /* ---------------------------------------------------------------- */
        /* Boot writer A (first) + sync B, both pinned to NUM_SHARDS shards.  */
        /* ---------------------------------------------------------------- */
        nodeA = spawnFleetServe(databaseUrl, portA, undefined, SHARDS_ENV);
        const bootA = await waitForReadyOrExit(nodeA);
        if (!bootA.ready) throw new Error(`node A failed to boot: exit=${bootA.exitCode} stderr=${bootA.stderr}`);
        expect(bootA.ready.role).toBe("writer");

        nodeB = spawnFleetServe(databaseUrl, portB, undefined, SHARDS_ENV);
        const bootB = await waitForReadyOrExit(nodeB);
        if (!bootB.ready) throw new Error(`node B failed to boot: exit=${bootB.exitCode} stderr=${bootB.stderr}`);
        expect(bootB.ready.role).toBe("sync");
        const urlB = bootB.ready.url;

        const lease1 = await waitForLease(pg, (l) => l.epoch >= 1 && l.writerUrl === advA);
        expect(lease1.epoch).toBe(1);

        /* ---------------------------------------------------------------- */
        /* (2) Cross-shard subscription opened BEFORE the writes. `messages:  */
        /* list` scans every shard (a query reads all shards); its pushed     */
        /* states must only GROW as the two cross-shard writes land.          */
        /* ---------------------------------------------------------------- */
        const sub = await subscribe(`${urlB.replace("http", "ws")}/api/sync`, 1, "messages:list", {});
        wsList = sub.ws;
        expect(latestMod(sub.messages, 1)!.value).toEqual([]);

        /* ---------------------------------------------------------------- */
        /* (1) Concurrent cross-shard commits: fire both sends SIMULTANEOUSLY */
        /* via the SYNC node → both forward to the writer, commit on their own */
        /* shard's connection, and both 200 within a tight window. (The true  */
        /* interleaving/concurrency proof lives in the DATABASE_URL-gated pool */
        /* test — `ee/packages/docstore-postgres/test/commit-pool.*`; here we  */
        /* prove both succeeded and the per-shard frontier state is consistent.)*/
        /* ---------------------------------------------------------------- */
        const t0 = Date.now();
        const [rx, ry] = await Promise.all([
          apiRun(urlB, "messages:send", { channelId: keyX, body: "msg-X" }),
          apiRun(urlB, "messages:send", { channelId: keyY, body: "msg-Y" }),
        ]);
        const windowMs = Date.now() - t0;
        expect(rx.status).toBe(200);
        expect(rx.body.committed).toBe(true);
        expect(ry.status).toBe(200);
        expect(ry.body.committed).toBe(true);
        expect(windowMs).toBeLessThan(15_000); // both landed together, not serialized behind a long stall

        /* ---------------------------------------------------------------- */
        /* (3) RYOW: an IMMEDIATE read-back via the SAME sync node (no sleep)  */
        /* sees BOTH writes — the forwarder's replica catch-up wait covers     */
        /* each forwarded commit.                                             */
        /* ---------------------------------------------------------------- */
        const readBack = await apiRun(urlB, "messages:list", {});
        expect(readBack.status).toBe(200);
        expect(bodiesOf(readBack.body.value)).toEqual(["msg-X", "msg-Y"]);

        /* ---------------------------------------------------------------- */
        /* Per-shard frontier independence (direct pg): each committed message */
        /* doc records the shard it committed on (`documents.shard_id`, D6);   */
        /* the two land on DIFFERENT shards (shardX / shardY), each matching    */
        /* the router; and each target shard's `frontier_ts` absorbed its own   */
        /* commit (>= that doc's ts). All N lease rows share one epoch + writer */
        /* — a consistent per-shard frontier state, no partial/split writer.    */
        /* ---------------------------------------------------------------- */
        const docRows = (
          await pg.query(`SELECT ts, shard_id, value FROM documents WHERE value LIKE '%"channelId"%' ORDER BY ts`)
        ).rows as Array<{ ts: string; shard_id: string; value: string }>;
        expect(docRows.length).toBe(2);
        const byChannel = new Map<string, { ts: bigint; shardId: string }>();
        for (const r of docRows) {
          const channelId = (JSON.parse(r.value) as { channelId: string }).channelId;
          // Each doc committed on the shard its OWN channelId routes to.
          expect(r.shard_id).toBe(shardIdForKeyValue(channelId, NUM_SHARDS));
          byChannel.set(channelId, { ts: BigInt(r.ts), shardId: r.shard_id });
        }
        expect(byChannel.get(keyX)!.shardId).toBe(shardX);
        expect(byChannel.get(keyY)!.shardId).toBe(shardY);
        expect(byChannel.get(keyX)!.shardId).not.toBe(byChannel.get(keyY)!.shardId); // independent shards

        const leaseRows = (
          await pg.query(`SELECT shard_id, epoch, writer_url, frontier_ts, prev_ts FROM shard_leases`)
        ).rows as Array<{ shard_id: string; epoch: string; writer_url: string; frontier_ts: string; prev_ts: string }>;
        expect(leaseRows.length).toBe(NUM_SHARDS); // one row per shard
        const epochs = new Set(leaseRows.map((r) => r.epoch));
        const writers = new Set(leaseRows.map((r) => r.writer_url));
        expect(epochs.size).toBe(1); // one consistent epoch across all shard rows
        expect([...writers]).toEqual([advA]); // one writer owns every shard
        const frontierByShard = new Map(leaseRows.map((r) => [r.shard_id, BigInt(r.frontier_ts)]));
        // Each write's shard advanced its OWN frontier past that write's commit ts.
        expect(frontierByShard.get(shardX)!).toBeGreaterThanOrEqual(byChannel.get(keyX)!.ts);
        expect(frontierByShard.get(shardY)!).toBeGreaterThanOrEqual(byChannel.get(keyY)!.ts);

        /* ---------------------------------------------------------------- */
        /* (2, cont.) Cross-shard subscription consistency: the pre-opened    */
        /* subscription's final state contains BOTH docs, and NO intermediate  */
        /* state ever regressed (each pushed state ⊇ its predecessor).         */
        /* ---------------------------------------------------------------- */
        await waitFor(() => {
          const v = latestMod(sub.messages, 1)?.value;
          return Array.isArray(v) && (v as unknown[]).length === 2;
        }, 20_000);
        const states = pushedQueryStates(sub.messages, 1).map(bodiesOf);
        expect(states.length).toBeGreaterThan(0);
        // Monotonic containment: a state never loses a body a prior state had (states only grow).
        for (let i = 1; i < states.length; i++) {
          const prev = new Set(states[i - 1]);
          for (const b of prev) expect(states[i]).toContain(b);
        }
        expect(states[states.length - 1]).toEqual(["msg-X", "msg-Y"]);

        /* ---------------------------------------------------------------- */
        /* (4) Shard guard through the REAL server: `sendMisrouted` runs on    */
        /* shardX (its `channelId` arg) but writes a doc whose channelId field  */
        /* routes to shardY — the kernel's write guard rejects it. Through the   */
        /* sync node's forward path, the response must be a 4xx whose body names */
        /* the table, the shard-key field, BOTH shards, and the fix.            */
        /* ---------------------------------------------------------------- */
        const guard = await apiRun(urlB, "messages:sendMisrouted", { channelId: keyX, misroutedTo: keyY, body: "bad" });
        expect(guard.status).toBeGreaterThanOrEqual(400);
        expect(guard.status).toBeLessThan(500);
        const guardErr = guard.body.error ?? "";
        expect(guardErr).toContain("messages"); // the table
        expect(guardErr).toContain("channelId"); // the shard-key field
        expect(guardErr).toContain(shardX); // the shard the mutation runs on
        expect(guardErr).toContain(shardY); // the shard the document routes to
        expect(guardErr.toLowerCase()).toContain("shardby"); // names the fix (a shardBy that resolves to that value)
        expect(guard.body.committed).not.toBe(true); // the misrouted write did NOT commit

        // The guard rejection left the committed set unchanged (still exactly the two good writes).
        const afterGuard = await apiRun(urlB, "messages:list", {});
        expect(bodiesOf(afterGuard.body.value)).toEqual(["msg-X", "msg-Y"]);

        /* ---------------------------------------------------------------- */
        /* (5) Density at N shards: the whole run's MVCC log is a dense        */
        /* prev_ts chain per document, and NOT ONE row carries ts=0 (a         */
        /* store-allocated ts is always > 0). Non-vacuous — two cross-shard    */
        /* commits are present.                                                */
        /* ---------------------------------------------------------------- */
        const chain = await assertDenseChain(pg);
        expect(chain.violations).toBe(0);
        const zeroTs = (await pg.query(`SELECT count(*)::int AS n FROM documents WHERE ts = 0`)).rows[0] as { n: number };
        expect(zeroTs.n).toBe(0);
        expect(wsList.readyState).toBe(WebSocket.OPEN); // the cross-shard subscription stayed healthy throughout
      } finally {
        wsList?.close();
        await pg.end().catch(() => {});
        await stopServe(nodeA);
        await stopServe(nodeB);
        stopPostgresContainer();
      }
    },
    { timeout: 240_000 },
  );
});
