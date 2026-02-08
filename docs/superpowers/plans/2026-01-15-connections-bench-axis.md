# Connections Bench Axis Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A first-class `--axis connections` for `@stackbase/bench` measuring a sync node's concurrent-WebSocket capacity: ΔRSS/connection + accept rate + idle CPU, hot-query push p50/p99 at N subscribers, per-subscription (distinct-query) state cost + matcher latency, and mass-reconnect-storm recovery — with a committed baseline and a findings doc.

**Architecture:** Three process kinds: the server under test as a child process (in-memory SQLite fixture app; RSS/CPU sampled externally via `ps`), W swarm worker child processes each holding N/W lightweight raw-`ws` connections speaking minimal sync protocol (one `ModifyQuerySet` subscribe; count-and-discard pushes; capture/echo resume fingerprints), and ~10 full `StackbaseClient` probes in the runner measuring real-client push latency. Cells sweep N and report through the standard `ScenarioResult` JSON → `bench:compare` machinery.

**Tech Stack:** TypeScript, Bun (runner + children), `ws` (raw client sockets + probe transport shim), vitest under Node for unit/smoke tests, the existing `@stackbase/bench` runner scaffolding.

**Spec:** `docs/superpowers/specs/2026-01-15-connections-bench-axis-design.md` (in this worktree)

## Global Constraints

- Work happens in THIS worktree (`.claude/worktrees/bench-connections`, branch `worktree-bench-connections`) — never touch the main checkout.
- The server under test runs as a CHILD PROCESS; its RSS is sampled via `ps -o rss=,%cpu= -p <pid>`. Driver memory must never contaminate server metrics.
- Swarm connections must be REAL subscribers: open ws → send `{type:"ModifyQuerySet", add:[{queryId, udfPath, args}], remove:[]}` → server allocates real session+subscription state. (The server assigns sessionIds itself on ws connect — `packages/cli/src/server.ts:280` — no Connect frame needed for a non-outbox subscriber.)
- Server pushes arrive as `{type:"Transition", ..., modifications:[...]}` whose modifications include `{type:"QueryUpdated", queryId, value, hash?}` and `{type:"QueryUnchanged", queryId}` — the swarm captures `hash` and echoes it as `resultHash` in the resubscribe `QueryRequest` (storm cell), then counts `QueryUnchanged`.
- WS protocol-level pings are answered automatically by the `ws` client library — no code needed, but do NOT disable it.
- Fail fast on fd limits: check `ulimit -n` before ramping; abort with exact raise instructions if `< need + 512` headroom.
- N sweep default `[1000, 5000, 10000, 25000, 50000]`, overridable via env `CONN_NS` (comma list, e.g. `CONN_NS=200` for quick runs). Workers default 4 (`CONN_WORKERS`).
- Tests run under Node via vitest (no Bun-only APIs in test files); children are spawned with `bun` explicitly.
- Cross-package imports resolve via built `dist/` — the worktree is already built (78/78 green baseline).
- In-memory SQLite store only for this axis (the store is deliberately not the variable); `run.ts` forces a single sqlite pass for `--axis connections`.
- Honesty rules go in the findings doc verbatim from the spec: loopback boundary, protocol-minimal swarm, machine-specific absolutes / shape-is-the-signal.
- Commits end with:

```
Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_015RKShEWjRcmbQVJ8ooUPP6
```

---

### Task 1: Pure helpers — swarm frames + proc stats + fd guard

**Files:**
- Create: `benchmarks/runner/src/cores/connections-frames.ts`
- Create: `benchmarks/runner/src/cores/proc-stats.ts`
- Test: `benchmarks/runner/test/connections-frames.test.ts`
- Test: `benchmarks/runner/test/proc-stats.test.ts`

**Interfaces:**
- Consumes: nothing project-specific (pure).
- Produces: `subscribeFrame(queryId: number, udfPath: string, args: unknown, resultHash?: string): string`; `newCounters(): SwarmCounters`; `classifyServerFrame(raw: string, c: SwarmCounters): void` where `SwarmCounters = { pushes: number; unchanged: number; lastHash?: string; firstFrameAtMs?: number }`; `parsePs(text: string): { rssKb: number; cpuPct: number }`; `sampleProc(pid: number): { rssKb: number; cpuPct: number }`; `fdLimit(): number` (Infinity for "unlimited"); `assertFdHeadroom(need: number): void` (throws with raise instructions).

- [ ] **Step 1: Write the failing tests**

Create `benchmarks/runner/test/connections-frames.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { subscribeFrame, classifyServerFrame, newCounters } from "../src/cores/connections-frames";

describe("subscribeFrame", () => {
  it("builds a ModifyQuerySet add with no resultHash by default", () => {
    const f = JSON.parse(subscribeFrame(7, "hot:get", {}));
    expect(f).toEqual({ type: "ModifyQuerySet", add: [{ queryId: 7, udfPath: "hot:get", args: {} }], remove: [] });
  });
  it("echoes a resume fingerprint when given", () => {
    const f = JSON.parse(subscribeFrame(7, "hot:get", { u: 3 }, "abc123"));
    expect(f.add[0]).toEqual({ queryId: 7, udfPath: "hot:get", args: { u: 3 }, resultHash: "abc123" });
  });
});

describe("classifyServerFrame", () => {
  it("counts QueryUpdated pushes and captures the latest hash", () => {
    const c = newCounters();
    classifyServerFrame(
      JSON.stringify({ type: "Transition", startVersion: {}, endVersion: {}, modifications: [{ type: "QueryUpdated", queryId: 7, value: [1], hash: "h1" }] }),
      c,
    );
    classifyServerFrame(
      JSON.stringify({ type: "Transition", startVersion: {}, endVersion: {}, modifications: [{ type: "QueryUpdated", queryId: 7, value: [2], hash: "h2" }] }),
      c,
    );
    expect(c.pushes).toBe(2);
    expect(c.lastHash).toBe("h2");
    expect(c.firstFrameAtMs).toBeTypeOf("number");
  });
  it("counts QueryUnchanged separately (the storm resume signal)", () => {
    const c = newCounters();
    classifyServerFrame(JSON.stringify({ type: "Transition", startVersion: {}, endVersion: {}, modifications: [{ type: "QueryUnchanged", queryId: 7 }] }), c);
    expect(c.unchanged).toBe(1);
    expect(c.pushes).toBe(0);
  });
  it("ignores non-JSON and unrelated frames without throwing", () => {
    const c = newCounters();
    classifyServerFrame("not json", c);
    classifyServerFrame(JSON.stringify({ type: "MutationResponse", requestId: "x" }), c);
    expect(c.pushes + c.unchanged).toBe(0);
  });
});
```

