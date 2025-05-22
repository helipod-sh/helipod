/** Client for the `/_admin/*` API. The dev server injects `window.__ADMIN_KEY__` same-origin. */
const KEY: string = (window as unknown as { __ADMIN_KEY__?: string }).__ADMIN_KEY__ ?? "";
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
  return r.json() as Promise<T>;
}

export type TableInfo = { name: string; indexes: string[]; shardKey?: string; documentCount: number };
export type TableData = { documents: Record<string, unknown>[]; total: number; page: number; pageSize: number };
export type FnInfo = { path: string; kind: string };
export type LogEntry = { id: number; path: string; kind: string; ts: number; durationMs: number; status: string; error?: string };
