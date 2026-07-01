/**
 * End-to-end ship gate for slice 6c (Postgres storage backend): proves the EXACT production path —
 * `stackbase serve` running under BUN (the primary runtime; `PostgresDocStore` was only proven
 * against PGlite/an in-process fixture in Tasks 1-7) → `pg` (node-postgres) → a REAL `postgres:16`
 * Docker container. Unlike `serve-e2e.test.ts`/`deploy-e2e.test.ts`, which call `startServe()`
 * in-process (so they run under vitest's Node host, never touching the `Bun` global), this test
 * spawns the real `stackbase` CLI entrypoint (`src/bin.ts`) as a child process via `bun`, mirroring
 * `build-e2e.test.ts`'s "launch the real artifact, read the JSON ready line off stdout" pattern —
 * because a container + the production runtime binary is the whole point of this gate.
 *
 * Proves, through the real `stackbase serve` process + a real Postgres container:
 *   1. `POST /api/run` a `notes:add` mutation commits.
 *   2. Its write fans out reactively to a WebSocket `notes:list` subscription opened BEFORE the
 *      write (event-driven — no polling on the socket itself).
 *   3. The row reads back via a second `POST /api/run` `notes:list` query.
 *   4. Single-writer rejection: while that `serve` still holds the DB, a SECOND `serve` process on
 *      the SAME `--database-url` exits non-zero fast, with the advisory-lock error on stderr — the
 *      first server is never stopped for this check, or the lock would simply be free.
 *   5. Persistence across restart: stop the first `serve`, boot a THIRD `serve` on the same
 *      `--database-url`, and the row written earlier is still there.
 *
 * Skips the whole suite if `docker` isn't on PATH (so it doesn't hard-fail in a Docker-less CI) —
 * the controller/ship-gate runner is expected to have Docker.
 */
import { describe, it, expect, afterAll } from "vitest";
import { spawn, spawnSync, type ChildProcessByStdio } from "node:child_process";
import { resolve } from "node:path";
import type { Readable } from "node:stream";
import WebSocket from "ws";
import { loadFunctionsDir } from "../src/load-modules";
import { push } from "../src/push-pipeline";
import { writeGenerated } from "@stackbase/codegen";

/* -------------------------------------------------------------------------- */
/* Docker availability + container lifecycle                                  */
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

const CONTAINER_NAME = `sb-pg-e2e-${process.pid}`;