Create `benchmarks/runner/test/proc-stats.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { parsePs, sampleProc, fdLimit } from "../src/cores/proc-stats";

describe("parsePs", () => {
  it("parses `ps -o rss=,%cpu=` output", () => {
    expect(parsePs("  123456  12.5\n")).toEqual({ rssKb: 123456, cpuPct: 12.5 });
  });
  it("throws on garbage so a dead pid is loud, not zero", () => {
    expect(() => parsePs("")).toThrow(/ps output/);
  });
});

describe("sampleProc (against our own live pid)", () => {
  it("returns a positive RSS for process.pid", () => {
    const s = sampleProc(process.pid);
    expect(s.rssKb).toBeGreaterThan(1000);
    expect(s.cpuPct).toBeGreaterThanOrEqual(0);
  });
});

describe("fdLimit", () => {
  it("returns a positive number or Infinity", () => {
    const n = fdLimit();
    expect(n === Infinity || n > 0).toBe(true);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

First check `benchmarks/runner/package.json`: if it has no `test` script / `vitest` devDependency yet (the runner may only have source entries today), add `"test": "vitest run"` to scripts and `"vitest": "catalog:"` to devDependencies (the workspace-standard pattern), then `bun install` from the repo root — bun's isolated linker means the runner can't borrow vitest from siblings.

Run: `cd benchmarks/runner && bun run test -- test/connections-frames.test.ts test/proc-stats.test.ts` (or `bunx vitest run …` if a test script already existed)
Expected: FAIL — cannot find `../src/cores/connections-frames` / `proc-stats`.

- [ ] **Step 3: Implement**

Create `benchmarks/runner/src/cores/connections-frames.ts`:

```ts
/**
 * Pure frame helpers for the connections-axis swarm: build the minimal-protocol subscribe frame
 * and classify inbound server frames into counters. Kept pure (no ws import) so they unit-test
 * without sockets. Protocol shapes per packages/sync/src/protocol.ts: QueryRequest
 * {queryId, udfPath, args, resultHash?}; pushes arrive inside Transition.modifications as
 * QueryUpdated {queryId, value, hash?} / QueryUnchanged {queryId}.
 */

export interface SwarmCounters {
  /** QueryUpdated modifications seen (fan-out deliveries). */
  pushes: number;
  /** QueryUnchanged modifications seen (cheap resume answers — the storm-cell signal). */
  unchanged: number;
  /** Latest server-minted result fingerprint — echoed as resultHash on a storm resubscribe. */
  lastHash?: string;
  /** Wall-clock of the first classified frame (time-to-first-result during ramp/storm). */
  firstFrameAtMs?: number;
}

export function newCounters(): SwarmCounters {
  return { pushes: 0, unchanged: 0 };
}

export function subscribeFrame(queryId: number, udfPath: string, args: unknown, resultHash?: string): string {
  return JSON.stringify({
    type: "ModifyQuerySet",
    add: [{ queryId, udfPath, args, ...(resultHash !== undefined ? { resultHash } : {}) }],
    remove: [],
  });
}

export function classifyServerFrame(raw: string, c: SwarmCounters): void {
  let msg: { type?: string; modifications?: Array<{ type?: string; hash?: string }> };
  try {
    msg = JSON.parse(raw) as typeof msg;
  } catch {
    return; // not JSON — not ours to count
  }
  if (msg.type !== "Transition" || !Array.isArray(msg.modifications)) return;
  for (const m of msg.modifications) {
    if (m.type === "QueryUpdated") {
      c.pushes++;
      if (typeof m.hash === "string") c.lastHash = m.hash;
      if (c.firstFrameAtMs === undefined) c.firstFrameAtMs = Date.now();
    } else if (m.type === "QueryUnchanged") {
      c.unchanged++;
      if (c.firstFrameAtMs === undefined) c.firstFrameAtMs = Date.now();
    }
  }
}
```

Create `benchmarks/runner/src/cores/proc-stats.ts`:

```ts
/**
 * External process sampling for the connections axis: the server under test is a CHILD process,
 * and its RSS/CPU are read via `ps` so driver-side memory never contaminates the headline
 * ΔRSS/connection number. Plus the fd-limit guardrail: fail fast with raise instructions rather
 * than produce garbage numbers at half-established swarms.
 */
import { execFileSync, spawnSync } from "node:child_process";

export function parsePs(text: string): { rssKb: number; cpuPct: number } {
  const m = text.trim().match(/^(\d+)\s+([\d.]+)$/);
  if (!m) throw new Error(`unexpected ps output: ${JSON.stringify(text)} — is the pid alive?`);
  return { rssKb: Number(m[1]), cpuPct: Number(m[2]) };
}

export function sampleProc(pid: number): { rssKb: number; cpuPct: number } {
  return parsePs(execFileSync("ps", ["-o", "rss=,%cpu=", "-p", String(pid)]).toString());
}

