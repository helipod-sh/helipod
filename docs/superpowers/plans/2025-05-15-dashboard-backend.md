# Dashboard Backend (Admin API + Log Sink) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the privileged admin/system API and an execution-log sink that the dashboard SPA (Plan 2) consumes — fully unit-tested, with no UI.

**Architecture:** A new `packages/admin` exposes pure admin operations over the existing `EmbeddedRuntime` (`run`, `store.scan`/`count`) plus a new `LogSink` in `packages/executor`. The CLI mounts these at `/_admin/*` behind an admin-key middleware. The dashboard is purely a client of this API, so a multi-project control plane can later aggregate many deployments' admin APIs without changes here.

**Tech Stack:** TypeScript, pnpm workspaces, tsup, vitest. `node:crypto` for the admin key (works on Node + Bun). No new runtime dependencies.

## Global Constraints

- **Clean-room.** Study `.reference/convex-backend/npm-packages/system-udfs/convex/_system/frontend/*` for API shape only; never copy code. (FSL-licensed.)
- **Engine never learns the UI.** Admin logic lives in `packages/admin`; the engine packages expose only generic seams.
- **Value fidelity.** All document/JSON crossing the wire uses `convexToJson`/`jsonToConvex` from `@stackbase/values` (bigint/bytes-safe).
- **Strict TS:** `strict`, `noUncheckedIndexedAccess`, `verbatimModuleSyntax`. ESM only.
- **Each package stays single-purpose;** `packages/admin` depends on `@stackbase/runtime-embedded`, `@stackbase/executor`, `@stackbase/id-codec`, `@stackbase/values`, `@stackbase/errors` — never a DB driver.

---

### Task 1: Execution-log sink (`packages/executor`)

**Files:**
- Create: `packages/executor/src/log-sink.ts`
- Modify: `packages/executor/src/index.ts` (add `export * from "./log-sink";`)
- Test: `packages/executor/test/log-sink.test.ts`

**Interfaces:**
- Produces: `LogKind = "query"|"mutation"|"action"`; `ExecutionLogEntry = { id:number; path:string; kind:LogKind; ts:number; durationMs:number; status:"ok"|"error"; error?:string }`; `LogFilter = { since?:number; kind?:LogKind; status?:"ok"|"error"; limit?:number }`; `interface LogSink { push(e: Omit<ExecutionLogEntry,"id">): void; query(f?:LogFilter): ExecutionLogEntry[]; size(): number; clear(): void }`; `class InMemoryLogSink implements LogSink` (ring buffer, ctor `capacity=1000`); `class NoopLogSink implements LogSink`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/executor/test/log-sink.test.ts
import { describe, it, expect } from "vitest";
import { InMemoryLogSink, NoopLogSink } from "../src/log-sink";

