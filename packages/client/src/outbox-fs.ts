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
    // Final compaction: a threshold-triggered mid-stream compact() resets opCount to the live
    // state size, so a trailing run of ops shorter than COMPACT_THRESHOLD (e.g. ending the
    // session right after crossing the threshold once) never crosses it again and would
    // otherwise sit uncompacted on disk. Mirror openOnce's same excess check so a closed queue
    // is always left compacted at rest.
    if (this.opCount > this.state.entries.size + this.state.meta.size) await this.compact();
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