/** Current soft fd limit; Infinity when "unlimited". */
export function fdLimit(): number {
  const out = spawnSync("sh", ["-c", "ulimit -n"]).stdout.toString().trim();
  return out === "unlimited" ? Infinity : Number(out);
}

export function assertFdHeadroom(need: number): void {
  const limit = fdLimit();
  if (limit >= need + 512) return;
  throw new Error(
    `fd limit too low: need ~${need + 512} (connections + headroom), have ${limit}.\n` +
      `Raise it for this shell:  ulimit -n 65536\n` +
      `macOS hard cap too low?   sudo launchctl limit maxfiles 65536 200000  (then reopen the terminal)\n` +
      `Aborting rather than benchmarking a half-established swarm.`,
  );
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd benchmarks/runner && bunx vitest run test/connections-frames.test.ts test/proc-stats.test.ts`
Expected: PASS (9 tests).

- [ ] **Step 5: Commit**

```bash
git add benchmarks/runner/src/cores/connections-frames.ts benchmarks/runner/src/cores/proc-stats.ts benchmarks/runner/test/connections-frames.test.ts benchmarks/runner/test/proc-stats.test.ts
git commit -m "feat(bench): connections-axis pure helpers — swarm frames, ps sampling, fd guard"
```

---

### Task 2: The child entries — fixture server + swarm worker

**Files:**
- Create: `benchmarks/runner/src/connections-server-entry.ts`
- Create: `benchmarks/runner/src/connections-worker.ts`
- Test: `benchmarks/runner/test/connections-children.test.ts`

**Interfaces:**
- Consumes: Task 1's `subscribeFrame`/`classifyServerFrame`/`newCounters`; `loadProject`/`startDevServer` from `@stackbase/cli`; `ws`.
- Produces:
  - Server entry: spawned as `bun src/connections-server-entry.ts`; boots the fixture app on port 0 and prints exactly one stdout line `{"ready":true,"port":<n>,"pid":<n>}`. Fixture functions: `hot:get` (query, args `{}`, returns all rows of `hot` via `by_creation`), `hot:bump` (mutation, args `{}`, upserts the single hot row's counter), `user:get` (query, args `{u: number}`, rows of `users` with `u === args.u` via index `by_u`), `user:bump` (mutation, args `{u: number}`, upserts that user row's counter).
  - Worker: spawned as `bun src/connections-worker.ts`; JSON-lines command protocol on stdin, replies on stdout:
    - `{"cmd":"connect","url":string,"n":number,"offset":number,"distinct":boolean}` → opens n sockets (subscribing to `user:get {u: offset+i}` when distinct, else `hot:get {}` — queryId 1 on every socket), replies `{"ok":"connect","connected":n,"rampMs":number}` when all have received their first frame.
    - `{"cmd":"report"}` → `{"ok":"report","connected":number,"pushes":number,"unchanged":number}` (aggregated).
    - `{"cmd":"kill-all"}` → destroys every socket abruptly (`socket.terminate()`), replies `{"ok":"kill-all"}`.
    - `{"cmd":"reconnect","spreadMs":number}` → reopens every socket on a uniform-random delay in `[0, spreadMs]`, resubscribing WITH the captured `lastHash` echoed as `resultHash`; replies `{"ok":"reconnect","reconnected":n,"stormMs":number,"unchanged":number}` when all have received their first post-reconnect frame.
    - `{"cmd":"exit"}` → closes sockets gracefully and exits 0.

- [ ] **Step 1: Write the child entries**

Create `benchmarks/runner/src/connections-server-entry.ts`:

```ts
/**
 * The system under test for `--axis connections`: a real sync server (startDevServer) over an
 * in-memory SQLite fixture, spawned as a CHILD so the runner can sample its RSS/CPU externally.
 * The store is deliberately cheap — connection machinery, not the commit path, is the variable.
 * Prints exactly one ready line: {"ready":true,"port":N,"pid":N}.
 */
import { v, defineSchema, defineTable } from "@stackbase/values";
import { query, mutation } from "@stackbase/executor";
import { SqliteDocStore, BunSqliteAdapter, NodeSqliteAdapter } from "@stackbase/docstore-sqlite";
import { createEmbeddedRuntime } from "@stackbase/runtime-embedded";
import { loadProject, startDevServer } from "@stackbase/cli";

const schema = defineSchema({
  hot: defineTable({ n: v.number() }),
  users: defineTable({ u: v.number(), n: v.number() }).index("by_u", ["u"]),
});

const hot = {
  get: query<Record<string, never>, unknown[]>({
    handler: (ctx) => ctx.db.query("hot", "by_creation").collect(),
  }),
  bump: mutation<Record<string, never>, number>({
    handler: async (ctx) => {
      const rows = await ctx.db.query("hot", "by_creation").collect();
      const row = rows[0] as { _id: string; n: number } | undefined;
      if (row === undefined) {
        await ctx.db.insert("hot", { n: 1 });
        return 1;
      }
      await ctx.db.replace(row._id, { n: row.n + 1 });
      return row.n + 1;
    },
  }),
};

const user = {
  get: query<{ u: number }, unknown[]>({
    handler: (ctx, { u }) =>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (ctx.db.query("users", "by_u") as any).eq("u", u).collect(),
  }),
  bump: mutation<{ u: number }, number>({
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
  }),
};

async function main() {
  const project = loadProject({ schema, modules: { hot, user } });
  const isBun = typeof (globalThis as { Bun?: unknown }).Bun !== "undefined";
  const runtime = await createEmbeddedRuntime({
    store: new SqliteDocStore(isBun ? new BunSqliteAdapter() : new NodeSqliteAdapter()),
    catalog: project.catalog,
    modules: project.moduleMap,
    tableNumbers: project.tableNumbers,
  });
  const server = await startDevServer(runtime, { port: 0, ip: "127.0.0.1" });
  process.stdout.write(JSON.stringify({ ready: true, port: server.port, pid: process.pid }) + "\n");
  // Stay alive until killed; exit cleanly on SIGTERM so the runner's teardown is quiet.
  process.on("SIGTERM", () => process.exit(0));
}

void main();
```

Create `benchmarks/runner/src/connections-worker.ts`:

```ts
/**
 * A swarm worker for `--axis connections`: holds a shard of N lightweight raw-ws connections,
 * each a REAL subscriber (one ModifyQuerySet; the server allocates real session/sub state), but
 * protocol-minimal on the client side (count-and-discard pushes; no reconcile work). Workers
 * exist so no single driver process needs the whole swarm's fds/memory. JSON-lines command
 * protocol on stdin/stdout — see the plan's Task 2 interface block.
 */
import { createInterface } from "node:readline";
import WebSocket from "ws";
import { subscribeFrame, classifyServerFrame, newCounters, type SwarmCounters } from "./cores/connections-frames";

interface Conn {
  ws: WebSocket;
  counters: SwarmCounters;
  queryArgs: unknown;
  gotFirst: boolean;
}

const QUERY_ID = 1;
let conns: Conn[] = [];
let url = "";
let distinct = false;
let offset = 0;

function openOne(i: number, resultHash?: string): Promise<Conn> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const counters = newCounters();
    const queryArgs = distinct ? { u: offset + i } : {};
    const conn: Conn = { ws, counters, queryArgs, gotFirst: false };
    const firstFrame = () => {
      if (!conn.gotFirst) {
        conn.gotFirst = true;
        resolve(conn);
      }
    };
    ws.on("open", () => ws.send(subscribeFrame(QUERY_ID, distinct ? "user:get" : "hot:get", queryArgs, resultHash)));
    ws.on("message", (data) => {
      classifyServerFrame(data.toString("utf8"), counters);
      if (counters.pushes + counters.unchanged > 0) firstFrame();
    });
    ws.on("error", (e) => reject(e));
  });
}

