/**
 * `drainOutboxOnce` — the headless one-shot outbox drain (spec Part B, "The Background Sync seam").
 * A Service Worker (or any UI-less context) can drain the durable queue: one exported function, no
 * `StackbaseClient`, no queries, no optimistic layers. Chromium's one-shot Background Sync then
 * becomes a documented recipe ON TOP of this (`docs/enduser/offline.md`) — a progressive
 * enhancement on the drain TRIGGER, never the durability story: the portable baseline stays the IDB
 * queue + drain-on-next-visit; this function only improves WHEN the drain runs.
 *
 * Composition (one refactor, zero duplication of the state machine):
 *  - `webSocketTransport(opts.url)` — already SW-compatible (the global `WebSocket`, no DOM deps).
 *  - The SAME `Connect`-handshake helpers `StackbaseClient` uses (`./connect-handshake`), fed from
 *    the durable STORE instead of a live in-memory log (`outboxHeldFromStore`).
 *  - A ~60-line store-only {@link DrainHost}: no rendering, no promises, no optimistic layer —
 *    `addHydrated` collects into a local array (not `client.ts`'s reactive `MutationLog`);
 *    `settleApplied` just dequeues; `settleTerminal` just marks `"failed"`; `whenBaselineAdopted`
 *    resolves immediately (there are no live queries to re-baseline — the `expectTransition: false`
 *    shape `client.ts#beginBaselineAwait` already has a branch for).
 *  - The SAME exported {@link OutboxDrain} (`./outbox-drain`) — identity gate, poison policy,
 *    chunking, transient backoff are all reused unchanged, under the SAME deployment-scoped Web
 *    Locks name `client.ts` uses (`stackbase:outbox:<origin>:<deployment>`) — a live tab already
 *    draining makes this call an immediate, cheap no-op (`{drained: 0, failed: 0, remaining}` via a
 *    non-blocking `ifAvailable` probe): "locks are efficiency, not correctness" holds here too.
 *
 * Unlike `StackbaseClient`, this function does NOT implement the `known: true` per-seq classifying
 * settle (`client.ts#settleVerdict`) — it doesn't need to: every held seq gets resent regardless via
 * the normal drain flush, and the server's exact-match receipts dedup a resend of an already-settled
 * seq into a harmless replay-ack (`MutationResponse{replayed:true}` for a prior success, or the SAME
 * recorded `code` for a prior terminal failure) — the whole point of the Receipted Outbox. The ONE
 * thing that genuinely needs store-level handling is `known: false` (a swept/foreign timeline): a
 * blind resend under the SAME (now-disowned) identity risks nothing, but re-presenting an entry
 * whose fate is genuinely UNKNOWN (a persisted `"parked"` row — durable + in-flight when some prior
 * live tab's connection dropped) under a FRESH clientId could double-apply if it secretly already
 * committed — so `"parked"` rows terminal-fail loudly (`OFFLINE_CLIENT_RESET`) exactly as
 * `client.ts#onClientReset` does for a live park, while `"unsent"` rows (never sent, safe either
 * way) simply re-enqueue under the fresh identity, store-level (dequeue the old row, append the new).
 */
import type { ServerMessage } from "@stackbase/sync";
import type { PendingMutation } from "./mutation-log";
import { buildConnectMessage, outboxHeldFromStore } from "./connect-handshake";
import { OutboxDrain, type DrainHost, type OutboxLockManager, type PoisonPolicy } from "./outbox-drain";
import { type ClientTransport, webSocketTransport } from "./transport";
import { OUTBOX_VERSION, defaultMintClientId, indexedDBOutbox, type OutboxEntry, type OutboxStorage } from "./outbox-storage";

