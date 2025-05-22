import { StrictMode, useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";

/**
 * Stackbase dashboard SPA. A client of the `/_admin/*` API (Plan 1). The dev server serves this
 * same-origin and injects `window.__ADMIN_KEY__`, so the admin key never leaves the machine.
 */
const KEY: string = (window as unknown as { __ADMIN_KEY__?: string }).__ADMIN_KEY__ ?? "";
const authHeaders = { Authorization: `Bearer ${KEY}`, "content-type": "application/json" };

async function adminGet<T>(path: string): Promise<T> {
  const r = await fetch(`/_admin${path}`, { headers: authHeaders });
  if (!r.ok) throw new Error(`admin ${path} → HTTP ${r.status}`);
  return r.json() as Promise<T>;
}
async function adminSend<T>(method: string, path: string, body?: unknown): Promise<T> {
  const r = await fetch(`/_admin${path}`, { method, headers: authHeaders, body: body === undefined ? undefined : JSON.stringify(body) });
  return r.json() as Promise<T>;
}

/** Minimal data hook: fetches when `key` changes, optionally polling every `intervalMs`. */
function useFetch<T>(make: () => Promise<T>, key: string, intervalMs?: number): { data?: T; loading: boolean } {
  const [data, setData] = useState<T>();
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let alive = true;
    setLoading(true);
    const run = () => {
      make()
        .then((d) => alive && setData(d))
        .catch(() => {})
        .finally(() => alive && setLoading(false));
    };
    run();
    const id = intervalMs ? setInterval(run, intervalMs) : undefined;
    return () => {
      alive = false;
      if (id) clearInterval(id);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, intervalMs]);
  return { data, loading };
}

type TableInfo = { name: string; indexes: string[]; shardKey?: string; documentCount: number };
type TableData = { documents: Record<string, unknown>[]; total: number; page: number; pageSize: number };
type FnInfo = { path: string; kind: string };
type LogEntry = { id: number; path: string; kind: string; ts: number; durationMs: number; status: string; error?: string };

