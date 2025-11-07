/**
 * The IndexedDB-backed `OutboxStorage` (verdict §(d) decision 8, `docs/dev/research/offline-outbox/
 * verdict.md`). ONE database, `stackbase-outbox` — the whole seam (the shared mutation queue AND
 * per-clientId identity) lives together so an origin eviction takes BOTH atomically. That is
 * verdict §(g) hazard 1 ("whole-origin eviction... co-evict — one database") pinned structurally:
 * there is no separate identity store to fall out of sync with the queue, because there is only
 * one store to begin with.
 *
 * Schema (v1):
 *  - `entries` — keyPath `["clientId", "seq"]` (the durable identity pair, verdict §(b)'s governing
 *                invariant: `(clientId, seq) -> payload` written exactly once); index `order`
 *                (drain FIFO across the WHOLE shared queue, every clientId); index `status`
 *                (candidate scans — e.g. everything still `unsent`/`inflight` — consumed from a
 *                later task onward).
 *  - `meta`    — keyPath `"clientId"`; one row per clientId, `{clientId, nextSeq, deployment}`.
 *
 * Write-behind: every mutating call (`append`/`updateStatus`/`dequeue`/`setMeta`) enqueues a
 * pending op and schedules (once) a microtask flush that opens ONE `readwrite` transaction across
 * both stores and applies every op queued since the last flush, in call order. Callers that fire
 * several appends synchronously in the same microtask turn get ONE transaction, not N.
 */
import type { HydrateResult, OutboxEntry, OutboxEntryStatus, OutboxMeta, OutboxStorage } from "./outbox-storage";

/** Bump when the persisted entry shape changes incompatibly. A hydrate that finds an entry
 *  stamped with a different version DROPS it (verdict §(g) hazard 10) — never runs it, never
 *  guesses a migration. */
export const OUTBOX_VERSION = 1;

export const OUTBOX_DB_NAME = "stackbase-outbox";
const DB_VERSION = 1;
const ENTRIES_STORE = "entries";
const META_STORE = "meta";

/** Shared by both `OutboxStorage` implementations (`outbox-storage.ts`'s `memoryOutbox()` and this
 *  file's IndexedDB backend) so "stale-version entries are dropped, with the caller able to raise
 *  a verdict for them" is one rule, not two independently-maintained copies of it. */
export function dropStaleVersion(all: OutboxEntry[]): HydrateResult {
  const entries: OutboxEntry[] = [];
  const dropped: OutboxEntry[] = [];
  for (const e of all) {
    if (e.outboxVersion === OUTBOX_VERSION) entries.push(e);
    else dropped.push(e);
  }
  return { entries, dropped };
}

function promisifyRequest<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB request failed"));
  });
}

function promisifyTransaction(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error("IndexedDB transaction failed"));
    tx.onabort = () => reject(tx.error ?? new Error("IndexedDB transaction aborted"));
  });
}

function openDatabase(idbFactory: IDBFactory, dbName: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    let request: IDBOpenDBRequest;
    try {
      request = idbFactory.open(dbName, DB_VERSION);
    } catch (err) {
      reject(err);
      return;
    }
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(ENTRIES_STORE)) {
        const store = db.createObjectStore(ENTRIES_STORE, { keyPath: ["clientId", "seq"] });
        store.createIndex("order", "order", { unique: false });
        store.createIndex("status", "status", { unique: false });
      }
      if (!db.objectStoreNames.contains(META_STORE)) {
        db.createObjectStore(META_STORE, { keyPath: "clientId" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB open failed"));
    request.onblocked = () => reject(new Error("IndexedDB open blocked by another connection"));
  });
}

type PendingOp =
  | { kind: "append"; entry: OutboxEntry; resolve: () => void; reject: (e: unknown) => void }
  | {
      kind: "updateStatus";
      clientId: string;
      seq: number;
      status: OutboxEntryStatus;
      resolve: () => void;
      reject: (e: unknown) => void;
    }
  | { kind: "dequeue"; clientId: string; seq: number; resolve: () => void; reject: (e: unknown) => void }
  | { kind: "setMeta"; clientId: string; meta: OutboxMeta; resolve: () => void; reject: (e: unknown) => void };

/** Exported (beyond the `openIndexedDBOutbox` factory) so tests can inspect `txnCount` — the
 *  concrete write-behind-batching evidence — without reaching into module internals. */
