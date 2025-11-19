/**
 * Embedded-Postgres test harness — a REAL native `postgres` server (the same PostgreSQL 16
 * postmaster the `postgres:16` Docker image runs, packaged by zonky/embedded-postgres-binaries),
 * spawned directly by the test process. No Docker required.
 *
 * This replaces the per-suite `docker run postgres:16` harness that the fleet/outbox/optimistic
 * E2E suites used. Because it is the real server binary, everything those suites exist to prove
 * survives verbatim: genuine multi-session advisory-lock contention, `pg_terminate_backend` by
 * `application_name`, concurrent DDL races, and multiple independent OS processes connecting
 * through the real `pg` driver over TCP. (Contrast PGlite, which is single-session by
 * construction and cannot exercise any of those.)
 *
 * `pause()`/`unpause()` are the `docker pause`/`unpause` equivalent: SIGSTOP/SIGCONT on the
 * postmaster and its backend children — queries hang, connections freeze, nothing errors.
 *
 * Leak story: each cluster lives in a `sb-embedded-pg-*` temp dir. A crashed test run can leak
 * a running postmaster; `startEmbeddedPg` sweeps stale clusters (older than 2h) on every boot,
 * so leaks self-clean on the next run instead of accumulating — the failure mode the Docker
 * harness had (leaked containers piled up until swept by hand).
 */
import EmbeddedPostgres from "embedded-postgres";
import { mkdtempSync, readFileSync, readdirSync, statSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";

const DIR_PREFIX = "sb-embedded-pg-";
const STALE_MS = 2 * 60 * 60 * 1000; // 2h — anything older is a leak from a crashed run

export interface EmbeddedPg {
  host: string;
  port: number;
  user: string;
  password: string;
  /** `postgres://postgres:postgres@127.0.0.1:<port>/postgres` — drop-in for DATABASE_URL. */
  url: string;
  dataDir: string;
  /** SIGSTOP the postmaster tree — the `docker pause` equivalent: queries hang, nothing errors. */
  pause(): void;
  /** SIGCONT the postmaster tree. */
  unpause(): void;
  /** Shut the server down and delete the data dir. Safe to call twice. */
  stop(): Promise<void>;
}

/**
 * True when the platform's native binaries package is installed (an optionalDependency of
 * `embedded-postgres` — absent on unsupported platforms or `--no-optional` installs).
 * Suites gate on this the way they used to gate on `docker` being on PATH.
 */
export function embeddedPgAvailable(): boolean {
  const platformPkg = `@embedded-postgres/${process.platform}-${process.arch}`;
  try {
    // The platform binaries are optionalDependencies of embedded-postgres, so under an isolating
    // linker (bun) they only resolve FROM embedded-postgres's own location — never from here.
    // (Main-export resolution both times: neither package exposes ./package.json in its exports map.)
    const require = createRequire(import.meta.url);
    const fromEmbedded = createRequire(require.resolve("embedded-postgres"));
    fromEmbedded.resolve(platformPkg);
    return true;
  } catch {
    return false;
  }
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const address = srv.address();
      if (address === null || typeof address === "string") {
        srv.close(() => reject(new Error("could not allocate a free port")));
        return;
      }
      const port = address.port;
      srv.close(() => resolve(port));
    });
  });
}

function postmasterPid(dataDir: string): number | undefined {
  try {
    const first = readFileSync(join(dataDir, "postmaster.pid"), "utf8").split("\n")[0] ?? "";
    const pid = Number.parseInt(first, 10);
    return Number.isFinite(pid) && pid > 0 ? pid : undefined;
  } catch {
    return undefined;
  }
}

/** SIGSTOP/SIGCONT the postmaster and its direct children (the session backends). */
function signalTree(pid: number, signal: "SIGSTOP" | "SIGCONT"): void {
  if (signal === "SIGSTOP") {
    // children first so no backend makes progress while the postmaster is already frozen
    spawnSync("pkill", [`-${signal}`, "-P", String(pid)]);
    process.kill(pid, signal);
  } else {
    process.kill(pid, signal);
    spawnSync("pkill", [`-${signal}`, "-P", String(pid)]);
  }
}

/** Remove clusters leaked by crashed runs: kill the postmaster, delete the data dir. */
function sweepStaleClusters(): void {
  let entries: string[];
  try {
    entries = readdirSync(tmpdir());
  } catch {
    return;
  }
  const cutoff = Date.now() - STALE_MS;
  for (const name of entries) {
    if (!name.startsWith(DIR_PREFIX)) continue;
    const dir = join(tmpdir(), name);
    try {
      if (statSync(dir).mtimeMs > cutoff) continue;
      const pid = postmasterPid(dir);
      if (pid !== undefined) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          /* already gone */
        }
      }
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* another concurrent run may be sweeping the same dir — fine either way */
    }
  }
}

/**
 * Boot a fresh single-use PostgreSQL 16 cluster on an OS-assigned port.
 * Callers own the lifecycle: always `await pg.stop()` in afterAll/finally.
 */
export async function startEmbeddedPg(): Promise<EmbeddedPg> {
  sweepStaleClusters();

  const dataDir = mkdtempSync(join(tmpdir(), DIR_PREFIX));
  const user = "postgres";
  const password = "postgres";

  // The port is allocated then released before Postgres binds it, so a concurrent suite can
  // (rarely) steal it in the gap — retry with a fresh port rather than failing the run.
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    const port = await freePort();
    const server = new EmbeddedPostgres({
      databaseDir: dataDir,
      user,
      password,
      port,
      persistent: false,
      onLog: () => {},
      onError: () => {},
    });
    try {
      if (!existsSync(join(dataDir, "PG_VERSION"))) await server.initialise();
      await server.start();
    } catch (e) {
      lastError = e;
      continue;
    }

    let stopped = false;
    return {
      host: "127.0.0.1",
      port,
      user,
      password,
      url: `postgres://${user}:${password}@127.0.0.1:${port}/postgres`,
      dataDir,
      pause() {
        const pid = postmasterPid(dataDir);
        if (pid === undefined) throw new Error(`no postmaster.pid under ${dataDir} — cluster not running?`);
        signalTree(pid, "SIGSTOP");
      },
      unpause() {
        const pid = postmasterPid(dataDir);
        if (pid === undefined) throw new Error(`no postmaster.pid under ${dataDir} — cluster not running?`);
        signalTree(pid, "SIGCONT");
      },
      async stop() {
        if (stopped) return;
        stopped = true;
        // a paused postmaster cannot process a shutdown request — always resume first
        const pid = postmasterPid(dataDir);
        if (pid !== undefined) {
          try {
            signalTree(pid, "SIGCONT");
          } catch {
            /* already gone */
          }
        }
        await server.stop(); // persistent: false ⇒ also deletes the data dir
        rmSync(dataDir, { recursive: true, force: true });
      },
    };
  }
  rmSync(dataDir, { recursive: true, force: true });
  throw new Error(`embedded postgres failed to start after 3 attempts: ${String(lastError)}`);
}