function cell(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

function DocEditor({ table, doc, onClose, onSaved }: { table: string; doc?: Record<string, unknown>; onClose: () => void; onSaved: () => void }) {
  const id = doc ? String(doc._id) : null;
  const initial = useMemo(() => {
    if (!doc) return "{\n  \n}";
    const { _id, _creationTime, ...rest } = doc;
    void _id;
    void _creationTime;
    return JSON.stringify(rest, null, 2);
  }, [doc]);
  const [text, setText] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function save() {
    let fields: Record<string, unknown>;
    try {
      fields = JSON.parse(text);
    } catch {
      setError("Invalid JSON");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const r = id
        ? await adminSend<{ error?: string }>("PATCH", `/tables/${table}/docs/${id}`, fields)
        : await adminSend<{ error?: string }>("POST", `/tables/${table}/docs`, fields);
      if (r && typeof r === "object" && "error" in r && r.error) {
        setError(String(r.error));
        setSaving(false);
        return;
      }
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setSaving(false);
    }
  }

  return (
    <div className="modal" onClick={onClose}>
      <div className="dialog" onClick={(e) => e.stopPropagation()}>
        <h2>{id ? "Edit document" : `New document in ${table}`}</h2>
        {id ? <div className="muted" style={{ marginBottom: "0.5rem" }}><code>{id}</code></div> : null}
        <textarea value={text} onChange={(e) => setText(e.target.value)} style={{ minHeight: "12rem" }} />
        {error ? <div className="pill err" style={{ display: "inline-block", marginTop: "0.5rem" }}>{error}</div> : null}
        <div className="muted" style={{ marginTop: "0.6rem", fontSize: "0.78rem" }}>Saving writes a real mutation to your database.</div>
        <div className="right">
          <button className="ghost" onClick={onClose}>Cancel</button>
          <button onClick={save} disabled={saving}>{saving ? "Saving…" : "Save"}</button>
        </div>
      </div>
    </div>
  );
}

function DataBrowser({ table }: { table: string }) {
  const [filter, setFilter] = useState("");
  const [applied, setApplied] = useState("");
  const [nonce, setNonce] = useState(0);
  const [editing, setEditing] = useState<Record<string, unknown> | null>(null);
  const [creating, setCreating] = useState(false);
  const q = useFetch<TableData>(
    () => adminGet(`/tables/${table}/data?pageSize=100${applied ? `&filter=${encodeURIComponent(applied)}` : ""}`),
    `data:${table}:${applied}:${nonce}`,
  );
  const docs = q.data?.documents ?? [];
  const columns = useMemo(() => {
    const seen = new Set<string>();
    for (const d of docs) for (const k of Object.keys(d)) seen.add(k);
    const sys = ["_id", "_creationTime"];
    return [...[...seen].filter((k) => !sys.includes(k)).sort(), ...sys.filter((k) => seen.has(k))];
  }, [docs]);

  async function del(id: string) {
    if (!window.confirm("Delete this document?")) return;
    await adminSend("DELETE", `/tables/${table}/docs/${id}`);
    setNonce((n) => n + 1);
  }

  return (
    <div>
      <div className="toolbar">
        <h1 style={{ margin: 0 }}>{table}</h1>
        <span className="muted">{q.data?.total ?? "…"} docs</span>
        <input
          placeholder="filter  field:value"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && setApplied(filter)}
        />
        <button className="ghost" onClick={() => setApplied(filter)}>Filter</button>
        <button onClick={() => setCreating(true)}>+ New</button>
      </div>
      {q.loading ? (
        <div className="empty">loading…</div>
      ) : docs.length === 0 ? (
        <div className="empty">No documents</div>
      ) : (
        <table>
          <thead><tr>{columns.map((c) => <th key={c}>{c}</th>)}<th></th></tr></thead>
          <tbody>
            {docs.map((d) => (
              <tr key={String(d._id)}>
                {columns.map((c) => <td key={c} title={cell(d[c])}>{cell(d[c])}</td>)}
                <td className="actions">
                  <button className="mini" onClick={() => setEditing(d)}>Edit</button>
                  <button className="mini danger" onClick={() => del(String(d._id))}>Del</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {editing || creating ? (
        <DocEditor
          table={table}
          doc={editing ?? undefined}
          onClose={() => { setEditing(null); setCreating(false); }}
          onSaved={() => { setEditing(null); setCreating(false); setNonce((n) => n + 1); }}
        />
      ) : null}
    </div>
  );
}

function FunctionRunner() {
  const fns = useFetch<FnInfo[]>(() => adminGet("/functions"), "functions");
  const [path, setPath] = useState("");
  const [args, setArgs] = useState("{}");
  const [result, setResult] = useState<unknown>(null);
  const [running, setRunning] = useState(false);

  useEffect(() => {
    if (!path && fns.data?.[0]) setPath(fns.data[0].path);
  }, [fns.data, path]);

  async function run() {
    setRunning(true);
    try {
      setResult(await adminSend("POST", "/run", { path, args: JSON.parse(args || "{}") }));
    } catch (e) {
      setResult({ error: e instanceof Error ? e.message : String(e) });
    } finally {
      setRunning(false);
    }
  }

  return (
    <div>
      <h1>Function runner</h1>
      <div className="row" style={{ marginBottom: "0.6rem" }}>
        <select value={path} onChange={(e) => setPath(e.target.value)} style={{ maxWidth: "20rem" }}>
          {(fns.data ?? []).map((f) => <option key={f.path} value={f.path}>{f.path} ({f.kind})</option>)}
        </select>
        <button onClick={run} disabled={running || !path}>{running ? "Running…" : "Run"}</button>
      </div>
      <div className="muted" style={{ marginBottom: "0.3rem" }}>Arguments (JSON)</div>
      <textarea value={args} onChange={(e) => setArgs(e.target.value)} />
      {result !== null && (
        <>
          <div className="muted" style={{ margin: "0.8rem 0 0.3rem" }}>Result</div>
          <pre>{JSON.stringify(result, null, 2)}</pre>
        </>
      )}
    </div>
  );
}

function Logs() {
  const q = useFetch<LogEntry[]>(() => adminGet("/logs"), "logs", 2000);
  const logs = q.data ?? [];
  return (
    <div>
      <h1>Logs <span className="muted" style={{ fontSize: "0.8rem" }}>(live, 2s)</span></h1>
      {logs.length === 0 ? (
        <div className="empty">No executions yet — run a function or use the app.</div>
      ) : (
        <table>
          <thead><tr><th>id</th><th>function</th><th>kind</th><th>status</th><th>ms</th></tr></thead>
          <tbody>
            {logs.map((l) => (
              <tr key={l.id}>
                <td className="muted">{l.id}</td>
                <td><code>{l.path}</code></td>
                <td><span className="pill kind">{l.kind}</span></td>
                <td><span className={`pill ${l.status === "ok" ? "ok" : "err"}`}>{l.status}</span>{l.error ? ` ${l.error}` : ""}</td>
                <td className="muted">{l.durationMs}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function App() {
  const tables = useFetch<TableInfo[]>(() => adminGet("/tables"), "tables");
  const [table, setTable] = useState<string | undefined>();
  const [tab, setTab] = useState<"data" | "functions" | "logs">("data");

  useEffect(() => {
    if (!table && tables.data?.[0]) setTable(tables.data[0].name);
  }, [tables.data, table]);

  return (
    <div className="app">
      <aside className="sidebar">
        <p className="brand">⚡ Stackbase</p>
        <div className="navsec">Tables</div>
        {(tables.data ?? []).map((t) => (
          <div
            key={t.name}
            className={`navitem ${table === t.name && tab === "data" ? "active" : ""}`}
            onClick={() => { setTable(t.name); setTab("data"); }}
          >
            <span>{t.name}</span>
            <span className="badge">{t.documentCount}</span>
          </div>
        ))}
        <div className="navsec">Tools</div>
        <div className={`navitem ${tab === "functions" ? "active" : ""}`} onClick={() => setTab("functions")}>Functions</div>
        <div className={`navitem ${tab === "logs" ? "active" : ""}`} onClick={() => setTab("logs")}>Logs</div>
      </aside>
      <main className="main">
        {tab === "data" && table ? <DataBrowser key={table} table={table} /> : null}
        {tab === "data" && !table ? <div className="empty">No tables</div> : null}
        {tab === "functions" ? <FunctionRunner /> : null}
        {tab === "logs" ? <Logs /> : null}
      </main>
    </div>
  );
}

const root = document.getElementById("root");
if (root) {
  createRoot(root).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}