async function handle(cmd: Record<string, unknown>): Promise<Record<string, unknown>> {
  if (cmd.cmd === "connect") {
    url = String(cmd.url);
    distinct = Boolean(cmd.distinct);
    offset = Number(cmd.offset ?? 0);
    const n = Number(cmd.n);
    const t0 = Date.now();
    conns = await Promise.all(Array.from({ length: n }, (_, i) => openOne(i)));
    return { ok: "connect", connected: conns.length, rampMs: Date.now() - t0 };
  }
  if (cmd.cmd === "report") {
    let pushes = 0;
    let unchanged = 0;
    for (const c of conns) {
      pushes += c.counters.pushes;
      unchanged += c.counters.unchanged;
    }
    return { ok: "report", connected: conns.filter((c) => c.ws.readyState === WebSocket.OPEN).length, pushes, unchanged };
  }
  if (cmd.cmd === "kill-all") {
    for (const c of conns) c.ws.terminate();
    return { ok: "kill-all" };
  }
  if (cmd.cmd === "reconnect") {
    const spreadMs = Number(cmd.spreadMs ?? 2000);
    const t0 = Date.now();
    const old = conns;
    conns = await Promise.all(
      old.map(
        (prev, i) =>
          new Promise<Conn>((resolve) => {
            setTimeout(() => void openOne(i, prev.counters.lastHash).then(resolve), Math.random() * spreadMs);
          }),
      ),
    );
    let unchanged = 0;
    for (const c of conns) unchanged += c.counters.unchanged;
    return { ok: "reconnect", reconnected: conns.length, stormMs: Date.now() - t0, unchanged };
  }
  if (cmd.cmd === "exit") {
    for (const c of conns) c.ws.close();
    setTimeout(() => process.exit(0), 50);
    return { ok: "exit" };
  }
  return { error: `unknown cmd ${String(cmd.cmd)}` };
}

const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  let cmd: Record<string, unknown>;
  try {
    cmd = JSON.parse(line) as Record<string, unknown>;
  } catch {
    process.stdout.write(JSON.stringify({ error: "bad json" }) + "\n");
    return;
  }
  void handle(cmd)
    .then((r) => process.stdout.write(JSON.stringify(r) + "\n"))
    .catch((e: unknown) => process.stdout.write(JSON.stringify({ error: String(e) }) + "\n"));
});
```

- [ ] **Step 2: Write the child-process integration test**

Create `benchmarks/runner/test/connections-children.test.ts`:

```ts
/** Boots the real server entry + one real worker as CHILD processes and drives the worker's
 *  whole command protocol at small N — the integration seam Task 3's orchestrator relies on. */
import { describe, it, expect, afterAll } from "vitest";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { join } from "node:path";

const runnerDir = join(__dirname, "..");
const children: ChildProcessWithoutNullStreams[] = [];

function spawnBun(script: string): ChildProcessWithoutNullStreams {
  const child = spawn("bun", [join(runnerDir, "src", script)], { stdio: ["pipe", "pipe", "pipe"] });
  children.push(child);
  return child;
}

function nextLine(child: ChildProcessWithoutNullStreams): Promise<string> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: child.stdout });
    rl.once("line", (l) => {
      rl.close();
      resolve(l);
    });
  });
}

async function send(child: ChildProcessWithoutNullStreams, cmd: object): Promise<Record<string, unknown>> {
  const reply = nextLine(child);
  child.stdin.write(JSON.stringify(cmd) + "\n");
  return JSON.parse(await reply) as Record<string, unknown>;
}

afterAll(() => {
  for (const c of children) c.kill("SIGKILL");
});

