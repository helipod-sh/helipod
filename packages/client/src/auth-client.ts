/**
 * `createAuthClient` — a thin token-lifecycle manager over a `HelipodClient` (auth slice A1).
 * Sign-in flows stay ordinary app mutations; the app hands the mint result to `setSession`. From
 * there this manages: persistence (default `localStorage`, memory fallback), applying the access
 * token via `client.setAuth` + re-applying on reconnect (SetAuth replay handles the wire side),
 * refresh scheduling at ~80% of the access TTL, a Web-Locks single-refresher, a BroadcastChannel
 * pair broadcast to sibling tabs, `REFRESH_STALE` wait-for-broadcast, and terminal-clear +
 * `onSignedOut` on `REFRESH_EXPIRED`/`REFRESH_REUSED`. The outbox fingerprint is switched to the
 * stable `sessionId` while a session is managed (spec decision 9).
 *
 * Non-browser hosts fall back to in-process serialization (no Web Locks) and a no-op broadcast; two
 * independent PROCESSES sharing one refresh token is documented as unsupported (spec decision 5).
 */

/** The persisted mint result — the raw pair + the stable ids the manager needs across a reload. */
export interface SessionInfo {
  token: string;
  refreshToken: string;
  sessionId: string;
  userId: string;
  /** Absolute wall-clock ms when the ACCESS token expires (mint `expiresAt`). Drives the 80% schedule. */
  expiresAt: number;
}

/** The minimal `HelipodClient` surface `createAuthClient` needs (kept structural for testability).
 *  `mutation` deliberately returns `Promise<unknown>` (not a generic) so `HelipodClient`'s
 *  overloaded `mutation(...): Promise<Value>` is structurally assignable; call sites cast. */
export interface AuthManagedClient {
  setAuth(token: string | null): void;
  setSessionFingerprint(sessionId: string | null): void;
  /** `opts.transient` is threaded straight to `HelipodClient.mutation`'s own escape hatch — the
   *  refresh call below always passes `{ transient: true }` so a refresh mutation never durably
   *  enqueues, even when the app configured an `outbox` (see the file doc's outbox-fingerprint
   *  paragraph and `client.ts#mutation`'s doc for why replaying a refresh is never safe). */
  mutation(ref: string, args?: Record<string, unknown>, opts?: { transient?: boolean }): Promise<unknown>;
}

/** Pluggable synchronous session store (same shape idea as the outbox storage seam). */
export interface SessionStorage {
  load(): SessionInfo | null;
  save(info: SessionInfo): void;
  clear(): void;
}

/** A minimal single-refresher lock seam (a subset of the Web Locks API). Non-browser → in-process. */
export interface RefreshLock {
  run<T>(fn: () => Promise<T>): Promise<T>;
}

/** A minimal cross-tab broadcast seam over the new pair. */
export interface PairBroadcast {
  post(info: SessionInfo): void;
  onMessage(cb: (info: SessionInfo) => void): void;
  close(): void;
}

export interface CreateAuthClientOptions {
  storage?: SessionStorage;
  lock?: RefreshLock;
  broadcast?: PairBroadcast;
  /** Injectable clock (tests). Defaults to `Date.now`. */
  now?: () => number;
  /** Refresh at this fraction of the access TTL (default 0.8). */
  refreshAtFraction?: number;
  /** Called when the session terminally ends (REFRESH_EXPIRED / REFRESH_REUSED, or clearSession). */
  onSignedOut?: () => void;
  /** Fixed function path for the refresh mutation (default "auth:refresh"). */
  refreshPath?: string;
}

export interface AuthClient {
  setSession(info: SessionInfo): void;
  clearSession(): void;
  getSessionInfo(): SessionInfo | null;
  close(): void;
}

const KEY = "helipod.session";

/** The default `localStorage` key `localStorageSession()` persists under — a `SessionInfo` JSON
 *  blob, `.sessionId` being the field a headless host needs for `headless-drain.ts`'s `getSessionId`
 *  option (mirroring the SAME managed-session fingerprint a live tab's `setSessionFingerprint`
 *  computes). Exported so a Service Worker (which shares `localStorage`'s *origin* but typically not
 *  a synchronous API to it) or any other headless host can name the same storage row without
 *  hand-copying the string literal. A custom `storage`/key (via `localStorageSession(key)` or a
 *  fully custom `SessionStorage`) is, of course, this app's own convention to document instead. */
export const SESSION_STORAGE_KEY = KEY;