export class IndexedDBOutboxStorage implements OutboxStorage {
  private queue: PendingOp[] = [];
  private flushScheduled = false;
  /** Exposed for tests only: how many `readwrite` transactions have actually been opened by the
   *  write-behind flush — the write-behind-batching property is "N appends in one microtask turn
   *  bump this by at most 1", not N. */
  txnCount = 0;

  constructor(private readonly db: IDBDatabase) {}

  private schedule(build: (resolve: () => void, reject: (e: unknown) => void) => PendingOp): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.queue.push(build(resolve, reject));
      if (!this.flushScheduled) {
        this.flushScheduled = true;
        queueMicrotask(() => void this.flush());
      }
    });
  }

  append(entry: OutboxEntry): Promise<void> {
    return this.schedule((resolve, reject) => ({ kind: "append", entry, resolve, reject }));
  }

  updateStatus(clientId: string, seq: number, status: OutboxEntryStatus): Promise<void> {
    return this.schedule((resolve, reject) => ({ kind: "updateStatus", clientId, seq, status, resolve, reject }));
  }

  dequeue(clientId: string, seq: number): Promise<void> {
    return this.schedule((resolve, reject) => ({ kind: "dequeue", clientId, seq, resolve, reject }));
  }

  setMeta(clientId: string, meta: OutboxMeta): Promise<void> {
    return this.schedule((resolve, reject) => ({ kind: "setMeta", clientId, meta, resolve, reject }));
  }

  private async flush(): Promise<void> {
    const ops = this.queue;
    this.queue = [];
    this.flushScheduled = false;
    if (ops.length === 0) return;

    this.txnCount++;
    let tx: IDBTransaction;
    try {
      tx = this.db.transaction([ENTRIES_STORE, META_STORE], "readwrite");
    } catch (err) {
      for (const op of ops) op.reject(err);
      return;
    }
    const entriesStore = tx.objectStore(ENTRIES_STORE);
    const metaStore = tx.objectStore(META_STORE);

    for (const op of ops) {
      switch (op.kind) {
        case "append":
          entriesStore.put(op.entry);
          break;
        case "updateStatus": {
          const getReq = entriesStore.get([op.clientId, op.seq]);
          getReq.onsuccess = () => {
            const existing = getReq.result as OutboxEntry | undefined;
            if (existing) entriesStore.put({ ...existing, status: op.status });
          };
          break;
        }
        case "dequeue":
          entriesStore.delete([op.clientId, op.seq]);
          break;
        case "setMeta":
          metaStore.put({ ...op.meta, clientId: op.clientId });
          break;
      }
    }

    try {
      await promisifyTransaction(tx);
      for (const op of ops) op.resolve();
    } catch (err) {
      for (const op of ops) op.reject(err);
    }
  }

  async getMeta(clientId: string): Promise<OutboxMeta | undefined> {
    const tx = this.db.transaction(META_STORE, "readonly");
    const row = (await promisifyRequest(tx.objectStore(META_STORE).get(clientId))) as
      | (OutboxMeta & { clientId: string })
      | undefined;
    if (!row) return undefined;
    const { clientId: _clientId, ...meta } = row;
    void _clientId;
    return meta;
  }

  async loadAll(): Promise<HydrateResult> {
    const tx = this.db.transaction(ENTRIES_STORE, "readonly");
    const all = (await promisifyRequest(tx.objectStore(ENTRIES_STORE).getAll())) as OutboxEntry[];
    all.sort((a, b) => a.order - b.order);
    const { entries, dropped } = dropStaleVersion(all);

    if (dropped.length > 0) {
      const delTx = this.db.transaction(ENTRIES_STORE, "readwrite");
      const store = delTx.objectStore(ENTRIES_STORE);
      for (const e of dropped) store.delete([e.clientId, e.seq]);
      await promisifyTransaction(delTx);
    }
    return { entries, dropped };
  }

  persist(): void {
    // Advisory only — no behavior anywhere branches on the grant (verdict §(g) hazard 3).
    if (typeof navigator !== "undefined" && navigator.storage?.persist) {
      void navigator.storage.persist().catch(() => {});
    }
  }
}

/** Open (creating if needed) the one shared outbox database and return a ready `OutboxStorage`.
 *  Rejects if `open()` fails — the caller (`outbox-storage.ts`'s `indexedDBOutbox()`) is what
 *  turns that rejection into the memory fallback; this function itself makes no fallback decision. */
export async function openIndexedDBOutbox(
  idbFactory: IDBFactory,
  dbName: string = OUTBOX_DB_NAME,
): Promise<IndexedDBOutboxStorage> {
  const db = await openDatabase(idbFactory, dbName);
  return new IndexedDBOutboxStorage(db);
}