describe("connections children (server entry + worker) at N=50", () => {
  it("connect → fan-out delivery → kill-all → reconnect with QueryUnchanged", async () => {
    const server = spawnBun("connections-server-entry.ts");
    const ready = JSON.parse(await nextLine(server)) as { ready: boolean; port: number; pid: number };
    expect(ready.ready).toBe(true);
    const url = `ws://127.0.0.1:${ready.port}/api/sync`;

    const worker = spawnBun("connections-worker.ts");
    const conn = await send(worker, { cmd: "connect", url, n: 50, offset: 0, distinct: false });
    expect(conn.connected).toBe(50);

    // Drive one write via the server's own HTTP run endpoint — every subscriber must see a push.
    const res = await fetch(`http://127.0.0.1:${ready.port}/api/run`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: "hot:bump", args: {} }),
    });
    expect(res.ok).toBe(true);
    await new Promise((r) => setTimeout(r, 500));

    const rep = await send(worker, { cmd: "report" });
    // Each conn saw the initial result + the bump push: pushes >= 2 * 50.
    expect(Number(rep.pushes)).toBeGreaterThanOrEqual(100);

    await send(worker, { cmd: "kill-all" });
    const re = await send(worker, { cmd: "reconnect", spreadMs: 300 });
    expect(re.reconnected).toBe(50);
    // Nothing changed while down → the resume path answers QueryUnchanged for (at least most of) the swarm.
    expect(Number(re.unchanged)).toBeGreaterThan(0);

    await send(worker, { cmd: "exit" });
  }, 60_000);
});
```

- [ ] **Step 3: Run it**

Run: `cd benchmarks/runner && bunx vitest run test/connections-children.test.ts`
Expected: PASS. Debug notes if not: (a) if `pushes` stays at 50 (initial results only), the hot:bump write didn't invalidate — check the fixture query/mutation touch the same table; (b) if `unchanged` is 0, the resubscribe isn't echoing `lastHash` — verify the initial QueryUpdated actually carried `hash` (it does for RERUN-classified queries per protocol.ts:115) and that `subscribeFrame` includes `resultHash`; a genuinely-diffable classification answering with a diff-reset instead is acceptable — in that case relax the assertion to `unchanged >= 0` and record the observed behavior in the report for the Task 3 storm metric to use `unchangedPct` as observed.

- [ ] **Step 4: Commit**

```bash
git add benchmarks/runner/src/connections-server-entry.ts benchmarks/runner/src/connections-worker.ts benchmarks/runner/test/connections-children.test.ts
git commit -m "feat(bench): connections-axis children — fixture server entry + swarm worker with storm resume"
```

---

### Task 3: The orchestrator core

**Files:**
- Create: `benchmarks/runner/src/cores/connections.ts`
- Test: `benchmarks/runner/test/connections-core-smoke.test.ts`

**Interfaces:**
- Consumes: Task 1 (`sampleProc`, `assertFdHeadroom`), Task 2's child protocols, `StackbaseClient`/`webSocketTransport` from `@stackbase/client`, `ws`.
- Produces: `runConnectionsCell(opts: ConnCellOpts): Promise<ConnCellResult>` with

```ts
export type ConnCell = "idle" | "hotpush" | "distinct" | "storm";
export interface ConnCellOpts { cell: ConnCell; n: number; workers: number; seconds: number; probes?: number }
export interface ConnCellResult { metrics: Record<string, number | null>; errors: number }
```

Metrics per cell (exact key names Task 4's scenario table relies on):
- idle: `rssPerConnKb`, `acceptPerSec`, `idleCpuPct`, `baselineRssKb`
- hotpush: `pushP50Ms`, `pushP99Ms`, `serverCpuPct`, `framesPerSec`, `deliveredPct`
- distinct: `rssPerConnKb`, `matcherP50Ms`, `matcherP99Ms`
- storm: `stormRecoverySec`, `unchangedPct`, `peakCpuPct`

- [ ] **Step 1: Implement the core**

Create `benchmarks/runner/src/cores/connections.ts`:

```ts
/**
 * Connections-axis orchestrator: spawns the server-under-test child + W swarm workers, ramps N
 * lightweight subscribers, runs one of the four cells, and reports metrics. The server's RSS/CPU
 * come from `ps` against the CHILD pid — the whole reason for the process split. Probes are full
 * StackbaseClients measuring what a real user feels at that N.
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface, type Interface } from "node:readline";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import WebSocket from "ws";
import { StackbaseClient, webSocketTransport, type ClientTransport } from "@stackbase/client";
import { sampleProc, assertFdHeadroom } from "./proc-stats";

export type ConnCell = "idle" | "hotpush" | "distinct" | "storm";
export interface ConnCellOpts { cell: ConnCell; n: number; workers: number; seconds: number; probes?: number }
export interface ConnCellResult { metrics: Record<string, number | null>; errors: number }

const SRC = join(__dirname, "..");

interface Child { proc: ChildProcessWithoutNullStreams; rl: Interface }

function spawnChild(script: string): Child {
  const proc = spawn("bun", [join(SRC, script)], { stdio: ["pipe", "pipe", "inherit"] });
  return { proc, rl: createInterface({ input: proc.stdout }) };
}

function nextLine(c: Child): Promise<string> {
  return new Promise((resolve) => c.rl.once("line", resolve));
}

async function send(c: Child, cmd: object): Promise<Record<string, unknown>> {
  const reply = nextLine(c);
  c.proc.stdin.write(JSON.stringify(cmd) + "\n");
  const parsed = JSON.parse(await reply) as Record<string, unknown>;
  if (parsed.error) throw new Error(`worker error: ${String(parsed.error)}`);
  return parsed;
}

function nodeWs(url: string): ClientTransport {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return webSocketTransport(url, { createWebSocket: (u) => new WebSocket(u) as unknown as any });
}

const pct = (sorted: number[], q: number) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]! : 0);

export async function runConnectionsCell(opts: ConnCellOpts): Promise<ConnCellResult> {
  const probesN = opts.probes ?? 10;
  assertFdHeadroom(opts.n + probesN);
  const errorsBox = { count: 0 };

  const server = spawnChild("connections-server-entry.ts");
  const workers: Child[] = [];
  const probes: StackbaseClient[] = [];
  try {
    const ready = JSON.parse(await nextLine(server)) as { port: number; pid: number };
    const wsUrl = `ws://127.0.0.1:${ready.port}/api/sync`;
    const baseline = sampleProc(ready.pid);

    // ---- probes: full clients on the hot query (distinct cell re-points probe 0 below) ----
    const probeValues: number[][] = [];
    for (let i = 0; i < probesN; i++) {
      const client = new StackbaseClient(nodeWs(wsUrl));
      probes.push(client);
      const seen: number[] = [];
      probeValues.push(seen);
      client.subscribe(opts.cell === "distinct" ? "user:get" : "hot:get", opts.cell === "distinct" ? { u: 0 } : {}, (v) => {
        const rows = v as Array<{ n: number }>;
        seen.push(rows[0]?.n ?? 0);
      });
    }

    // ---- ramp the swarm across W workers ----
    const per = Math.floor(opts.n / opts.workers);
    const rampT0 = performance.now();
    for (let w = 0; w < opts.workers; w++) workers.push(spawnChild("connections-worker.ts"));
    await Promise.all(
      workers.map((c, w) =>
        send(c, {
          cmd: "connect",
          url: wsUrl,
          n: w === opts.workers - 1 ? opts.n - per * (opts.workers - 1) : per,
          offset: w * per,
          distinct: opts.cell === "distinct",
        }),
      ),
    );
    const rampSec = (performance.now() - rampT0) / 1000;
    const atN = sampleProc(ready.pid);
    const rssPerConnKb = +((atN.rssKb - baseline.rssKb) / opts.n).toFixed(2);

    // ---- the cell ----
    if (opts.cell === "idle") {
      const samples: number[] = [];
      const end = performance.now() + opts.seconds * 1000;
      while (performance.now() < end) {
        await new Promise((r) => setTimeout(r, 500));
        samples.push(sampleProc(ready.pid).cpuPct);
      }
      const idleCpuPct = +(samples.reduce((a, b) => a + b, 0) / Math.max(1, samples.length)).toFixed(1);
      return { metrics: { rssPerConnKb, acceptPerSec: Math.round(opts.n / rampSec), idleCpuPct, baselineRssKb: baseline.rssKb }, errors: errorsBox.count };
    }

    if (opts.cell === "hotpush" || opts.cell === "distinct") {
      const writer = probes[0]!;
      const path = opts.cell === "hotpush" ? "hot:bump" : "user:bump";
      const args = opts.cell === "hotpush" ? {} : { u: 0 };
      const lat: number[] = [];
      const cpu: number[] = [];
      const writes = Math.max(5, opts.seconds * 5); // ~5 writes/sec
      const framesBefore = await totalPushes(workers);
      for (let i = 0; i < writes; i++) {
        const before = probeValues.map((s) => s.length);
        const t0 = performance.now();
        await writer.mutation(path, args);
        // latency = write() → EVERY probe observed the new value
        await waitFor(() => probeValues.every((s, p) => s.length > before[p]!), 10_000);
        lat.push(performance.now() - t0);
        cpu.push(sampleProc(ready.pid).cpuPct);
        await new Promise((r) => setTimeout(r, 200 - Math.min(150, performance.now() - t0)));
      }
      const sorted = [...lat].sort((a, b) => a - b);
      const framesAfter = await totalPushes(workers);
      const expected = opts.cell === "hotpush" ? writes * opts.n : writes; // distinct: only conn u=0's range
      const delivered = framesAfter - framesBefore;
      const metrics: Record<string, number | null> =
        opts.cell === "hotpush"
          ? {
              pushP50Ms: +pct(sorted, 0.5).toFixed(2),
              pushP99Ms: +pct(sorted, 0.99).toFixed(2),
              serverCpuPct: +(cpu.reduce((a, b) => a + b, 0) / Math.max(1, cpu.length)).toFixed(1),
              framesPerSec: Math.round(delivered / opts.seconds),
              deliveredPct: +((100 * delivered) / expected).toFixed(1),
            }
          : { rssPerConnKb, matcherP50Ms: +pct(sorted, 0.5).toFixed(2), matcherP99Ms: +pct(sorted, 0.99).toFixed(2) };
      return { metrics, errors: errorsBox.count };
    }

    // ---- storm ----
    await Promise.all(workers.map((c) => send(c, { cmd: "kill-all" })));
    await new Promise((r) => setTimeout(r, 500)); // let the server observe the disconnects
    const cpuPeak = { v: 0 };
    const cpuTimer = setInterval(() => {
      try {
        cpuPeak.v = Math.max(cpuPeak.v, sampleProc(ready.pid).cpuPct);
      } catch {
        /* server died — the reconnect await will surface it */
      }
    }, 250);
    const t0 = performance.now();
    const results = await Promise.all(workers.map((c) => send(c, { cmd: "reconnect", spreadMs: 2000 })));
    clearInterval(cpuTimer);
    const stormRecoverySec = +((performance.now() - t0) / 1000).toFixed(2);
    const unchanged = results.reduce((a, r) => a + Number(r.unchanged ?? 0), 0);
    return {
      metrics: { stormRecoverySec, unchangedPct: +((100 * unchanged) / opts.n).toFixed(1), peakCpuPct: +cpuPeak.v.toFixed(1) },
      errors: errorsBox.count,
    };
  } finally {
    for (const p of probes) p.close();
    for (const w of workers) {
      w.proc.stdin.write(JSON.stringify({ cmd: "exit" }) + "\n");
      setTimeout(() => w.proc.kill("SIGKILL"), 1000).unref();
    }
    server.proc.kill("SIGTERM");
    setTimeout(() => server.proc.kill("SIGKILL"), 1000).unref();
  }
}

