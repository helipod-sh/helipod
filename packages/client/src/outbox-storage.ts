/**
 * The `OutboxStorage` seam — the client's first storage API (verdict §(d), `docs/dev/research/
 * offline-outbox/verdict.md`). Two implementations: `memoryOutbox()` (the default — preserves
 * today's behavior byte-for-byte; nothing persists across a reload) and `indexedDBOutbox()`
 * (probe-and-fallback: real durability in a browser, transparently degrades to `memoryOutbox()`
 * wherever IndexedDB is unavailable or fails to open — Node, private-mode Safari, a corrupt
 * origin). Durability is opt-in constructor config (`new StackbaseClient(transport, { outbox:
 * indexedDBOutbox() })`); a client constructed without `outbox` never touches this file's runtime
 * branches that matter — `memoryOutbox()`'s Maps are just as ephemeral as the pre-outbox client.
 *
 * Persisted record shape is verdict §(d) verbatim: `{clientId, seq, requestId, udfPath, args, seed,
 * order, status, identityFingerprint, outboxVersion, enqueuedAt}`. `order` is an explicit column —
 * Map/array insertion order does not survive IndexedDB, and the drain (a later task) needs a
 * persisted total order across the WHOLE shared queue (every clientId sharing this database), not
 * just within one clientId's entries.
 *
 * Identity (verdict §(d) "Identity", hazard 8): **one clientId per tab-session, minted at client
 * construction, never reused across a reload.** A fresh `StackbaseClient` instance always mints a
 * BRAND NEW clientId — there is no reseed protocol, so there is nothing to get wrong (hazard 8:
 * "reload resets counters — dissolved structurally"). Entries persisted under an OLDER clientId
 * from a previous session are untouched by minting a new one; they hydrate and drain under their
 * own **recorded** `(clientId, seq)` pair later (a later task's drain). The "-or-loaded" half of
 * `mintIdentity` concerns `nextSeq`, not `clientId`: a fresh clientId's meta row does not exist, so
 * `nextSeq` starts at 0 — but the loader still calls `getMeta` first rather than assuming absence,
 * so a colliding clientId (astronomically unlikely — see `defaultMintClientId`) resumes from its
 * recorded `nextSeq` instead of silently reusing a seq that already named a payload (verdict §(b)'s
 * governing invariant: the map `(clientId, seq) -> payload` is written exactly once).
 */
import type { JSONValue } from "@stackbase/values";
import { OUTBOX_DB_NAME, OUTBOX_VERSION, dropStaleVersion, openIndexedDBOutbox } from "./outbox-idb";

export { OUTBOX_VERSION };

export type OutboxEntryStatus = "unsent" | "inflight" | "parked" | "completed" | "failed";

/** T5 (R9): the terminal verdict recorded alongside a `"failed"` durable entry — surfaced through
 *  `client.pendingMutations()`/`usePendingMutations()` and `onMutationFailed`. */
export interface OutboxEntryError {
  message: string;
  code?: string;
}

/** One durable outbox record — the persisted twin of `PendingMutation` (`./mutation-log`), plus
 *  the fields only a durable queue needs (`clientId`, `seq`, `order`, `identityFingerprint`,
 *  `outboxVersion`, `enqueuedAt`). `args`/`seed` are the fields whose omission would make a
 *  hydrated replay non-deterministic (verdict D2) — everything else (`touched`, the `update`
 *  closure) is recomputed or looked up in the optimistic-updater registry, never persisted. */
export interface OutboxEntry {
  clientId: string;
  seq: number;
  requestId: string;
  udfPath: string;
  args: JSONValue;
  seed: { entropy: string; now: number };
  /** Global position across the WHOLE shared queue (every clientId) — the drain's FIFO key. */
  order: number;
  status: OutboxEntryStatus;
  /** SHA-256 of the `SetAuth` token at enqueue time; absent for an unauthenticated mutation. Set
   *  at flush-time by a later task; carried as a plain field here so the schema is stable from
   *  day one (verdict §(g) hazard 9). */
  identityFingerprint?: string;
  outboxVersion: number;
  enqueuedAt: number;
  /** T5 (R9): set (via `updateStatus`'s optional 4th argument) when `status` transitions to
   *  `"failed"` — a terminal, server-recorded verdict a live `mutation()` promise may have no
   *  awaiter for (a hydrated cross-reload entry, or a retried one). Absent for every other status. */
  error?: OutboxEntryError;
}

