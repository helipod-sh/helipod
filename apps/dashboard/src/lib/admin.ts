/**
 * Client for the `/_admin/*` API. Local dev injects `window.__ADMIN_KEY__`. For a self-host bind
 * (no injected key — so the secret isn't embedded in unauthenticated HTML) we prompt once and keep
 * the key in sessionStorage.
 */
function resolveKey(): string {
  const injected = (window as unknown as { __ADMIN_KEY__?: string }).__ADMIN_KEY__;
  if (typeof injected === "string" && injected) return injected;
  const stored = sessionStorage.getItem("sb_admin_key");
  if (stored) return stored;
  const entered = window.prompt("Stackbase admin key (STACKBASE_ADMIN_KEY):") ?? "";
  if (entered) sessionStorage.setItem("sb_admin_key", entered);
  return entered;
}
const KEY: string = resolveKey();
const authHeaders = { Authorization: `Bearer ${KEY}`, "content-type": "application/json" };

export async function adminGet<T>(path: string): Promise<T> {
  const r = await fetch(`/_admin${path}`, { headers: authHeaders });
  if (!r.ok) throw new Error(`admin ${path} → HTTP ${r.status}`);
  return r.json() as Promise<T>;
}

export async function adminSend<T>(method: string, path: string, body?: unknown): Promise<T> {
  const r = await fetch(`/_admin${path}`, {
    method,
    headers: authHeaders,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!r.ok) {
    const b = (await r.json().catch(() => ({}))) as { error?: string };
    throw new Error(b.error ?? `admin ${path} → HTTP ${r.status}`);
  }
  return r.json() as Promise<T>;
}

export type TableInfo = { name: string; indexes: string[]; shardKey?: string; documentCount: number };
export type TableData = { documents: Record<string, unknown>[]; total: number; page: number; pageSize: number };
export type FnInfo = { path: string; kind: string };
export type LogEntry = { id: number; path: string; kind: string; ts: number; durationMs: number; status: string; error?: string };
