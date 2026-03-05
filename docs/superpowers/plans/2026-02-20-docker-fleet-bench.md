# Docker-Fleet Bench Axis Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A first-class `--axis docker-fleet` (rung 3.5): fleet nodes as Docker containers with cgroup-enforced cpu/memory budgets, booted FROM THE REPO'S OWN Dockerfile running `serve --fleet` over a postgres:16 container — producing the budget capacity table, the no-noisy-neighbor proof, and best-effort netem WAN tiers.

**Architecture:** A container lifecycle core (image build-once, `docker run` with `--cpus/--memory`, readiness from `docker logs`' ready line, per-container `docker stats` sampling, fresh Postgres database per fleet, envelope check against the Docker VM allocation) under three cells that reuse rung-1/3's swarm workers and probes verbatim from the HOST via published ports. Confirmed pre-plan: `turbo prune @stackbase/cli --docker` ships `ee/packages/fleet` (devDependency workspace packages are included), so the shipped image can run fleet mode — Task 1 proves it empirically.

**Tech Stack:** TypeScript, Bun, Docker CLI (no SDK — shell out, matching the repo's e2e style), `postgres:16` + the repo image, `ws`, vitest under Node (Docker-gated).

**Spec:** `docs/superpowers/specs/2026-02-20-docker-fleet-bench-design.md` (this worktree)

## Global Constraints

- Work ONLY in this worktree (`.claude/worktrees/docker-fleet-bench`, branch `worktree-docker-fleet-bench`). The main checkout belongs to another session. The worktree is installed + built.
- Nodes boot from the repo image: `docker build --target runner -t stackbase-bench-dfleet .` (context = worktree root; build once per run, cached). Containers run the image's own entrypoint (`bun packages/cli/dist/bin.js`) with args `serve --dir /app/convex --data /data/db.sqlite --port 3000 --ip 0.0.0.0 --no-dashboard --database-url <pg> --fleet --advertise-url http://<containerName>:3000`, env `STACKBASE_ADMIN_KEY`, fixture bind-mounted read-only: `-v <worktree>/benchmarks/runner/fixtures/fleetconn/convex:/app/convex:ro` (the rung-3 fixture, `_generated` committed).
- Inter-node traffic rides a user-defined network (`docker network create <run-scoped name>`); `--advertise-url` uses container DNS names. Host-side swarm/probes use published ports: `-p 127.0.0.1::3000` (random host port, read back via `docker port <name> 3000`).
- Postgres: `postgres:16` container on the same network (`POSTGRES_PASSWORD=dfleet`, no volume), admin port published to host for the runner's CREATE/DROP DATABASE; nodes connect via the network-internal address (`postgres://postgres:dfleet@<pgName>:5432/<db>`). **Fresh database per fleet** (the rung-3 lease-TTL rule).
- Per-container sampling ONLY via `docker stats --no-stream --format '{{.CPUPerc}}\t{{.MemUsage}}'`; OOM detection via `docker inspect -f '{{.State.OOMKilled}}'`.
- **Envelope check before every cell**: sum of requested budgets (+1 cpu/1g postgres + 0.5 cpu/512m headroom) must fit `docker info`'s NCPU/MemTotal — throw with the exact math otherwise. The VM allocation rides in every cell's METRICS (`vmNcpu`, `vmMemGb` — via a `vmProfile()` export on the boot core; static scenario params can't know it), so every baseline row carries its envelope.
- Budget tiers default `[{cpus:1,mem:"512m"},{cpus:2,mem:"1g"},{cpus:4,mem:"2g"}]`, env `DFLEET_TIERS` as `"1/512m,2/1g"` (fail-fast on set-but-invalid); N ladder per tier default `[1000,2000,4000]`, env `DFLEET_NS` (same rule); `CONN_WORKERS` reused.
- Reuse rung-1/3 pieces verbatim: `connections-worker.ts` protocol (connect `rampPerSec`/`timeoutMs`/`failed`; reconnect `url` override), `subscribeFrame`/`classifyServerFrame`, `assertFdHeadroom`, aggregate pacing (1000/s ÷ workers), paced-floor semantics. The ONLY sampling difference: `docker stats`, not `ps`.
- Docker-gating: scenarios check `dockerAvailable()` (a `docker info` probe) and SKIP with a stated reason when absent — mirror `pgAvailable()`'s pattern. The smoke test is `describe.skip`-gated the same way.
- Compare-gate checklist: reuse existing higher-better keys; any NEW higher-better metric must be registered in `METRIC_DIRECTION` with a test (`maxCleanN` will need this).
- Honesty rules verbatim in the findings (from the spec): containers don't create hardware — no aggregate multiplication; no autoscaling claims; Docker-on-macOS VM caveat first-class with the stamped allocation; host→container port-forward overhead constant across cells; netem is simulation; inherited swarm/probe/pacing/driver boundaries.
- Subagent operational rules: children/sweeps via nohup + logs, poll with until-loops, treat log SILENCE (8+ min, no process) as death; never yield expecting notifications. Long Docker builds: run with generous timeouts and echo progress.
- Commits end with:

```
Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_015RKShEWjRcmbQVJ8ooUPP6
```

---

### Task 1: The container fleet-boot core (and the proof the shipped image does fleet)

**Files:**
- Create: `benchmarks/runner/src/cores/docker-fleet-boot.ts`
- Test: `benchmarks/runner/test/docker-fleet-boot.test.ts`

**Interfaces:**
- Consumes: nothing new (shells out to `docker`; reads the rung-3 fixture path).
- Produces (Tasks 2-3 rely on):

```ts
export interface Tier { cpus: number; mem: string }
export interface DockerNode { name: string; role: "writer" | "sync"; hostPort: number; url: string; wsUrl: string }
export interface DockerFleet { writer: DockerNode; syncs: DockerNode[]; dbName: string; stop(): Promise<void>; killSync(i: number): void }
export function dockerAvailable(): boolean
export async function ensureImage(): Promise<string>            // builds once, returns tag
export async function ensureEnvelope(tiers: Tier[]): Promise<{ vmNcpu: number; vmMemGb: number }> // throws with math if unfit
export async function bootDockerFleet(opts: { syncCount: number; syncTier: Tier; writerTier?: Tier }): Promise<DockerFleet>
export function sampleContainer(name: string): { cpuPct: number; memMb: number }
```

- [ ] **Step 1: Write the failing test**

Create `benchmarks/runner/test/docker-fleet-boot.test.ts`:

```ts
/** THE PROOF TASK: the repo's own shipped image (Dockerfile runner stage) can run `serve --fleet`
 *  over a postgres:16 container — roles asserted, health on every node, a writer commit readable
 *  via a sync node, budgets enforced, teardown clean. Docker-gated. */
import { describe, it, expect } from "vitest";
import { dockerAvailable, ensureImage, ensureEnvelope, bootDockerFleet, sampleContainer } from "../src/cores/docker-fleet-boot";

const maybe = dockerAvailable() ? describe : describe.skip;

maybe("docker-fleet-boot (shipped image, writer + 1 sync over postgres:16)", () => {
  it("builds the image, boots a budgeted fleet with asserted roles, and proves cross-node visibility", async () => {
    await ensureImage();
    const env = await ensureEnvelope([{ cpus: 1, mem: "512m" }]);
    expect(env.vmNcpu).toBeGreaterThan(0);

    const fleet = await bootDockerFleet({ syncCount: 1, syncTier: { cpus: 1, mem: "512m" } });
    try {
      expect(fleet.writer.role).toBe("writer");
      expect(fleet.syncs[0]!.role).toBe("sync");

      for (const node of [fleet.writer, fleet.syncs[0]!]) {
        const health = (await (await fetch(`${node.url}/api/health`)).json()) as { status: string };
        expect(health.status).toBe("ok");
      }

      const bump = await fetch(`${fleet.writer.url}/api/run`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: "hot:bump", args: {} }),
      });
      expect(bump.ok).toBe(true);
      const deadline = Date.now() + 10_000;
      let seen = 0;
      while (Date.now() < deadline) {
        const res = (await (
          await fetch(`${fleet.syncs[0]!.url}/api/run`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ path: "hot:get", args: {} }),
          })
        ).json()) as { value: Array<{ n: number }> };
        seen = res.value[0]?.n ?? 0;
        if (seen >= 1) break;
        await new Promise((r) => setTimeout(r, 100));
      }
      expect(seen).toBeGreaterThanOrEqual(1); // cross-node visibility through the containers

      const stats = sampleContainer(fleet.syncs[0]!.name);
      expect(stats.memMb).toBeGreaterThan(0);
      expect(stats.memMb).toBeLessThan(600); // the 512m budget is actually enforced
    } finally {
      await fleet.stop();
    }
  }, 900_000); // first image build can take minutes

  it("two sequential fleets get fresh databases (no lease-TTL bleed)", async () => {
    const fleetA = await bootDockerFleet({ syncCount: 1, syncTier: { cpus: 1, mem: "512m" } });
    const dbA = fleetA.dbName;
    await fleetA.stop();
    const fleetB = await bootDockerFleet({ syncCount: 1, syncTier: { cpus: 1, mem: "512m" } });
    try {
      expect(fleetB.dbName).not.toBe(dbA);
      const t0 = Date.now();
      const bump = await fetch(`${fleetB.writer.url}/api/run`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: "hot:bump", args: {} }),
      });
      expect(bump.ok).toBe(true);
      expect(Date.now() - t0).toBeLessThan(5_000); // no dead-fleet fencing wait
    } finally {
      await fleetB.stop();
    }
  }, 300_000);
});
```

- [ ] **Step 2: Verify it fails**

Run: `cd benchmarks/runner && bun run test -- test/docker-fleet-boot.test.ts`
Expected: FAIL — cannot find `../src/cores/docker-fleet-boot`. (If Docker isn't running, start Docker Desktop first — this axis needs it; the gate makes CI skip, but the dev machine should run it.)

- [ ] **Step 3: Implement `cores/docker-fleet-boot.ts`**

```ts
/**
 * Container fleet lifecycle for the docker-fleet axis (rung 3.5): fleet nodes are containers of
 * THE SHIPPED IMAGE (Dockerfile runner stage) running `serve --fleet`, with cgroup-enforced
 * cpu/memory budgets, over a postgres:16 container. Everything shells out to the docker CLI
 * (repo e2e style). Fresh Postgres database per fleet (the rung-3 lease-TTL rule). Sampling via
 * `docker stats`. HONESTY: this measures containers on ONE host — budgets, not extra hardware.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { resolve } from "node:path";

export interface Tier { cpus: number; mem: string }
export interface DockerNode { name: string; role: "writer" | "sync"; hostPort: number; url: string; wsUrl: string }
export interface DockerFleet { writer: DockerNode; syncs: DockerNode[]; dbName: string; stop(): Promise<void>; killSync(i: number): void }

const IMAGE_TAG = "stackbase-bench-dfleet";
const PG_IMAGE = "postgres:16";
const ADMIN_KEY = "dfleet-bench-admin-key";
const WORKTREE_ROOT = resolve(__dirname, "../../../..");
const FIXTURE_CONVEX = resolve(__dirname, "../../fixtures/fleetconn/convex");
const RUN_ID = `dfleet${process.pid}`;
const NET = `${RUN_ID}-net`;
const PG_NAME = `${RUN_ID}-pg`;

let fleetCounter = 0;
let imageBuilt = false;
let infraUp = false;
let pgHostPort = 0;

function docker(args: string[], opts: { timeoutMs?: number } = {}): string {
  return execFileSync("docker", args, { timeout: opts.timeoutMs ?? 60_000, encoding: "utf8" });
}

export function dockerAvailable(): boolean {
  return spawnSync("docker", ["info", "--format", "{{.NCPU}}"], { timeout: 10_000 }).status === 0;
}

/** Build the shipped image once per process (cached by Docker's layer cache thereafter). */
export async function ensureImage(): Promise<string> {
  if (imageBuilt) return IMAGE_TAG;
  docker(["build", "--target", "runner", "-t", IMAGE_TAG, WORKTREE_ROOT], { timeoutMs: 900_000 });
  imageBuilt = true;
  return IMAGE_TAG;
}

export async function ensureEnvelope(tiers: Tier[]): Promise<{ vmNcpu: number; vmMemGb: number }> {
  const [ncpuRaw, memRaw] = docker(["info", "--format", "{{.NCPU}} {{.MemTotal}}"]).trim().split(" ");
  const vmNcpu = Number(ncpuRaw);
  const vmMemGb = Number(memRaw) / 1024 ** 3;
  const memMb = (m: string): number => (m.endsWith("g") ? Number(m.slice(0, -1)) * 1024 : Number(m.slice(0, -1)));
  const needCpu = tiers.reduce((a, t) => a + t.cpus, 0) + 1.5; // +1 pg, +0.5 headroom
  const needMemMb = tiers.reduce((a, t) => a + memMb(t.mem), 0) + 1536; // +1g pg, +512m headroom
  if (needCpu > vmNcpu || needMemMb > vmMemGb * 1024) {
    throw new Error(
      `Docker VM envelope unfit: need ~${needCpu} cpus / ${Math.round(needMemMb)}MB ` +
        `(tiers + postgres + headroom), VM has ${vmNcpu} cpus / ${vmMemGb.toFixed(1)}GB. ` +
        `Shrink DFLEET_TIERS or raise Docker Desktop's allocation.`,
    );
  }
  return { vmNcpu, vmMemGb: +vmMemGb.toFixed(1) };
}

/** Run-scoped shared infra: one network + one postgres container, torn down by teardownInfra(). */
async function ensureInfra(): Promise<void> {
  if (infraUp) return;
  docker(["network", "create", NET]);
  docker([
    "run", "-d", "--name", PG_NAME, "--network", NET, "--cpus", "1", "--memory", "1g",
    "-e", "POSTGRES_PASSWORD=dfleet", "-p", "127.0.0.1::5432", PG_IMAGE,
  ]);
  pgHostPort = Number(docker(["port", PG_NAME, "5432"]).trim().split(":").pop());
  // Wait for pg readiness via docker exec pg_isready (bounded).
  const deadline = Date.now() + 60_000;
  for (;;) {
    if (spawnSync("docker", ["exec", PG_NAME, "pg_isready", "-U", "postgres"], { timeout: 10_000 }).status === 0) break;
    if (Date.now() > deadline) throw new Error("postgres container never became ready");
    await new Promise((r) => setTimeout(r, 500));
  }
  infraUp = true;
}

export async function teardownInfra(): Promise<void> {
  if (!infraUp) return;
  spawnSync("docker", ["rm", "-f", PG_NAME], { timeout: 30_000 });
  spawnSync("docker", ["network", "rm", NET], { timeout: 30_000 });
  infraUp = false;
}

function adminSql(sql: string): void {
  docker(["exec", PG_NAME, "psql", "-U", "postgres", "-c", sql]);
}

async function waitForReady(name: string): Promise<{ role: "writer" | "sync" }> {
  const deadline = Date.now() + 120_000;
  for (;;) {
    const logs = spawnSync("docker", ["logs", name], { timeout: 10_000, encoding: "utf8" });
    const text = `${logs.stdout ?? ""}`;
    for (const line of text.split("\n")) {
      try {
        const parsed = JSON.parse(line) as { url?: string; role?: "writer" | "sync" };
        if (typeof parsed.url === "string" && parsed.role !== undefined) return { role: parsed.role };
      } catch {
        /* not the ready line */
      }
    }
    const state = docker(["inspect", "-f", "{{.State.Status}} {{.State.OOMKilled}}", name]).trim();
    if (!state.startsWith("running")) throw new Error(`container ${name} not running before ready (${state}); logs:\n${text.slice(-2000)}\n${logs.stderr ?? ""}`);
    if (Date.now() > deadline) throw new Error(`container ${name} ready timeout; last logs:\n${text.slice(-2000)}`);
    await new Promise((r) => setTimeout(r, 500));
  }
}

async function runNode(name: string, tier: Tier, dbName: string): Promise<DockerNode> {
  docker([
    "run", "-d", "--name", name, "--network", NET,
    "--cpus", String(tier.cpus), "--memory", tier.mem,
    "-e", `STACKBASE_ADMIN_KEY=${ADMIN_KEY}`,
    "-v", `${FIXTURE_CONVEX}:/app/convex:ro`,
    "-p", "127.0.0.1::3000",
    IMAGE_TAG,
    "serve", "--dir", "/app/convex", "--data", "/data/db.sqlite", "--port", "3000", "--ip", "0.0.0.0",
    "--no-dashboard", "--database-url", `postgres://postgres:dfleet@${PG_NAME}:5432/${dbName}`,
    "--fleet", "--advertise-url", `http://${name}:3000`,
  ]);
  const ready = await waitForReady(name);
  const hostPort = Number(docker(["port", name, "3000"]).trim().split(":").pop());
  return { name, role: ready.role, hostPort, url: `http://127.0.0.1:${hostPort}`, wsUrl: `ws://127.0.0.1:${hostPort}/api/sync` };
}

export async function bootDockerFleet(opts: { syncCount: number; syncTier: Tier; writerTier?: Tier }): Promise<DockerFleet> {
  await ensureImage();
  await ensureInfra();
  const dbName = `dfleet_${process.pid}_${++fleetCounter}`;
  adminSql(`CREATE DATABASE ${dbName}`);
  const names: string[] = [];
  const writerTier = opts.writerTier ?? { cpus: 2, mem: "1g" };

  const writerName = `${RUN_ID}-w${fleetCounter}`;
  names.push(writerName);
  const writer = await runNode(writerName, writerTier, dbName);
  if (writer.role !== "writer") {
    spawnSync("docker", ["rm", "-f", writerName], { timeout: 30_000 });
    throw new Error(`first docker fleet node booted as "${writer.role}", expected writer`);
  }
  const syncs: DockerNode[] = [];
  for (let i = 0; i < opts.syncCount; i++) {
    const n = `${RUN_ID}-s${fleetCounter}x${i}`;
    names.push(n);
    const node = await runNode(n, opts.syncTier, dbName);
    if (node.role !== "sync") {
      for (const x of names) spawnSync("docker", ["rm", "-f", x], { timeout: 30_000 });
      throw new Error(`docker fleet node ${i + 2} booted as "${node.role}", expected sync`);
    }
    syncs.push(node);
  }

  return {
    writer, syncs, dbName,
    killSync(i: number): void {
      docker(["kill", syncs[i]!.name]); // SIGKILL-equivalent for the failstorm-style teardown
    },
    async stop(): Promise<void> {
      for (const n of names) spawnSync("docker", ["rm", "-f", n], { timeout: 30_000 });
      try {
        adminSql(`DROP DATABASE ${dbName} WITH (FORCE)`);
      } catch {
        // Tolerated: the postgres container is run-scoped and removed by teardownInfra().
      }
    },
  };
}

/** The Docker VM's allocation — stamped into every cell's metrics so baseline rows carry their
 *  envelope (the macOS-VM honesty rule). Cached after first read. */
let vmCache: { vmNcpu: number; vmMemGb: number } | null = null;
export function vmProfile(): { vmNcpu: number; vmMemGb: number } {
  if (vmCache) return vmCache;
  const [ncpuRaw, memRaw] = docker(["info", "--format", "{{.NCPU}} {{.MemTotal}}"]).trim().split(" ");
  vmCache = { vmNcpu: Number(ncpuRaw), vmMemGb: +(Number(memRaw) / 1024 ** 3).toFixed(1) };
  return vmCache;
}

export function sampleContainer(name: string): { cpuPct: number; memMb: number } {
  const out = docker(["stats", "--no-stream", "--format", "{{.CPUPerc}}\t{{.MemUsage}}", name]).trim();
  const [cpuRaw, memRaw] = out.split("\t");
  const cpuPct = Number(cpuRaw!.replace("%", ""));
  const memPart = memRaw!.split("/")[0]!.trim(); // e.g. "213.4MiB"
  const memMb = memPart.endsWith("GiB") ? Number(memPart.replace("GiB", "")) * 1024 : Number(memPart.replace("MiB", ""));
  if (!Number.isFinite(cpuPct) || !Number.isFinite(memMb)) throw new Error(`unparseable docker stats for ${name}: ${out}`);
  return { cpuPct, memMb };
}
```

- [ ] **Step 4: Run the tests — pass**

Run: `cd benchmarks/runner && bun run test -- test/docker-fleet-boot.test.ts`
Expected: 2 PASS (first run includes the image build — allow up to ~15 min; later runs are cached). Debug notes: (a) if the writer's ready line never appears, `docker logs <name>` by hand — if the failure is `Cannot find module '@stackbase/fleet'`, the prune assumption broke: STOP and report BLOCKED with the logs (the fix would touch the Dockerfile — a plan-level decision, not yours); (b) if `serve` dies on `_generated not found`, the bind-mount path is wrong — verify `FIXTURE_CONVEX` resolves inside THIS worktree; (c) Bun-runtime images print the ready line on stdout — if it lands on stderr, include `logs.stderr` in the scan (adjust `waitForReady` and note the deviation).

- [ ] **Step 5: Typecheck + commit**

`bun run typecheck` (worktree root) — clean.

```bash
git add benchmarks/runner/src/cores/docker-fleet-boot.ts benchmarks/runner/test/docker-fleet-boot.test.ts
git commit -m "feat(bench): docker-fleet boot core — budgeted containers of the shipped image run serve --fleet"
```

---

### Task 2: The three cells + smoke

**Files:**
- Create: `benchmarks/runner/src/cores/docker-fleet.ts`
- Test: `benchmarks/runner/test/docker-fleet-smoke.test.ts`

**Interfaces:**
- Consumes: Task 1's exports; rung-1 worker protocol (`connections-worker.ts`: connect `{url,n,offset,distinct,rampPerSec,timeoutMs}` → `{connected,failed,rampMs}`, `report` → `{pushes,unchanged}`, `kill-all`, `reconnect {spreadMs,timeoutMs,url?}` → `{reconnected,failed,stormMs,unchanged}`, `exit`); `assertFdHeadroom` from `cores/proc-stats`; `StackbaseClient`/`webSocketTransport` + `ws`.
- Produces:

```ts
export type DFleetCell = "budget" | "neighbor" | "wanhop"
export interface DFleetCellOpts { cell: DFleetCell; tier: Tier; ns: number[]; workers: number; seconds: number; wanDelayMs?: number }
export interface DFleetCellResult { metrics: Record<string, number | null>; errors: number; skipped?: string }
export async function runDockerFleetCell(opts: DFleetCellOpts): Promise<DFleetCellResult>
```

Metric keys:
- budget: `maxCleanN`, `rssPerConnMb` (docker-stats mem delta / N at maxCleanN), `pushP50Ms`, `pushP99Ms`, `serverCpuPct` (of the BUDGET: docker stats CPUPerc is host-relative — report both `cpuPctRaw` and `cpuPctOfBudget` = raw/cpus), `stormRecoverySec`, `unchangedPct`, `reconnectFailed`
- neighbor: `quietIdleCpuPct`, `loadedIdleCpuPct` (B/C avg, control vs A-load windows), `quietProbeP50Ms`, `loadedProbeP50Ms`, `neighborDeltaPct` (loaded/quiet p50 − 1, ×100), `aCpuPctOfBudget`
- wanhop: `pushP50Ms`, `pushP99Ms` per delay tier (cell instantiated per tier; `wanDelayMs` in params); skipped → `{metrics:{}, errors:0, skipped:"netem unavailable: <reason>"}`

- [ ] **Step 1: Implement the core**

Create `benchmarks/runner/src/cores/docker-fleet.ts`:

```ts
/**
 * The three rung-3.5 cells over budgeted containers. Swarm workers + probes run on the HOST
 * (rung-1 machinery verbatim) against published ports — the driver's memory stays out of the
 * Docker VM; the port-forward overhead is constant across cells (documented). Budget CPU is
 * reported both raw (host-relative docker stats) and normalized to the tier's budget.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { createInterface, type Interface } from "node:readline";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { spawnSync } from "node:child_process";
import WebSocket from "ws";
import { StackbaseClient, webSocketTransport, type ClientTransport } from "@stackbase/client";
import { assertFdHeadroom } from "./proc-stats";
import { bootDockerFleet, sampleContainer, vmProfile, type Tier, type DockerFleet } from "./docker-fleet-boot";

export type DFleetCell = "budget" | "neighbor" | "wanhop";
export interface DFleetCellOpts { cell: DFleetCell; tier: Tier; ns: number[]; workers: number; seconds: number; wanDelayMs?: number }
export interface DFleetCellResult { metrics: Record<string, number | null>; errors: number; skipped?: string }

const SRC = join(__dirname, "..");
interface Worker { proc: ChildProcess; rl: Interface }

function spawnWorker(): Worker {
  const proc = spawn("bun", [join(SRC, "connections-worker.ts")], { stdio: ["pipe", "pipe", "inherit"] });
  proc.stdin!.on("error", () => {});
  return { proc, rl: createInterface({ input: proc.stdout! }) };
}
function nextLine(rl: Interface): Promise<string> {
  return new Promise((r) => rl.once("line", r));
}
async function send(w: Worker, cmd: object, boundMs = 120_000): Promise<Record<string, unknown>> {
  const reply = nextLine(w.rl);
  w.proc.stdin!.write(JSON.stringify(cmd) + "\n");
  const timeout = new Promise<never>((_, rej) => setTimeout(() => rej(new Error(`worker no-reply (${boundMs}ms): ${JSON.stringify(cmd).slice(0, 60)}`)), boundMs).unref());
  const parsed = JSON.parse(await Promise.race([reply, timeout])) as Record<string, unknown>;
  if (parsed.error) throw new Error(`worker error: ${String(parsed.error)}`);
  return parsed;
}
function nodeWs(url: string): ClientTransport {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return webSocketTransport(url, { createWebSocket: (u) => new WebSocket(u) as unknown as any });
}
const pct = (s: number[], q: number) => (s.length ? s[Math.min(s.length - 1, Math.floor(q * s.length))]! : 0);
const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

/** Ramp n connections across the workers onto wsUrl; throws on any failure (invalid cell). */
async function ramp(workers: Worker[], wsUrl: string, n: number): Promise<void> {
  const per = Math.floor(n / workers.length);
  const rampPer = Math.max(1, Math.floor(1000 / workers.length));
  await Promise.all(
    workers.map((w, i) =>
      send(w, { cmd: "connect", url: wsUrl, n: i === workers.length - 1 ? n - per * (workers.length - 1) : per, offset: i * per, distinct: false, rampPerSec: rampPer }, 300_000).then((r) => {
        if (Number(r.failed) > 0) throw new Error(`ramp: worker ${i} reported ${String(r.failed)} failures at n=${n}`);
      }),
    ),
  );
}

/** Probes on a node's published port; returns seen-arrays and a barriered ready promise. */
function attachProbes(wsUrl: string, count: number, onAdvance: () => void): { clients: StackbaseClient[]; seen: number[][]; ready: Promise<void> } {
  const clients: StackbaseClient[] = [];
  const seen: number[][] = [];
  for (let i = 0; i < count; i++) {
    const c = new StackbaseClient(nodeWs(wsUrl));
    clients.push(c);
    const s: number[] = [];
    seen.push(s);
    c.subscribe("hot:get", {}, (v) => {
      const rows = v as Array<{ n: number }>;
      s.push(rows[0]?.n ?? 0);
      onAdvance();
    });
  }
  const ready = (async () => {
    const start = Date.now();
    while (seen.some((s) => s.length === 0)) {
      if (Date.now() - start > 30_000) throw new Error("probe initial-result barrier timed out (30s)");
      await new Promise((r) => setTimeout(r, 25));
    }
  })();
  return { clients, seen, ready };
}

/** Drive writes via the writer; measure write→all-probes-advanced latency (event-driven). */
async function hotpushLoop(writer: StackbaseClient, probeSeen: number[][], notifier: { fn: (() => void) | null }, writes: number, containerName: string): Promise<{ p50: number; p99: number; cpuRaw: number }> {
  const lat: number[] = [];
  const cpu: number[] = [];
  for (let i = 0; i < writes; i++) {
    const before = probeSeen.map((s) => s.length);
    const t0 = performance.now();
    const done = new Promise<void>((res) => {
      const check = () => {
        if (probeSeen.every((s, p) => s.length > before[p]!)) {
          notifier.fn = null;
          res();
        }
      };
      notifier.fn = check;
      check();
    });
    const cap = new Promise<never>((_, rej) => setTimeout(() => rej(new Error("fan-out wait cap (15s)")), 15_000).unref());
    await writer.mutation("hot:bump", {});
    await Promise.race([done, cap]);
    lat.push(performance.now() - t0);
    cpu.push(sampleContainer(containerName).cpuPct);
    await new Promise((r) => setTimeout(r, Math.max(50, 200 - (performance.now() - t0))));
  }
  const sorted = [...lat].sort((a, b) => a - b);
  return { p50: +pct(sorted, 0.5).toFixed(2), p99: +pct(sorted, 0.99).toFixed(2), cpuRaw: +avg(cpu).toFixed(1) };
}

function netemProbe(containerName: string): string | null {
  // Try adding+removing a no-op netem qdisc inside the target's netns via a privileged helper.
  const add = spawnSync("docker", ["run", "--rm", `--net=container:${containerName}`, "--cap-add", "NET_ADMIN", "alpine", "sh", "-c", "apk add -q iproute2 >/dev/null 2>&1 && tc qdisc add dev eth0 root netem delay 0ms && tc qdisc del dev eth0 root"], { timeout: 120_000, encoding: "utf8" });
  return add.status === 0 ? null : `netem unavailable: ${(add.stderr || add.stdout || "unknown").trim().slice(0, 200)}`;
}

function netemSet(containerName: string, delayMs: number): void {
  const r = spawnSync("docker", ["run", "--rm", `--net=container:${containerName}`, "--cap-add", "NET_ADMIN", "alpine", "sh", "-c", `apk add -q iproute2 >/dev/null 2>&1 && tc qdisc replace dev eth0 root netem delay ${delayMs}ms`], { timeout: 120_000, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`netem set failed: ${r.stderr}`);
}

export async function runDockerFleetCell(opts: DFleetCellOpts): Promise<DFleetCellResult> {
  const probesN = 5;
  assertFdHeadroom(Math.max(...opts.ns) + probesN * 3 + 16);
  const workers: Worker[] = [];
  const clients: StackbaseClient[] = [];
  let fleet: DockerFleet | undefined;
  const notifier: { fn: (() => void) | null } = { fn: null };
  const onAdvance = () => notifier.fn?.();
  try {
    if (opts.cell === "budget") {
      fleet = await bootDockerFleet({ syncCount: 1, syncTier: opts.tier });
      const sync = fleet.syncs[0]!;
      const writer = new StackbaseClient(nodeWs(fleet.writer.wsUrl));
      clients.push(writer);
      const probes = attachProbes(sync.wsUrl, probesN, onAdvance);
      clients.push(...probes.clients);
      await probes.ready;
      for (let w = 0; w < opts.workers; w++) workers.push(spawnWorker());

      let maxCleanN: number | null = null;
      let final: { p50: number; p99: number; cpuRaw: number } | null = null;
      let memAtMax = 0;
      const memBase = sampleContainer(sync.name).memMb;
      for (const n of opts.ns) {
        try {
          // Fresh swarm per rung: kill-all then re-ramp to the new N (cheaper than a new fleet;
          // the budget cell measures capacity, not cross-rung state).
          await Promise.all(workers.map((w) => send(w, { cmd: "kill-all" })));
          await ramp(workers, sync.wsUrl, n);
          if (docker_oomKilled(sync.name)) throw new Error("OOMKilled during ramp");
          const r = await hotpushLoop(writer, probes.seen, notifier, Math.max(5, opts.seconds * 5), sync.name);
          maxCleanN = n;
          final = r;
          memAtMax = sampleContainer(sync.name).memMb;
        } catch (e) {
          // The rung failed — the previous rung stands as maxCleanN. Record and stop climbing.
          break;
        }
      }
      if (maxCleanN === null || final === null) throw new Error(`budget tier ${opts.tier.cpus}cpu/${opts.tier.mem}: even N=${opts.ns[0]} failed`);
      // Storm at maxCleanN: kill-all + reconnect (same node).
      await Promise.all(workers.map((w) => send(w, { cmd: "kill-all" })));
      await ramp(workers, sync.wsUrl, maxCleanN);
      await Promise.all(workers.map((w) => send(w, { cmd: "kill-all" })));
      const t0 = performance.now();
      const storm = await Promise.all(workers.map((w) => send(w, { cmd: "reconnect", spreadMs: 2000 }, 120_000)));
      const stormRecoverySec = +((performance.now() - t0) / 1000).toFixed(2);
      const unchanged = storm.reduce((a, r) => a + Number(r.unchanged ?? 0), 0);
      const reconnectFailed = storm.reduce((a, r) => a + Number(r.failed ?? 0), 0);
      return {
        metrics: {
          ...vmProfile(), // vmNcpu/vmMemGb: every baseline row carries its envelope
          maxCleanN,
          rssPerConnMb: +((memAtMax - memBase) / maxCleanN).toFixed(3),
          pushP50Ms: final.p50,
          pushP99Ms: final.p99,
          cpuPctRaw: final.cpuRaw,
          cpuPctOfBudget: +(final.cpuRaw / opts.tier.cpus).toFixed(1),
          stormRecoverySec,
          unchangedPct: +((100 * unchanged) / maxCleanN).toFixed(1),
          reconnectFailed,
        },
        errors: 0,
      };
    }

    if (opts.cell === "neighbor") {
      fleet = await bootDockerFleet({ syncCount: 3, syncTier: opts.tier });
      const [a, b, c] = fleet.syncs as [typeof fleet.syncs[0], typeof fleet.syncs[0], typeof fleet.syncs[0]];
      const writer = new StackbaseClient(nodeWs(fleet.writer.wsUrl));
      clients.push(writer);
      // Idle swarms on B and C; probes on B and C (the neighbors under observation).
      const n = opts.ns[0]!;
      for (let w = 0; w < opts.workers; w++) workers.push(spawnWorker());
      const half = workers.length >> 1 || 1;
      await Promise.all([
        ...workers.slice(0, half).map((w, i) => send(w, { cmd: "connect", url: b.wsUrl, n: Math.floor(n / 2 / half), offset: i * 10_000, distinct: false, rampPerSec: Math.max(1, Math.floor(1000 / workers.length)) }, 300_000)),
        ...workers.slice(half).map((w, i) => send(w, { cmd: "connect", url: c.wsUrl, n: Math.floor(n / 2 / (workers.length - half)), offset: 100_000 + i * 10_000, distinct: false, rampPerSec: Math.max(1, Math.floor(1000 / workers.length)) }, 300_000)),
      ]);
      const probesB = attachProbes(b.wsUrl, probesN, onAdvance);
      const probesC = attachProbes(c.wsUrl, probesN, onAdvance);
      clients.push(...probesB.clients, ...probesC.clients);
      await probesB.ready;
      await probesC.ready;
      const neighborSeen = [...probesB.seen, ...probesC.seen];

      // CONTROL window: A quiet. Measure B/C idle CPU + push latency (writer writes fan to all).
      const quiet = await hotpushLoop(writer, neighborSeen, notifier, Math.max(5, opts.seconds * 5), b.name);
      const quietIdle = +avg([sampleContainer(b.name).cpuPct, sampleContainer(c.name).cpuPct]).toFixed(1);

      // LOAD window: hammer A with its own hot swarm + rapid writes... A's load = a dedicated
      // swarm on A plus the same shared writes; the write stream is common, so A's EXTRA load is
      // its swarm's fan-out work. Ramp A's swarm now:
      const aWorkers: Worker[] = [];
      for (let w = 0; w < 2; w++) aWorkers.push(spawnWorker());
      workers.push(...aWorkers);
      await Promise.all(aWorkers.map((w, i) => send(w, { cmd: "connect", url: a.wsUrl, n: Math.floor(n / 2), offset: 200_000 + i * 50_000, distinct: false, rampPerSec: 500 }, 300_000)));
      const loaded = await hotpushLoop(writer, neighborSeen, notifier, Math.max(5, opts.seconds * 5), b.name);
      const loadedIdle = +avg([sampleContainer(b.name).cpuPct, sampleContainer(c.name).cpuPct]).toFixed(1);
      const aCpu = sampleContainer(a.name).cpuPct;

      return {
        metrics: {
          ...vmProfile(),
          quietIdleCpuPct: quietIdle,
          loadedIdleCpuPct: loadedIdle,
          quietProbeP50Ms: quiet.p50,
          loadedProbeP50Ms: loaded.p50,
          neighborDeltaPct: +((loaded.p50 / Math.max(0.01, quiet.p50) - 1) * 100).toFixed(1),
          aCpuPctOfBudget: +(aCpu / opts.tier.cpus).toFixed(1),
        },
        errors: 0,
      };
    }

    // ---- wanhop ----
    fleet = await bootDockerFleet({ syncCount: 1, syncTier: opts.tier });
    const sync = fleet.syncs[0]!;
    const reason = netemProbe(sync.name);
    if (reason) return { metrics: {}, errors: 0, skipped: reason };
    const writer = new StackbaseClient(nodeWs(fleet.writer.wsUrl));
    clients.push(writer);
    const probes = attachProbes(sync.wsUrl, probesN, onAdvance);
    clients.push(...probes.clients);
    await probes.ready;
    netemSet(sync.name, opts.wanDelayMs ?? 10);
    const r = await hotpushLoop(writer, probes.seen, notifier, Math.max(5, opts.seconds * 5), sync.name);
    return { metrics: { ...vmProfile(), pushP50Ms: r.p50, pushP99Ms: r.p99 }, errors: 0 };
  } finally {
    for (const c of clients) c.close();
    for (const w of workers) {
      try {
        w.proc.stdin!.write(JSON.stringify({ cmd: "exit" }) + "\n");
      } catch {
        /* dead */
      }
      setTimeout(() => w.proc.kill("SIGKILL"), 1000).unref();
    }
    await fleet?.stop();
  }
}

function docker_oomKilled(name: string): boolean {
  const out = spawnSync("docker", ["inspect", "-f", "{{.State.OOMKilled}}", name], { timeout: 10_000, encoding: "utf8" });
  return out.stdout?.trim() === "true";
}
```

- [ ] **Step 2: The smoke test**

Create `benchmarks/runner/test/docker-fleet-smoke.test.ts`:

```ts
/** Tiny-N smoke of all three cells over real budgeted containers. Docker-gated; the wanhop cell
 *  may legitimately SKIP (netem unavailable in the VM kernel) — the skip must carry a reason. */
import { describe, it, expect, afterAll } from "vitest";
import { runDockerFleetCell } from "../src/cores/docker-fleet";
import { dockerAvailable, teardownInfra } from "../src/cores/docker-fleet-boot";

const maybe = dockerAvailable() ? describe : describe.skip;
const tier = { cpus: 1, mem: "512m" };

maybe("docker-fleet smoke (1cpu/512m, tiny N)", () => {
  afterAll(async () => {
    await teardownInfra();
  });

  it("budget cell finds a max clean N and reports the capacity row", async () => {
    const r = await runDockerFleetCell({ cell: "budget", tier, ns: [100, 200], workers: 2, seconds: 2 });
    expect(r.metrics.maxCleanN).toBeGreaterThanOrEqual(100);
    expect(r.metrics.pushP50Ms).toBeGreaterThan(0);
    expect(r.metrics.reconnectFailed).toBe(0);
  }, 900_000);

  it("neighbor cell reports control-vs-loaded windows", async () => {
    const r = await runDockerFleetCell({ cell: "neighbor", tier, ns: [200], workers: 2, seconds: 2 });
    expect(r.metrics.quietProbeP50Ms).toBeGreaterThan(0);
    expect(r.metrics.loadedProbeP50Ms).toBeGreaterThan(0);
  }, 900_000);

  it("wanhop either measures under injected delay or skips with a reason", async () => {
    const r = await runDockerFleetCell({ cell: "wanhop", tier, ns: [100], workers: 2, seconds: 2, wanDelayMs: 10 });
    if (r.skipped) {
      expect(r.skipped).toMatch(/netem/);
    } else {
      // 10ms injected each way must show up in the push latency.
      expect(r.metrics.pushP50Ms).toBeGreaterThan(10);
    }
  }, 900_000);
});
```

- [ ] **Step 3: Run it**

Run: `cd benchmarks/runner && bun run test -- test/docker-fleet-smoke.test.ts`
Expected: 3 PASS (wanhop possibly via the skip path — that's a pass). Debug notes: (a) the budget cell's per-rung `kill-all → ramp` reuses live workers — if a re-ramp reports failures, check the worker's connect handler tolerates being called twice (it replaces `conns` — rung-1 code does); (b) neighbor's A-load swarm uses offsets far from B/C's to avoid user-id collisions — irrelevant for hot:get but keeps report counts distinct; (c) `docker stats` adds ~1s per sample — the hotpush loop samples once per write; if that dominates the 200ms pacing, note it (measurement overhead, constant across cells).

- [ ] **Step 4: Commit**

```bash
git add benchmarks/runner/src/cores/docker-fleet.ts benchmarks/runner/test/docker-fleet-smoke.test.ts
git commit -m "feat(bench): docker-fleet cells — budget capacity, no-noisy-neighbor, netem wanhop"
```

---

### Task 3: Axis wiring

**Files:**
- Create: `benchmarks/runner/src/scenarios/docker-fleet.ts`
- Modify: `benchmarks/runner/src/run.ts` (Axis union + `scenariosFor` branch + force single sqlite pass for this axis)
- Modify: `benchmarks/runner/src/cli.ts` (usage line gains `docker-fleet`)
- Modify: `benchmarks/runner/src/scenarios/reactive.ts` (`Scenario.axis` union gains `"docker-fleet"`)
- Modify: `benchmarks/runner/src/compare.ts` (`METRIC_DIRECTION` gains `maxCleanN: "higher-better"`)
- Modify: root `package.json` (`"bench:dockerfleet": "bun benchmarks/runner/src/cli.ts run --axis docker-fleet --store sqlite"`)
- Test: `benchmarks/runner/test/docker-fleet-env.test.ts` + extend `compare.test.ts`

**Interfaces:**
- Produces: `dockerFleetScenarios(seconds: number): Scenario[]` — cells × tiers: `budget` per tier over the N ladder; `neighbor` at the MIDDLE tier only; `wanhop` at the middle tier × delays `[1, 10, 50]`. Names `dfleet-budget-1c512m`, `dfleet-neighbor-2c1g`, `dfleet-wanhop-2c1g-d10`. Env: `DFLEET_TIERS` (`"1/512m,2/1g,4/2g"` default), `DFLEET_NS` (`[1000,2000,4000]` default), `CONN_WORKERS` — all fail-fast on set-but-invalid (exported `tiersFromEnv`/`nsFromEnv` for tests). A skipped wanhop result flows through with `skipped` recorded into params/metrics as-is (`errors: 0`).

- [ ] **Step 1: Failing env + polarity tests**

`benchmarks/runner/test/docker-fleet-env.test.ts`:

```ts
import { describe, it, expect, afterEach } from "vitest";
import { tiersFromEnv, nsFromEnv, dockerFleetScenarios } from "../src/scenarios/docker-fleet";

const KEYS = ["DFLEET_TIERS", "DFLEET_NS", "CONN_WORKERS"] as const;
const saved: Record<string, string | undefined> = {};
for (const k of KEYS) saved[k] = process.env[k];
afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe("docker-fleet env parsing", () => {
  it("defaults: three tiers, three Ns", () => {
    delete process.env.DFLEET_TIERS;
    delete process.env.DFLEET_NS;
    expect(tiersFromEnv()).toEqual([{ cpus: 1, mem: "512m" }, { cpus: 2, mem: "1g" }, { cpus: 4, mem: "2g" }]);
    expect(nsFromEnv()).toEqual([1000, 2000, 4000]);
  });
  it("DFLEET_TIERS honored; set-but-invalid throws", () => {
    process.env.DFLEET_TIERS = "2/1g";
    expect(tiersFromEnv()).toEqual([{ cpus: 2, mem: "1g" }]);
    process.env.DFLEET_TIERS = "banana";
    expect(() => tiersFromEnv()).toThrow(/DFLEET_TIERS/);
  });
  it("DFLEET_NS set-but-invalid throws", () => {
    process.env.DFLEET_NS = "0";
    expect(() => nsFromEnv()).toThrow(/DFLEET_NS/);
  });
  it("scenario names: budget per tier, neighbor+wanhop at the middle tier", () => {
    process.env.DFLEET_TIERS = "1/512m,2/1g,4/2g";
    process.env.DFLEET_NS = "100";
    const names = dockerFleetScenarios(2).map((s) => s.name);
    expect(names).toContain("dfleet-budget-1c512m");
    expect(names).toContain("dfleet-budget-4c2g");
    expect(names).toContain("dfleet-neighbor-2c1g");
    expect(names).toContain("dfleet-wanhop-2c1g-d10");
    expect(names).not.toContain("dfleet-neighbor-1c512m");
  });
});
```

Extend `compare.test.ts` with one case: a `maxCleanN` DROP past the band flags as a regression (higher-better).

- [ ] **Step 2: Implement scenario + wiring** (the scenario file mirrors `fleet-connections.ts`'s structure; run.ts gets `"docker-fleet"` in the Axis union, a `scenariosFor` branch, and the forced `flags.store = "sqlite"` single pass; cli usage line; `Scenario.axis` widened; `METRIC_DIRECTION` gains `maxCleanN`; root script added after `bench:fleetconn`):

```ts
/**
 * docker-fleet axis (`--axis docker-fleet`, rung 3.5): budgeted containers of the shipped image.
 * Docker-gated: absent Docker, every cell resolves as an explicit skip (never a silent pass).
 * HONESTY: budgets on one host — capacity planning numbers, never capacity multiplication.
 */
import { runDockerFleetCell } from "../cores/docker-fleet";
import { dockerAvailable, ensureEnvelope, teardownInfra, type Tier } from "../cores/docker-fleet-boot";
import type { Scenario } from "./reactive";

export function tiersFromEnv(): Tier[] {
  const raw = process.env.DFLEET_TIERS;
  if (raw === undefined) return [{ cpus: 1, mem: "512m" }, { cpus: 2, mem: "1g" }, { cpus: 4, mem: "2g" }];
  const tiers: Tier[] = [];
  for (const part of raw.split(",")) {
    const m = part.trim().match(/^(\d+)\/(\d+(?:m|g))$/);
    if (m) tiers.push({ cpus: Number(m[1]), mem: m[2]! });
  }
  if (tiers.length === 0) throw new Error(`DFLEET_TIERS was set to "${raw}" but parsed to no valid tiers (want "2/1g,4/2g")`);
  return tiers;
}

export function nsFromEnv(): number[] {
  const raw = process.env.DFLEET_NS;
  if (raw === undefined) return [1000, 2000, 4000];
  const ns = raw.split(",").map((s) => Number(s.trim())).filter((n) => Number.isInteger(n) && n >= 1);
  if (ns.length === 0) throw new Error(`DFLEET_NS was set to "${raw}" but parsed to no valid N`);
  return ns;
}

function workersFromEnv(): number {
  const raw = process.env.CONN_WORKERS;
  if (raw === undefined) return 4;
  const w = Number(raw);
  if (!Number.isInteger(w) || w < 1) throw new Error(`CONN_WORKERS was set to "${raw}" but must parse to an integer >= 1`);
  return w;
}

const WAN_DELAYS = [1, 10, 50];

export function dockerFleetScenarios(seconds: number): Scenario[] {
  const tiers = tiersFromEnv();
  const ns = nsFromEnv();
  const workers = workersFromEnv();
  const middle = tiers[Math.floor((tiers.length - 1) / 2)]!;
  const tierName = (t: Tier) => `${t.cpus}c${t.mem}`;
  const scenarios: Scenario[] = [];
  const guard = async <T>(run: () => Promise<T>): Promise<T> => {
    if (!dockerAvailable()) throw new Error("docker-fleet needs Docker (docker info failed) — start Docker Desktop");
    await ensureEnvelope(tiers);
    return run();
  };

  for (const tier of tiers) {
    scenarios.push({
      name: `dfleet-budget-${tierName(tier)}`,
      axis: "docker-fleet",
      params: { cell: "budget", tier: tierName(tier), ns, workers },
      run: () => guard(async () => {
        const r = await runDockerFleetCell({ cell: "budget", tier, ns, workers, seconds });
        return { metrics: r.metrics, errors: r.errors }; // budget never skips
      }),
    });
  }
  scenarios.push({
    name: `dfleet-neighbor-${tierName(middle)}`,
    axis: "docker-fleet",
    params: { cell: "neighbor", tier: tierName(middle), n: ns[0], workers },
    run: () => guard(async () => {
      const r = await runDockerFleetCell({ cell: "neighbor", tier: middle, ns: [ns[0]!], workers, seconds });
      return { metrics: r.metrics, errors: r.errors };
    }),
  });
  for (const d of WAN_DELAYS) {
    scenarios.push({
      name: `dfleet-wanhop-${tierName(middle)}-d${d}`,
      axis: "docker-fleet",
      params: { cell: "wanhop", tier: tierName(middle), delayMs: d, workers },
      run: () => guard(async () => {
        const r = await runDockerFleetCell({ cell: "wanhop", tier: middle, ns: [Math.min(500, ns[0]!)], workers, seconds, wanDelayMs: d });
        return { metrics: r.skipped ? {} : r.metrics, errors: r.errors };
      }),
    });
  }
  // Final teardown scenario: infra cleanup rides the sweep's tail (network + postgres).
  scenarios.push({
    name: "dfleet-teardown",
    axis: "docker-fleet",
    params: { cell: "teardown" },
    run: async () => {
      await teardownInfra();
      return { metrics: {}, errors: 0 };
    },
  });
  return scenarios;
}
```

- [ ] **Step 3: Tiny end-to-end** — `DFLEET_TIERS=1/512m DFLEET_NS=100 CONN_WORKERS=2 bun run bench:dockerfleet -- --seconds 2` → budget + neighbor + 3 wanhop (or skips) + teardown lines, results JSON written (delete after inspection); repo typecheck + runner suite green.

- [ ] **Step 4: Commit**

```bash
git add benchmarks/runner/src/scenarios/docker-fleet.ts benchmarks/runner/src/run.ts benchmarks/runner/src/cli.ts benchmarks/runner/src/scenarios/reactive.ts benchmarks/runner/src/compare.ts benchmarks/runner/test/docker-fleet-env.test.ts benchmarks/runner/test/compare.test.ts package.json
git commit -m "feat(bench): register the docker-fleet axis — scenarios, CLI, bench:dockerfleet, maxCleanN polarity"
```

---

### Task 4: Baseline, findings, the capacity table

**Files:**
- Create: `benchmarks/baselines/docker-fleet-baseline.json` (via `--save`)
- Create: `benchmarks/docs/docker-fleet-findings.md`
- Modify: `benchmarks/docs/performance-backlog.md` ONLY if a standing verdict changes.

- [ ] **Step 1: The full sweep** — `bun run bench:dockerfleet -- --seconds 5 --save benchmarks/baselines/docker-fleet-baseline.json` via nohup + log + a silence-aware poller (no new line for 10+ min AND no docker/bench process = death). Default = 3 budget tiers (each climbing the N ladder) + neighbor + 3 wanhop + teardown; each budget tier boots one fleet and re-ramps per rung — expect 30-60 min including the first image build. On a cell failure: light diagnosis, honest partial, documented cap (the standing rules).

- [ ] **Step 2: The findings doc** — `benchmarks/docs/docker-fleet-findings.md`; every number from the baseline JSON; structure:

```markdown
# docker-fleet — findings (<date>, this machine)

Method: docs/superpowers/specs/2026-02-20-docker-fleet-bench-design.md.
THE HONESTY BLOCK (verbatim from the spec): containers do not create hardware — aggregate
capacity beyond the host is NOT claimed and autoscaling is out of scope; Docker-on-macOS is a VM
(this run: <vmNcpu> vCPU / <vmMemGb>GB stamped from docker info) — absolutes are VM-relative,
shapes and per-budget comparisons are the signal, a Linux host is the target for publishable
absolutes; the host driver crosses the port-forward path on every connection (constant across
cells); netem is simulation; inherited rung-1/3 boundaries.

## The capacity table (the centerpiece)
| Node budget | max clean N | RSS/conn | hotpush p50/p99 | CPU (of budget) | storm recovery | QueryUnchanged |
| 1 vCPU / 512MB | ... |
| 2 vCPU / 1GB   | ... |
| 4 vCPU / 2GB   | ... |
(rows from JSON; one paragraph on the scaling shape across budgets)

## No noisy neighbor
(quiet vs loaded windows for B/C; neighborDeltaPct verdict against the compare band)

## The WAN hop (netem) — or its honest skip
| injected delay | push p50 | p99 |
(rows, or the skip reason verbatim)

## Deploy-path dividend
(one paragraph: every cell booted the SHIPPED image with the documented bind-mount pattern in
fleet mode — what that continuously re-verifies about the self-host path)

## Caps and reproduction
(conditions, image build time, exact invocations, DFLEET_* envs)
```

- [ ] **Step 3: Repo verification + commit**

```bash
bun run typecheck && bun run test
git add benchmarks/baselines/docker-fleet-baseline.json benchmarks/docs/docker-fleet-findings.md
git commit -m "feat(bench): docker-fleet baseline + findings — the budget capacity table on the shipped image"
```

(Include `performance-backlog.md` in the add only if edited.)
