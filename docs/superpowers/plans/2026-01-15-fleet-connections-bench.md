# Fleet-Connections Bench Axis Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A first-class `--axis fleet-connections` measuring multi-node sync-fleet connection behavior on one machine: per-node parity vs the single-node baseline (no-fleet-tax), cross-node push propagation, the failover storm (SIGKILL a sync node → its connections redistribute onto survivors), and whether K nodes parallelize the measured 19µs/subscriber hot-fan-out wall.

**Architecture:** Boots a real fleet as spawned `serve` children (writer + K sync nodes, `--fleet` over one shared embedded-postgres — the exact boot shape `packages/cli/test/outbox-e2e.test.ts`'s fleet arm uses), each ps-sampled independently. Reuses rung 1's swarm workers / frame helpers / proc-stats / pacing verbatim; the one rung-1 touch is an additive `url` override on the worker's `reconnect` command (failstorm redistribution). Subscribers live only on sync nodes; writes drive through the writer via a probe client.

**Tech Stack:** TypeScript, Bun children, `ws`, embedded-postgres (`@stackbase/docstore-postgres/test-support/embedded-pg` via the bench's shared `pgServerUrl()`), vitest under Node.

**Spec:** `docs/superpowers/specs/2026-01-15-fleet-connections-bench-design.md` (this worktree)

## Global Constraints

- Work ONLY in this worktree (`.claude/worktrees/fleet-connections-bench`, branch `worktree-fleet-connections-bench`). The main checkout belongs to another session.
- Fleet nodes are CHILD processes spawned exactly like `spawnFleetServe` in `packages/cli/test/outbox-e2e.test.ts:906-916`: `bun <CLI_BIN> serve --dir <fixtureConvexDir> --data <tmp>/db.sqlite --port P --ip 127.0.0.1 --no-dashboard --database-url <pgUrl> --fleet --advertise-url http://127.0.0.1:P`, env `STACKBASE_ADMIN_KEY`. The ready stdout line is JSON with `url` AND `role` (`"writer"` first boot, `"sync"` for later boots) — assert roles.
- `serve` NEVER runs codegen: the fixture convex dir must carry a COMMITTED `_generated/` (kept fresh by a codegen script + drift test, the examples pattern).
- The shared store is embedded-postgres via the bench's existing `pgServerUrl()` / `stopPgServer()` (scenarios/reactive.ts) — fail fast (`pgAvailable()`) if unavailable; this axis has no SQLite mode.
- Per-node RSS/CPU only from `sampleProc(pid)` (rung 1's proc-stats). `assertFdHeadroom(nTotal + probes)` before ramping.
- Reuse rung 1's `connections-worker.ts` (paced ramps, `failed` counts, `timeoutMs`); the ONLY change allowed there is the additive `reconnect.url` override. Aggregate pacing rule: per-worker rate = `Math.max(1, Math.floor(rampPerSec / totalWorkers))`.
- Sweep: cells × K ∈ {1, 2, 4}, N_total default 8,000; env `FLEETCONN_KS` / `FLEETCONN_NS` / `CONN_WORKERS`, all fail-fast validated (set-but-invalid throws — the rung-1 rule).
- `bench:compare` polarity checklist (the rung-1 Critical, now a checklist item): new higher-better metrics must be registered; `deliveredPct`/`unchangedPct`/`framesPerSec`/`acceptPerSec` already are; `reconnectFailed` is already in `ZERO_BASE_ALERT`. This plan's new keys that need registration: none higher-better beyond those (verify at wiring time; `nodeSpreadMs`, latencies, CPU, RSS are lower-better defaults).
- Honesty rules verbatim in the findings: single-machine co-location → per-node marginal claims only, NO aggregate-capacity multiplication (stated as arithmetic-from-parity); embedded-pg substrate (absolute RSS not comparable to rung 1's sqlite baselines — compare shapes/marginals); loopback; paced floors; storm recovery includes the jittered spread; driver boundary caps N_total.
- Tests under Node/vitest via `cd benchmarks/runner && bun run test`; children spawned with `bun`.
- Commits end with:

```
Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_015RKShEWjRcmbQVJ8ooUPP6
```

---

### Task 1: The fleet fixture + fleet-boot core

**Files:**
- Create: `benchmarks/runner/fixtures/fleetconn/convex/schema.ts`
- Create: `benchmarks/runner/fixtures/fleetconn/convex/hot.ts`
- Create: `benchmarks/runner/fixtures/fleetconn/convex/user.ts`
- Create: `benchmarks/runner/fixtures/fleetconn/codegen.ts`
- Create: `benchmarks/runner/fixtures/fleetconn/convex/_generated/*` (via the codegen script — never hand-written)
- Create: `benchmarks/runner/src/cores/fleet-boot.ts`
- Test: `benchmarks/runner/test/fleet-boot.test.ts`

**Interfaces:**
- Consumes: `pgServerUrl()` from `../scenarios/reactive` (shared embedded-pg); `sampleProc` from `./proc-stats`.
- Produces (Tasks 3-4 rely on): 

```ts
export interface FleetNode { role: "writer" | "sync"; port: number; pid: number; url: string; wsUrl: string }
export interface Fleet { writer: FleetNode; syncs: FleetNode[]; stop(): Promise<void>; killSync(i: number): void }
export async function bootFleet(syncCount: number): Promise<Fleet>
```

`bootFleet` boots 1 writer + `syncCount` sync nodes (writer first, roles asserted from ready lines), each with its own tmp `--data` dir (cleaned in `stop()`); `killSync(i)` SIGKILLs sync node i (for failstorm); `stop()` SIGTERMs everything and removes tmp dirs. Fixture function paths: `hot:get {}`, `hot:bump {}`, `user:get {u}`, `user:bump {u}` — IDENTICAL shapes to rung 1's `connections-server-entry.ts` fixture so the swarm/probe code reuses unchanged.

- [ ] **Step 1: The fixture app**

Create `benchmarks/runner/fixtures/fleetconn/convex/schema.ts`:

```ts
import { defineSchema, defineTable, v } from "@stackbase/values";

// Mirrors the rung-1 connections fixture (hot singleton counter + per-connection user rows) so the
// swarm workers and probes drive the SAME function paths against a fleet. Unsharded: connection
// machinery, not sharding, is the variable under test.
export default defineSchema({
  hot: defineTable({ n: v.number() }),
  users: defineTable({ u: v.number(), n: v.number() }).index("by_u", ["u"]),
});
```

Create `benchmarks/runner/fixtures/fleetconn/convex/hot.ts`:

```ts
import { v } from "@stackbase/values";
import { query, mutation } from "./_generated/server";

export const get = query({
  args: {},
  returns: v.array(v.object({ _id: v.id("hot"), _creationTime: v.number(), n: v.number() })),
  handler: (ctx) => ctx.db.query("hot", "by_creation").collect(),
});

export const bump = mutation({
  args: {},
  returns: v.number(),
  handler: async (ctx) => {
    const rows = (await ctx.db.query("hot", "by_creation").collect()) as Array<{ _id: string; n: number }>;
    const row = rows[0];
    if (row === undefined) {
      await ctx.db.insert("hot", { n: 1 });
      return 1;
    }
    await ctx.db.replace(row._id, { n: row.n + 1 });
    return row.n + 1;
  },
});
```

Create `benchmarks/runner/fixtures/fleetconn/convex/user.ts`:

```ts
import { v } from "@stackbase/values";
import { query, mutation } from "./_generated/server";

export const get = query({
  args: { u: v.number() },
  returns: v.array(v.object({ _id: v.id("users"), _creationTime: v.number(), u: v.number(), n: v.number() })),
  handler: (ctx, { u }) =>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (ctx.db.query("users", "by_u") as any).eq("u", u).collect(),
});

export const bump = mutation({
  args: { u: v.number() },
  returns: v.number(),
  handler: async (ctx, { u }) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rows = (await (ctx.db.query("users", "by_u") as any).eq("u", u).collect()) as Array<{ _id: string; u: number; n: number }>;
    const row = rows[0];
    if (row === undefined) {
      await ctx.db.insert("users", { u, n: 1 });
      return 1;
    }
    await ctx.db.replace(row._id, { u, n: row.n + 1 });
    return row.n + 1;
  },
});
```

Create `benchmarks/runner/fixtures/fleetconn/codegen.ts` (the examples' codegen pattern):

```ts
/** Regenerate the fleetconn fixture's convex/_generated. Run: `bun fixtures/fleetconn/codegen.ts`
 *  from benchmarks/runner. serve NEVER runs codegen, so _generated is committed; the fleet-boot
 *  test's drift check keeps it fresh. */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { push } from "@stackbase/cli";
import schema from "./convex/schema";
import * as hot from "./convex/hot";
import * as user from "./convex/user";

const here = dirname(fileURLToPath(import.meta.url));
const generatedDir = join(here, "convex/_generated");

const { generated } = push({ schema, modules: { hot, user } });
mkdirSync(generatedDir, { recursive: true });
for (const file of generated.files) writeFileSync(join(generatedDir, file.path), file.content, "utf8");
process.stdout.write(`generated: ${generated.files.map((f) => f.path).join(", ")}\n`);
```

Bootstrap note (the known chicken-and-egg): `hot.ts`/`user.ts` import `./_generated/server` before it exists. Bootstrap exactly as the examples did: `bun -e 'import { generateServer } from "@stackbase/codegen"; import { mkdirSync, writeFileSync } from "node:fs"; mkdirSync("fixtures/fleetconn/convex/_generated", { recursive: true }); const f = generateServer(); writeFileSync("fixtures/fleetconn/convex/_generated/" + f.path, f.content);'` (note: `generateServer()` returns `{path, content}`), then run the real codegen script. If `@stackbase/codegen` isn't yet a runner devDependency, add `"@stackbase/codegen": "workspace:*"` + `bun install` from the worktree root.

- [ ] **Step 2: Write the failing fleet-boot test**

Create `benchmarks/runner/test/fleet-boot.test.ts`:

```ts
/** Boots a REAL 1-writer + 2-sync fleet over embedded-postgres via the serve CLI children and
 *  proves the seam Task 3 stands on: roles, health, cross-node write visibility, kill/stop. */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { push } from "@stackbase/cli";
import { bootFleet } from "../src/cores/fleet-boot";
import { pgAvailable, stopPgServer } from "../src/scenarios/reactive";
import schema from "../fixtures/fleetconn/convex/schema";
import * as hot from "../fixtures/fleetconn/convex/hot";
import * as user from "../fixtures/fleetconn/convex/user";

const maybe = pgAvailable() ? describe : describe.skip;

maybe("fleet-boot (writer + 2 sync over embedded-pg)", () => {
  it("boots with asserted roles, serves health on every node, and a writer commit is readable fleet-wide", async () => {
    const fleet = await bootFleet(2);
    try {
      expect(fleet.writer.role).toBe("writer");
      expect(fleet.syncs.map((s) => s.role)).toEqual(["sync", "sync"]);

      for (const node of [fleet.writer, ...fleet.syncs]) {
        const health = (await (await fetch(`${node.url}/api/health`)).json()) as { status: string };
        expect(health.status).toBe("ok");
      }

      // A write through the WRITER is readable via a SYNC node (replica visibility, bounded wait).
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
      expect(seen).toBeGreaterThanOrEqual(1);
    } finally {
      await fleet.stop();
      await stopPgServer();
    }
  }, 120_000);

  it("committed fixture _generated is up to date (no drift)", () => {
    const { generated } = push({ schema, modules: { hot, user } });
    const dir = join(__dirname, "../fixtures/fleetconn/convex/_generated");
    for (const file of generated.files) {
      expect(readFileSync(join(dir, file.path), "utf8"), `${file.path} stale — run bun fixtures/fleetconn/codegen.ts`).toBe(file.content);
    }
  });
});
```

- [ ] **Step 3: Verify it fails**

Run: `cd benchmarks/runner && bun run test -- test/fleet-boot.test.ts`
Expected: FAIL — cannot find `../src/cores/fleet-boot` (after the fixture bootstrap of Step 1; if the fixture files themselves error first, finish Step 1's bootstrap).

- [ ] **Step 4: Implement `cores/fleet-boot.ts`**

```ts
/**
 * Fleet lifecycle for the fleet-connections axis: 1 writer + K sync nodes as REAL `serve`
 * children (`--fleet` over one shared embedded-postgres) — the same boot shape the fleet E2Es
 * use. Children so every node is independently ps-sampleable; writer boots first (the lease
 * makes it the writer), sync roles are asserted from each node's ready line.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer } from "node:net";
import { pgServerUrl } from "../scenarios/reactive";

export interface FleetNode {
  role: "writer" | "sync";
  port: number;
  pid: number;
  url: string;
  wsUrl: string;
}

export interface Fleet {
  writer: FleetNode;
  syncs: FleetNode[];
  stop(): Promise<void>;
  /** SIGKILL sync node i — the failstorm trigger. Its FleetNode stays in `syncs` (dead). */
  killSync(i: number): void;
}

const CLI_BIN = resolve(__dirname, "../../../../packages/cli/dist/bin.js");
const FIXTURE_CONVEX = resolve(__dirname, "../../fixtures/fleetconn/convex");
const ADMIN_KEY = "fleetconn-bench-admin-key";

interface Spawned { proc: ChildProcess; dataDir: string; node: FleetNode }

function freePort(): Promise<number> {
  return new Promise((resolvePromise, reject) => {
    const srv = createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      if (addr && typeof addr === "object") srv.close(() => resolvePromise(addr.port));
      else srv.close(() => reject(new Error("no port")));
    });
  });
}

function waitForReady(proc: ChildProcess): Promise<{ url: string; role: "writer" | "sync"; port: number }> {
  return new Promise((resolvePromise, reject) => {
    let buf = "";
    let stderr = "";
    const timer = setTimeout(() => reject(new Error(`fleet node ready timeout; stderr=${stderr}`)), 60_000);
    proc.stdout!.on("data", (chunk: Buffer) => {
      buf += chunk.toString("utf8");
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        try {
          const parsed = JSON.parse(line) as { url?: string; role?: "writer" | "sync"; port?: number };
          if (typeof parsed.url === "string" && parsed.role !== undefined) {
            clearTimeout(timer);
            resolvePromise(parsed as { url: string; role: "writer" | "sync"; port: number });
            return;
          }
        } catch {
          /* not the ready line */
        }
      }
    });
    proc.stderr!.on("data", (c: Buffer) => (stderr += c.toString("utf8")));
    proc.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`fleet node exited before ready (code=${code}); stderr=${stderr}`));
    });
  });
}

async function spawnNode(databaseUrl: string): Promise<Spawned> {
  const port = await freePort();
  const dataDir = mkdtempSync(join(tmpdir(), "fleetconn-"));
  const proc = spawn(
    "bun",
    [
      CLI_BIN, "serve", "--dir", FIXTURE_CONVEX, "--data", join(dataDir, "db.sqlite"),
      "--port", String(port), "--ip", "127.0.0.1", "--no-dashboard",
      "--database-url", databaseUrl, "--fleet", "--advertise-url", `http://127.0.0.1:${port}`,
    ],
    { env: { ...process.env, STACKBASE_ADMIN_KEY: ADMIN_KEY }, stdio: ["ignore", "pipe", "pipe"] },
  );
  proc.stdin?.on?.("error", () => {}); // rung-1 lesson: never let a dead child's pipe mask the real error
  const ready = await waitForReady(proc);
  const node: FleetNode = {
    role: ready.role,
    port,
    pid: proc.pid!,
    url: `http://127.0.0.1:${port}`,
    wsUrl: `ws://127.0.0.1:${port}/api/sync`,
  };
  return { proc, dataDir, node };
}

export async function bootFleet(syncCount: number): Promise<Fleet> {
  const databaseUrl = await pgServerUrl();
  const spawned: Spawned[] = [];

  // Writer FIRST (first boot takes the lease), then the sync nodes sequentially so roles are
  // deterministic — parallel boots could race the lease.
  const writerS = await spawnNode(databaseUrl);
  if (writerS.node.role !== "writer") {
    writerS.proc.kill("SIGKILL");
    throw new Error(`first fleet node booted as "${writerS.node.role}", expected writer`);
  }
  spawned.push(writerS);
  const syncs: FleetNode[] = [];
  for (let i = 0; i < syncCount; i++) {
    const s = await spawnNode(databaseUrl);
    if (s.node.role !== "sync") {
      for (const sp of spawned) sp.proc.kill("SIGKILL");
      s.proc.kill("SIGKILL");
      throw new Error(`fleet node ${i + 2} booted as "${s.node.role}", expected sync`);
    }
    spawned.push(s);
    syncs.push(s.node);
  }

  return {
    writer: writerS.node,
    syncs,
    killSync(i: number): void {
      const s = spawned[1 + i];
      if (!s) throw new Error(`no sync node ${i}`);
      s.proc.kill("SIGKILL");
    },
    async stop(): Promise<void> {
      for (const s of spawned) {
        if (s.proc.exitCode === null && s.proc.signalCode === null) s.proc.kill("SIGTERM");
      }
      await Promise.all(
        spawned.map(
          (s) =>
            new Promise<void>((r) => {
              if (s.proc.exitCode !== null || s.proc.signalCode !== null) return r();
              const t = setTimeout(() => {
                s.proc.kill("SIGKILL");
                r();
              }, 5_000);
              s.proc.once("exit", () => {
                clearTimeout(t);
                r();
              });
            }),
        ),
      );
      for (const s of spawned) rmSync(s.dataDir, { recursive: true, force: true });
    },
  };
}
```

- [ ] **Step 5: Run the tests — pass**

Run: `cd benchmarks/runner && bun run test -- test/fleet-boot.test.ts`
Expected: 2 PASS (boot+roles+health+cross-node visibility; drift). Debug notes: if the writer's ready line lacks `role`, dump the raw line — the fleet E2E asserts `.role`, so it exists on the fleet path; verify `--fleet` was passed. If cross-node read never sees the bump, check the sync node's replica-tailer needs the shared pg URL (it does — same `--database-url`).

- [ ] **Step 6: Typecheck + commit**

Run: `bun run typecheck` (repo root of the worktree) — clean.

```bash
git add benchmarks/runner/fixtures/fleetconn benchmarks/runner/src/cores/fleet-boot.ts benchmarks/runner/test/fleet-boot.test.ts benchmarks/runner/package.json bun.lock
git commit -m "feat(bench): fleetconn fixture + fleet-boot core — real serve children over embedded-pg"
```

(Omit package.json/bun.lock if `@stackbase/codegen` was already present.)

---

### Task 2: Worker reconnect-URL override (the one rung-1 touch)

**Files:**
- Modify: `benchmarks/runner/src/connections-worker.ts` (the `reconnect` command)
- Test: extend `benchmarks/runner/test/connections-children.test.ts`

**Interfaces:**
- Produces: `{"cmd":"reconnect", spreadMs?, timeoutMs?, url?}` — when `url` is present, every reconnecting socket targets the NEW url (the failstorm redistribution: a dead node's workers rejoin on a survivor). Absent → current behavior byte-identical.

- [ ] **Step 1: Write the failing test (extend the existing file)**

Append to `benchmarks/runner/test/connections-children.test.ts`:

```ts
describe("worker reconnect url override (fleet failstorm redistribution)", () => {
  it("reconnect with a url moves the swarm to a DIFFERENT live server", async () => {
    const serverA = spawnBun("connections-server-entry.ts");
    const readyA = JSON.parse(await nextLine(serverA)) as { port: number };
    const serverB = spawnBun("connections-server-entry.ts");
    const readyB = JSON.parse(await nextLine(serverB)) as { port: number };

    const worker = spawnBun("connections-worker.ts");
    const conn = await send(worker, { cmd: "connect", url: `ws://127.0.0.1:${readyA.port}/api/sync`, n: 20, offset: 0, distinct: false });
    expect(conn.connected).toBe(20);

    serverA.kill("SIGKILL");
    await new Promise((r) => setTimeout(r, 300));
    await send(worker, { cmd: "kill-all" });
    const re = await send(worker, {
      cmd: "reconnect",
      spreadMs: 200,
      timeoutMs: 5000,
      url: `ws://127.0.0.1:${readyB.port}/api/sync`,
    });
    expect(re.reconnected).toBe(20); // all 20 landed on server B
    expect(re.failed).toBe(0);

    await send(worker, { cmd: "exit" });
  }, 60_000);
});
```

- [ ] **Step 2: Run — verify it fails** (`reconnected` will be 0: the worker still targets dead A)

Run: `cd benchmarks/runner && bun run test -- test/connections-children.test.ts`

- [ ] **Step 3: Implement** — in `connections-worker.ts`'s `reconnect` handler, before scheduling the reopen loop, add:

```ts
if (typeof cmd.url === "string" && cmd.url.length > 0) url = String(cmd.url);
```

(One line — `url` is already the module-level target `openOne` reads.)

- [ ] **Step 4: Run — the new test passes AND the two existing children tests stay green.**

- [ ] **Step 5: Commit**

```bash
git add benchmarks/runner/src/connections-worker.ts benchmarks/runner/test/connections-children.test.ts
git commit -m "feat(bench): connections worker — reconnect url override for fleet failstorm redistribution"
```

---

### Task 3: The fleet-connections cells core

**Files:**
- Create: `benchmarks/runner/src/cores/fleet-connections.ts`
- Test: `benchmarks/runner/test/fleet-connections-smoke.test.ts`

**Interfaces:**
- Consumes: `bootFleet`/`Fleet` (Task 1); the worker protocol incl. `reconnect.url` (Task 2); `sampleProc`, `assertFdHeadroom` (rung 1); `StackbaseClient`/`webSocketTransport` + `ws`.
- Produces:

```ts
export type FleetCell = "parity" | "xnode" | "failstorm" | "hotfan";
export interface FleetCellOpts { cell: FleetCell; nTotal: number; syncNodes: number; workers: number; seconds: number; probesPerNode?: number }
export interface FleetCellResult { metrics: Record<string, number | null>; errors: number }
export async function runFleetCell(opts: FleetCellOpts): Promise<FleetCellResult>
```

Metric keys (Task 4's table + findings rely on these exact names):
- parity: `rssPerConnKbAvg`, `rssPerConnKbSpread`, `idleCpuPctAvg`, `acceptPerSec`, `perNodeN`
- xnode: `pushP50Ms`, `pushP99Ms`, `nodeSpreadMs`, `deliveredPct`, `writerCpuPct`, `syncCpuPctAvg`
- failstorm: `stormRecoverySec`, `unchangedPct`, `reconnectFailed`, `survivorCpuPeakPct`, `survivorRssDeltaKbPerConn`
- hotfan: `fanoutP50Ms`, `fanoutP99Ms`, `syncCpuPctAvg`, `framesPerSec`, `deliveredPct`

- [ ] **Step 1: Implement the core**

Create `benchmarks/runner/src/cores/fleet-connections.ts`:

```ts
/**
 * Fleet-connections cells: what K sync nodes do to connection behavior on one machine.
 * HONESTY: co-located nodes share RAM/CPU — this core measures per-node marginals (parity),
 * cross-node latency, failover redistribution, and fan-out parallelization SHAPE. It never
 * claims aggregate capacity multiplication (see the spec + findings).
 *
 * Topology per cell: bootFleet(K) → swarm workers assigned round-robin to SYNC nodes (the
 * writer holds no subscribers), probes (full StackbaseClients) on every sync node, writes
 * driven through the WRITER via one extra probe client.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { createInterface, type Interface } from "node:readline";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import WebSocket from "ws";
import { StackbaseClient, webSocketTransport, type ClientTransport } from "@stackbase/client";
import { bootFleet, type Fleet, type FleetNode } from "./fleet-boot";
import { sampleProc, assertFdHeadroom } from "./proc-stats";

export type FleetCell = "parity" | "xnode" | "failstorm" | "hotfan";
export interface FleetCellOpts {
  cell: FleetCell;
  nTotal: number;
  syncNodes: number;
  workers: number;
  seconds: number;
  probesPerNode?: number;
}
export interface FleetCellResult { metrics: Record<string, number | null>; errors: number }

const SRC = join(__dirname, "..");
interface WorkerChild { proc: ChildProcess; rl: Interface; targetSync: number; n: number }

function spawnWorker(): { proc: ChildProcess; rl: Interface } {
  const proc = spawn("bun", [join(SRC, "connections-worker.ts")], { stdio: ["pipe", "pipe", "inherit"] });
  proc.stdin!.on("error", () => {});
  return { proc, rl: createInterface({ input: proc.stdout! }) };
}

function nextLine(rl: Interface): Promise<string> {
  return new Promise((resolve) => rl.once("line", resolve));
}

async function send(w: { proc: ChildProcess; rl: Interface }, cmd: object, boundMs = 120_000): Promise<Record<string, unknown>> {
  const reply = nextLine(w.rl);
  w.proc.stdin!.write(JSON.stringify(cmd) + "\n");
  const timeout = new Promise<never>((_, rej) => setTimeout(() => rej(new Error(`worker did not reply to ${JSON.stringify(cmd).slice(0, 60)} within ${boundMs}ms — died?`)), boundMs).unref());
  const parsed = JSON.parse(await Promise.race([reply, timeout])) as Record<string, unknown>;
  if (parsed.error) throw new Error(`worker error: ${String(parsed.error)}`);
  return parsed;
}

function nodeWs(url: string): ClientTransport {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return webSocketTransport(url, { createWebSocket: (u) => new WebSocket(u) as unknown as any });
}

const pct = (sorted: number[], q: number) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]! : 0);
const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

export async function runFleetCell(opts: FleetCellOpts): Promise<FleetCellResult> {
  const probesPerNode = opts.probesPerNode ?? 3;
  assertFdHeadroom(opts.nTotal + probesPerNode * opts.syncNodes + 8);

  const fleet: Fleet = await bootFleet(opts.syncNodes);
  const workers: WorkerChild[] = [];
  const probes: StackbaseClient[] = [];
  let writerClient: StackbaseClient | undefined;
  try {
    const syncs = fleet.syncs;

    /* ---- probes: per sync node, all on the cell's query; plus the writer-side mutation client ---- */
    // probeSeen[nodeIdx][probeIdx] = counts observed
    const probeSeen: number[][][] = syncs.map(() => []);
    let onAdvance: (() => void) | null = null;
    for (let s = 0; s < syncs.length; s++) {
      for (let p = 0; p < probesPerNode; p++) {
        const client = new StackbaseClient(nodeWs(syncs[s]!.wsUrl));
        probes.push(client);
        const seen: number[] = [];
        probeSeen[s]!.push(seen);
        client.subscribe(opts.cell === "parity" ? "hot:get" : opts.cell === "xnode" ? "user:get" : "hot:get",
          opts.cell === "xnode" ? { u: 0 } : {}, (v) => {
            const rows = v as Array<{ n: number }>;
            seen.push(rows[0]?.n ?? 0);
            onAdvance?.();
          });
      }
    }
    writerClient = new StackbaseClient(nodeWs(fleet.writer.wsUrl));

    /* ---- ramp: workers round-robin across sync nodes, aggregate pacing across ALL workers ---- */
    const perWorkerN = Math.floor(opts.nTotal / opts.workers);
    const rampPerWorker = Math.max(1, Math.floor(1000 / opts.workers)); // 1000/s aggregate (rung-1 rule)
    const rampT0 = performance.now();
    const baselineRss = new Map<number, number>();
    for (const n of [fleet.writer, ...syncs]) baselineRss.set(n.pid, sampleProc(n.pid).rssKb);
    for (let w = 0; w < opts.workers; w++) {
      const { proc, rl } = spawnWorker();
      workers.push({ proc, rl, targetSync: w % syncs.length, n: w === opts.workers - 1 ? opts.nTotal - perWorkerN * (opts.workers - 1) : perWorkerN });
    }
    await Promise.all(
      workers.map((w, i) =>
        send(w, {
          cmd: "connect",
          url: syncs[w.targetSync]!.wsUrl,
          n: w.n,
          offset: i * perWorkerN,
          distinct: false,
          rampPerSec: rampPerWorker,
        }).then((r) => {
          if (Number(r.failed) > 0) throw new Error(`ramp failed: worker ${i} reported ${String(r.failed)} failures — cell invalid`);
        }),
      ),
    );
    const rampSec = (performance.now() - rampT0) / 1000;
    const perNodeN = opts.nTotal / syncs.length;

    /* ---- cells ---- */
    if (opts.cell === "parity") {
      const cpuSamples: number[][] = syncs.map(() => []);
      const end = performance.now() + opts.seconds * 1000;
      while (performance.now() < end) {
        await new Promise((r) => setTimeout(r, 500));
        syncs.forEach((n, i) => cpuSamples[i]!.push(sampleProc(n.pid).cpuPct));
      }
      const rssPerConn = syncs.map((n) => (sampleProc(n.pid).rssKb - baselineRss.get(n.pid)!) / perNodeN);
      return {
        metrics: {
          rssPerConnKbAvg: +avg(rssPerConn).toFixed(2),
          rssPerConnKbSpread: +(Math.max(...rssPerConn) - Math.min(...rssPerConn)).toFixed(2),
          idleCpuPctAvg: +avg(cpuSamples.map(avg)).toFixed(1),
          acceptPerSec: Math.round(opts.nTotal / rampSec),
          perNodeN: Math.round(perNodeN),
        },
        errors: 0,
      };
    }

    if (opts.cell === "xnode" || opts.cell === "hotfan") {
      // xnode: writes to user:bump{u:0} — only probes watch it (swarm watches hot:get, quiet).
      // hotfan: writes to hot:bump — the ENTIRE swarm on every node receives every push.
      const path = opts.cell === "xnode" ? "user:bump" : "hot:bump";
      const args = opts.cell === "xnode" ? { u: 0 } : {};
      const writes = Math.max(5, opts.seconds * 5);
      const lat: number[] = [];
      const perNodeLat: number[][] = syncs.map(() => []);
      const writerCpu: number[] = [];
      const syncCpu: number[][] = syncs.map(() => []);
      const framesBefore = await totalPushes(workers);
      const loopT0 = performance.now();
      for (let i = 0; i < writes; i++) {
        const before = probeSeen.map((node) => node.map((s) => s.length));
        const nodeDone: number[] = syncs.map(() => 0);
        const t0 = performance.now();
        const allDone = new Promise<void>((resolveDone) => {
          const check = () => {
            let all = true;
            for (let s = 0; s < syncs.length; s++) {
              const done = probeSeen[s]!.every((seen, p) => seen.length > before[s]![p]!);
              if (done && nodeDone[s] === 0) nodeDone[s] = performance.now() - t0;
              if (!done) all = false;
            }
            if (all) {
              onAdvance = null;
              resolveDone();
            }
          };
          onAdvance = check;
          check();
        });
        const cap = new Promise<never>((_, rej) => setTimeout(() => rej(new Error("fan-out wait cap (15s)")), 15_000).unref());
        await writerClient.mutation(path, args);
        await Promise.race([allDone, cap]);
        lat.push(performance.now() - t0);
        syncs.forEach((n, s) => {
          perNodeLat[s]!.push(nodeDone[s]!);
          syncCpu[s]!.push(sampleProc(n.pid).cpuPct);
        });
        writerCpu.push(sampleProc(fleet.writer.pid).cpuPct);
        await new Promise((r) => setTimeout(r, Math.max(50, 200 - (performance.now() - t0))));
      }
      const loopSec = (performance.now() - loopT0) / 1000;
      const sorted = [...lat].sort((a, b) => a - b);
      const framesAfter = await totalPushes(workers);
      const delivered = framesAfter - framesBefore;
      // hotfan: every swarm conn gets every write; xnode: the swarm's hot:get is untouched by
      // user:bump — delivered stays ~0 and deliveredPct is reported for the PROBES instead.
      const expected = opts.cell === "hotfan" ? writes * opts.nTotal : writes * probesPerNode * syncs.length;
      const deliveredCount = opts.cell === "hotfan" ? delivered : probeSeen.flat().reduce((a, s) => a + s.length, 0) - probeSeen.flat().length /* minus initial results */;
      const perNodeP50 = perNodeLat.map((xs) => pct([...xs].sort((a, b) => a - b), 0.5));
      const base: Record<string, number | null> = {
        deliveredPct: +Math.min(100, (100 * deliveredCount) / expected).toFixed(1),
        syncCpuPctAvg: +avg(syncCpu.map(avg)).toFixed(1),
      };
      if (opts.cell === "xnode") {
        return {
          metrics: {
            ...base,
            pushP50Ms: +pct(sorted, 0.5).toFixed(2),
            pushP99Ms: +pct(sorted, 0.99).toFixed(2),
            nodeSpreadMs: +(Math.max(...perNodeP50) - Math.min(...perNodeP50)).toFixed(2),
            writerCpuPct: +avg(writerCpu).toFixed(1),
          },
          errors: 0,
        };
      }
      return {
        metrics: {
          ...base,
          fanoutP50Ms: +pct(sorted, 0.5).toFixed(2),
          fanoutP99Ms: +pct(sorted, 0.99).toFixed(2),
          framesPerSec: Math.round(delivered / loopSec),
        },
        errors: 0,
      };
    }

    /* ---- failstorm ---- */
    const victim = 0; // kill sync node 0; its workers redistribute round-robin over survivors
    const survivors = syncs.filter((_, i) => i !== victim);
    if (survivors.length === 0) throw new Error("failstorm needs syncNodes >= 2");
    const survivorRssBefore = survivors.map((n) => sampleProc(n.pid).rssKb);
    fleet.killSync(victim);
    await new Promise((r) => setTimeout(r, 500));
    const victimWorkers = workers.filter((w) => w.targetSync === victim);
    const movedN = victimWorkers.reduce((a, w) => a + w.n, 0);
    const cpuPeak = survivors.map(() => 0);
    const cpuTimer = setInterval(() => {
      survivors.forEach((n, i) => {
        try {
          cpuPeak[i] = Math.max(cpuPeak[i]!, sampleProc(n.pid).cpuPct);
        } catch {
          /* transient ps failure — the reconnect result is the authority */
        }
      });
    }, 250);
    let results: Array<Record<string, unknown>>;
    const t0 = performance.now();
    try {
      results = await Promise.all(
        victimWorkers.map((w, i) =>
          send(w, { cmd: "reconnect", spreadMs: 2000, url: survivors[i % survivors.length]!.wsUrl }),
        ),
      );
    } finally {
      clearInterval(cpuTimer);
    }
    const stormRecoverySec = +((performance.now() - t0) / 1000).toFixed(2);
    const unchanged = results.reduce((a, r) => a + Number(r.unchanged ?? 0), 0);
    const reconnectFailed = results.reduce((a, r) => a + Number(r.failed ?? 0), 0);
    const survivorRssDelta = survivors.map((n, i) => sampleProc(n.pid).rssKb - survivorRssBefore[i]!);
    return {
      metrics: {
        stormRecoverySec,
        unchangedPct: +((100 * unchanged) / movedN).toFixed(1),
        reconnectFailed,
        survivorCpuPeakPct: +Math.max(...cpuPeak).toFixed(1),
        survivorRssDeltaKbPerConn: +(survivorRssDelta.reduce((a, b) => a + b, 0) / movedN).toFixed(2),
      },
      errors: 0,
    };
  } finally {
    writerClient?.close();
    for (const p of probes) p.close();
    for (const w of workers) {
      try {
        w.proc.stdin!.write(JSON.stringify({ cmd: "exit" }) + "\n");
      } catch {
        /* already dead */
      }
      setTimeout(() => w.proc.kill("SIGKILL"), 1000).unref();
    }
    await fleet.stop();
  }
}

async function totalPushes(workers: WorkerChild[]): Promise<number> {
  const reps = await Promise.all(workers.filter((w) => w.proc.exitCode === null).map((w) => send(w, { cmd: "report" }, 30_000)));
  return reps.reduce((a, r) => a + Number(r.pushes ?? 0), 0);
}
```

- [ ] **Step 2: Write the smoke test**

Create `benchmarks/runner/test/fleet-connections-smoke.test.ts`:

```ts
/** K=2 sync nodes, N=200 total, all four cells through the REAL fleet (embedded-pg + serve
 *  children). Presence + sanity only — magnitudes belong to the baseline run. */
import { describe, it, expect } from "vitest";
import { runFleetCell } from "../src/cores/fleet-connections";
import { pgAvailable, stopPgServer } from "../src/scenarios/reactive";

const maybe = pgAvailable() ? describe : describe.skip;
const base = { nTotal: 200, syncNodes: 2, workers: 2, seconds: 2 };

maybe("fleet-connections smoke (K=2, N=200)", () => {
  it("parity reports per-node marginals", async () => {
    const r = await runFleetCell({ cell: "parity", ...base });
    expect(r.metrics.rssPerConnKbAvg).toBeGreaterThan(0);
    expect(r.metrics.perNodeN).toBe(100);
  }, 240_000);

  it("xnode delivers writer commits to probes on every sync node", async () => {
    const r = await runFleetCell({ cell: "xnode", ...base });
    expect(r.metrics.pushP50Ms).toBeGreaterThan(0);
    expect(r.metrics.deliveredPct).toBeGreaterThan(90);
  }, 240_000);

  it("hotfan fans a writer commit to the whole cross-node swarm", async () => {
    const r = await runFleetCell({ cell: "hotfan", ...base });
    expect(r.metrics.fanoutP50Ms).toBeGreaterThan(0);
    expect(r.metrics.deliveredPct).toBeGreaterThan(90);
  }, 240_000);

  it("failstorm: a SIGKILLed sync node's swarm redistributes onto the survivor", async () => {
    const r = await runFleetCell({ cell: "failstorm", ...base });
    expect(r.metrics.stormRecoverySec).toBeGreaterThan(0);
    expect(r.metrics.stormRecoverySec).toBeLessThan(60);
    expect(r.metrics.reconnectFailed).toBe(0);
  }, 240_000);

  it("(teardown) stop shared pg", async () => {
    await stopPgServer();
    expect(true).toBe(true);
  });
});
```

- [ ] **Step 3: Run it**

Run: `cd benchmarks/runner && bun run test -- test/fleet-connections-smoke.test.ts`
Expected: 5 PASS (~4-8 min: each cell boots its own fleet). Likely first-run issues: (a) xnode `deliveredPct` low → the probe-count arithmetic (initial results subtracted) — dump `probeSeen` lengths; (b) failstorm reconnect landing `known:false`-style resets are FINE for the swarm (raw subscribers just resubscribe) — if `unchangedPct` is 0, check the hash echo still happens on the overridden-url reconnect (it should — `lastHash` travels with the conn); a low value here is a FINDING to record (cross-node fingerprints: the survivor re-serves the same query content, so `QueryUnchanged` should still hit — the fingerprint is content-derived, not node-local; if it is NOT, that's a genuine engine discovery for the findings doc, not a bench bug to paper over).

- [ ] **Step 4: Commit**

```bash
git add benchmarks/runner/src/cores/fleet-connections.ts benchmarks/runner/test/fleet-connections-smoke.test.ts
git commit -m "feat(bench): fleet-connections cells — parity, xnode, hotfan, failstorm over a real fleet"
```

---

### Task 4: Axis wiring

**Files:**
- Create: `benchmarks/runner/src/scenarios/fleet-connections.ts`
- Modify: `benchmarks/runner/src/run.ts` (Axis union + branch + force single pg-less pass)
- Modify: `benchmarks/runner/src/cli.ts` (usage line)
- Modify: `benchmarks/runner/src/scenarios/reactive.ts` (widen `Scenario.axis` union with `"fleet-connections"`)
- Modify: root `package.json` (`"bench:fleetconn": "bun benchmarks/runner/src/cli.ts run --axis fleet-connections --store sqlite"`)
- Test: `benchmarks/runner/test/fleet-connections-env.test.ts`

**Interfaces:**
- Produces: `fleetConnectionsScenarios(seconds: number): Scenario[]` — cells × K from `FLEETCONN_KS` (default `[1,2,4]`) at `FLEETCONN_NS` (default `[8000]`, one N_total per K to keep the sweep bounded), workers from `CONN_WORKERS` (default 4; workers must be ≥ syncNodes so every node gets a worker — validate and throw otherwise). Names `fleetconn-<cell>-k<K>-n<N>`. `failstorm` cells are skipped at K=1 (needs a survivor) — emit K≥2 only.
- Env helpers exported for tests: `ksFromEnv()`, `nsFromEnv()` (fail-fast on set-but-invalid, the rung-1 rule).
- run.ts note: the axis needs embedded-pg but NOT a store handle — force `flags.store = "sqlite"` (single pass, handle unused, same as connections) and let the scenarios manage pg via `pgServerUrl()`/`stopPgServer()` (already called unconditionally by `runVerb`). Check `pgAvailable()` inside the scenario run and throw a clear message if absent.

- [ ] **Step 1: Failing env tests** (`fleet-connections-env.test.ts`: defaults; `FLEETCONN_KS=2` honored; `FLEETCONN_KS=abc` throws; `FLEETCONN_NS=0` throws; `CONN_WORKERS=1` with K=2 throws the workers≥K validation; failstorm absent at K=1, present at K=2):

```ts
import { describe, it, expect, afterEach } from "vitest";
import { ksFromEnv, nsFromEnv, fleetConnectionsScenarios } from "../src/scenarios/fleet-connections";

const KEYS = ["FLEETCONN_KS", "FLEETCONN_NS", "CONN_WORKERS"] as const;
const saved: Record<string, string | undefined> = {};
for (const k of KEYS) saved[k] = process.env[k];
afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe("fleet-connections env parsing", () => {
  it("defaults: K=[1,2,4], N=[8000]", () => {
    delete process.env.FLEETCONN_KS;
    delete process.env.FLEETCONN_NS;
    expect(ksFromEnv()).toEqual([1, 2, 4]);
    expect(nsFromEnv()).toEqual([8000]);
  });
  it("FLEETCONN_KS honored; set-but-invalid throws", () => {
    process.env.FLEETCONN_KS = "2";
    expect(ksFromEnv()).toEqual([2]);
    process.env.FLEETCONN_KS = "abc";
    expect(() => ksFromEnv()).toThrow(/FLEETCONN_KS/);
  });
  it("FLEETCONN_NS set-but-invalid throws", () => {
    process.env.FLEETCONN_NS = "0";
    expect(() => nsFromEnv()).toThrow(/FLEETCONN_NS/);
  });
  it("failstorm present at K>=2 only; workers>=K validated", () => {
    process.env.FLEETCONN_KS = "1,2";
    process.env.FLEETCONN_NS = "400";
    delete process.env.CONN_WORKERS;
    const names = fleetConnectionsScenarios(2).map((s) => s.name);
    expect(names).toContain("fleetconn-parity-k1-n400");
    expect(names).not.toContain("fleetconn-failstorm-k1-n400");
    expect(names).toContain("fleetconn-failstorm-k2-n400");
    process.env.CONN_WORKERS = "1";
    expect(() => fleetConnectionsScenarios(2)).toThrow(/CONN_WORKERS/);
  });
});
```

- [ ] **Step 2: Implement the scenario file**

```ts
/**
 * Fleet-connections axis (`--axis fleet-connections`): rung 3 of the connection ladder — what K
 * co-located sync nodes do to connection behavior. Single-machine SHAPE-PROOF only (see the
 * spec's honesty section); requires embedded-postgres (the fleet's shared store).
 */
import { runFleetCell, type FleetCell } from "../cores/fleet-connections";
import { pgAvailable, type Scenario } from "./reactive";

export function ksFromEnv(): number[] {
  const raw = process.env.FLEETCONN_KS;
  if (raw === undefined) return [1, 2, 4];
  const ks = raw.split(",").map((s) => Number(s.trim())).filter((n) => Number.isInteger(n) && n >= 1);
  if (ks.length === 0) throw new Error(`FLEETCONN_KS was set to "${raw}" but parsed to no valid K (need integers >= 1)`);
  return ks;
}

export function nsFromEnv(): number[] {
  const raw = process.env.FLEETCONN_NS;
  if (raw === undefined) return [8000];
  const ns = raw.split(",").map((s) => Number(s.trim())).filter((n) => Number.isInteger(n) && n >= 1);
  if (ns.length === 0) throw new Error(`FLEETCONN_NS was set to "${raw}" but parsed to no valid N (need integers >= 1)`);
  return ns;
}

function workersFromEnv(): number {
  const raw = process.env.CONN_WORKERS;
  if (raw === undefined) return 4;
  const w = Number(raw);
  if (!Number.isInteger(w) || w < 1) throw new Error(`CONN_WORKERS was set to "${raw}" but must parse to an integer >= 1`);
  return w;
}

export function fleetConnectionsScenarios(seconds: number): Scenario[] {
  const workers = workersFromEnv();
  const cells: FleetCell[] = ["parity", "xnode", "hotfan", "failstorm"];
  const scenarios: Scenario[] = [];
  for (const k of ksFromEnv()) {
    if (workers < k) throw new Error(`CONN_WORKERS=${workers} < K=${k}: every sync node needs at least one worker`);
    for (const n of nsFromEnv()) {
      for (const cell of cells) {
        if (cell === "failstorm" && k < 2) continue; // needs a survivor
        scenarios.push({
          name: `fleetconn-${cell}-k${k}-n${n}`,
          axis: "fleet-connections",
          params: { cell, k, nTotal: n, workers },
          run: async () => {
            if (!pgAvailable()) throw new Error("fleet-connections needs embedded-postgres (unavailable on this platform)");
            const r = await runFleetCell({ cell, nTotal: n, syncNodes: k, workers, seconds });
            return { metrics: r.metrics, errors: r.errors };
          },
        });
      }
    }
  }
  return scenarios;
}
```

- [ ] **Step 3: Wire run.ts / cli.ts / reactive.ts / package.json** — Axis union gains `"fleet-connections"`; `scenariosFor` branch; `if (flags.axis === "fleet-connections") flags.store = "sqlite";` (single pass; scenarios own pg); cli usage `--axis reactive|writes|sharded|connections|fleet-connections`; `Scenario.axis` union widened; root script `bench:fleetconn` after `bench:connections`.

- [ ] **Step 4: Verify tiny end-to-end**

Run: `FLEETCONN_KS=2 FLEETCONN_NS=200 CONN_WORKERS=2 bun run bench:fleetconn -- --seconds 2`
Expected: four `sqlite/fleetconn-*-k2-n200` metric lines + a results JSON (delete it; results are gitignored). Then repo `bun run typecheck` clean, runner suite green.

- [ ] **Step 5: Commit**

```bash
git add benchmarks/runner/src/scenarios/fleet-connections.ts benchmarks/runner/src/run.ts benchmarks/runner/src/cli.ts benchmarks/runner/src/scenarios/reactive.ts package.json benchmarks/runner/test/fleet-connections-env.test.ts
git commit -m "feat(bench): register the fleet-connections axis — scenarios, CLI, bench:fleetconn"
```

---

### Task 5: Baseline, findings, backlog

**Files:**
- Create: `benchmarks/baselines/fleet-connections-baseline.json` (via `--save`)
- Create: `benchmarks/docs/fleet-connections-findings.md`
- Modify: `benchmarks/docs/performance-backlog.md` (ONLY if hotfan changes the #9/#11 picture — dated line, replace-don't-stack)

- [ ] **Step 1: Preflight + full sweep**

```bash
ulimit -n 65536
bun run bench:fleetconn -- --seconds 5 --save benchmarks/baselines/fleet-connections-baseline.json
```

Default sweep = K ∈ {1,2,4} × N_total 8,000 × 4 cells (failstorm skipped at K=1) = 11 cells, each booting its own fleet (writer + K serve children + embedded-pg) — expect 30-60 min. Machine-conditions note (load, ulimit) recorded for the findings. If a cell fails, the rung-1 rules apply: diagnose lightly, honest partial baseline with the cap documented; watch specifically for driver memory (N_total 8k × K=4 ramps are within rung 1's proven envelope, but fleets add ~5 extra processes' RSS).

- [ ] **Step 2: The findings doc**

`benchmarks/docs/fleet-connections-findings.md`, structure (every number from the baseline JSON, no invented values):

```markdown
# Fleet-connections — findings (<date>, this machine)

Method: docs/superpowers/specs/2026-01-15-fleet-connections-bench-design.md.
Honesty boundaries (verbatim): single-machine co-location — per-node marginal claims only, NO
aggregate-capacity multiplication (stated as arithmetic-from-parity pending multi-machine
measurement); embedded-postgres substrate (absolute RSS not comparable to the sqlite rung-1
baselines — shapes/marginals only); loopback; paced accept floors; storm recovery includes the
jittered spread; driver boundary caps N_total.

## Verdict 1 — the fleet tax (parity)
| K | RSS/conn avg | spread | idle CPU avg | perNodeN |
(rows from JSON, K=1 control vs K=2/4)
<within-bands / tax found: ...>

## Verdict 2 — the cross-node hop (xnode)
| K | push p50 | p99 | node spread | writer CPU | sync CPU avg |
<the writer→sync fan-out hop priced; compare shape vs rung-1 single-node hotpush at matched N/K>

## Verdict 3 — the failover storm (failstorm)
| K | recovery (s) | QueryUnchanged % | reconnectFailed | survivor CPU peak | survivor ΔRSS/conn |
<did the fingerprint resume survive cross-NODE redistribution? (content-derived hashes should
answer QueryUnchanged on the survivor — if they did not, that is an engine finding, reported
as such)>

## Verdict 4 — does K parallelize the hot-fan-out wall? (hotfan)
| K | fanout p50 | p99 | sync CPU avg | frames/s |
<the ladder's headline: at N_total=8k, does K=4 approach fanout ≈ single-node/(K)? What this
means for #9/#11's trigger>

## Caps and reproduction
<conditions, any caps, exact invocations>
```

- [ ] **Step 3: Backlog update if warranted** — if hotfan shows K parallelizes fan-out effectively, append the dated nuance to #9/#11 ("the fleet is the first-line answer at moderate K; dedup trigger revised to ..."); if it does NOT (e.g. the shared store or writer serializes anyway), record that with the numbers.

- [ ] **Step 4: Repo verification + commit**

```bash
bun run typecheck && bun run test
git add benchmarks/baselines/fleet-connections-baseline.json benchmarks/docs/fleet-connections-findings.md benchmarks/docs/performance-backlog.md
git commit -m "feat(bench): fleet-connections baseline + findings — the four fleet verdicts"
```