export interface OutboxMeta {
  /** In-memory-serial cursor for this clientId's NEXT mutation, loaded once at mint time. */
  nextSeq: number;
  deployment?: string;
}

/** The result of a full-queue hydrate. `dropped` holds entries whose `outboxVersion` didn't match
 *  the running code's `OUTBOX_VERSION` — removed from storage as a side effect of the hydrate
 *  itself, returned so the caller can settle them with a terminal verdict rather than silently
 *  discarding a promise's fate (verdict §(g) hazard 10: "outboxVersion stamp, drop-with-verdict at
 *  hydrate"). */
export interface HydrateResult {
  /** Current-version entries, in persisted `order`. */
  entries: OutboxEntry[];
  /** Stale-version entries deleted during this hydrate. */
  dropped: OutboxEntry[];
}

/** The seam. Every method is safe to call concurrently — the IndexedDB implementation
 *  write-behind-batches same-microtask calls into one transaction (see `outbox-idb.ts`). */
export interface OutboxStorage {
  /** Durably record a new entry. The caller must NOT await this before sending the mutation on the
   *  wire — "the send never waits for the append" (verdict §(d)); this promise exists so a caller
   *  CAN confirm durability later (e.g. park-eligibility at transport close). */
  append(entry: OutboxEntry): Promise<void>;
  /** Mutate only `status` (and, when given, `error` — T5's R9 terminal-failure record; every other
   *  field is preserved verbatim). Called with `status: "failed"` INSTEAD OF `dequeue()` on a
   *  terminal failure (verdict §(d) R9: "failed entries persist until dismissed/retried") — every
   *  other status transition (`"inflight"`/`"unsent"`/`"parked"`) omits `error`. */
  updateStatus(clientId: string, seq: number, status: OutboxEntryStatus, error?: OutboxEntryError): Promise<void>;
  /** Remove a fully-settled entry. */
  dequeue(clientId: string, seq: number): Promise<void>;
  /** Hydrate the whole shared queue, across every clientId, in persisted `order`. */
  loadAll(): Promise<HydrateResult>;
  getMeta(clientId: string): Promise<OutboxMeta | undefined>;
  setMeta(clientId: string, meta: OutboxMeta): Promise<void>;
  /** OPTIONAL (verdict §(g) hazard 1 / Task 4's dead-meta prune): every clientId with a meta row.
   *  The drain uses it at hydrate to reclaim rows for clientIds that are neither the current session
   *  nor have any live queue entries — one such tiny row otherwise accrues per prior tab-session and
   *  every `onClientReset`. Optional so a minimal `OutboxStorage` double (which never prunes) stays
   *  valid; both shipped backends implement it. */
  listMetaClientIds?(): Promise<string[]>;
  /** OPTIONAL companion to {@link listMetaClientIds} — delete one dead meta row. */
  deleteMeta?(clientId: string): Promise<void>;
  /** Advisory `navigator.storage.persist()` request — fire-and-forget, no return value, and no
   *  behavior anywhere ever branches on whether the grant is honored (verdict §(g) hazard 3: "zero
   *  behavior branches on the grant"). A no-op for the memory backend. */
  persist(): void;
}

/** Default cap on how many outbox-tracked entries (`unsent`/`inflight`/`parked` — not yet fully
 *  settled) may sit in `client.ts`'s live log at once, per verdict §(d) "Enqueue": "bounded
 *  (default 1000)". Overridable via `new StackbaseClient(transport, { outboxMaxQueueSize })`. */
export const DEFAULT_OUTBOX_MAX_QUEUE_SIZE = 1000;