describe("InMemoryLogSink", () => {
  it("assigns increasing ids and queries newest-first with filters", () => {
    const sink = new InMemoryLogSink();
    sink.push({ path: "messages:list", kind: "query", ts: 1, durationMs: 2, status: "ok" });
    sink.push({ path: "messages:send", kind: "mutation", ts: 3, durationMs: 4, status: "error", error: "boom" });

    const all = sink.query();
    expect(all.map((e) => e.id)).toEqual([2, 1]); // newest-first
    expect(sink.query({ status: "error" }).map((e) => e.path)).toEqual(["messages:send"]);
    expect(sink.query({ kind: "query" }).map((e) => e.path)).toEqual(["messages:list"]);
    expect(sink.query({ since: 1 }).map((e) => e.id)).toEqual([2]); // id > since
  });

  it("evicts oldest beyond capacity", () => {
    const sink = new InMemoryLogSink(2);
    for (let i = 0; i < 3; i++) sink.push({ path: "f", kind: "query", ts: i, durationMs: 0, status: "ok" });
    expect(sink.size()).toBe(2);
    expect(sink.query().map((e) => e.id)).toEqual([3, 2]); // id 1 evicted
  });

  it("NoopLogSink stores nothing", () => {
    const sink = new NoopLogSink();
    sink.push({ path: "f", kind: "query", ts: 0, durationMs: 0, status: "ok" });
    expect(sink.size()).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @stackbase/executor test log-sink`
Expected: FAIL — `Cannot find module '../src/log-sink'`.

- [ ] **Step 3: Write minimal implementation**

```ts
// packages/executor/src/log-sink.ts
export type LogKind = "query" | "mutation" | "action";

export interface ExecutionLogEntry {
  id: number;
  path: string;
  kind: LogKind;
  ts: number;        // wall-clock ms when the run started
  durationMs: number;
  status: "ok" | "error";
  error?: string;
}

export interface LogFilter {
  since?: number;    // only entries with id > since
  kind?: LogKind;
  status?: "ok" | "error";
  limit?: number;    // cap the result (after newest-first ordering)
}

export interface LogSink {
  push(entry: Omit<ExecutionLogEntry, "id">): void;
  query(filter?: LogFilter): ExecutionLogEntry[];
  size(): number;
  clear(): void;
}

/** Bounded ring buffer; ids strictly increase across the sink's lifetime. */
export class InMemoryLogSink implements LogSink {
  private readonly entries: ExecutionLogEntry[] = [];
  private nextId = 1;
  constructor(private readonly capacity: number = 1000) {}

  push(entry: Omit<ExecutionLogEntry, "id">): void {
    this.entries.push({ ...entry, id: this.nextId++ });
    if (this.entries.length > this.capacity) this.entries.shift();
  }

  query(filter: LogFilter = {}): ExecutionLogEntry[] {
    let out = this.entries;
    if (filter.since !== undefined) out = out.filter((e) => e.id > filter.since!);
    if (filter.kind !== undefined) out = out.filter((e) => e.kind === filter.kind);
    if (filter.status !== undefined) out = out.filter((e) => e.status === filter.status);
    out = [...out].reverse(); // newest-first
    return filter.limit !== undefined ? out.slice(0, filter.limit) : out;
  }

  size(): number {
    return this.entries.length;
  }
  clear(): void {
    this.entries.length = 0;
  }
}

export class NoopLogSink implements LogSink {
  push(): void {}
  query(): ExecutionLogEntry[] {
    return [];
  }
  size(): number {
    return 0;
  }
  clear(): void {}
}
```

Then add to `packages/executor/src/index.ts`:

```ts
export * from "./log-sink";
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @stackbase/executor test log-sink`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/executor/src/log-sink.ts packages/executor/src/index.ts packages/executor/test/log-sink.test.ts
git commit -m "feat(executor): add execution-log sink (InMemory + Noop)"
```

---

### Task 2: Emit a log entry per execution (`InlineUdfExecutor`)

**Files:**
- Modify: `packages/executor/src/executor.ts`
- Test: `packages/executor/test/executor-logging.test.ts`

**Interfaces:**
- Consumes: `LogSink` from Task 1.
- Produces: `ExecutorDeps` gains `logSink?: LogSink` and `now?: () => number`; `RunOptions` gains `path?: string`. After every `run()`, on success or error, one entry is pushed: `{ path: options.path ?? "<anonymous>", kind: fn.type, ts: <start>, durationMs: <end-start>, status, error? }`. Errors are still rethrown.

- [ ] **Step 1: Write the failing test**

```ts
// packages/executor/test/executor-logging.test.ts
import { describe, it, expect } from "vitest";
import { SqliteDocStore, NodeSqliteAdapter } from "@stackbase/docstore-sqlite";
import { MonotonicTimestampOracle } from "@stackbase/docstore";
import { SingleWriterTransactor } from "@stackbase/transactor";
import { QueryRuntime } from "@stackbase/query-engine";
import { InlineUdfExecutor, InMemoryLogSink, SimpleIndexCatalog, query } from "../src/index";

async function harness() {
  const store = new SqliteDocStore(new NodeSqliteAdapter());
  await store.setupSchema();
  const transactor = new SingleWriterTransactor(store, new MonotonicTimestampOracle());
  const queryRuntime = new QueryRuntime(store);
  const sink = new InMemoryLogSink();
  let clock = 100;
  const now = () => (clock += 5); // start=105, end=110 → duration 5
  const executor = new InlineUdfExecutor({ transactor, queryRuntime, catalog: new SimpleIndexCatalog(), logSink: sink, now });
  return { executor, sink };
}

describe("executor logging", () => {
  it("records an ok entry with the path, kind, and duration", async () => {
    const { executor, sink } = await harness();
    const ping = query(async () => 42);
    await executor.run(ping, {}, { path: "util:ping" });

    const [entry] = sink.query();
    expect(entry).toMatchObject({ path: "util:ping", kind: "query", status: "ok", durationMs: 5 });
  });

  it("records an error entry and rethrows", async () => {
    const { executor, sink } = await harness();
    const boom = query(async () => {
      throw new Error("kaboom");
    });
    await expect(executor.run(boom, {}, { path: "util:boom" })).rejects.toThrow("kaboom");
    expect(sink.query({ status: "error" })[0]).toMatchObject({ path: "util:boom", error: "kaboom" });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @stackbase/executor test executor-logging`
Expected: FAIL — `logSink`/`now` not accepted, or no entry recorded.

- [ ] **Step 3: Write minimal implementation**

In `packages/executor/src/executor.ts`, update imports and `ExecutorDeps`/`RunOptions`, and wrap `run`:

```ts
import type { LogKind, LogSink } from "./log-sink";

export interface ExecutorDeps {
  transactor: Transactor;
  queryRuntime: QueryRuntime;
  catalog: IndexCatalog;
  logSink?: LogSink;
  now?: () => number;
}

export interface RunOptions {
  /** Seed for the deterministic RNG (defaults to 0 so re-runs are reproducible). */
  seed?: number;
  /** Function path, recorded in the execution log. */
  path?: string;
}
```

Replace the body of `run` so it times and logs (keep the existing transaction logic inside `try`):

```ts
  async run<T = unknown>(fn: RegisteredFunction, args: unknown, options: RunOptions = {}): Promise<UdfResult<T>> {
    if (fn.type === "action" || fn.type === "httpAction") {
      throw new Error(`the inline executor does not yet run ${fn.type} functions (M5 scope)`);
    }
    const profile = profileFor(fn.type);
    const seed = options.seed ?? 0;
    const clock = this.deps.now ?? Date.now;
    const startedAt = clock();
    const logEntry = (status: "ok" | "error", error?: string): void => {
      this.deps.logSink?.push({
        path: options.path ?? "<anonymous>",
        kind: fn.type as LogKind,
        ts: startedAt,
        durationMs: clock() - startedAt,
        status,
        ...(error !== undefined ? { error } : {}),
      });
    };

    try {
      const commit = await this.deps.transactor.runInTransaction(async (txn) => {
        const kctx: KernelContext = {
          profile,
          txn,
          queryRuntime: this.deps.queryRuntime,
          catalog: this.deps.catalog,
          snapshotTs: txn.snapshotTs,
          random: createSeededRandom(seed),
          logs: [],
        };
        const channel = new InlineSyscallChannel(this.router, kctx);
        const db = fn.type === "query" ? new GuestDatabaseReader(channel) : new GuestDatabaseWriter(channel);
        const guestCtx = { db, random: () => kctx.random.next() };
        const value = await fn.handler(guestCtx, args);
        return { value: value as T, logs: kctx.logs, readRanges: txn.reads.toArray() };
      });
      logEntry("ok");
      return {
        value: commit.value.value,
        logs: commit.value.logs,
        committed: commit.committed,
        commitTs: commit.commitTs,
        readRanges: commit.value.readRanges,
        oplog: commit.oplog,
      };
    } catch (e) {
      logEntry("error", e instanceof Error ? e.message : String(e));
      throw e;
    }
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @stackbase/executor test executor-logging`
Expected: PASS (2 tests). Also run `pnpm --filter @stackbase/executor test` — existing 9 still pass.

- [ ] **Step 5: Commit**

```bash
git add packages/executor/src/executor.ts packages/executor/test/executor-logging.test.ts
git commit -m "feat(executor): emit an execution-log entry per run"
```

---

### Task 3: Thread the log sink through the runtime

**Files:**
- Modify: `packages/runtime-embedded/src/runtime.ts`
- Test: `packages/runtime-embedded/test/runtime-logging.test.ts`

**Interfaces:**
- Consumes: `LogSink`, executor `logSink`/`path` from Tasks 1–2.
- Produces: `EmbeddedRuntimeOptions` gains `logSink?: LogSink`; the runtime passes it to the executor and **records the path** on every `run`/sync execution. (So commits via WS, `runtime.run`, and the admin API all log.)

- [ ] **Step 1: Write the failing test**

```ts
// packages/runtime-embedded/test/runtime-logging.test.ts
import { describe, it, expect } from "vitest";
import { SqliteDocStore, NodeSqliteAdapter } from "@stackbase/docstore-sqlite";
import { InMemoryLogSink, SimpleIndexCatalog, query } from "@stackbase/executor";
import { EmbeddedRuntime } from "../src/index";

describe("runtime logging", () => {
  it("logs the function path for runtime.run()", async () => {
    const sink = new InMemoryLogSink();
    const runtime = await EmbeddedRuntime.create({
      store: new SqliteDocStore(new NodeSqliteAdapter()),
      catalog: new SimpleIndexCatalog(),
      modules: { "util:ping": query(async () => "pong") },
      logSink: sink,
    });
    await runtime.run("util:ping", {});
    expect(sink.query()[0]).toMatchObject({ path: "util:ping", kind: "query", status: "ok" });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @stackbase/runtime-embedded test runtime-logging`
Expected: FAIL — `logSink` not accepted / no path recorded.

- [ ] **Step 3: Write minimal implementation**

In `packages/runtime-embedded/src/runtime.ts`:

```ts
// 1. import the type
import { InlineUdfExecutor, type IndexCatalog, type LogSink, type RegisteredFunction, type UdfResult } from "@stackbase/executor";

// 2. add to EmbeddedRuntimeOptions
export interface EmbeddedRuntimeOptions {
  store: DocStore;
  catalog: IndexCatalog;
  modules: Record<string, RegisteredFunction>;
  fanoutAdapter?: EmbeddedWriteFanoutAdapter;
  originId?: string;
  logSink?: LogSink;
}

// 3. pass the sink to the executor in create()
const executor = new InlineUdfExecutor({ transactor, queryRuntime, catalog: options.catalog, logSink: options.logSink });

// 4. record the path in the syncExecutor closures and run()
//    syncExecutor.runQuery:
const r = await executor.run(resolve(path), jsonToConvex(args), { path });
//    syncExecutor.runMutation:
const r = await executor.run(resolve(path), jsonToConvex(args), { path });
```

And update `run()`:

```ts
  async run<T = unknown>(path: string, args: JSONValue): Promise<UdfResult<T>> {
    const fn = this.modules[path];
    if (!fn) throw new FunctionNotFoundError(`unknown function: ${path}`);
    return this.executor.run<T>(fn, jsonToConvex(args), { path });
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @stackbase/runtime-embedded test runtime-logging` → PASS.
Run: `pnpm --filter @stackbase/runtime-embedded test` → existing 4 still pass.

- [ ] **Step 5: Commit**

```bash
git add packages/runtime-embedded/src/runtime.ts packages/runtime-embedded/test/runtime-logging.test.ts
git commit -m "feat(runtime): accept a log sink and record function paths"
```

---

### Task 4: Scaffold `packages/admin` + admin-key auth

**Files:**
- Create: `packages/admin/package.json`, `packages/admin/tsconfig.json`, `packages/admin/tsup.config.ts`, `packages/admin/src/index.ts`
- Create: `packages/admin/src/auth.ts`
- Test: `packages/admin/test/auth.test.ts`

**Interfaces:**
- Produces: `generateAdminKey(): string` (32 url-safe bytes); `verifyAdminKey(expected: string, presented: string | undefined): boolean` (constant-time, false on undefined/length-mismatch).

- [ ] **Step 1: Scaffold the package**

`packages/admin/package.json` (copy the field shape from `packages/executor/package.json`; adjust name/deps):

```json
{
  "name": "@stackbase/admin",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "exports": { ".": { "types": "./dist/index.d.ts", "import": "./dist/index.js" } },
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "scripts": {
    "build": "tsup",
    "typecheck": "tsc --noEmit",
    "test": "vitest run"
  },
  "dependencies": {
    "@stackbase/errors": "workspace:*",
    "@stackbase/executor": "workspace:*",
    "@stackbase/id-codec": "workspace:*",
    "@stackbase/runtime-embedded": "workspace:*",
    "@stackbase/values": "workspace:*"
  },
  "devDependencies": {
    "@stackbase/docstore-sqlite": "workspace:*",
    "@types/node": "catalog:",
    "typescript": "catalog:",
    "vitest": "catalog:"
  }
}
```

`packages/admin/tsconfig.json` and `tsup.config.ts`: copy verbatim from `packages/executor/` (same compiler options + `tsup` ESM+dts config). `packages/admin/src/index.ts`:

```ts
export * from "./auth";
```

- [ ] **Step 2: Write the failing test**

```ts
// packages/admin/test/auth.test.ts
import { describe, it, expect } from "vitest";
import { generateAdminKey, verifyAdminKey } from "../src/auth";

describe("admin key", () => {
  it("generates distinct url-safe keys", () => {
    const a = generateAdminKey();
    const b = generateAdminKey();
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("verifies only the exact key (constant-time, undefined-safe)", () => {
    const key = generateAdminKey();
    expect(verifyAdminKey(key, key)).toBe(true);
    expect(verifyAdminKey(key, key + "x")).toBe(false);
    expect(verifyAdminKey(key, "nope")).toBe(false);
    expect(verifyAdminKey(key, undefined)).toBe(false);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm --filter @stackbase/admin test auth`
Expected: FAIL — module not found.

- [ ] **Step 4: Write minimal implementation**

```ts
// packages/admin/src/auth.ts
import { randomBytes, timingSafeEqual } from "node:crypto";

/** A fresh url-safe admin key (192 bits of entropy). */
export function generateAdminKey(): string {
  return randomBytes(24).toString("base64url");
}

/** Constant-time comparison; false for a missing or wrong-length key. */
export function verifyAdminKey(expected: string, presented: string | undefined): boolean {
  if (presented === undefined) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(presented);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
```

- [ ] **Step 5: Run test, then build, then commit**

Run: `pnpm --filter @stackbase/admin test auth` → PASS.
Run: `pnpm --filter @stackbase/admin build` → emits `dist/`.

```bash
git add packages/admin
git commit -m "feat(admin): scaffold package + constant-time admin-key auth"
```

---

### Task 5: `AdminApi` read methods (tables, data, functions, logs)

**Files:**
- Create: `packages/admin/src/admin-api.ts`
- Modify: `packages/admin/src/index.ts` (add `export * from "./admin-api";`)
- Test: `packages/admin/test/admin-api.test.ts`

**Interfaces:**
- Consumes: `EmbeddedRuntime` (`.store`, `.run`), `LogSink`, `encodeStorageTableId` from `@stackbase/id-codec`, `convexToJson` from `@stackbase/values`.
- Produces:
  ```ts
  interface AdminDeps { runtime: EmbeddedRuntime; schemaJson: SchemaJsonLike; tableNumbers: Record<string, number>; manifest: ManifestLike; logSink: LogSink }
  type SchemaJsonLike = { tables: Record<string, { indexes: { indexDescriptor: string }[]; shardKey?: string }> }
  type ManifestLike = { path: string; functions: { name: string; type: string }[] }[]
  class AdminApi {
    listTables(): Promise<{ name: string; indexes: string[]; shardKey?: string; documentCount: number }[]>
    getTableData(table: string, opts?: { page?: number; pageSize?: number; filter?: string }): Promise<{ documents: JSONValue[]; total: number; page: number; pageSize: number }>
    listFunctions(): { path: string; kind: string }[]
    queryLogs(filter?: LogFilter): ExecutionLogEntry[]
  }
  ```
  `filter` is `"field:value"` equality (string compare on the doc's own field); unknown table → throws `Error("unknown table: <t>")`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/admin/test/admin-api.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { SqliteDocStore, NodeSqliteAdapter } from "@stackbase/docstore-sqlite";
import { InMemoryLogSink, SimpleIndexCatalog, defineSchema, defineTable, v, mutation, query } from "@stackbase/executor";
import { EmbeddedRuntime } from "@stackbase/runtime-embedded";
import { AdminApi } from "../src/admin-api";

// NOTE: defineSchema/defineTable/v are re-exported by the executor for tests; if not, import from "@stackbase/values".

const schema = defineSchema({ notes: defineTable({ title: v.string(), done: v.boolean() }) });

async function makeApi() {
  const store = new SqliteDocStore(new NodeSqliteAdapter());
  const catalog = new SimpleIndexCatalog();
  catalog.addTable("notes", 10001);
  const logSink = new InMemoryLogSink();
  const runtime = await EmbeddedRuntime.create({
    store, catalog, logSink,
    modules: {
      "notes:add": mutation(async (ctx, a: { title: string; done: boolean }) => ctx.db.insert("notes", a)),
      "notes:list": query(async (ctx) => ctx.db.query("notes").collect()),
    },
  });
  const api = new AdminApi({
    runtime,
    schemaJson: schema.export() as never,
    tableNumbers: { notes: 10001 },
    manifest: [{ path: "notes", functions: [{ name: "add", type: "mutation" }, { name: "list", type: "query" }] }],
    logSink,
  });
  return { api, runtime };
}

describe("AdminApi", () => {
  it("lists tables with document counts", async () => {
    const { api, runtime } = await makeApi();
    await runtime.run("notes:add", { title: "a", done: false });
    const tables = await api.listTables();
    expect(tables).toEqual([{ name: "notes", indexes: [], shardKey: undefined, documentCount: 1 }]);
  });

  it("paginates and filters table data", async () => {
    const { api, runtime } = await makeApi();
    await runtime.run("notes:add", { title: "a", done: false });
    await runtime.run("notes:add", { title: "b", done: true });
    const page = await api.getTableData("notes", { pageSize: 10 });
    expect(page.total).toBe(2);
    const filtered = await api.getTableData("notes", { filter: "title:b" });
    expect(filtered.documents.map((d: any) => d.title)).toEqual(["b"]);
  });

  it("lists functions and reads the log", async () => {
    const { api, runtime } = await makeApi();
    await runtime.run("notes:list", {});
    expect(api.listFunctions()).toContainEqual({ path: "notes:list", kind: "query" });
    expect(api.queryLogs()[0]).toMatchObject({ path: "notes:list", status: "ok" });
  });

  it("throws on an unknown table", async () => {
    const { api } = await makeApi();
    await expect(api.getTableData("ghost")).rejects.toThrow("unknown table: ghost");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @stackbase/admin test admin-api`
Expected: FAIL — `../src/admin-api` not found.

- [ ] **Step 3: Write minimal implementation**

```ts
// packages/admin/src/admin-api.ts
import { encodeStorageTableId } from "@stackbase/id-codec";
import { convexToJson, type JSONValue, type Value } from "@stackbase/values";
import type { EmbeddedRuntime } from "@stackbase/runtime-embedded";
import type { ExecutionLogEntry, LogFilter, LogSink } from "@stackbase/executor";

export type SchemaJsonLike = {
  tables: Record<string, { indexes: { indexDescriptor: string }[]; shardKey?: string }>;
};
export type ManifestLike = { path: string; functions: { name: string; type: string }[] }[];

export interface AdminDeps {
  runtime: EmbeddedRuntime;
  schemaJson: SchemaJsonLike;
  tableNumbers: Record<string, number>;
  manifest: ManifestLike;
  logSink: LogSink;
}

export interface TableInfo {
  name: string;
  indexes: string[];
  shardKey?: string;
  documentCount: number;
}
export interface TableDataPage {
  documents: JSONValue[];
  total: number;
  page: number;
  pageSize: number;
}

export class AdminApi {
  constructor(private readonly deps: AdminDeps) {}

  private tableId(table: string): string {
    const n = this.deps.tableNumbers[table];
    if (n === undefined) throw new Error(`unknown table: ${table}`);
    return encodeStorageTableId(n);
  }

  async listTables(): Promise<TableInfo[]> {
    const out: TableInfo[] = [];
    for (const [name, def] of Object.entries(this.deps.schemaJson.tables)) {
      out.push({
        name,
        indexes: def.indexes.map((i) => i.indexDescriptor),
        shardKey: def.shardKey,
        documentCount: await this.deps.runtime.store.count(this.tableId(name)),
      });
    }
    return out;
  }

  async getTableData(
    table: string,
    opts: { page?: number; pageSize?: number; filter?: string } = {},
  ): Promise<TableDataPage> {
    const tableId = this.tableId(table);
    const page = opts.page ?? 0;
    const pageSize = opts.pageSize ?? 50;
    const docs = (await this.deps.runtime.store.scan(tableId)).map((d) => d.value.value as Record<string, Value>);

    let rows = docs;
    if (opts.filter && opts.filter.includes(":")) {
      const idx = opts.filter.indexOf(":");
      const field = opts.filter.slice(0, idx);
      const want = opts.filter.slice(idx + 1);
      rows = rows.filter((d) => String(d[field] ?? "") === want);
    }

    const total = rows.length;
    const start = page * pageSize;
    const documents = rows.slice(start, start + pageSize).map((d) => convexToJson(d));
    return { documents, total, page, pageSize };
  }

  listFunctions(): { path: string; kind: string }[] {
    return this.deps.manifest.flatMap((m) =>
      m.functions.map((f) => ({ path: `${m.path}:${f.name}`, kind: f.type })),
    );
  }

  queryLogs(filter?: LogFilter): ExecutionLogEntry[] {
    return this.deps.logSink.query(filter);
  }
}
```

Add to `packages/admin/src/index.ts`: `export * from "./admin-api";`

> If `defineSchema`/`defineTable`/`v`/`mutation`/`query` are not re-exported from `@stackbase/executor`, import `defineSchema`/`defineTable`/`v` from `@stackbase/values` and `mutation`/`query` from `@stackbase/executor` in the test — check `packages/executor/src/index.ts` first and use whichever path exists.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @stackbase/admin test admin-api`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/admin/src/admin-api.ts packages/admin/src/index.ts packages/admin/test/admin-api.test.ts
git commit -m "feat(admin): AdminApi read methods (tables, data, functions, logs)"
```

---

### Task 6: Write operations — `runFunction` + system patch/delete mutations

**Files:**
- Create: `packages/admin/src/system-functions.ts`
- Modify: `packages/admin/src/admin-api.ts` (add `runFunction`, `patchDocument`, `deleteDocument`)
- Modify: `packages/admin/src/index.ts`
- Test: `packages/admin/test/admin-write.test.ts`

**Interfaces:**
- Produces: `systemModules(): Record<string, RegisteredFunction>` returning `{ "_system:patchDocument": <mutation>, "_system:deleteDocument": <mutation> }`. `AdminApi.runFunction(path, args): Promise<{ value: JSONValue; committed: boolean }>`; `AdminApi.patchDocument(id, fields): Promise<JSONValue>`; `AdminApi.deleteDocument(id): Promise<void>`. The CLI must merge `systemModules()` into the runtime's module map (Task 8).

- [ ] **Step 1: Write the failing test**

```ts
// packages/admin/test/admin-write.test.ts
import { describe, it, expect } from "vitest";
import { SqliteDocStore, NodeSqliteAdapter } from "@stackbase/docstore-sqlite";
import { InMemoryLogSink, SimpleIndexCatalog, defineSchema, defineTable, v, mutation, query } from "@stackbase/executor";
import { EmbeddedRuntime } from "@stackbase/runtime-embedded";
import { AdminApi } from "../src/admin-api";
import { systemModules } from "../src/system-functions";

const schema = defineSchema({ notes: defineTable({ title: v.string() }) });

async function makeApi() {
  const store = new SqliteDocStore(new NodeSqliteAdapter());
  const catalog = new SimpleIndexCatalog();
  catalog.addTable("notes", 10001);
  const logSink = new InMemoryLogSink();
  const runtime = await EmbeddedRuntime.create({
    store, catalog, logSink,
    modules: {
      "notes:add": mutation(async (ctx, a: { title: string }) => ctx.db.insert("notes", a)),
      "notes:list": query(async (ctx) => ctx.db.query("notes").collect()),
      ...systemModules(),
    },
  });
  const api = new AdminApi({ runtime, schemaJson: schema.export() as never, tableNumbers: { notes: 10001 }, manifest: [], logSink });
  return { api, runtime };
}

describe("AdminApi writes", () => {
  it("runs a function and reports the result", async () => {
    const { api } = await makeApi();
    const r = await api.runFunction("notes:add", { title: "x" });
    expect(typeof r.value).toBe("string"); // the new doc id
    expect(r.committed).toBe(true);
  });

  it("patches and deletes a document", async () => {
    const { api, runtime } = await makeApi();
    const id = (await runtime.run<string>("notes:add", { title: "orig" })).value;

    const patched = await api.patchDocument(id, { title: "edited" });
    expect((patched as any).title).toBe("edited");

    await api.deleteDocument(id);
    const left = await runtime.run<unknown[]>("notes:list", {});
    expect(left.value).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @stackbase/admin test admin-write`
Expected: FAIL — `systemModules`/`runFunction`/`patchDocument` missing.

- [ ] **Step 3: Write minimal implementation**

```ts
// packages/admin/src/system-functions.ts
import { mutation, type RegisteredFunction } from "@stackbase/executor";
import { DocumentNotFoundError } from "@stackbase/errors";

/** Built-in privileged mutations the admin API invokes by id. Registered under `_system:*`. */
export function systemModules(): Record<string, RegisteredFunction> {
  return {
    "_system:patchDocument": mutation(async (ctx, args: { id: string; fields: Record<string, unknown> }) => {
      const existing = await ctx.db.get(args.id);
      if (!existing) throw new DocumentNotFoundError(`cannot patch missing document ${args.id}`);
      await ctx.db.replace(args.id, { ...existing, ...args.fields });
      return await ctx.db.get(args.id);
    }),
    "_system:deleteDocument": mutation(async (ctx, args: { id: string }) => {
      await ctx.db.delete(args.id);
      return null;
    }),
  };
}
```

Add to `packages/admin/src/admin-api.ts`:

```ts
  async runFunction(path: string, args: JSONValue): Promise<{ value: JSONValue; committed: boolean }> {
    const r = await this.deps.runtime.run(path, args);
    return { value: convexToJson(r.value as Value), committed: r.committed };
  }

  async patchDocument(id: string, fields: Record<string, JSONValue>): Promise<JSONValue> {
    const r = await this.deps.runtime.run("_system:patchDocument", { id, fields });
    return convexToJson(r.value as Value);
  }

  async deleteDocument(id: string): Promise<void> {
    await this.deps.runtime.run("_system:deleteDocument", { id });
  }
```

Add to `packages/admin/src/index.ts`: `export * from "./system-functions";`

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @stackbase/admin test admin-write` → PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/admin/src/system-functions.ts packages/admin/src/admin-api.ts packages/admin/src/index.ts packages/admin/test/admin-write.test.ts
git commit -m "feat(admin): runFunction + system patch/delete mutations"
```

---

### Task 7: Admin HTTP router (auth + routing, pure)

**Files:**
- Create: `packages/admin/src/router.ts`
- Modify: `packages/admin/src/index.ts`
- Test: `packages/admin/test/router.test.ts`

**Interfaces:**
- Consumes: `AdminApi` (Task 5–6), `verifyAdminKey` (Task 4).
- Produces: `interface AdminRequest { method: string; path: string; query: Record<string,string>; body?: string; authorization?: string }`; `interface AdminResponse { status: number; body: JSONValue }`; `handleAdminRequest(api: AdminApi, adminKey: string, req: AdminRequest): Promise<AdminResponse>`. Routes (all under `/_admin`): `GET /_admin/tables`, `GET /_admin/tables/:t/data`, `GET /_admin/functions`, `POST /_admin/run`, `GET /_admin/logs`, `PATCH /_admin/tables/:t/docs/:id`, `DELETE /_admin/tables/:t/docs/:id`. Missing/bad key → `401`. Unknown route → `404`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/admin/test/router.test.ts
import { describe, it, expect } from "vitest";
import { handleAdminRequest } from "../src/router";

// Minimal fake AdminApi — the router only forwards to these methods.
const api: any = {
  listTables: async () => [{ name: "notes", indexes: [], documentCount: 0 }],
  getTableData: async (_t: string, o: any) => ({ documents: [], total: 0, page: o.page ?? 0, pageSize: o.pageSize ?? 50 }),
  listFunctions: () => [{ path: "notes:list", kind: "query" }],
  queryLogs: () => [],
  runFunction: async () => ({ value: 1, committed: true }),
  patchDocument: async (_id: string, f: any) => ({ ...f, _id }),
  deleteDocument: async () => undefined,
};
const KEY = "secret";
const auth = { authorization: `Bearer ${KEY}` };

describe("handleAdminRequest", () => {
  it("rejects missing/wrong key with 401", async () => {
    const r = await handleAdminRequest(api, KEY, { method: "GET", path: "/_admin/tables", query: {} });
    expect(r.status).toBe(401);
  });

  it("routes tables, data, functions, run, logs", async () => {
    expect((await handleAdminRequest(api, KEY, { method: "GET", path: "/_admin/tables", query: {}, ...auth })).status).toBe(200);
    expect((await handleAdminRequest(api, KEY, { method: "GET", path: "/_admin/tables/notes/data", query: { pageSize: "10" }, ...auth })).status).toBe(200);
    expect((await handleAdminRequest(api, KEY, { method: "POST", path: "/_admin/run", query: {}, body: JSON.stringify({ path: "notes:list", args: {} }), ...auth })).status).toBe(200);
    const logs = await handleAdminRequest(api, KEY, { method: "GET", path: "/_admin/logs", query: {}, ...auth });
    expect(logs.status).toBe(200);
  });

  it("404s an unknown admin route", async () => {
    const r = await handleAdminRequest(api, KEY, { method: "GET", path: "/_admin/nope", query: {}, ...auth });
    expect(r.status).toBe(404);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @stackbase/admin test router`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```ts
// packages/admin/src/router.ts
import type { JSONValue } from "@stackbase/values";
import { verifyAdminKey } from "./auth";
import type { AdminApi } from "./admin-api";

export interface AdminRequest {
  method: string;
  path: string;
  query: Record<string, string>;
  body?: string;
  authorization?: string;
}
export interface AdminResponse {
  status: number;
  body: JSONValue;
}

function bearer(authorization?: string): string | undefined {
  if (!authorization) return undefined;
  const m = /^Bearer (.+)$/.exec(authorization);
  return m ? m[1] : undefined;
}

export async function handleAdminRequest(api: AdminApi, adminKey: string, req: AdminRequest): Promise<AdminResponse> {
  if (!verifyAdminKey(adminKey, bearer(req.authorization))) {
    return { status: 401, body: { error: "unauthorized" } };
  }
  const parts = req.path.split("/").filter(Boolean); // ["_admin", ...]
  const seg = parts.slice(1); // drop "_admin"

  try {
    if (req.method === "GET" && seg.length === 1 && seg[0] === "tables") {
      return { status: 200, body: (await api.listTables()) as unknown as JSONValue };
    }
    if (req.method === "GET" && seg.length === 3 && seg[0] === "tables" && seg[2] === "data") {
      const page = req.query.page ? Number(req.query.page) : undefined;
      const pageSize = req.query.pageSize ? Number(req.query.pageSize) : undefined;
      const data = await api.getTableData(seg[1]!, { page, pageSize, filter: req.query.filter });
      return { status: 200, body: data as unknown as JSONValue };
    }
    if (req.method === "GET" && seg.length === 1 && seg[0] === "functions") {
      return { status: 200, body: api.listFunctions() as unknown as JSONValue };
    }
    if (req.method === "POST" && seg.length === 1 && seg[0] === "run") {
      const { path, args } = JSON.parse(req.body ?? "{}") as { path?: string; args?: JSONValue };
      if (!path) return { status: 400, body: { error: "missing path" } };
      return { status: 200, body: (await api.runFunction(path, args ?? {})) as unknown as JSONValue };
    }
    if (req.method === "GET" && seg.length === 1 && seg[0] === "logs") {
      const since = req.query.since ? Number(req.query.since) : undefined;
      return { status: 200, body: api.queryLogs({ since }) as unknown as JSONValue };
    }
    if (req.method === "PATCH" && seg.length === 4 && seg[0] === "tables" && seg[2] === "docs") {
      const fields = JSON.parse(req.body ?? "{}") as Record<string, JSONValue>;
      return { status: 200, body: await api.patchDocument(seg[3]!, fields) };
    }
    if (req.method === "DELETE" && seg.length === 4 && seg[0] === "tables" && seg[2] === "docs") {
      await api.deleteDocument(seg[3]!);
      return { status: 200, body: { ok: true } };
    }
    return { status: 404, body: { error: "not found" } };
  } catch (e) {
    return { status: 400, body: { error: e instanceof Error ? e.message : String(e) } };
  }
}
```

Add to `packages/admin/src/index.ts`: `export * from "./router";`

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @stackbase/admin test router` → PASS (3 tests). Then `pnpm --filter @stackbase/admin test` → all admin tests pass; `pnpm --filter @stackbase/admin build` → green.

- [ ] **Step 5: Commit**

```bash
git add packages/admin/src/router.ts packages/admin/src/index.ts packages/admin/test/router.test.ts
git commit -m "feat(admin): admin HTTP router with admin-key auth"
```

---

### Task 8: Wire the admin API + log sink into the CLI dev server

**Files:**
- Modify: `packages/cli/package.json` (add `"@stackbase/admin": "workspace:*"`)
- Modify: `packages/cli/src/http-handler.ts` (accept an optional admin context; route `/_admin/*`)
- Modify: `packages/cli/src/cli.ts` (create the log sink + admin key, merge `systemModules()`, build the `AdminApi`, print the key)
- Modify: `packages/cli/src/server.ts` (pass `authorization` header + query into the admin route on both backends)
- Test: `packages/cli/test/admin-routes.test.ts`

**Interfaces:**
- Consumes: `AdminApi`, `handleAdminRequest`, `generateAdminKey`, `systemModules` from `@stackbase/admin`; `InMemoryLogSink` from `@stackbase/executor`.
- Produces: `handleHttpRequest(runtime, req, info, admin?)` where `admin = { api: AdminApi; key: string }`; when `req.path` starts with `/_admin/`, it delegates to `handleAdminRequest`. `req: HttpRequest` gains `query?: Record<string,string>` and `authorization?: string`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/cli/test/admin-routes.test.ts
import { describe, it, expect } from "vitest";
import { SqliteDocStore, NodeSqliteAdapter } from "@stackbase/docstore-sqlite";
import { InMemoryLogSink, SimpleIndexCatalog, defineSchema, defineTable, v, mutation } from "@stackbase/executor";
import { EmbeddedRuntime } from "@stackbase/runtime-embedded";
import { AdminApi, systemModules } from "@stackbase/admin";
import { handleHttpRequest } from "../src/http-handler";

const schema = defineSchema({ notes: defineTable({ title: v.string() }) });

async function setup() {
  const store = new SqliteDocStore(new NodeSqliteAdapter());
  const catalog = new SimpleIndexCatalog();
  catalog.addTable("notes", 10001);
  const logSink = new InMemoryLogSink();
  const runtime = await EmbeddedRuntime.create({
    store, catalog, logSink,
    modules: { "notes:add": mutation(async (ctx, a: { title: string }) => ctx.db.insert("notes", a)), ...systemModules() },
  });
  const api = new AdminApi({ runtime, schemaJson: schema.export() as never, tableNumbers: { notes: 10001 }, manifest: [], logSink });
  return { runtime, admin: { api, key: "k" } };
}
const info = { functions: [], tables: ["notes"] };

describe("admin routes via handleHttpRequest", () => {
  it("401 without the key, 200 with it", async () => {
    const { runtime, admin } = await setup();
    const noKey = await handleHttpRequest(runtime, { method: "GET", path: "/_admin/tables" }, info, admin);
    expect(noKey.status).toBe(401);
    const ok = await handleHttpRequest(runtime, { method: "GET", path: "/_admin/tables", authorization: "Bearer k" }, info, admin);
    expect(ok.status).toBe(200);
    expect(JSON.parse(ok.body)[0].name).toBe("notes");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @stackbase/cli test admin-routes`
Expected: FAIL — `handleHttpRequest` ignores `/_admin` / has no `admin` param.

- [ ] **Step 3: Write minimal implementation**

In `packages/cli/src/http-handler.ts` add the import, extend `HttpRequest`, and delegate:

```ts
import { handleAdminRequest, type AdminApi } from "@stackbase/admin";

export interface HttpRequest {
  method: string;
  path: string;
  body?: string;
  query?: Record<string, string>;
  authorization?: string;
}

// new optional 4th param on handleHttpRequest:
export async function handleHttpRequest(
  runtime: EmbeddedRuntime,
  req: HttpRequest,
  info: ServerInfo,
  admin?: { api: AdminApi; key: string },
): Promise<HttpResponse> {
  if (admin && req.path.startsWith("/_admin/")) {
    const res = await handleAdminRequest(admin.api, admin.key, {
      method: req.method,
      path: req.path,
      query: req.query ?? {},
      body: req.body,
      authorization: req.authorization,
    });
    return json(res.status, res.body);
  }
  // ...existing routes unchanged...
}
```

In `packages/cli/src/cli.ts` (the `dev` command, where the runtime is created from `loadProject` artifacts), create the sink/key, merge system modules, build the API, and thread it through. Add:

```ts
import { InMemoryLogSink } from "@stackbase/executor";
import { AdminApi, generateAdminKey, systemModules } from "@stackbase/admin";

// when building the runtime:
const logSink = new InMemoryLogSink();
const adminKey = process.env.STACKBASE_ADMIN_KEY ?? generateAdminKey();
const runtime = await EmbeddedRuntime.create({
  store, catalog: project.catalog, logSink,
  modules: { ...project.moduleMap, ...systemModules() },
});
const adminApi = new AdminApi({
  runtime,
  schemaJson: project.schemaJson,
  tableNumbers: project.tableNumbers,
  manifest: project.manifest,
  logSink,
});
// pass `{ api: adminApi, key: adminKey }` into startDevServer/handleHttpRequest, and:
process.stdout.write(`admin key → ${adminKey}\n`);
```

In `packages/cli/src/server.ts`, both backends must pass the header + parsed query to `handleHttpRequest`. Node backend: read `req.headers.authorization` and parse `url.searchParams`; Bun backend: `req.headers.get("authorization")` and `url.searchParams`. Thread `admin` (from `startDevServer` options) into each `handleHttpRequest(runtime, {…, query, authorization}, info, admin)` call. Add `admin?: { api: AdminApi; key: string }` to `DevServerOptions`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @stackbase/cli test admin-routes` → PASS.
Run: `pnpm build && pnpm typecheck && pnpm test` → all packages green.

- [ ] **Step 5: Commit**

```bash
git add packages/cli docs
git commit -m "feat(cli): mount the admin API at /_admin behind an admin key"
```

---

## Self-Review

**Spec coverage (against `2025-05-15-dashboard-design.md`):**
- §3.1 admin endpoints — tables (T5), table data + filter/page (T5), functions (T5), run (T6), logs (T5), patch/delete (T6), routing (T7), CLI mount (T8). ✅ (create-document is deferred to Plan 2's data-browser "new row" task — noted below.)
- §3.2 log sink — T1; executor emit — T2; runtime threading — T3. ✅
- §3.3 admin-key boundary — T4 (key) + T7 (401) + T8 (`STACKBASE_ADMIN_KEY` / auto-gen + print). ✅
- §6 testing — every task is vitest-TDD. ✅
- §3.4/§4/§5/§7 (SPA, live bridge, multi-project shell) — **Plan 2** (frontend); out of scope here by design.

**Deferred to Plan 2 (frontend), called out so it isn't lost:** `POST /_admin/tables/:t/docs` (create document) — trivially added as a `_system:insertDocument` mutation when the data browser grows an "add row" affordance; not needed for read+run+edit+delete.

**Placeholder scan:** none — every step has runnable code/commands. The one conditional note (Task 5 re-export path for `defineSchema`/`v`) instructs the implementer to check `packages/executor/src/index.ts` and pick the existing import path; both alternatives are spelled out.

**Type consistency:** `LogSink`/`ExecutionLogEntry`/`LogFilter` (T1) are consumed unchanged in T2/T3/T5/T7; `AdminApi` method signatures in the T5/T6 Interfaces match their calls in T7's router and T8's CLI wiring; `AdminDeps.schemaJson` shape (`SchemaJsonLike`) matches `project.schemaJson` usage in T8.