/** localStorage-backed store with an in-memory fallback wherever localStorage is unavailable/throws. */
export function localStorageSession(key = KEY): SessionStorage {
  let ls: Storage | undefined;
  try {
    ls = typeof localStorage !== "undefined" ? localStorage : undefined;
    if (ls) { ls.setItem(`${key}.probe`, "1"); ls.removeItem(`${key}.probe`); }
  } catch {
    ls = undefined;
  }
  if (!ls) return memorySession();
  return {
    load() {
      try { const raw = ls!.getItem(key); return raw ? (JSON.parse(raw) as SessionInfo) : null; } catch { return null; }
    },
    save(info) { try { ls!.setItem(key, JSON.stringify(info)); } catch { /* quota/private-mode: best-effort */ } },
    clear() { try { ls!.removeItem(key); } catch { /* best-effort */ } },
  };
}

/** In-memory store — nothing survives a reload; the default fallback and a test seam. */
export function memorySession(): SessionStorage {
  let cur: SessionInfo | null = null;
  return { load: () => cur, save: (i) => { cur = i; }, clear: () => { cur = null; } };
}

/** Web-Locks single-refresher when available (browser); otherwise a promise-chain in-process serializer. */
function defaultLock(): RefreshLock {
  const locks = typeof navigator !== "undefined" ? (navigator as unknown as { locks?: { request: (name: string, cb: () => Promise<unknown>) => Promise<unknown> } }).locks : undefined;
  if (locks) {
    return { run: <T>(fn: () => Promise<T>) => locks.request("helipod:auth:refresh", fn as () => Promise<unknown>) as Promise<T> };
  }
  let tail: Promise<unknown> = Promise.resolve();
  return {
    run<T>(fn: () => Promise<T>): Promise<T> {
      const next = tail.then(fn, fn);
      tail = next.catch(() => {});
      return next as Promise<T>;
    },
  };
}

/** BroadcastChannel when available; a no-op otherwise. */
function defaultBroadcast(): PairBroadcast {
  const BC = typeof BroadcastChannel !== "undefined" ? BroadcastChannel : undefined;
  if (!BC) return { post: () => {}, onMessage: () => {}, close: () => {} };
  const ch = new BC("helipod:auth:pair");
  return {
    post: (info) => ch.postMessage(info),
    onMessage: (cb) => { ch.onmessage = (e: MessageEvent) => cb(e.data as SessionInfo); },
    close: () => ch.close(),
  };
}

/** Extract the auth error code from a rejected mutation (spec: `err.code ?? err.message`). */
function codeOf(err: unknown): string {
  if (err && typeof err === "object") {
    const c = (err as { code?: unknown }).code;
    if (typeof c === "string") return c;
    const m = (err as { message?: unknown }).message;
    if (typeof m === "string") return m;
  }
  return String(err);
}