/** Thrown (as a rejected `mutation()` promise, never a synchronous throw) when the durable outbox
 *  is at capacity. Verdict §(d): the NEW enqueue is rejected, not the oldest queued one — "the new
 *  write has a live awaiter [this very call]; the oldest durable promise may not [e.g. it survived
 *  a reload, where there is no live JS promise for it at all until the registry rebuilds a layer]."
 *  A coded error (`.code`) so callers can distinguish this from every other mutation failure. */
export class OutboxOverflowError extends Error {
  readonly code = "OUTBOX_OVERFLOW";
  constructor(
    message = "the durable outbox is full — this mutation was rejected so an already-queued promise, " +
      "which may have no live awaiter across a reload, is never silently evicted",
  ) {
    super(message);
    this.name = "OutboxOverflowError";
  }
}

/** Rejection for a parked mutation the server disowned on `ConnectAck{known: false}` — the client's
 *  presented history matched neither a record nor a floor (a swept/foreign/reset timeline), so the
 *  client re-mints its identity (`onClientReset`). A parked entry was in-flight when the socket
 *  dropped: its outcome is genuinely unknowable and, since the server has no dedup record for it,
 *  a blind resend under a fresh clientId could double-apply — so it rejects LOUDLY (verdict §(d)
 *  Retention: "parked entries reject loudly"). Coded so apps can distinguish it from every other
 *  failure. `unsent` entries (never hit the wire) are safe to re-enqueue instead and are NOT
 *  rejected. */
export class OfflineClientResetError extends Error {
  readonly code = "OFFLINE_CLIENT_RESET";
  constructor(
    message = "the server disowned this client's mutation history (swept/foreign timeline); its " +
      "identity was reset and this in-flight-at-disconnect mutation, whose outcome is unknowable, " +
      "was rejected rather than blindly resent",
  ) {
    super(message);
    this.name = "OfflineClientResetError";
  }
}

/** The in-memory default — what a client gets when it passes no `outbox` at all. Nothing here
 *  survives past this `StackbaseClient` instance's lifetime, which is exactly today's (pre-outbox)
 *  behavior: a reload has no durable queue to hydrate, because there never was one. */
export function memoryOutbox(): OutboxStorage {
  const entries = new Map<string, OutboxEntry>();
  const meta = new Map<string, OutboxMeta>();
  const key = (clientId: string, seq: number) => `${clientId}\0${seq}`;

  return {
    async append(entry) {
      entries.set(key(entry.clientId, entry.seq), { ...entry });
    },
    async updateStatus(clientId, seq, status, error) {
      const existing = entries.get(key(clientId, seq));
      if (existing) entries.set(key(clientId, seq), { ...existing, status, ...(error !== undefined ? { error } : {}) });
    },
    async dequeue(clientId, seq) {
      entries.delete(key(clientId, seq));
    },
    async loadAll() {
      const all = [...entries.values()].sort((a, b) => a.order - b.order);
      const { entries: current, dropped } = dropStaleVersion(all);
      for (const e of dropped) entries.delete(key(e.clientId, e.seq));
      return { entries: current, dropped };
    },
    async getMeta(clientId) {
      const m = meta.get(clientId);
      return m ? { ...m } : undefined;
    },
    async setMeta(clientId, m) {
      meta.set(clientId, { ...m });
    },
    async listMetaClientIds() {
      return [...meta.keys()];
    },
    async deleteMeta(clientId) {
      meta.delete(clientId);
    },
    persist() {
      // No-op: nothing here survives a reload anyway, so there is nothing worth asking the
      // browser to protect from eviction.
    },
  };
}

export interface IndexedDBOutboxOptions {
  /** Injectable for tests / non-default globals — defaults to `globalThis.indexedDB`. */
  indexedDB?: IDBFactory;
  dbName?: string;
  /** Best-effort, fire-and-forget notification whenever the adapter falls back to memory — e.g.
   *  no IndexedDB in this runtime, or `open()` failed (private-mode Safari, a corrupt origin). The
   *  fallback itself is never gated on this callback existing or succeeding. */
  onFallback?: (reason: unknown) => void;
}

