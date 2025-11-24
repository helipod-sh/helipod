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

/** Thrown (rejecting the operation's promise) when a mutating call's flush runs — or would run —
 *  after `close()` has completed. Before this existed, a flush that observed `closed` mid-batch
 *  simply `return`ed, letting every op in that batch resolve normally despite never being written
 *  — a silent, undetectable data-loss window. Now the batch's shared promise rejects instead, so a
 *  caller racing `close()` learns its write was dropped rather than believing it durable. */
export class OutboxClosedError extends Error {
  readonly code = "OUTBOX_CLOSED";
  constructor(message = "fsOutbox is closed; this operation was rejected rather than silently dropped") {
    super(message);
    this.name = "OutboxClosedError";
  }
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
  /** Serializes flushes, compactions, and close() — every disk mutation chains on this, INCLUDING
   *  close() itself (see close() below), so nothing can run concurrently with or after a completed
   *  close(). Fail-stop by construction: once any chained link throws (disk-full, a corrupt-open
   *  failure, `OutboxClosedError`), `this.tail` becomes a permanently-rejected promise and every
   *  later `.then(...)` chained onto it (the normal way every method here extends the chain) short-
   *  circuits straight to that SAME rejection without ever running its own body — callers see the
   *  original failure's error, not a fresh one. This is intentional, not a bug to route around: a
   *  fsOutbox instance whose disk state may be compromised should not keep pretending to work.
   *  Recovery (probe-and-fallback to memoryOutbox, lock steal) is Task 3's seam, not this file's. */
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
    // A flush always writes `line + "\n"` as ONE buffer and fsyncs only after that write
    // completes — so a journal missing its trailing newline PROVES the very last line was never
    // acknowledged (append()'s promise for it never resolved), regardless of whether the bytes
    // that did land happen to parse as valid JSON. Accepting a parseable-but-unterminated last
    // line would glue whatever a LATER session appends onto its tail, corrupting an entry that
    // WAS legitimately acknowledged (see the finding this fixes: torn-newline glue).
    const hasTrailingNewline = raw.endsWith("\n");
    const lines = raw.length === 0 ? [] : raw.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      if (line === "") {
        // the split artifact after a final newline, or a blank line mid-file (skip)
        if (i < lines.length - 1) validBytes += 1;
        continue;
      }
      const isLast = i === lines.length - 1;
      if (isLast && !hasTrailingNewline) {
        // Torn tail, unconditionally: never attempt to parse it — its missing newline alone
        // proves it was never durably acknowledged. Truncate back to the last known-good byte.
        await truncate(this.journalPath, validBytes);
        continue;
      }
      try {
        const op = JSON.parse(line) as JournalOp;
        applyOp(this.state, op);
        this.opCount++;
        validBytes += Buffer.byteLength(line, "utf8") + 1;
      } catch {
        if (isLast) {
          // corrupt tail line that DOES have a trailing newline — physically truncate so it can
          // never become a corrupt middle
          await truncate(this.journalPath, validBytes);
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
        if (batch.length === 0) return;
        // close() chains its ENTIRE body (drain -> compact-if-excess -> closed=true ->
        // handle.close) as a single link on `this.tail` too, so `this.closed` can only ever
        // become true strictly BEFORE or AFTER this whole flush runs — never mid-flush. Seeing it
        // true here means this batch lost the race entirely (queued after close() had already
        // completed its own tail link): reject rather than silently `return`ing a "success" for
        // ops that were never written — see OutboxClosedError's doc comment.
        if (this.closed) throw new OutboxClosedError();
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
      // Unconditionally restore a WORKING append handle, regardless of `this.handle`'s current
      // truthiness: a failure partway through the steps above (write/sync/rename to the tmp file
      // failing AFTER `this.handle?.close()` already ran) leaves `this.handle` closed-but-set —
      // the old `if (!this.handle)` guard would then skip reopening entirely, and every later
      // write would throw against a dead handle forever. Close-if-present (best-effort; it may
      // already be closed) then always reopen fresh.
      await this.handle?.close().catch(() => {});
      this.handle = await open(this.journalPath, "a");
    }
  }