async function totalPushes(workers: Child[]): Promise<number> {
  const reps = await Promise.all(workers.map((c) => send(c, { cmd: "report" })));
  return reps.reduce((a, r) => a + Number(r.pushes ?? 0), 0);
}

async function waitFor(cond: () => boolean, timeoutMs: number): Promise<void> {
  const start = performance.now();
  for (;;) {
    if (cond()) return;
    if (performance.now() - start > timeoutMs) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
}
```

- [ ] **Step 2: Write the smoke test (small N through the real processes)**

Create `benchmarks/runner/test/connections-core-smoke.test.ts`:

```ts
/** N=200 smoke of all four cells through the REAL orchestrator (real children, real sockets) —
 *  keeps the axis alive in CI without heavy runs. Numbers are not asserted for magnitude, only
 *  for presence and basic sanity (delivery happened, storm recovered). */
import { describe, it, expect } from "vitest";
import { runConnectionsCell } from "../src/cores/connections";

describe("connections core smoke (N=200, 2 workers)", () => {
  it("idle reports RSS/conn and accept rate", async () => {
    const r = await runConnectionsCell({ cell: "idle", n: 200, workers: 2, seconds: 2 });
    expect(r.metrics.rssPerConnKb).toBeGreaterThan(0);
    expect(r.metrics.acceptPerSec).toBeGreaterThan(0);
  }, 120_000);

  it("hotpush delivers to every subscriber and reports p50/p99", async () => {
    const r = await runConnectionsCell({ cell: "hotpush", n: 200, workers: 2, seconds: 2 });
    expect(r.metrics.pushP50Ms).toBeGreaterThan(0);
    expect(r.metrics.deliveredPct).toBeGreaterThan(90);
  }, 120_000);

  it("distinct reports matcher latency", async () => {
    const r = await runConnectionsCell({ cell: "distinct", n: 200, workers: 2, seconds: 2 });
    expect(r.metrics.matcherP50Ms).toBeGreaterThan(0);
  }, 120_000);

  it("storm recovers all connections", async () => {
    const r = await runConnectionsCell({ cell: "storm", n: 200, workers: 2, seconds: 2 });
    expect(r.metrics.stormRecoverySec).toBeGreaterThan(0);
    expect(r.metrics.stormRecoverySec).toBeLessThan(30);
  }, 120_000);
});
```

- [ ] **Step 3: Run it**

Run: `cd benchmarks/runner && bunx vitest run test/connections-core-smoke.test.ts`
Expected: 4 PASS (allow ~2-4 min total). Likely first-run issues and their causes: `deliveredPct` low → the report was read before pushes finished propagating (add a 500ms settle before the final `totalPushes`); probe latency waits timing out on `distinct` → probe 0 subscribes `user:get {u:0}` but no user row exists until the first `user:bump` — the first write CREATES the row, which is itself an invalidation, so this should work; if not, seed one `user:bump {u:0}` before the measured loop.

- [ ] **Step 4: Commit**

```bash
git add benchmarks/runner/src/cores/connections.ts benchmarks/runner/test/connections-core-smoke.test.ts
git commit -m "feat(bench): connections-axis orchestrator — four cells over child server + swarm workers"
```

---

### Task 4: Axis wiring — scenario, CLI, root script

**Files:**
- Create: `benchmarks/runner/src/scenarios/connections.ts`
- Modify: `benchmarks/runner/src/run.ts` (add `"connections"` to the `Axis` union at line 8; add the axis branch in `scenariosFor`; force a single sqlite pass for this axis)
- Modify: `benchmarks/runner/src/cli.ts` (usage line: `--axis reactive|writes|sharded|connections`)
- Modify: `package.json` (root): add `"bench:connections": "bun benchmarks/runner/src/cli.ts run --axis connections --store sqlite"`

**Interfaces:**
- Consumes: Task 3's `runConnectionsCell` + the `Scenario` type from `scenarios/reactive`.
- Produces: `connectionsScenarios(seconds: number): Scenario[]` — cells × N sweep; N list from `CONN_NS` env (comma list) defaulting to `[1000, 5000, 10000, 25000, 50000]`; workers from `CONN_WORKERS` defaulting to 4. Scenario names `conn-<cell>-n<k>` (e.g. `conn-hotpush-n5000`).

- [ ] **Step 1: Implement the scenario file**

Create `benchmarks/runner/src/scenarios/connections.ts`:

```ts
/**
 * Connections axis (`--axis connections`): a sync node's concurrent-WebSocket capacity. Cells per
 * the 2026-01-15 design spec: idle (RSS/conn + accept + heartbeat CPU), hotpush (fan-out push
 * latency at N — prices perf-backlog #9/#11 at connection scale), distinct (per-sub state +
 * matcher), storm (mass reconnect through the shipped resume machinery). The store handle is
 * unused: the server under test is a CHILD process over in-memory SQLite by design.
 */
import { runConnectionsCell, type ConnCell } from "../cores/connections";
import type { Scenario } from "./reactive";

const DEFAULT_NS = [1000, 5000, 10000, 25000, 50000];

function nsFromEnv(): number[] {
  const raw = process.env.CONN_NS;
  if (!raw) return DEFAULT_NS;
  return raw.split(",").map((s) => Number(s.trim())).filter((n) => Number.isFinite(n) && n > 0);
}

export function connectionsScenarios(seconds: number): Scenario[] {
  const workers = Number(process.env.CONN_WORKERS ?? 4);
  const cells: ConnCell[] = ["idle", "hotpush", "distinct", "storm"];
  const scenarios: Scenario[] = [];
  for (const n of nsFromEnv()) {
    for (const cell of cells) {
      scenarios.push({
        name: `conn-${cell}-n${n}`,
        axis: "connections",
        params: { cell, n, workers },
        run: async () => {
          const r = await runConnectionsCell({ cell, n, workers, seconds });
          return { metrics: r.metrics, errors: r.errors };
        },
      });
    }
  }
  return scenarios;
}
```

- [ ] **Step 2: Wire run.ts / cli.ts / package.json**

In `benchmarks/runner/src/run.ts`:
- Line 8: `type Axis = "reactive" | "writes" | "sharded" | "connections";`
- Import: `import { connectionsScenarios } from "./scenarios/connections";`
- In `scenariosFor`: add `if (axis === "connections") return connectionsScenarios(seconds);` (before the reactive default; the `store`/`prefix` params are unused by this axis).
- In `runVerb`: after `parseFlags`, add `if (flags.axis === "connections") flags.store = "sqlite";` (single pass; the handle is unused but the loop shape stays uniform).

In `benchmarks/runner/src/cli.ts`: update the usage string to `--axis reactive|writes|sharded|connections`.

In root `package.json` scripts (after `bench:sharded`): `"bench:connections": "bun benchmarks/runner/src/cli.ts run --axis connections --store sqlite",`

- [ ] **Step 3: Verify end-to-end at tiny N**

Run: `CONN_NS=200 CONN_WORKERS=2 bun run bench:connections -- --seconds 2`
Expected: four `sqlite/conn-*-n200` lines with metrics JSON, and a results file written under `benchmarks/results/`. Then `bun run typecheck` at repo root — clean.

- [ ] **Step 4: Commit**

```bash
git add benchmarks/runner/src/scenarios/connections.ts benchmarks/runner/src/run.ts benchmarks/runner/src/cli.ts package.json
git commit -m "feat(bench): register the connections axis — scenarios, CLI, bench:connections script"
```

---

### Task 5: Baseline run, findings doc, backlog update

**Files:**
- Create: `benchmarks/baselines/connections-baseline.json` (copied from a full run via `--save`)
- Create: `benchmarks/docs/connections-findings.md`
- Modify: `benchmarks/docs/performance-backlog.md` (re-score #9 result-sharing and #11 off-thread send against the measured hotpush numbers)

- [ ] **Step 1: Preflight fd limits, then full sweep**

```bash
ulimit -n           # if < 65536: ulimit -n 65536 (and note if the hard cap needed raising)
bun run bench:connections -- --seconds 5 --save benchmarks/baselines/connections-baseline.json
```

Expected: the full default sweep (4 cells × 5 Ns = 20 scenarios). This is a LONG run (~20-40 min with ramps). If the machine can't reach 50k (fd/port/memory), record the highest N that completed cleanly, set `CONN_NS` to the achievable sweep for the saved baseline, and DOCUMENT the cap + reason in the findings doc — an honest partial baseline beats a garbage full one.

- [ ] **Step 2: Write `benchmarks/docs/connections-findings.md`**

Structure (fill with the real numbers from Step 1 — this doc is the deliverable, so every number comes from the saved baseline JSON, no invented values):

```markdown
# Connections axis — findings (<date>, this machine)

Method: see docs/superpowers/specs/2026-01-15-connections-bench-axis-design.md.
Honesty boundaries (verbatim from the spec): localhost loopback (no WAN jitter/TLS);
swarm connections are protocol-minimal real subscribers; absolute numbers are
machine-specific — the shape is the signal; in-memory SQLite store by design.

## Headline
- <N_max> concurrent subscribed connections on one sync node at <rssPerConnKb> KB/connection
  (server RSS: <baseline> → <at N_max>).
- Accept rate: <acceptPerSec>/s. Idle CPU at N_max: <idleCpuPct>%.

## Hot-query fan-out (the #9/#11 pricing cell)
| N | push p50 | push p99 | server CPU | frames/s | delivered |
|---|---|---|---|---|---|
(rows from baseline JSON)
Verdict on #9 (identical-query result sharing): <indicted at N≥X / stays parked because ...>
Verdict on #11 (off-thread sends): <same form>

## Distinct queries (per-sub state + matcher)
| N | RSS/conn | matcher p50 | matcher p99 |
(rows)
Interval-matcher shape at N live subs: <flat / grew — vs the O(log N) expectation>

## Reconnect storm
| N | recovery (s) | QueryUnchanged % | peak CPU |
(rows)
The shipped resume machinery (fingerprints + DLR-3) under a full-swarm storm: <observations>

## Caps and reproduction
Reached N=<max>. <fd/port/memory caps hit, exact settings used: ulimit, CONN_WORKERS>
Repro: `bun run bench:connections -- --seconds 5` (sweep via CONN_NS).
```

- [ ] **Step 3: Update `benchmarks/docs/performance-backlog.md`**

Find the #9 (identical-query dedup / result sharing) and #11 (off-thread fan-out) entries and append a dated line each: `2026-01-15 connections-axis: <indicted at N≥…: hotpush p99 …ms, CPU …% / stays parked: …>` — the verdict text mirroring the findings doc.

- [ ] **Step 4: Full verification + commit**

```bash
bun run typecheck && bun run test    # repo-wide; the new runner tests ride the runner package's suite
git add benchmarks/baselines/connections-baseline.json benchmarks/docs/connections-findings.md benchmarks/docs/performance-backlog.md
git commit -m "feat(bench): connections baseline + findings — the measured per-node connection number"
```
