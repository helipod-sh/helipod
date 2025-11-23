# fsOutbox — Filesystem OutboxStorage Adapter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Durable offline mutation queues for non-browser clients (CLI, Electron/Tauri sidecar hosts) via a JSONL-journal filesystem implementation of the existing `OutboxStorage` seam, shipped as the `@stackbase/client/outbox-fs` subpath export.

**Architecture:** One append-only `journal.jsonl` per queue dir; every seam mutation is one appended JSON line through a serialized write-behind appender (same-microtask ops batch into one write + fsync); hydrate replays the journal (torn tail physically truncated, corrupt middle lines quarantined); compaction rewrites state tmp→fsync→rename at open and past 4096 ops; an `O_EXCL` pid lockfile enforces one writer per dir with probe-and-fallback to `memoryOutbox()` (mirroring `indexedDBOutbox()`'s degradation shape exactly).

**Tech Stack:** TypeScript, `node:fs/promises` + `node:path` (no new dependencies), vitest under Node, tsup.

**Spec:** `docs/superpowers/specs/2025-11-04-fs-outbox-adapter-design.md` (approved). Where this plan and the spec differ, the spec governs.

## Global Constraints

- No new package dependencies. `node:fs`/`node:fs/promises`/`node:path` imports live ONLY in `packages/client/src/outbox-fs.ts` — the `.` and `./react` bundles stay browser-clean.
- `fsync` defaults to **true**; `append()`'s returned promise resolves only after write + fsync (park-eligibility durability proof). The caller never awaits it before the wire send — that's the seam's existing contract, unchanged.
- Journal line shapes verbatim from the spec: `{"op":"append","entry":…}`, `{"op":"status","clientId","seq","status","error"?}`, `{"op":"dequeue","clientId","seq"}`, `{"op":"meta","clientId","meta"}`, `{"op":"metaDelete","clientId"}`.
- Compaction threshold: **4096** journal ops.
- Lock steal rules verbatim: dead pid (`ESRCH`), unreadable/garbage lockfile, or own-pid-not-in-registry → steal (unlink + one retry); live foreign pid or same-process registry hit → fallback + `onFallback` fired once.
- `close?(): Promise<void>` is a new OPTIONAL seam method; all callers use `?.`.
- Tests run under Node (vitest) — no Bun APIs. In-package tests import `src/` relatively; the cli E2E resolves `@stackbase/client` via built dist (run `bun run build` first).
- The E2E filename MUST end `-e2e.test.ts` (the cli package's two-phase test script runs `*-e2e` files in phase 2).
- Branch: `git checkout -b fs-outbox main` before Task 1.
- Every commit ends with:
  `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`
  `Claude-Session: https://claude.ai/code/session_015RKShEWjRcmbQVJ8ooUPP6`

## File Map

| File | Role |
|---|---|
| `packages/client/src/outbox-storage.ts` | seam: add optional `close?()`; memory impl gains no-op close; `indexedDBOutbox()` wrapper forwards close |
| `packages/client/src/outbox-idb.ts` | `IndexedDBOutboxStorage.close()` (flush + `db.close()`) |
| `packages/client/src/outbox-fs.ts` | NEW — the whole fs adapter (journal, replay, compaction, lock, fallback) |
| `packages/client/test/outbox-contract.ts` | NEW — shared `runOutboxStorageContract` suite + `makeEntry` fixture |
| `packages/client/test/outbox-storage.test.ts` | memory runs the contract; memory-only describes stay |
| `packages/client/test/outbox-idb.test.ts` | IDB runs the contract; schema/batching/persist describes stay |
| `packages/client/test/outbox-fs.test.ts` | NEW — fs contract run + fs-specific tests |
| `packages/client/tsup.config.ts` + `package.json` | new entry + `./outbox-fs` subpath export |
| `packages/cli/test/outbox-fs-e2e.test.ts` | NEW — process-restart drain E2E through a real server |
| `docs/enduser/offline.md`, `CLAUDE.md` | docs |

---

### Task 1: `close()` on the seam + the shared storage contract suite

**Files:**
- Modify: `packages/client/src/outbox-storage.ts` (interface ~:117, memory impl ~:199, wrapper ~:247)
- Modify: `packages/client/src/outbox-idb.ts` (class `IndexedDBOutboxStorage`, ~:104)
- Create: `packages/client/test/outbox-contract.ts`
- Modify: `packages/client/test/outbox-storage.test.ts`, `packages/client/test/outbox-idb.test.ts`

**Interfaces:**
- Consumes: existing `OutboxStorage`, `OutboxEntry`, `memoryOutbox`, `indexedDBOutbox`, `mintIdentity`, `OUTBOX_VERSION` (all `src/outbox-storage.ts`), `dropStaleVersion` (`src/outbox-idb.ts`).
- Produces: `OutboxStorage.close?(): Promise<void>`; `runOutboxStorageContract(name: string, factory: () => Promise<{ storage: OutboxStorage; cleanup?: () => Promise<void> }>): void` and `makeEntry(overrides?: Partial<OutboxEntry>): OutboxEntry` from `test/outbox-contract.ts`. Tasks 2–4 rely on these exact names.

- [ ] **Step 1: Read the two source test files** — `packages/client/test/outbox-storage.test.ts` (the memory CRUD describes, ~:26-111) and `packages/client/test/outbox-idb.test.ts` (`makeEntry` :12, the "CRUD + hydrate" describe ~:76-134). The contract suite's assertions come from these, not from scratch.

- [ ] **Step 2: Add `close?()` to the seam** in `packages/client/src/outbox-storage.ts`, after `persist()` in the interface (~:117):

```ts
  /** OPTIONAL: flush pending writes and release any backing resources (fs lock, IDB handle).
   *  Additive like `listMetaClientIds` — callers guard with `?.`. Nothing in the client core
   *  calls it; it exists for host shutdown/relaunch flows (Electron window cycling) and tests.
   *  A client that never calls it loses nothing (backends self-heal: exit hooks, stale-lock
   *  steal, IDB's own connection lifecycle). */
  close?(): Promise<void>;
```

In `memoryOutbox()` add after `deleteMeta`:

```ts
    async close() {
      // No backing resource — a memory queue's lifetime IS the instance's lifetime.
    },
```

In the `indexedDBOutbox()` wrapper's returned object add (next to `deleteMeta` forwarding):

```ts
    close: async () => (await impl()).close?.(),
```

- [ ] **Step 3: Implement `IndexedDBOutboxStorage.close()`** in `packages/client/src/outbox-idb.ts` — inside the class, after the last public method. The class already has a `flush()` used by the write-behind batcher and holds `this.db`:

```ts
  async close(): Promise<void> {
    await this.flush();
    this.db.close();
  }
```

(If `flush()` is private and returns the in-flight batch promise, call it the same way the microtask does — read the class first; the requirement is "no pending batched op is lost, then the handle closes".)

- [ ] **Step 4: Write `packages/client/test/outbox-contract.ts`** — the shared behaviors, extracted (assertions ported, not invented) from the two existing files:

```ts
/** Shared OutboxStorage contract — run verbatim against every backend (memory, IDB, fs).
 *  Backend-specific behavior (IDB schema/batching, fs journal/lock) stays in the backend's file. */
import { describe, it, expect } from "vitest";
import type { OutboxEntry, OutboxStorage } from "../src/outbox-storage";
import { mintIdentity } from "../src/outbox-storage";
import { OUTBOX_VERSION } from "../src/outbox-idb";

export function makeEntry(overrides: Partial<OutboxEntry> = {}): OutboxEntry {
  return {
    clientId: "c1",
    seq: 0,
    requestId: "r-0",
    udfPath: "messages:send",
    args: { body: "hi" },
    seed: { entropy: "e", now: 1 },
    order: 0,
    status: "unsent",
    outboxVersion: OUTBOX_VERSION,
    enqueuedAt: 1,
    ...overrides,
  };
}

export function runOutboxStorageContract(
  name: string,
  factory: () => Promise<{ storage: OutboxStorage; cleanup?: () => Promise<void> }>,
): void {
  describe(`OutboxStorage contract — ${name}`, () => {
    async function withStorage(fn: (s: OutboxStorage) => Promise<void>) {
      const { storage, cleanup } = await factory();
      try {
        await fn(storage);
      } finally {
        await storage.close?.();
        await cleanup?.();
      }
    }

    it("append + loadAll roundtrips entries in persisted order across clientIds", () =>
      withStorage(async (s) => {
        await s.append(makeEntry({ clientId: "b", seq: 0, order: 1 }));
        await s.append(makeEntry({ clientId: "a", seq: 0, order: 0 }));
        await s.append(makeEntry({ clientId: "a", seq: 1, order: 2 }));
        const { entries, dropped } = await s.loadAll();
        expect(dropped).toEqual([]);
        expect(entries.map((e) => [e.clientId, e.seq])).toEqual([["a", 0], ["b", 0], ["a", 1]]);
        expect(entries[0]).toMatchObject({ udfPath: "messages:send", args: { body: "hi" } });
      }));

    it("updateStatus changes only status; error is recorded on failed and absent otherwise", () =>
      withStorage(async (s) => {
        await s.append(makeEntry());
        await s.updateStatus("c1", 0, "inflight");
        let [e] = (await s.loadAll()).entries;
        expect(e!.status).toBe("inflight");
        expect(e!.error).toBeUndefined();
        expect(e!.args).toEqual({ body: "hi" });
        await s.updateStatus("c1", 0, "failed", { message: "boom", code: "X" });
        [e] = (await s.loadAll()).entries;
        expect(e!.status).toBe("failed");
        expect(e!.error).toEqual({ message: "boom", code: "X" });
      }));

    it("updateStatus / dequeue for a missing (clientId, seq) are silent no-ops", () =>
      withStorage(async (s) => {
        await s.updateStatus("ghost", 9, "parked");
        await s.dequeue("ghost", 9);
        expect((await s.loadAll()).entries).toEqual([]);
      }));

    it("dequeue removes exactly the one entry", () =>
      withStorage(async (s) => {
        await s.append(makeEntry({ seq: 0, order: 0 }));
        await s.append(makeEntry({ seq: 1, order: 1 }));
        await s.dequeue("c1", 0);
        const { entries } = await s.loadAll();
        expect(entries.map((e) => e.seq)).toEqual([1]);
      }));

    it("loadAll drops stale-outboxVersion entries, deletes them from storage, and reports them", () =>
      withStorage(async (s) => {
        await s.append(makeEntry({ seq: 0, order: 0 }));
        await s.append(makeEntry({ seq: 1, order: 1, outboxVersion: OUTBOX_VERSION - 1 }));
        const first = await s.loadAll();
        expect(first.entries.map((e) => e.seq)).toEqual([0]);
        expect(first.dropped.map((e) => e.seq)).toEqual([1]);
        const second = await s.loadAll();
        expect(second.entries.map((e) => e.seq)).toEqual([0]);
        expect(second.dropped).toEqual([]);
      }));

    it("meta roundtrips; getMeta of an unknown clientId is undefined; deleteMeta removes; list enumerates", () =>
      withStorage(async (s) => {
        expect(await s.getMeta("nope")).toBeUndefined();
        await s.setMeta("c1", { nextSeq: 3, deployment: "dep" });
        await s.setMeta("c2", { nextSeq: 0 });
        expect(await s.getMeta("c1")).toEqual({ nextSeq: 3, deployment: "dep" });
        expect((await s.listMetaClientIds?.())?.sort()).toEqual(["c1", "c2"]);
        await s.deleteMeta?.("c1");
        expect(await s.getMeta("c1")).toBeUndefined();
      }));

    it("mintIdentity mints a fresh clientId at nextSeq 0 and resumes a colliding clientId's cursor", () =>
      withStorage(async (s) => {
        const a = await mintIdentity(s, { mintClientId: () => "fixed" });
        expect(a).toEqual({ clientId: "fixed", nextSeq: 0 });
        await s.setMeta("fixed", { nextSeq: 7 });
        const b = await mintIdentity(s, { mintClientId: () => "fixed" });
        expect(b.nextSeq).toBe(7);
      }));

    it("close() (when present) is idempotent-safe to call after use", () =>
      withStorage(async (s) => {
        await s.append(makeEntry());
        await s.close?.();
      }));
  });
}
```

- [ ] **Step 5: Wire the contract into the two existing test files.** In `outbox-storage.test.ts` add at top-level (keep the existing memory-specific describes that don't duplicate contract coverage; DELETE the memory CRUD assertions the contract now covers — port, don't duplicate):

```ts
import { runOutboxStorageContract } from "./outbox-contract";
runOutboxStorageContract("memoryOutbox", async () => ({ storage: memoryOutbox() }));
```

In `outbox-idb.test.ts` (fake-indexeddb is already a devDependency and in use there — follow the file's existing setup for constructing a fresh IDB factory per test; delete the now-covered "CRUD + hydrate" assertions, keep schema/write-behind/persist/probe describes; update its `makeEntry` uses to import from `./outbox-contract`):

```ts
import { runOutboxStorageContract, makeEntry } from "./outbox-contract";
runOutboxStorageContract("indexedDBOutbox (fake-indexeddb)", async () => {
  const idb = new IDBFactory(); // per the file's existing fake-indexeddb import style
  return { storage: indexedDBOutbox({ indexedDB: idb }) };
});
```

- [ ] **Step 6: Run and verify**

Run: `cd packages/client && bunx vitest run test/outbox-storage.test.ts test/outbox-idb.test.ts`
Expected: PASS — contract suite green twice (memory + IDB), remaining backend-specific describes green.

- [ ] **Step 7: Typecheck + commit**

```bash
cd packages/client && bun run typecheck
git add -A packages/client
git commit -m "feat(client): optional OutboxStorage.close() + shared storage contract suite"
```

---

### Task 2: The journal core — `outbox-fs.ts` (no lock yet)

**Files:**
- Create: `packages/client/src/outbox-fs.ts`
- Create: `packages/client/test/outbox-fs.test.ts`

**Interfaces:**
- Consumes: `OutboxStorage`, `OutboxEntry`, `OutboxMeta`, `OutboxEntryStatus`, `OutboxEntryError`, `HydrateResult`, `memoryOutbox` (`./outbox-storage`); `dropStaleVersion` (`./outbox-idb`).
- Produces: `fsOutbox(opts: FsOutboxOptions): OutboxStorage` and `interface FsOutboxOptions { dir: string; fsync?: boolean; onFallback?: (reason: unknown) => void }`; the returned storage additionally exposes `stats: { flushes: number; fsyncs: number }` (test observability, documented not-API). Task 3 wraps `openFsOutbox` (the internal direct-open, exported for tests as `__openFsOutboxDirect`) with the lock+fallback; Task 4/5 import `fsOutbox`.

- [ ] **Step 1: Write the failing tests** — `packages/client/test/outbox-fs.test.ts`:

```ts
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync, appendFileSync, existsSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fsOutbox } from "../src/outbox-fs";
import { makeEntry } from "./outbox-contract";

const dirs: string[] = [];
function freshDir(): string {
  const d = mkdtempSync(join(tmpdir(), "sb-outbox-fs-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("fsOutbox — journal durability", () => {
  it("append resolves only after the line is durably in journal.jsonl (read-after-await)", async () => {
    const dir = freshDir();
    const s = fsOutbox({ dir });
    await s.append(makeEntry());
    const raw = readFileSync(join(dir, "journal.jsonl"), "utf8");
    expect(raw).toContain('"op":"append"');
    expect(raw).toContain('"udfPath":"messages:send"');
    await s.close?.();
  });

  it("same-microtask appends batch into ONE flush (write-behind)", async () => {
    const dir = freshDir();
    const s = fsOutbox({ dir }) as ReturnType<typeof fsOutbox> & { stats: { flushes: number } };
    await Promise.all([s.append(makeEntry({ seq: 0, order: 0 })), s.append(makeEntry({ seq: 1, order: 1 })), s.append(makeEntry({ seq: 2, order: 2 }))]);
    expect(s.stats.flushes).toBe(1);
    expect((await s.loadAll()).entries).toHaveLength(3);
    await s.close?.();
  });

  it("restart-rehydrate: a fresh instance on the same dir hydrates the same entries in order", async () => {
    const dir = freshDir();
    const a = fsOutbox({ dir });
    await a.append(makeEntry({ seq: 0, order: 1 }));
    await a.append(makeEntry({ clientId: "c2", seq: 0, order: 0 }));
    await a.updateStatus("c1", 0, "parked");
    await a.close?.();
    const b = fsOutbox({ dir });
    const { entries } = await b.loadAll();
    expect(entries.map((e) => [e.clientId, e.status])).toEqual([["c2", "unsent"], ["c1", "parked"]]);
    await b.close?.();
  });
});

describe("fsOutbox — corruption", () => {
  it("a torn TAIL line is physically truncated and only that entry is lost", async () => {
    const dir = freshDir();
    const a = fsOutbox({ dir });
    await a.append(makeEntry({ seq: 0, order: 0 }));
    await a.close?.();
    appendFileSync(join(dir, "journal.jsonl"), '{"op":"append","entry":{"clientId":"c1","se'); // torn: no newline, invalid JSON
    const b = fsOutbox({ dir });
    const { entries } = await b.loadAll();
    expect(entries.map((e) => e.seq)).toEqual([0]);
    await b.close?.();
    const raw = readFileSync(join(dir, "journal.jsonl"), "utf8");
    expect(raw.endsWith("\n")).toBe(true);
    expect(raw).not.toContain('"se'.padEnd(3)); // torn fragment gone from the journal
  });

  it("a corrupt MIDDLE line is quarantined and skipped; later ops for other entries still apply", async () => {
    const dir = freshDir();
    const a = fsOutbox({ dir });
    await a.append(makeEntry({ seq: 0, order: 0 }));
    await a.append(makeEntry({ seq: 1, order: 1 }));
    await a.close?.();
    // corrupt the FIRST line in place (middle of the file once we append one more valid op)
    const p = join(dir, "journal.jsonl");
    const lines = readFileSync(p, "utf8").split("\n");
    lines[0] = "corrupt-not-json";
    writeFileSync(p, lines.join("\n"));
    const b = fsOutbox({ dir });
    const { entries } = await b.loadAll();
    expect(entries.map((e) => e.seq)).toEqual([1]);
    expect(readFileSync(join(dir, "journal.quarantine"), "utf8")).toContain("corrupt-not-json");
    await b.close?.();
  });
});

describe("fsOutbox — compaction", () => {
  it("compacts past the op threshold: state identical, journal shrinks, tmp not left behind", async () => {
    const dir = freshDir();
    const s = fsOutbox({ dir, fsync: false });
    await s.append(makeEntry({ seq: 0, order: 0 }));
    for (let i = 0; i < 5000; i++) await s.updateStatus("c1", 0, i % 2 ? "inflight" : "unsent");
    const { entries } = await s.loadAll();
    expect(entries).toHaveLength(1);
    await s.close?.();
    const opCount = readFileSync(join(dir, "journal.jsonl"), "utf8").trim().split("\n").length;
    expect(opCount).toBeLessThan(100); // compacted: state is 1 entry (+ metas), not 5001 ops
    expect(existsSync(join(dir, "journal.tmp"))).toBe(false);
    const b = fsOutbox({ dir });
    expect((await b.loadAll()).entries).toHaveLength(1);
    await b.close?.();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd packages/client && bunx vitest run test/outbox-fs.test.ts`
Expected: FAIL — `Cannot find module '../src/outbox-fs'`.

- [ ] **Step 3: Implement `packages/client/src/outbox-fs.ts`** (Task 3 adds the lock; keep `openDirect` factored so Task 3 wraps it):

```ts
/**
 * `fsOutbox()` — the filesystem OutboxStorage for Node/Bun/Electron/Tauri hosts (spec:
 * docs/superpowers/specs/2025-11-04-fs-outbox-adapter-design.md). One append-only JSONL journal
 * per queue dir; every seam mutation is one appended line through a serialized write-behind
 * appender (same-microtask ops batch into ONE write+fsync — the fs twin of outbox-idb's
 * pendingOps/queueMicrotask batcher); hydrate replays the journal. A torn TAIL line (the only
 * thing an interrupted append can produce) is physically truncated — that entry was never
 * park-eligible, so dropping it is correct. A corrupt MIDDLE line is quarantined and skipped.
 * Compaction (at open and past 4096 ops) rewrites live state tmp → fsync → rename → dir fsync.
 * `node:*` imports live ONLY in this file — it ships as the `./outbox-fs` subpath export so the
 * browser bundles never see them.
 */
import { appendFileSync } from "node:fs";
import { mkdir, open, readFile, rename, rm, truncate, type FileHandle } from "node:fs/promises";
import { join, resolve } from "node:path";
import type {
  HydrateResult,
  OutboxEntry,
  OutboxEntryError,
  OutboxEntryStatus,
  OutboxMeta,
  OutboxStorage,
} from "./outbox-storage";
import { dropStaleVersion } from "./outbox-idb";

export interface FsOutboxOptions {
  /** Queue directory (created recursively). One durable queue per dir. */
  dir: string;
  /** fsync appends before resolving append()'s promise. Default true. */
  fsync?: boolean;
  /** Fired once if the adapter degrades to memoryOutbox() (Task 3: lock held, open failure). */
  onFallback?: (reason: unknown) => void;
}

const COMPACT_THRESHOLD = 4096;

type JournalOp =
  | { op: "append"; entry: OutboxEntry }
  | { op: "status"; clientId: string; seq: number; status: OutboxEntryStatus; error?: OutboxEntryError }
  | { op: "dequeue"; clientId: string; seq: number }
  | { op: "meta"; clientId: string; meta: OutboxMeta }
  | { op: "metaDelete"; clientId: string };

const key = (clientId: string, seq: number) => `${clientId}\0${seq}`;

interface State {
  entries: Map<string, OutboxEntry>;
  meta: Map<string, OutboxMeta>;
}

function applyOp(state: State, op: JournalOp): void {
  switch (op.op) {
    case "append":
      state.entries.set(key(op.entry.clientId, op.entry.seq), op.entry);
      break;
    case "status": {
      const existing = state.entries.get(key(op.clientId, op.seq));
      if (existing)
        state.entries.set(key(op.clientId, op.seq), {
          ...existing,
          status: op.status,
          ...(op.error !== undefined ? { error: op.error } : {}),
        });
      break;
    }
    case "dequeue":
      state.entries.delete(key(op.clientId, op.seq));
      break;
    case "meta":
      state.meta.set(op.clientId, op.meta);
      break;
    case "metaDelete":
      state.meta.delete(op.clientId);
      break;
  }
}

/** The direct (lock-free) open — Task 3's fsOutbox() wraps this with lock + probe-and-fallback. */
export class FsOutboxStorage implements OutboxStorage {
  readonly stats = { flushes: 0, fsyncs: 0 };

  private state: State = { entries: new Map(), meta: new Map() };
  private opCount = 0;
  private handle: FileHandle | undefined;
  private pending: string[] = [];
  private flushScheduled = false;
  /** Serializes flushes and compactions — every disk mutation chains on this. */
  private tail: Promise<void> = Promise.resolve();
  private opened = false;
  private closed = false;

  constructor(
    private readonly dir: string,
    private readonly fsync: boolean,
  ) {}

  private get journalPath() {
    return join(this.dir, "journal.jsonl");
  }

  /** Replay the journal into memory; truncate a torn tail; quarantine corrupt middles; compact. */
  private async openOnce(): Promise<void> {
    if (this.opened) return;
    this.opened = true;
    await mkdir(this.dir, { recursive: true });
    let raw = "";
    try {
      raw = await readFile(this.journalPath, "utf8");
    } catch {
      /* fresh dir — no journal yet */
    }
    let validBytes = 0;
    const lines = raw.length === 0 ? [] : raw.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      if (line === "") {
        // the split artifact after a final newline, or a blank line mid-file (skip)
        if (i < lines.length - 1) validBytes += 1;
        continue;
      }
      const isLast = i === lines.length - 1;
      try {
        const op = JSON.parse(line) as JournalOp;
        applyOp(this.state, op);
        this.opCount++;
        validBytes += Buffer.byteLength(line, "utf8") + (isLast ? 0 : 1);
      } catch {
        if (isLast) {
          // torn tail — physically truncate so it can never become a corrupt middle
          await truncate(this.journalPath, validBytes).catch(() => {});
        } else {
          appendFileSync(join(this.dir, "journal.quarantine"), line + "\n");
          validBytes += Buffer.byteLength(line, "utf8") + 1;
        }
      }
    }
    this.handle = await open(this.journalPath, "a");
    // Open-time compaction bounds a journal that grew across prior sessions.
    if (this.opCount > this.state.entries.size + this.state.meta.size) await this.compact();
  }

  private ready(): Promise<void> {
    this.tail = this.tail.then(() => this.openOnce());
    return this.tail;
  }

  private write(op: JournalOp): Promise<void> {
    this.pending.push(JSON.stringify(op) + "\n");
    this.opCount++;
    if (!this.flushScheduled) {
      this.flushScheduled = true;
      this.tail = this.tail.then(async () => {
        await this.openOnce();
        this.flushScheduled = false;
        const batch = this.pending.splice(0);
        if (batch.length === 0 || this.closed) return;
        await this.handle!.write(batch.join(""));
        this.stats.flushes++;
        if (this.fsync) {
          await this.handle!.sync();
          this.stats.fsyncs++;
        }
        if (this.opCount > COMPACT_THRESHOLD) await this.compact();
      });
    }
    return this.tail;
  }

  /** Rewrite live state tmp → fsync → rename → dir fsync. Failure leaves the old journal intact. */
  private async compact(): Promise<void> {
    const tmpPath = join(this.dir, "journal.tmp");
    try {
      const lines: string[] = [];
      for (const [clientId, meta] of this.state.meta) lines.push(JSON.stringify({ op: "meta", clientId, meta } satisfies JournalOp) + "\n");
      for (const entry of [...this.state.entries.values()].sort((a, b) => a.order - b.order))
        lines.push(JSON.stringify({ op: "append", entry } satisfies JournalOp) + "\n");
      const tmp = await open(tmpPath, "w");
      await tmp.write(lines.join(""));
      await tmp.sync();
      await tmp.close();
      await this.handle?.close();
      await rename(tmpPath, this.journalPath);
      const dirHandle = await open(this.dir, "r").catch(() => undefined);
      if (dirHandle) {
        await dirHandle.sync().catch(() => {});
        await dirHandle.close();
      }
      this.handle = await open(this.journalPath, "a");
      this.opCount = this.state.entries.size + this.state.meta.size;
    } catch {
      await rm(tmpPath, { force: true }).catch(() => {});
      if (!this.handle) this.handle = await open(this.journalPath, "a").catch(() => undefined as never);
    }
  }

  async append(entry: OutboxEntry): Promise<void> {
    applyOp(this.state, { op: "append", entry: { ...entry } });
    await this.write({ op: "append", entry });
  }

  async updateStatus(clientId: string, seq: number, status: OutboxEntryStatus, error?: OutboxEntryError): Promise<void> {
    if (!this.opened) await this.ready();
    if (!this.state.entries.has(key(clientId, seq))) return; // silent no-op, contract behavior
    applyOp(this.state, { op: "status", clientId, seq, status, error });
    await this.write({ op: "status", clientId, seq, status, ...(error !== undefined ? { error } : {}) });
  }

  async dequeue(clientId: string, seq: number): Promise<void> {
    if (!this.opened) await this.ready();
    if (!this.state.entries.has(key(clientId, seq))) return;
    applyOp(this.state, { op: "dequeue", clientId, seq });
    await this.write({ op: "dequeue", clientId, seq });
  }

  async loadAll(): Promise<HydrateResult> {
    await this.ready();
    const all = [...this.state.entries.values()].sort((a, b) => a.order - b.order);
    const { entries, dropped } = dropStaleVersion(all);
    for (const e of dropped) {
      applyOp(this.state, { op: "dequeue", clientId: e.clientId, seq: e.seq });
      void this.write({ op: "dequeue", clientId: e.clientId, seq: e.seq });
    }
    return { entries: entries.map((e) => ({ ...e })), dropped };
  }

  async getMeta(clientId: string): Promise<OutboxMeta | undefined> {
    await this.ready();
    const m = this.state.meta.get(clientId);
    return m ? { ...m } : undefined;
  }

  async setMeta(clientId: string, meta: OutboxMeta): Promise<void> {
    applyOp(this.state, { op: "meta", clientId, meta: { ...meta } });
    await this.write({ op: "meta", clientId, meta });
  }

  async listMetaClientIds(): Promise<string[]> {
    await this.ready();
    return [...this.state.meta.keys()];
  }

  async deleteMeta(clientId: string): Promise<void> {
    if (!this.opened) await this.ready();
    applyOp(this.state, { op: "metaDelete", clientId });
    await this.write({ op: "metaDelete", clientId });
  }

  persist(): void {
    // No-op: no eviction advisory exists on a filesystem.
  }

  async close(): Promise<void> {
    await this.ready(); // drain pending flushes
    this.closed = true;
    await this.handle?.close();
    this.handle = undefined;
  }
}

/** Task 2 shape: direct open (no lock). Task 3 replaces this body with lock + probe-and-fallback
 *  around the same FsOutboxStorage. */
export function fsOutbox(opts: FsOutboxOptions): OutboxStorage & { stats: { flushes: number; fsyncs: number } } {
  return new FsOutboxStorage(resolve(opts.dir), opts.fsync !== false);
}
```

- [ ] **Step 4: Run the tests**

Run: `cd packages/client && bunx vitest run test/outbox-fs.test.ts`
Expected: PASS (all three describes). If the compaction test is slow, that's the 5000 sequential awaited writes with `fsync: false` — acceptable up to ~10s; do NOT raise the threshold to pass.

- [ ] **Step 5: Typecheck + commit**

```bash
cd packages/client && bun run typecheck
git add -A packages/client
git commit -m "feat(client): fsOutbox journal core — JSONL write-behind, torn-tail truncation, quarantine, compaction"
```

---

### Task 3: Lock, same-process registry, probe-and-fallback, exit hook

**Files:**
- Modify: `packages/client/src/outbox-fs.ts` (the `fsOutbox()` factory + new lock section)
- Modify: `packages/client/test/outbox-fs.test.ts` (new describe)

**Interfaces:**
- Consumes: `FsOutboxStorage` (Task 2), `memoryOutbox` (`./outbox-storage`).
- Produces: final `fsOutbox()` — async probe, lock, fallback; `close()` releases the lock and deregisters. Signature unchanged from Task 2.

- [ ] **Step 1: Write the failing tests** (append to `test/outbox-fs.test.ts`):

```ts
describe("fsOutbox — one writer per dir (lock + probe-and-fallback)", () => {
  it("a same-process double-open falls back to memory and fires onFallback once", async () => {
    const dir = freshDir();
    const a = fsOutbox({ dir });
    await a.append(makeEntry());
    const reasons: unknown[] = [];
    const b = fsOutbox({ dir, onFallback: (r) => reasons.push(r) });
    await b.append(makeEntry({ clientId: "other", seq: 0, order: 5 }));
    expect(reasons).toHaveLength(1);
    // b is memory-backed: its entry is NOT in the journal
    expect(readFileSync(join(dir, "journal.jsonl"), "utf8")).not.toContain('"other"');
    // but b still works as a queue (degraded, not broken)
    expect((await b.loadAll()).entries.map((e) => e.clientId)).toEqual(["other"]);
    await a.close?.();
    await b.close?.();
  });

  it("close() releases the lock: reopen on the same dir succeeds and hydrates", async () => {
    const dir = freshDir();
    const a = fsOutbox({ dir });
    await a.append(makeEntry());
    await a.close?.();
    expect(existsSync(join(dir, "lock"))).toBe(false);
    const reasons: unknown[] = [];
    const b = fsOutbox({ dir, onFallback: (r) => reasons.push(r) });
    expect((await b.loadAll()).entries).toHaveLength(1);
    expect(reasons).toHaveLength(0);
    await b.close?.();
  });

  it("a DEAD-pid stale lock is stolen and the adapter opens normally", async () => {
    const dir = freshDir();
    writeFileSync(join(dir, "lock"), JSON.stringify({ pid: 999999999, createdAt: 1 }));
    const reasons: unknown[] = [];
    const s = fsOutbox({ dir, onFallback: (r) => reasons.push(r) });
    await s.append(makeEntry());
    expect(reasons).toHaveLength(0);
    expect(readFileSync(join(dir, "journal.jsonl"), "utf8")).toContain('"op":"append"');
    await s.close?.();
  });

  it("an OWN-pid lock left by a previous boot (pid recycled, dir not registered) is stolen", async () => {
    const dir = freshDir();
    writeFileSync(join(dir, "lock"), JSON.stringify({ pid: process.pid, createdAt: 1 }));
    const reasons: unknown[] = [];
    const s = fsOutbox({ dir, onFallback: (r) => reasons.push(r) });
    await s.append(makeEntry());
    expect(reasons).toHaveLength(0);
    await s.close?.();
  });

  it("a GARBAGE lockfile is stolen, not fatal", async () => {
    const dir = freshDir();
    writeFileSync(join(dir, "lock"), "not json at all");
    const s = fsOutbox({ dir });
    await s.append(makeEntry());
    expect((await s.loadAll()).entries).toHaveLength(1);
    await s.close?.();
  });
});
```

Note the same-process test also covers the "live pid → fallback" branch: the holder IS this process and IS registered, so it is treated as genuinely held.

- [ ] **Step 2: Run to verify failure** — `bunx vitest run test/outbox-fs.test.ts -t "one writer"`
Expected: FAIL (no lock exists yet; double-open currently succeeds and corrupts nothing but writes to the same journal — the `onFallback` expectations fail).

- [ ] **Step 3: Implement the lock + fallback in `outbox-fs.ts`.** Add imports `writeFile`, `unlink` to the `node:fs/promises` import and `unlinkSync` to `node:fs`. Add before `fsOutbox()`:

```ts
/** Dirs opened (and locked) by THIS process — makes a same-process double-open deterministic and
 *  distinguishes a genuinely-live own-pid lock from one left by a previous boot that recycled our
 *  pid. Keyed by resolved dir path. */
const openDirs = new Set<string>();
/** Lockfile paths for the best-effort exit hook (SIGKILL still leaks; the next open steals). */
const liveLocks = new Set<string>();
let exitHookRegistered = false;

class OutboxLockHeldError extends Error {
  readonly code = "OUTBOX_LOCK_HELD";
  constructor(holder: number) {
    super(`outbox dir is locked by live pid ${holder} — one writer per dir; falling back to memory`);
    this.name = "OutboxLockHeldError";
  }
}

async function acquireLock(dir: string): Promise<string> {
  const lockPath = join(dir, "lock");
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await writeFile(lockPath, JSON.stringify({ pid: process.pid, createdAt: Date.now() }), { flag: "wx" });
      liveLocks.add(lockPath);
      if (!exitHookRegistered) {
        exitHookRegistered = true;
        process.once("exit", () => {
          for (const p of liveLocks) {
            try {
              unlinkSync(p);
            } catch {
              /* already gone */
            }
          }
        });
      }
      return lockPath;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      let stale = false;
      try {
        const { pid } = JSON.parse(await readFile(lockPath, "utf8")) as { pid?: unknown };
        if (typeof pid !== "number") stale = true;
        else if (pid === process.pid) stale = !openDirs.has(dir); // recycled pid from a prior boot
        else {
          try {
            process.kill(pid, 0); // signal 0: existence probe only
          } catch (killErr) {
            if ((killErr as NodeJS.ErrnoException).code === "ESRCH") stale = true;
            else throw new OutboxLockHeldError(pid); // EPERM: alive but not ours
          }
          if (!stale) throw new OutboxLockHeldError(pid);
        }
      } catch (parseOrHeld) {
        if (parseOrHeld instanceof OutboxLockHeldError) throw parseOrHeld;
        stale = true; // unreadable/garbage
      }
      if (!stale) throw new OutboxLockHeldError(-1);
      await rm(lockPath, { force: true });
      // loop: one retry of wx
    }
  }
  throw new OutboxLockHeldError(-1);
}
```

Replace the Task 2 `fsOutbox()` body with the probe-and-fallback wrapper (mirroring `indexedDBOutbox()`'s `resolved`/`ready` delegation in `outbox-storage.ts:222-254`):

```ts
export function fsOutbox(opts: FsOutboxOptions): OutboxStorage & { stats: { flushes: number; fsyncs: number } } {
  const dir = resolve(opts.dir);
  const stats = { flushes: 0, fsyncs: 0 };

  let resolved: OutboxStorage | undefined;
  const ready: Promise<OutboxStorage> = (async (): Promise<OutboxStorage> => {
    if (openDirs.has(dir)) throw new OutboxLockHeldError(process.pid); // same-process double-open
    await mkdir(dir, { recursive: true });
    const lockPath = await acquireLock(dir);
    openDirs.add(dir);
    const store = new FsOutboxStorage(dir, opts.fsync !== false);
    // splice the real stats through so callers see live counters regardless of when probe resolves
    Object.defineProperty(store, "stats", { value: stats, writable: false });
    const innerClose = store.close.bind(store);
    store.close = async () => {
      await innerClose();
      openDirs.delete(dir);
      liveLocks.delete(lockPath);
      await unlink(lockPath).catch(() => {});
    };
    return store;
  })().catch((err: unknown) => {
    opts.onFallback?.(err);
    return memoryOutbox();
  });
  void ready.then((impl) => {
    resolved = impl;
  });
  const impl = async (): Promise<OutboxStorage> => resolved ?? ready;

  return {
    stats,
    append: async (entry) => (await impl()).append(entry),
    updateStatus: async (clientId, seq, status, error) => (await impl()).updateStatus(clientId, seq, status, error),
    dequeue: async (clientId, seq) => (await impl()).dequeue(clientId, seq),
    loadAll: async () => (await impl()).loadAll(),
    getMeta: async (clientId) => (await impl()).getMeta(clientId),
    setMeta: async (clientId, meta) => (await impl()).setMeta(clientId, meta),
    listMetaClientIds: async () => (await impl()).listMetaClientIds?.() ?? [],
    deleteMeta: async (clientId) => (await impl()).deleteMeta?.(clientId),
    persist: () => {
      void impl().then((i) => i.persist());
    },
    close: async () => (await impl()).close?.(),
  };
}
```

(Adjust `FsOutboxStorage.stats` to `stats = { flushes: 0, fsyncs: 0 }` assigned via the defineProperty splice above — i.e. make the class field non-readonly, or have the class accept the stats object as a constructor arg; pick the constructor-arg form if the defineProperty spread fights TypeScript. The Task 2 direct-construction tests must be updated to construct via `fsOutbox()` only — they already do.)

- [ ] **Step 4: Run the full fs test file**

Run: `cd packages/client && bunx vitest run test/outbox-fs.test.ts`
Expected: PASS — Task 2 describes still green (the factory now locks, but each test uses a fresh dir and closes), new lock describe green.

- [ ] **Step 5: Typecheck + commit**

```bash
cd packages/client && bun run typecheck
git add -A packages/client
git commit -m "feat(client): fsOutbox lock — one writer per dir, stale-steal, probe-and-fallback to memory"
```

---

### Task 4: Packaging (`./outbox-fs` subpath) + cross-backend contract + browser cleanliness

**Files:**
- Modify: `packages/client/tsup.config.ts`, `packages/client/package.json`
- Modify: `packages/client/test/outbox-fs.test.ts` (contract run), new `packages/client/test/dist-browser-clean.test.ts`

- [ ] **Step 1: Run the shared contract against fs.** Append to `test/outbox-fs.test.ts`:

```ts
import { runOutboxStorageContract } from "./outbox-contract";
runOutboxStorageContract("fsOutbox (tmpdir)", async () => {
  const dir = freshDir();
  return { storage: fsOutbox({ dir }), cleanup: async () => rmSync(dir, { recursive: true, force: true }) };
});
```

Run: `bunx vitest run test/outbox-fs.test.ts` → PASS (contract + all prior describes).

- [ ] **Step 2: tsup entry + subpath export.** `tsup.config.ts`: `entry: ["src/index.ts", "src/react.tsx", "src/outbox-fs.ts"]`. `package.json` exports gains:

```json
    "./outbox-fs": {
      "types": "./dist/outbox-fs.d.ts",
      "default": "./dist/outbox-fs.js"
    }
```

- [ ] **Step 3: Browser-cleanliness test** — `packages/client/test/dist-browser-clean.test.ts`:

```ts
/** The browser entrypoints must never grow a node builtin import — outbox-fs is the only file
 *  allowed to touch node:*, and it ships as its own subpath entry. Guards the split at the
 *  artifact level (dist is built before tests in the turbo pipeline). */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

describe("dist browser cleanliness", () => {
  it.each(["index.js", "react.js"])("dist/%s contains no node: specifier", (file) => {
    const src = readFileSync(join(__dirname, "..", "dist", file), "utf8");
    expect(src).not.toMatch(/["']node:[a-z/]+["']/);
  });
  it("dist/outbox-fs.js exists and is the only node:-importing entry", () => {
    const src = readFileSync(join(__dirname, "..", "dist", "outbox-fs.js"), "utf8");
    expect(src).toMatch(/node:fs/);
  });
});
```

- [ ] **Step 4: Build + run + typecheck**

```bash
cd packages/client && bun run build && bunx vitest run && bun run typecheck
```
Expected: all green (the full client suite, not just outbox files — reconnect/drain/registry tests must be untouched by the seam addition).

- [ ] **Step 5: Commit**

```bash
git add -A packages/client
git commit -m "feat(client): ship fsOutbox as the ./outbox-fs subpath export; dist browser-cleanliness guard"
```

---

### Task 5: E2E through the real server + docs + full gate

**Files:**
- Create: `packages/cli/test/outbox-fs-e2e.test.ts`
- Modify: `docs/enduser/offline.md`, `CLAUDE.md`

- [ ] **Step 1: Read the flagship harness** — `packages/cli/test/outbox-e2e.test.ts` lines 1–130 (imports, fixture schema/module, server boot helper, `nodeWsTransport`) and scenario 1a (~:305-360, the SQLite flagship: session 1 offline-enqueue → "reload" → session 2 drains). The new file reuses the same helpers by copying its import block and fixture setup — the reload-fidelity model (two clients over one durable storage) is documented at :13-22 and applies verbatim, with `fsOutbox({dir})` playing the role IDB played.

- [ ] **Step 2: Write `packages/cli/test/outbox-fs-e2e.test.ts`.** Shape (mirror scenario 1a's structure and helpers exactly; the deltas are the storage and the close between sessions):

```ts
/**
 * fsOutbox E2E — the Node/Electron twin of the browser flagship (outbox-e2e.test.ts 1a):
 * offline → process exit → fresh process → exactly-once drain, with the durable queue on the
 * FILESYSTEM (fsOutbox) instead of IndexedDB. Session 1 = a real StackbaseClient over a real
 * WebSocket whose transport never connects (server not yet started), enqueueing K mutations into
 * a tmpdir journal; `close()` releases the dir. Session 2 = a genuinely fresh client + fresh
 * fsOutbox on the SAME dir against a now-running real dev server: hydrate → Connect/ConnectAck →
 * drain → exactly K rows committed (receipts absorb any resend), pendingMutations() empty.
 */
```

Test body requirements (assertions, not prose):
- K = 6 mutations enqueued in session 1 while disconnected; after `await Promise.allSettled` of the sends' fire-and-forget, assert `journal.jsonl` in the tmpdir contains 6 `"op":"append"` lines (durability BEFORE the server ever existed);
- `await outbox1.close?.()` then construct session 2: fresh `fsOutbox({ dir })`, fresh client, real server (same boot helper as 1a);
- after drain completes: server-side row count === K exactly (query through the same fixture read the flagship uses), `client2.pendingMutations()` empty, and `lock` file gone after `close()`.
- Set generous vitest timeout (60_000) matching the flagship's.

- [ ] **Step 3: Build + run**

```bash
bun run build   # cli E2E resolves @stackbase/client (incl. ./outbox-fs) via dist
cd packages/cli && bunx vitest run test/outbox-fs-e2e.test.ts
```
Expected: PASS.

- [ ] **Step 4: Docs.** `docs/enduser/offline.md`:
- New section "Node, Electron, and Tauri hosts" after the IndexedDB backend section: `fsOutbox({ dir })` usage snippet (`import { fsOutbox } from "@stackbase/client/outbox-fs"`), the one-writer-per-dir rule (second process falls back to memory + `onFallback`), the network-filesystem caveat (lock semantics need local disk), and the Electron split: renderer keeps `indexedDBOutbox()`, main/sidecar processes use `fsOutbox()`.
- The deferred table: the "A Node/Bun filesystem `OutboxStorage` adapter" row is REMOVED from the deferred table and the section prose notes it shipped (keep the other rows verbatim).
- `CLAUDE.md`: in the durable-offline-sync entry, extend the `outbox:` mention to `outbox: indexedDBOutbox()/fsOutbox()/memoryOutbox()` with a one-clause parenthetical (fs = Node/Electron hosts, one writer per dir, journal+lock in a queue dir).

- [ ] **Step 5: Full gate + commit**

```bash
bun run build && bun run typecheck && bun run test
git add -A
git commit -m "feat(client,docs): fsOutbox E2E through the real server + offline guide section"
```
Expected: 64/64 turbo tasks green (the cli suite picks the new file up in phase 2 via the `*-e2e` filter).

---

## Self-review notes (spec coverage)

- Spec API/fsync/onFallback → T2+T3. Journal table/torn-tail/quarantine/compaction → T2. Lock/registry/own-pid/exit-hook/close → T3 (+T1 seam). Subpath export + browser-clean → T4. Contract suite across three backends → T1+T4. E2E + docs + deferred-row move → T5. Error-handling table rows: fallback paths T3; append-rejection-after-open is inherent (write() propagates); compaction-failure-keeps-old-journal T2 impl + covered implicitly by compaction test's success path (a dedicated fault-injection test is deliberately out — YAGNI, the catch path is 6 lines).
- Non-goals respected: no shared-live-dir support, no sqlite backend, no Windows CI.