  async append(entry: OutboxEntry): Promise<void> {
    // Hydrate first if this is the very first call on this instance: applying `entry` to
    // `this.state` BEFORE the journal replay would run means the replay (which mutates the SAME
    // `this.state` object) could land AFTER this fresher write, letting a stale on-disk value win
    // over the one just set — a state inversion. `updateStatus`/`dequeue`/`deleteMeta` already
    // guard the same way.
    if (!this.opened) await this.ready();
    applyOp(this.state, { op: "append", entry: structuredClone(entry) });
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
      // Loss-safe, so the rejection is deliberately swallowed rather than surfaced: `e` is
      // ALREADY removed from `this.state` and already returned to the caller inside `dropped` —
      // the caller has already treated it as gone either way. If this particular disk write fails
      // (e.g. transient disk-full), the stale-version row simply survives on disk to be dropped
      // again, idempotently, on the NEXT hydrate. Leaving this unhandled would surface as an
      // `unhandledRejection`, which several Electron/Node hosts treat as fatal — worse than a
      // silently-retried cleanup.
      void this.write({ op: "dequeue", clientId: e.clientId, seq: e.seq }).catch(() => {});
    }
    return { entries: entries.map((e) => structuredClone(e)), dropped };
  }

  async getMeta(clientId: string): Promise<OutboxMeta | undefined> {
    await this.ready();
    const m = this.state.meta.get(clientId);
    return m ? structuredClone(m) : undefined;
  }

  async setMeta(clientId: string, meta: OutboxMeta): Promise<void> {
    // Same first-open-ordering hazard as append() — see its comment.
    if (!this.opened) await this.ready();
    applyOp(this.state, { op: "meta", clientId, meta: structuredClone(meta) });
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
    // The ENTIRE body runs as ONE link chained onto `this.tail` — not "await ready(), then do
    // more stuff off-tail" as before. That old shape let `this.closed = true` and the final
    // `compact()`/`handle.close()` run OUTSIDE the serialization every other disk mutation
    // respects: a flush or compact racing concurrently with close() could interleave file-handle
    // use with it (both touching `journal.tmp`/the append handle), and `closed` could flip true
    // mid-flush, letting that flush's `return` resolve its callers' promises without ever writing
    // their batch (see OutboxClosedError's doc comment for the fix on that half). Chaining the
    // whole thing as one tail link makes "final drain, then compact-if-excess, then mark closed,
    // then close the handle" atomic relative to every other operation in this class: anything
    // already chained onto `this.tail` before this call runs first (the drain); anything chained
    // after (including a `write()` racing close()) runs only once this ENTIRE body — including
    // `this.closed = true` — has completed, and correctly observes `closed`.
    this.tail = this.tail.then(async () => {
      await this.openOnce(); // a close() before any op ever ran still needs a real handle to close
      // Final compaction: a threshold-triggered mid-stream compact() resets opCount to the live
      // state size, so a trailing run of ops shorter than COMPACT_THRESHOLD (e.g. ending the
      // session right after crossing the threshold once) never crosses it again and would
      // otherwise sit uncompacted on disk. Mirror openOnce's same excess check so a closed queue
      // is always left compacted at rest.
      if (this.opCount > this.state.entries.size + this.state.meta.size) await this.compact();
      this.closed = true;
      await this.handle?.close();
      this.handle = undefined;
    });
    return this.tail;
  }
}

/** Task 2 shape: direct open (no lock). Task 3 replaces this body with lock + probe-and-fallback
 *  around the same FsOutboxStorage. */
export function fsOutbox(opts: FsOutboxOptions): OutboxStorage & { stats: { flushes: number; fsyncs: number } } {
  return new FsOutboxStorage(resolve(opts.dir), opts.fsync !== false);
}
