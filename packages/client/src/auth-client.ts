/**
 * `createAuthClient` — a thin token-lifecycle manager over a `StackbaseClient` (auth slice A1).
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

/** The minimal `StackbaseClient` surface `createAuthClient` needs (kept structural for testability).
 *  `mutation` deliberately returns `Promise<unknown>` (not a generic) so `StackbaseClient`'s
 *  overloaded `mutation(...): Promise<Value>` is structurally assignable; call sites cast. */
export interface AuthManagedClient {
  setAuth(token: string | null): void;
  setSessionFingerprint(sessionId: string | null): void;
  mutation(ref: string, args?: Record<string, unknown>): Promise<unknown>;
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

const KEY = "stackbase.session";

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
    return { run: <T>(fn: () => Promise<T>) => locks.request("stackbase:auth:refresh", fn as () => Promise<unknown>) as Promise<T> };
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
  const ch = new BC("stackbase:auth:pair");
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

  function apply(next: SessionInfo | null): void {
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

  async function doRefresh(): Promise<void> {
    if (!info || closed) return;
    const before = info;
    try {
      const result = await lock.run(async () => {
        // Another tab may have rotated (and broadcast) while we queued for the lock: re-read storage
        // and, if a newer pair is present, adopt it instead of refreshing again.
        const latest = storage.load();
        if (latest && latest.refreshToken !== before.refreshToken) return { adopted: latest };
        const next = (await client.mutation(refreshPath, { refreshToken: before.refreshToken })) as SessionInfo;
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
        // storage; if a newer pair landed, adopt it — otherwise reschedule and try again.
        setTimeout(() => {
          if (closed) return;
          const latest = storage.load();
          if (latest && latest.refreshToken !== before.refreshToken) apply(latest);
          else schedule();
        }, 250);
        return;
      }
      if (code === "REFRESH_EXPIRED" || code === "REFRESH_REUSED") {
        apply(null);
        opts.onSignedOut?.();
        return;
      }
      // Transient/unknown: reschedule a retry.
      schedule();
    }
  }

  // Adopt a pair broadcast by another tab (it already committed the rotation server-side).
  broadcast.onMessage((incoming) => {
    if (closed || !info) return;
    if (incoming.refreshToken !== info.refreshToken) apply(incoming);
  });

  // Re-apply a persisted session on construction (reload continuity).
  if (info) apply(info);

  return {
    setSession(next) { apply(next); },
    clearSession() { apply(null); opts.onSignedOut?.(); },
    getSessionInfo() { return info; },
    close() {
      closed = true;
      if (timer) clearTimeout(timer);
      broadcast.close();
    },
  };
}