/** Probe-and-fallback (verdict §(g) hazard 5): if IndexedDB isn't available in this runtime at
 *  all, or `open()` fails for any reason, every method transparently delegates to a fresh
 *  `memoryOutbox()` instead — same interface, same call sites, only durability is lost. The probe
 *  is asynchronous (an IDB `open()` can only fail asynchronously), so calls made before the
 *  outcome is known queue behind the open attempt; every call after routes directly with no added
 *  latency. */
export function indexedDBOutbox(opts: IndexedDBOutboxOptions = {}): OutboxStorage {
  const idbFactory = opts.indexedDB ?? (typeof indexedDB !== "undefined" ? indexedDB : undefined);
  if (!idbFactory) {
    opts.onFallback?.(new Error("IndexedDB is not available in this runtime"));
    return memoryOutbox();
  }

  let resolved: OutboxStorage | undefined;
  const ready: Promise<OutboxStorage> = openIndexedDBOutbox(idbFactory, opts.dbName ?? OUTBOX_DB_NAME).catch((err: unknown) => {
    opts.onFallback?.(err);
    return memoryOutbox();
  });
  void ready.then((impl) => {
    resolved = impl;
  });

  const impl = async (): Promise<OutboxStorage> => resolved ?? ready;

  return {
    append: async (entry) => (await impl()).append(entry),
    updateStatus: async (clientId, seq, status, error) => (await impl()).updateStatus(clientId, seq, status, error),
    dequeue: async (clientId, seq) => (await impl()).dequeue(clientId, seq),
    loadAll: async () => (await impl()).loadAll(),
    getMeta: async (clientId) => (await impl()).getMeta(clientId),
    setMeta: async (clientId, meta) => (await impl()).setMeta(clientId, meta),
    listMetaClientIds: async () => (await impl()).listMetaClientIds?.() ?? [],
    deleteMeta: async (clientId) => (await impl()).deleteMeta?.(clientId),
    persist: () => {
      // Advisory-only — fire-and-forget even the routing to the resolved implementation.
      void impl().then((i) => i.persist());
    },
  };
}

let identityEntropyCounter = 0;
/** Not `crypto.randomUUID()` unconditionally — some test/SSR runtimes lack it. Collision odds are
 *  irrelevant either way: `mintIdentity` re-reads `getMeta` for whatever id comes out, so even a
 *  freak collision resumes from a recorded `nextSeq` rather than silently reusing a seq.
 *
 *  Exported (beyond `mintIdentity`'s internal default) so `client.ts` can mint a clientId
 *  SYNCHRONOUSLY at construction — `mutation()` must stay fully synchronous (T1's open concern),
 *  so the clientId every entry stamps cannot wait on `mintIdentity`'s async `getMeta`/`setMeta`
 *  round-trip. `client.ts` mints with this directly, then feeds the SAME id into `mintIdentity` via
 *  `opts.mintClientId` so the durable meta row it persists names the id actually in use. */
export function defaultMintClientId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return `c-${Date.now().toString(36)}-${(identityEntropyCounter++).toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Mint this tab-session's clientId and establish its `nextSeq` cursor in the outbox's meta store.
 * Per the file doc's identity model: ALWAYS mints a fresh clientId — never reuses one from a prior
 * session. Returns `{clientId, nextSeq}`; the caller (client construction) keeps `nextSeq` as an
 * in-memory serial counter from here on (verdict §(d): "seqs minted serially in-memory per tab") —
 * it is not re-read from storage again this session.
 */
export async function mintIdentity(
  storage: OutboxStorage,
  opts: { deployment?: string; mintClientId?: () => string } = {},
): Promise<{ clientId: string; nextSeq: number }> {
  const clientId = (opts.mintClientId ?? defaultMintClientId)();
  const existing = await storage.getMeta(clientId);
  const nextSeq = existing?.nextSeq ?? 0;
  await storage.setMeta(clientId, { nextSeq, deployment: opts.deployment });
  return { clientId, nextSeq };
}