export function createAuthClient(client: AuthManagedClient, opts: CreateAuthClientOptions = {}): AuthClient {
  const storage = opts.storage ?? localStorageSession();
  const lock = opts.lock ?? defaultLock();
  const broadcast = opts.broadcast ?? defaultBroadcast();
  const now = opts.now ?? (() => Date.now());
  const fraction = opts.refreshAtFraction ?? 0.8;
  const refreshPath = opts.refreshPath ?? "auth:refresh";

  let info: SessionInfo | null = storage.load();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let closed = false;
  /** Consecutive generic (non-STALE, non-terminal) refresh failures — drives `scheduleBackoff()`'s
   *  exponential delay. Reset by `apply()` on any successful refresh or adopted pair. */
  let refreshFailureCount = 0;

  function apply(next: SessionInfo | null): void {
    refreshFailureCount = 0;
    info = next;
    if (next) {
      storage.save(next);
      client.setSessionFingerprint(next.sessionId);
      client.setAuth(next.token);
      schedule();
    } else {
      storage.clear();
      client.setSessionFingerprint(null);
      client.setAuth(null);
      if (timer) clearTimeout(timer);
    }
  }

  function schedule(): void {
    if (timer) clearTimeout(timer);
    if (!info || closed) return;
    // The access token was minted for `accessTtl = expiresAt - mintTime`; we don't store mintTime, so
    // approximate the remaining budget as `expiresAt - now` and fire at 80% of it (min 0). This is
    // exact right after a mint/rotation (the common case) and conservative afterward.
    const remaining = info.expiresAt - now();
    const delay = Math.max(0, remaining * fraction);
    timer = setTimeout(() => { void doRefresh(); }, delay);
  }

  const backoffBaseMs = 1000;
  const backoffCapMs = 60_000;

  /** Exponential backoff for a transient (non-STALE, non-terminal) refresh failure: 1s, 2s, 4s, … up
   *  to `backoffCapMs`. This is distinct from `schedule()`'s TTL-based delay, which is derived from
   *  `expiresAt - now()` and collapses to ~0 once `now() >= expiresAt` — using `schedule()` here would
   *  spin in a tight zero-delay retry loop for the rest of a server outage. `refreshFailureCount` is
   *  reset by `apply()` on the next successful refresh or adopted pair. */
  function scheduleBackoff(): void {
    if (timer) clearTimeout(timer);
    if (!info || closed) return;
    refreshFailureCount++;
    const delay = Math.min(backoffCapMs, backoffBaseMs * 2 ** (refreshFailureCount - 1));
    timer = setTimeout(() => { void doRefresh(); }, delay);
  }

  /** `expiresAt` moves strictly forward on every rotation (it's the new access token's absolute
   *  expiry), so it doubles as a monotonic generation marker. A foreign pair (re-read under the lock,
   *  or delivered via broadcast) must only be adopted when it is STRICTLY NEWER than our current one —
   *  adopting an older/foreign pair regresses our state and shared storage, which can cascade into a
   *  spurious `REFRESH_REUSED` forced sign-out (using a since-superseded refresh token) or a zero-delay
   *  retry loop (a stale `expiresAt` already in the past). */
  function isNewer(candidate: SessionInfo, currentInfo: SessionInfo): boolean {
    return candidate.refreshToken !== currentInfo.refreshToken && candidate.expiresAt > currentInfo.expiresAt;
  }

  async function doRefresh(): Promise<void> {
    if (!info || closed) return;
    const before = info;
    try {
      const result = await lock.run(async () => {
        // Another tab may have rotated (and broadcast) while we queued for the lock: re-read storage
        // and, if a newer pair is present, adopt it instead of refreshing again. See `isNewer` — a
        // naive refreshToken-diff check would also match an OLDER foreign pair.
        const latest = storage.load();
        if (latest && isNewer(latest, before)) return { adopted: latest };
        // `{ transient: true }` — never durably enqueue a refresh call (see `AuthManagedClient.mutation`'s
        // doc): a drain-replayed stale refresh after a reload has no live awaiter for the mint result
        // and risks rotating the session blind, tripping reuse-detection into a force sign-out.
        const next = (await client.mutation(refreshPath, { refreshToken: before.refreshToken }, { transient: true })) as SessionInfo;
        return { minted: next };
      });
      if (closed) return;
      if ("adopted" in result && result.adopted) { apply(result.adopted); return; }
      if ("minted" in result && result.minted) {
        apply(result.minted);
        broadcast.post(result.minted);      // tell sibling tabs about the winning pair
      }
    } catch (err) {
      if (closed) return;
      const code = codeOf(err);
      if (code === "REFRESH_STALE") {
        // Honest race: the winner's broadcast should arrive shortly. Wait briefly, then re-read
        // storage; if a newer pair landed, adopt it (see `isNewer`) — otherwise reschedule and try
        // again.
        setTimeout(() => {
          if (closed) return;
          const latest = storage.load();
          if (latest && isNewer(latest, before)) apply(latest);
          else schedule();
        }, 250);
        return;
      }
      if (code === "REFRESH_EXPIRED" || code === "REFRESH_REUSED") {
        apply(null);
        opts.onSignedOut?.();
        return;
      }
      // Transient/unknown (e.g. a network blip or server outage): back off exponentially rather than
      // `schedule()`'s TTL-based delay (see `scheduleBackoff`'s doc comment).
      scheduleBackoff();
    }
  }

  // Adopt a pair broadcast by another tab (it already committed the rotation server-side). Guarded by
  // `isNewer` (see its doc comment) so a stale/out-of-order/foreign broadcast can never regress us.
  broadcast.onMessage((incoming) => {
    if (closed || !info) return;
    if (isNewer(incoming, info)) apply(incoming);
  });

  // Re-apply a persisted session on construction (reload continuity).
  if (info) apply(info);

  return {
    setSession(next) { apply(next); },
    clearSession() { apply(null); opts.onSignedOut?.(); },
    getSessionInfo() { return info ? { ...info } : null; }, // shallow copy — never hand out the live internal object
    close() {
      closed = true;
      if (timer) clearTimeout(timer);
      broadcast.close();
    },
  };
}