export interface HeadlessDrainOptions {
  /** The ws(s) sync endpoint. Ignored when `_transport` is injected (tests). */
  url: string;
  /** Defaults to `indexedDBOutbox()` — IndexedDB exists in a Service Worker just as it does in a
   *  tab, so the SAME durable queue a live client wrote is readable here with no extra plumbing. */
  outbox?: OutboxStorage;
  /** Distinguishes the drain's Web Locks name per deployment, matching a live client's own
   *  `outboxDeployment` constructor option (`client.ts:320`'s naming) — MUST agree with whatever a
   *  live tab configured, or the two will never contend for the same lock. Defaults to `"default"`. */
  deployment?: string;
  /** SW-readable auth (the app owns SW-readable token storage — this function only documents the
   *  constraint, it does not build one). Replayed as `SetAuth` BEFORE `Connect`, exactly as a
   *  reconnecting `StackbaseClient` replays its last-set token. */
  getAuthToken?: () => Promise<string | null>;
  /** How a coded (terminal, server-recorded) failure is handled — `"skip"` (default: settle
   *  terminally and continue) or `"pause"` (halt the whole drain and surface via `onPause`). */
  poisonPolicy?: PoisonPolicy;
  /** The whole-drain wall-clock budget — after this the socket is closed and the current counts are
   *  returned, whatever state the drain is in. Default 30 000ms. */
  timeoutMs?: number;
  /** The Web Locks manager — `undefined` probes the ambient `navigator.locks`, `null` forces
   *  single-tab (no contention check at all — ALWAYS drains), an object is used directly (tests
   *  inject a fake). Mirrors `OutboxDrainOptions.locks`. */
  locks?: OutboxLockManager | null;
  /** @internal test seam — inject a transport instead of opening a real WebSocket. Kept
   *  underscore-internal: not part of the documented public surface. */
  _transport?: ClientTransport;
}

/** The origin component of the drain's Web Locks name — mirrors `client.ts#originTag` verbatim (a
 *  Service Worker's global scope has `location` too; Node/tests share one stable fallback). MUST
 *  compute the SAME value a live tab's `StackbaseClient` would, or the two never contend for the
 *  same lock. */
function originTag(): string {
  const loc = (globalThis as { location?: { origin?: string } }).location;
  return loc?.origin ?? "app";
}

/** SHA-256 hex digest — a local mirror of `client.ts#sha256Hex` (same duplication discipline as
 *  `outbox-drain.ts`'s `computeDrainBackoff`: a browser SDK file must not grow a cross-file runtime
 *  dependency for one six-line hash, but the TWO copies must stay byte-identical). */