function runDocker(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync("docker", args, { encoding: "utf8" });
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

/** Start `postgres:16` on an OS-assigned host port and block until `pg_isready` succeeds. */
async function startPostgresContainer(): Promise<{ port: number }> {
  runDocker(["rm", "-f", CONTAINER_NAME]); // in case a previous run leaked it
  const run = runDocker([
    "run",
    "-d",
    "--name",
    CONTAINER_NAME,
    "-e",
    "POSTGRES_PASSWORD=postgres",
    "-p",
    "127.0.0.1::5432",
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
/* Fixture: reuse deploy-e2e's `notes` app (notes:add + notes:list)            */
/* -------------------------------------------------------------------------- */

function fixtureFunctionsDir(): string {
  return resolve(new URL(".", import.meta.url).pathname, "fixtures", "deploy-v2", "stackbase");
}

/** Refresh the fixture's committed `_generated/` in place (same load->push->write step `deploy`/
 * `codegen` perform) so the checked-in output stays honest — deterministic, no git diff on a rerun. */
async function regenerate(functionsDir: string): Promise<void> {
  const loaded = await loadFunctionsDir(functionsDir);
  const { generated } = push(loaded, []);
  writeGenerated(generated.files, resolve(functionsDir, "_generated"));
}

/* -------------------------------------------------------------------------- */
/* `serve` child-process lifecycle (spawned via `bun` — the production runtime)*/
/* -------------------------------------------------------------------------- */

const CLI_BIN = resolve(new URL(".", import.meta.url).pathname, "../src/bin.ts");
const ADMIN_KEY = "e2e-pg-key";

/** `spawn(..., { stdio: ["ignore", "pipe", "pipe"] })`'s precise type — stdin is `null`, not a
 * `Writable`, which is why `ChildProcessWithoutNullStreams` doesn't fit here. */
type ServeProcess = ChildProcessByStdio<null, Readable, Readable>;

type ReadyOrExit = { ready?: { url: string }; exitCode?: number | null; stdout: string; stderr: string };

/** Wait for either the `serve` ready JSON line on stdout, or the process exiting first (the
 * single-writer-rejection path never prints a ready line — it exits fast via `bin.ts`'s catch). */
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
      const nl = stdoutBuf.indexOf("\n");
      if (nl >= 0) finish({ ready: JSON.parse(stdoutBuf.slice(0, nl)), stdout: stdoutBuf, stderr: stderrBuf });
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

function spawnServe(databaseUrl: string): ServeProcess {
  return spawn(
    "bun",
    [CLI_BIN, "serve", "--dir", fixtureFunctionsDir(), "--port", "0", "--ip", "127.0.0.1", "--no-dashboard", "--database-url", databaseUrl],
    { env: { ...process.env, STACKBASE_ADMIN_KEY: ADMIN_KEY }, stdio: ["ignore", "pipe", "pipe"] },
  );
}

async function stopServe(proc: ServeProcess): Promise<void> {
  if (proc.exitCode !== null) return; // already exited
  proc.kill("SIGTERM");
  await new Promise<void>((r) => proc.once("exit", () => r()));
}

/* -------------------------------------------------------------------------- */
/* WS helpers (mirrors serve-e2e.test.ts / deploy-e2e.test.ts)                 */
/* -------------------------------------------------------------------------- */

function openWs(url: string): Promise<WebSocket> {
  return new Promise((resolvePromise, reject) => {
    const ws = new WebSocket(url);
    ws.once("open", () => resolvePromise(ws));
    ws.once("error", reject);
  });
}

type ServerMsg = {
  type: string;
  queryId?: number;
  value?: unknown;
  error?: string;
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
    await new Promise<void>((r) => setTimeout(r, 10));
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

async function subscribeToNotesList(wsUrl: string): Promise<{ ws: WebSocket; messages: ServerMsg[] }> {
  const ws = await openWs(wsUrl);
  const messages = collectMessages(ws);
  send(ws, { type: "ModifyQuerySet", add: [{ queryId: 1, udfPath: "notes:list", args: {} }], remove: [] });
  await waitFor(() => latestMod(messages, 1)?.type === "QueryUpdated");
  return { ws, messages };
}

/* -------------------------------------------------------------------------- */
/* Test                                                                        */
/* -------------------------------------------------------------------------- */

maybeDescribe("stackbase serve — Postgres ship gate (real container, real bun process)", () => {
  afterAll(() => {
    stopPostgresContainer();
  });

  it(
    "commits + fans out + reads back over a real Postgres container; single-writer refuses; survives a restart",
    async () => {
      await regenerate(fixtureFunctionsDir());
      const { port } = await startPostgresContainer();
      const databaseUrl = `postgres://postgres:postgres@127.0.0.1:${port}/postgres`;

      let round1: ServeProcess | undefined;
      let round2: ServeProcess | undefined;
      let round3: ServeProcess | undefined;
      try {
        /* -------------------------------------------------------------------- */
        /* 1. Boot serve #1 against the real container.                         */
        /* -------------------------------------------------------------------- */
        round1 = spawnServe(databaseUrl);
        const boot1 = await waitForReadyOrExit(round1);
        if (!boot1.ready) throw new Error(`serve #1 failed to boot: exit=${boot1.exitCode} stderr=${boot1.stderr}`);
        const url1 = boot1.ready.url;

        /* -------------------------------------------------------------------- */
        /* 2. Subscribe to notes:list BEFORE any write -> [].                   */
        /* -------------------------------------------------------------------- */
        const { ws, messages } = await subscribeToNotesList(`${url1.replace("http", "ws")}/api/sync`);
        expect(latestMod(messages, 1)!.value).toEqual([]);

        /* -------------------------------------------------------------------- */
        /* 3. POST /api/run a mutation -> commits.                              */
        /* -------------------------------------------------------------------- */
        const addRes = await fetch(`${url1}/api/run`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ path: "notes:add", args: { box: "b1", text: "hello" } }),
        });
        expect(addRes.status).toBe(200);
        const addBody = (await addRes.json()) as { committed: boolean };
        expect(addBody.committed).toBe(true);

        /* -------------------------------------------------------------------- */
        /* 4. The write fans out reactively to the subscription opened BEFORE   */
        /*    it, over the real Postgres-backed engine.                         */
        /* -------------------------------------------------------------------- */
        await waitFor(() => {
          const m = latestMod(messages, 1);
          return m?.type === "QueryUpdated" && Array.isArray(m.value) && (m.value as unknown[]).length > 0;
        });
        expect(latestMod(messages, 1)!.value).toEqual([{ box: "b1", text: "hello" }]);

        /* -------------------------------------------------------------------- */
        /* 5. The row reads back via a fresh POST /api/run query too.           */
        /* -------------------------------------------------------------------- */
        const listRes = await fetch(`${url1}/api/run`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ path: "notes:list", args: {} }),
        });
        expect(listRes.status).toBe(200);
        expect(((await listRes.json()) as { value: unknown }).value).toEqual([{ box: "b1", text: "hello" }]);

        ws.close();

        /* -------------------------------------------------------------------- */
        /* 6. Single-writer rejection: serve #1 is STILL UP and holds the       */
        /*    advisory lock. A SECOND serve on the same --database-url must     */
        /*    exit fast, non-zero, with the advisory-lock error on stderr.      */
        /* -------------------------------------------------------------------- */
        round2 = spawnServe(databaseUrl);
        const boot2 = await waitForReadyOrExit(round2);
        expect(boot2.ready).toBeUndefined();
        expect(boot2.exitCode).not.toBe(0);
        expect(boot2.stderr).toMatch(/advisory lock|already connected/i);
        await stopServe(round2);
        round2 = undefined;

        /* -------------------------------------------------------------------- */
        /* 7. Stop serve #1 (releasing the lock), then boot serve #3 on the     */
        /*    SAME database — the row written earlier must still be there.     */
        /* -------------------------------------------------------------------- */
        await stopServe(round1);
        round1 = undefined;

        round3 = spawnServe(databaseUrl);
        const boot3 = await waitForReadyOrExit(round3);
        if (!boot3.ready) throw new Error(`serve #3 failed to boot: exit=${boot3.exitCode} stderr=${boot3.stderr}`);
        const url3 = boot3.ready.url;

        const listRes2 = await fetch(`${url3}/api/run`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ path: "notes:list", args: {} }),
        });
        expect(listRes2.status).toBe(200);
        expect(((await listRes2.json()) as { value: unknown }).value).toEqual([{ box: "b1", text: "hello" }]);
      } finally {
        if (round1) await stopServe(round1);
        if (round2) await stopServe(round2);
        if (round3) await stopServe(round3);
        stopPostgresContainer();
      }
    },
    { timeout: 180_000 },
  );
});
