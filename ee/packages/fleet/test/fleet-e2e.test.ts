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
 *      `role: "sync"`; `fleet_lease` reads `epoch=1, writer_url=A`.
 *   2. Write forwarding + cross-process fan-out: a mutation POSTed to the SYNC node B forwards to A,
 *      commits, and A's NOTIFY wakes B's CommitTailer, which re-runs a subscription opened on B —
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
import { resolve } from "node:path";
import { createServer } from "node:net";
import type { Readable } from "node:stream";
import WebSocket from "ws";
import { Client } from "pg";

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
 *  with a `url`), or the process exiting first. Robust to any non-JSON log lines emitted before it. */
function waitForReadyOrExit(proc: ServeProcess): Promise<ReadyOrExit> {
  return new Promise((resolvePromise) => {
    let stdoutBuf = "";
    let stderrBuf = "";
    let settled = false;
    const finish = (result: ReadyOrExit) => {
      if (settled) return;
      settled = true;
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

function spawnFleetServe(databaseUrl: string, port: number): ServeProcess {
  const advertiseUrl = `http://127.0.0.1:${port}`;
  return spawn(
    "bun",
    [
      CLI_BIN, "serve",
      "--dir", fixtureConvexDir(),
      "--port", String(port),
      "--ip", "127.0.0.1",
      "--no-dashboard",
      "--database-url", databaseUrl,
      "--fleet",
      "--advertise-url", advertiseUrl,
    ],
    { env: { ...process.env, STACKBASE_ADMIN_KEY: ADMIN_KEY }, stdio: ["ignore", "pipe", "pipe"] },
  );
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
  const r = await pg.query("SELECT epoch, writer_url FROM fleet_lease WHERE id = 1");
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

/* -------------------------------------------------------------------------- */
/* Test                                                                        */
/* -------------------------------------------------------------------------- */

maybeDescribe("stackbase serve --fleet — Tier-2 ship gate (real containers, real processes, failover)", () => {
  afterAll(() => {
    stopPostgresContainer();
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
});