async function sha256Hex(input: string): Promise<string> {
  const bytes = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Probe the ambient `navigator.locks`, wrapped into the seam — a local mirror of
 *  `outbox-drain.ts`'s private `probeLockManager` (unexported there, so duplicated here rather than
 *  widening that file's public surface for one caller). */
function probeLockManager(): OutboxLockManager | undefined {
  const nav = (globalThis as { navigator?: { locks?: { request?: unknown } } }).navigator;
  const locks = nav?.locks;
  if (locks && typeof locks.request === "function") {
    return {
      request: (name, options, callback) => (locks as { request: OutboxLockManager["request"] }).request(name, options, callback),
    };
  }
  return undefined;
}

/** A non-blocking availability check: `{ifAvailable: true}` per the real Web Locks contract invokes
 *  the callback with `null` (never queues) when the lock is currently held elsewhere. Our own
 *  `OutboxLockManager.request`'s declared callback type (`() => Promise<unknown>`) omits that
 *  parameter — structurally still assignable here (a function that reads an EXTRA optional param a
 *  caller doesn't have to pass still satisfies a narrower declared type), so this is the one place
 *  that reads the real lock object. A callback invoked with no argument at all (a fake that doesn't
 *  implement `ifAvailable` semantics) is treated as "available" — the permissive default. */
async function isLockAvailable(locks: OutboxLockManager, name: string): Promise<boolean> {
  let available = false;
  await locks.request(name, { ifAvailable: true }, (async (lock?: unknown) => {
    available = lock !== null;
  }) as () => Promise<unknown>);
  return available;
}

function countActive(entries: OutboxEntry[]): number {
  return entries.filter((e) => e.status === "unsent" || e.status === "inflight" || e.status === "parked").length;
}

function toOutboxEntry(entry: PendingMutation): OutboxEntry {
  return {
    clientId: entry.clientId!,
    seq: entry.seq!,
    requestId: entry.requestId,
    udfPath: entry.udfPath,
    args: entry.args,
    seed: entry.seed,
    order: entry.order!,
    status: "unsent",
    identityFingerprint: entry.identityFingerprint,
    outboxVersion: OUTBOX_VERSION,
    enqueuedAt: entry.enqueuedAt ?? Date.now(),
  };
}

/**
 * Drain the durable outbox once: connect, hand `Connect`+`MutationBatch` traffic to the SAME
 * {@link OutboxDrain} state machine a live tab uses, and resolve once the queue is empty/terminal
 * or `timeoutMs` elapses — whichever comes first. Safe to call from a Service Worker's `sync` event
 * handler inside `event.waitUntil(...)`, or from any other script with no live `StackbaseClient`.
 */
export async function drainOutboxOnce(opts: HeadlessDrainOptions): Promise<{ drained: number; failed: number; remaining: number }> {
  const outbox = opts.outbox ?? indexedDBOutbox();
  const deployment = opts.deployment ?? "default";
  const lockName = `stackbase:outbox:${originTag()}:${deployment}`;
  const timeoutMs = opts.timeoutMs ?? 30_000;

  const initial = await outbox.loadAll();
  if (countActive(initial.entries) === 0) {
    // Nothing to do — mirrors `StackbaseClient`'s own "an EMPTY outbox sends NO first-connect
    // Connect" byte-identical short-circuit (`outbox-drain.ts#becomeLeader`'s `drainable().length >
    // 0` gate), just one level up: skip the lock probe and the socket entirely.
    return { drained: 0, failed: 0, remaining: 0 };
  }

  const locks = opts.locks === undefined ? probeLockManager() : (opts.locks ?? undefined);
  if (locks) {
    const available = await isLockAvailable(locks, lockName);
    if (!available) {
      // A live tab already holds the leader lock — it is already draining this exact queue. Our job
      // is done without opening a socket at all ("locks are efficiency, not correctness": the SAME
      // safety would hold even if we raced ahead and drained too — receipts dedup either way).
      return { drained: 0, failed: 0, remaining: countActive(initial.entries) };
    }
  }

  const transport = opts._transport ?? webSocketTransport(opts.url, { reconnect: false });

  // Auth BEFORE Connect (mirrors `client.ts#onTransportReopened`'s "SetAuth replay first"):
  // resolved here, synchronously ahead of `drain.start()`, so `currentFingerprint()` below is
  // already correct by the time the flush-time identity gate ever reads it — no race to gate on.
  let fingerprint = "anon";
  if (opts.getAuthToken) {
    const token = await opts.getAuthToken();
    if (token) {
      transport.send({ type: "SetAuth", token });
      fingerprint = await sha256Hex(token);
    }
  }

  let drained = 0;
  let failed = 0;
  let armed = false;
  let closed = false;
  let connectSent = false;
  let orderCounter = Date.now();
  const log = new Map<string, PendingMutation>();
  let nextRequestId = 1;

  const heldAtConnect = outboxHeldFromStore(initial.entries);

  function addHydrated(e: OutboxEntry): void {
    for (const existing of log.values()) {
      if (existing.clientId === e.clientId && existing.seq === e.seq) return;
    }
    // A persisted `"parked"` row's fate is genuinely unknown (in-flight when some prior live tab's
    // connection dropped) — preserved so a `known: false` reset treats it with the SAME caution
    // `client.ts#onClientReset` gives a live park (reject loudly, never blind-resend under a fresh
    // identity). Every other persisted status (`"unsent"`/`"inflight"`) normalizes to `"unsent"` —
    // safe to (re)send either way, mirroring `client.ts#addHydratedEntry`'s own normalization.
    const status: PendingMutation["status"] = e.status === "parked" ? { type: "parked" } : { type: "unsent" };
    const entry: PendingMutation = {
      requestId: String(nextRequestId++),
      udfPath: e.udfPath,
      args: e.args,
      seed: e.seed,
      touched: new Set(),
      status,
      clientId: e.clientId,
      seq: e.seq,
      order: e.order,
      identityFingerprint: e.identityFingerprint,
      enqueuedAt: e.enqueuedAt,
      durable: true,
    };
    log.set(entry.requestId, entry);
  }

  function drainable(): PendingMutation[] {
    // Mirrors `client.ts#drainableEntries` exactly: durable, recorded `(clientId, seq)`, still
    // `unsent`/`parked`, FIFO by persisted `order`.
    return [...log.values()]
      .filter((e) => e.clientId !== undefined && e.seq !== undefined && e.durable === true && (e.status.type === "unsent" || e.status.type === "parked"))
      .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  }

  let doneResolve: (() => void) | undefined;
  function checkDone(): void {
    if (log.size === 0 || drain.isPaused) doneResolve?.();
  }

  const host: DrainHost = {
    outbox,
    // No live identity is ever minted for NEW mutations here (this function never calls
    // `mutation()`) — nothing of this session's own needs protecting from `pruneDeadMeta`.
    currentClientId: () => undefined,
    currentFingerprint: () => fingerprint,
    transportOpen: () => !closed,
    isArmed: () => armed,
    drainable,
    addHydrated,
    ensureInitialHandshake: () => {
      if (connectSent) return;
      connectSent = true;
      transport.send(buildConnectMessage(`${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`, undefined, heldAtConnect));
    },
    setStatus: (entry, status) => {
      entry.status = { type: status };
      if (entry.clientId !== undefined && entry.seq !== undefined) {
        void outbox.updateStatus(entry.clientId, entry.seq, status).catch(() => {});
      }
    },
    batchEntry: (entry) => ({ requestId: entry.requestId, udfPath: entry.udfPath, args: entry.args, clientId: entry.clientId, seq: entry.seq }),
    sendBatch: (entries) => transport.send({ type: "MutationBatch", entries }),
    settleApplied: (requestId) => {
      const entry = log.get(requestId);
      log.delete(requestId);
      if (entry?.clientId !== undefined && entry.seq !== undefined) void outbox.dequeue(entry.clientId, entry.seq).catch(() => {});
      drained++;
      checkDone();
    },
    settleTerminal: (requestId, code, message) => {
      const entry = log.get(requestId);
      log.delete(requestId);
      if (entry?.clientId !== undefined && entry.seq !== undefined) {
        void outbox.updateStatus(entry.clientId, entry.seq, "failed", { message, code }).catch(() => {});
      }
      failed++;
      checkDone();
    },
    // No live queries — nothing to re-baseline (matches `client.ts#beginBaselineAwait`'s
    // `expectTransition: false` branch, which adopts immediately with nothing to wait for).
    whenBaselineAdopted: () => Promise.resolve(),
  };

  const drain = new OutboxDrain(host, {
    lockName,
    locks: opts.locks,
    poisonPolicy: opts.poisonPolicy ?? "skip",
    intervalMs: 0, // one-shot: progress is driven by responses/backoff timers, not a periodic nudge
    onPause: () => checkDone(),
  });

  /** `known: false` (verdict §(d) Retention, store-level): re-mint a fresh clientId; re-enqueue
   *  every `"unsent"` entry under it with a NEW seq (dequeue the old durable row, append the new);
   *  terminal-fail every `"parked"` entry LOUDLY (`OFFLINE_CLIENT_RESET`) instead — see the file
   *  doc's "genuinely unknown fate" note. Mirrors `client.ts#onClientReset`, store-level only (no
   *  promises to reject/resolve, no layers to drop). */
  async function handleClientReset(): Promise<void> {
    const fresh = defaultMintClientId();
    let freshSeq = 0;
    for (const entry of [...log.values()]) {
      if (entry.status.type === "parked") {
        log.delete(entry.requestId);
        failed++;
        if (entry.clientId !== undefined && entry.seq !== undefined) {
          void outbox
            .updateStatus(entry.clientId, entry.seq, "failed", {
              message: "the server disowned this client's mutation history (swept/foreign timeline)",
              code: "OFFLINE_CLIENT_RESET",
            })
            .catch(() => {});
        }
      } else if (entry.status.type === "unsent") {
        const oldClientId = entry.clientId;
        const oldSeq = entry.seq;
        entry.clientId = fresh;
        entry.seq = freshSeq++;
        entry.order = ++orderCounter;
        if (oldClientId !== undefined && oldSeq !== undefined) void outbox.dequeue(oldClientId, oldSeq).catch(() => {});
        void outbox.append(toOutboxEntry(entry)).catch(() => {});
      }
    }
    await outbox.setMeta(fresh, { nextSeq: freshSeq, deployment });
  }

  const disposeMessage = transport.onMessage((msg: ServerMessage) => {
    if (msg.type === "MutationResponse") {
      if (drain.handles(msg.requestId)) drain.onResponse(msg);
      return;
    }
    if (msg.type === "ConnectAck") {
      armed = true;
      if (msg.known) {
        drain.nudge();
      } else {
        void handleClientReset().then(() => {
          drain.nudge();
          checkDone();
        });
      }
    }
  });
  const disposeClose = transport.onClose(() => {
    closed = true;
    drain.onTransportClosed();
  });

  const donePromise = new Promise<void>((resolve) => {
    doneResolve = resolve;
  });
  drain.start();
  await Promise.race([donePromise, new Promise<void>((resolve) => setTimeout(resolve, timeoutMs))]);

  drain.stop();
  disposeMessage();
  disposeClose();
  transport.close();

  return { drained, failed, remaining: log.size };
}
