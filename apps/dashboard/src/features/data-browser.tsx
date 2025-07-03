import { useEffect, useMemo, useRef, useState } from "react";
import { useReactTable, getCoreRowModel, flexRender, type ColumnDef } from "@tanstack/react-table";
import { adminGet, adminSend, type TableInfo } from "@/lib/admin";
import { AdminBrowse, wsTransport, adminWsUrl, type BrowsePage, type FilterCond } from "@/lib/ws-admin";
import { Button } from "@/components/ui/button";
import { Input, Textarea } from "@/components/ui/input";
import { Dialog } from "@/components/ui/dialog";

type Row = Record<string, unknown>;
const SYS = ["_id", "_creationTime"];

const OPS: FilterCond["op"][] = ["eq", "ne", "lt", "lte", "gt", "gte"];

function cell(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

// ---------------------------------------------------------------------------
// DocEditor — writes via admin HTTP; live subscription reflects the result.
// ---------------------------------------------------------------------------
function DocEditor({ table, doc, onClose }: { table: string; doc?: Row; onClose: () => void }) {
  const id = doc ? String(doc._id) : null;
  const initial = useMemo(() => {
    if (!doc) return "{\n  \n}";
    const rest: Row = {};
    for (const [k, v] of Object.entries(doc)) if (!SYS.includes(k)) rest[k] = v;
    return JSON.stringify(rest, null, 2);
  }, [doc]);
  const [text, setText] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function save() {
    let fields: Record<string, unknown>;
    try {
      fields = JSON.parse(text) as Record<string, unknown>;
    } catch {
      setError("Invalid JSON");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      if (id) await adminSend("PATCH", `/tables/${encodeURIComponent(table)}/docs/${id}`, fields);
      else await adminSend("POST", `/tables/${encodeURIComponent(table)}/docs`, fields);
      // No invalidateQueries — the live subscription reflects writes automatically.
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setSaving(false);
    }
  }

  return (
    <Dialog open onClose={onClose} title={id ? "Edit document" : `New document in ${table}`}>
      {id ? <div className="mb-2 font-mono text-xs text-muted-foreground">{id}</div> : null}
      <Textarea value={text} onChange={(e) => setText(e.target.value)} className="min-h-48" />
      {error ? <div className="mt-2 inline-block rounded bg-destructive/15 px-2 py-0.5 text-xs text-destructive">{error}</div> : null}
      <div className="mt-2 text-xs text-muted-foreground">Saving writes a real mutation to your database.</div>
      <div className="mt-4 flex justify-end gap-2">
        <Button variant="secondary" onClick={onClose}>Cancel</Button>
        <Button onClick={save} disabled={saving}>{saving ? "Saving…" : "Save"}</Button>
      </div>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// FilterRow — one field/op/value condition
// ---------------------------------------------------------------------------
function FilterRow({
  cond,
  onChange,
  onRemove,
  fields,
}: {
  cond: FilterCond;
  onChange: (c: FilterCond) => void;
  onRemove: () => void;
  fields: string[];
}) {
  return (
    <div className="flex items-center gap-2">
      <select
        className="h-8 rounded-md border border-input bg-secondary/40 px-2 text-sm"
        value={cond.field}
        onChange={(e) => onChange({ ...cond, field: e.target.value })}
      >
        {fields.map((f) => <option key={f} value={f}>{f}</option>)}
        {!fields.includes(cond.field) && <option value={cond.field}>{cond.field}</option>}
      </select>
      <select
        className="h-8 rounded-md border border-input bg-secondary/40 px-2 text-sm"
        value={cond.op}
        onChange={(e) => onChange({ ...cond, op: e.target.value as FilterCond["op"] })}
      >
        {OPS.map((op) => <option key={op} value={op}>{op}</option>)}
      </select>
      <Input
        className="h-8 max-w-48"
        value={String(cond.value ?? "")}
        onChange={(e) => onChange({ ...cond, value: e.target.value })}
        placeholder="value"
      />
      <Button size="sm" variant="secondary" onClick={onRemove}>✕</Button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// DataBrowser — live grid via AdminBrowse subscription
// ---------------------------------------------------------------------------
export function DataBrowser({ table }: { table: string }) {
  // Live page state
  const [page, setPage] = useState<BrowsePage | null>(null);
  // Cursor stack for prev navigation: stack[0] = initial (null), each push is a nextCursor
  const [cursorStack, setCursorStack] = useState<Array<string | null>>([null]);
  const cursorStackRef = useRef(cursorStack);
  cursorStackRef.current = cursorStack;
  const currentCursor = cursorStack.at(-1) ?? null;

  // Structured filters
  const [filterConds, setFilterConds] = useState<FilterCond[]>([]);
  // Applied filters (committed on button press)
  const [appliedFilter, setAppliedFilter] = useState<FilterCond[]>([]);

  // Editor state
  const [editing, setEditing] = useState<Row | null>(null);
  const [creating, setCreating] = useState(false);
  const [opError, setOpError] = useState<string | null>(null);

  // AdminBrowse instance — one per table mount
  const browseRef = useRef<AdminBrowse | null>(null);

  useEffect(() => {
    const browse = new AdminBrowse(wsTransport(adminWsUrl()), resolveAdminKey());
    browseRef.current = browse;
    return () => { browse.close(); browseRef.current = null; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [table]);

  // Re-subscribe when table, cursor, or filter changes
  useEffect(() => {
    const browse = browseRef.current;
    if (!browse) return;
    browse.subscribe(table, { cursor: currentCursor, filter: appliedFilter }, setPage);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [table, currentCursor, appliedFilter]);

  const docs = useMemo(() => page?.documents ?? [], [page]);

  const fieldKeys = useMemo(() => {
    const seen = new Set<string>();
    for (const d of docs) for (const k of Object.keys(d)) seen.add(k);
    return [...[...seen].filter((k) => !SYS.includes(k)).sort(), ...SYS.filter((k) => seen.has(k))];
  }, [docs]);

  async function del(id: string) {
    if (!window.confirm("Delete this document?")) return;
    setOpError(null);
    try {
      await adminSend("DELETE", `/tables/${encodeURIComponent(table)}/docs/${id}`);
      // No invalidateQueries — the live subscription reflects writes automatically.
    } catch (e) {
      setOpError(e instanceof Error ? e.message : String(e));
    }
  }

  function goNext() {
    if (!page?.hasMore || !page.nextCursor) return;
    setCursorStack((s) => [...s, page.nextCursor]);
  }

  function goPrev() {
    setCursorStack((s) => s.length > 1 ? s.slice(0, -1) : s);
  }

  function applyFilters() {
    setCursorStack([null]); // reset to first page
    setAppliedFilter([...filterConds]);
  }

  function addFilterCond() {
    setFilterConds((f) => [...f, { field: fieldKeys[0] ?? "_id", op: "eq", value: "" }]);
  }

  const columns = useMemo<ColumnDef<Row>[]>(() => {
    const fields: ColumnDef<Row>[] = fieldKeys.map((k) => ({
      id: k,
      accessorFn: (r) => r[k],
      header: k,
      cell: (info) => {
        const s = cell(info.getValue());
        return <span title={s} className="block max-w-[26rem] truncate">{s}</span>;
      },
    }));
    fields.push({
      id: "_actions",
      header: () => null,
      cell: ({ row }) => (
        <div className="flex justify-end gap-1.5">
          <Button size="sm" variant="secondary" onClick={() => setEditing(row.original)}>Edit</Button>
          <Button size="sm" variant="destructive" onClick={() => del(String(row.original._id))}>Del</Button>
        </div>
      ),
    });
    return fields;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fieldKeys]);

  const tableModel = useReactTable({ data: docs, columns, getCoreRowModel: getCoreRowModel() });

  const isLoading = page === null;
  const hasPrev = cursorStack.length > 1;

  return (
    <div>
      {/* Header row */}
      <div className="mb-3 flex items-center gap-3">
        <h1 className="text-lg font-semibold">{table}</h1>
        <Button onClick={() => setCreating(true)}>+ New</Button>
      </div>

      {/* Scan-capped banner */}
      {page?.scanCapped ? (
        <div className="mb-3 rounded-md border border-amber-400/40 bg-amber-400/10 px-3 py-2 text-sm text-amber-700 dark:text-amber-300">
          Scan limit reached — narrow the filter to see all results.
        </div>
      ) : null}

      {/* Structured filter UI */}
      <div className="mb-3 space-y-2">
        {filterConds.map((cond, i) => (
          <FilterRow
            key={i}
            cond={cond}
            fields={fieldKeys.length ? fieldKeys : ["_id"]}
            onChange={(c) => setFilterConds((f) => f.map((x, j) => j === i ? c : x))}
            onRemove={() => setFilterConds((f) => f.filter((_, j) => j !== i))}
          />
        ))}
        <div className="flex gap-2">
          <Button variant="secondary" size="sm" onClick={addFilterCond}>+ Filter</Button>
          {filterConds.length > 0 && (
            <Button variant="secondary" size="sm" onClick={applyFilters}>Apply</Button>
          )}
          {appliedFilter.length > 0 && (
            <Button variant="secondary" size="sm" onClick={() => { setFilterConds([]); setAppliedFilter([]); setCursorStack([null]); }}>
              Clear filters
            </Button>
          )}
        </div>
      </div>

      {opError ? (
        <div className="mb-3 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">{opError}</div>
      ) : null}

      {isLoading ? (
        <div className="py-12 text-center text-muted-foreground">loading…</div>
      ) : docs.length === 0 ? (
        <div className="py-12 text-center text-muted-foreground">No documents</div>
      ) : (
        <div className="overflow-auto rounded-lg border border-border">
          <table className="w-full text-sm">
            <thead className="bg-card">
              {tableModel.getHeaderGroups().map((hg) => (
                <tr key={hg.id}>
                  {hg.headers.map((h) => (
                    <th key={h.id} className="border-b border-border px-3 py-2 text-left font-medium text-muted-foreground">
                      {h.isPlaceholder ? null : flexRender(h.column.columnDef.header, h.getContext())}
                    </th>
                  ))}
                </tr>
              ))}
            </thead>
            <tbody>
              {tableModel.getRowModel().rows.map((row) => (
                <tr key={row.id} className="hover:bg-card/60">
                  {row.getVisibleCells().map((c) => (
                    <td key={c.id} className="whitespace-nowrap border-b border-border px-3 py-2">
                      {flexRender(c.column.columnDef.cell, c.getContext())}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Cursor pagination */}
      <div className="mt-3 flex items-center gap-3">
        <Button variant="secondary" size="sm" disabled={!hasPrev} onClick={goPrev}>← Prev</Button>
        <Button variant="secondary" size="sm" disabled={!page?.hasMore} onClick={goNext}>Next →</Button>
        {hasPrev && <span className="text-xs text-muted-foreground">Page {cursorStack.length}</span>}
      </div>

      {editing || creating ? (
        <DocEditor table={table} doc={editing ?? undefined} onClose={() => { setEditing(null); setCreating(false); }} />
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// resolveAdminKey — mirrors admin.ts but without side effects on import
// ---------------------------------------------------------------------------
function resolveAdminKey(): string {
  const injected = (window as unknown as { __ADMIN_KEY__?: string }).__ADMIN_KEY__;
  if (typeof injected === "string" && injected) return injected;
  const stored = sessionStorage.getItem("sb_admin_key");
  if (stored) return stored;
  return sessionStorage.getItem("sb_admin_key") ?? "";
}

// ---------------------------------------------------------------------------
// TableList — left-rail table list via HTTP (loaded once + manual refresh)
// ---------------------------------------------------------------------------
export function TableList({
  selected,
  onSelect,
}: {
  selected: string | null;
  onSelect: (t: string) => void;
}) {
  const [tables, setTables] = useState<TableInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const data = await adminGet<TableInfo[]>("/tables");
      setTables(data);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void load(); }, []);

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center justify-between px-2 py-1">
        <span className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Tables</span>
        <button
          className="text-xs text-muted-foreground hover:text-foreground"
          onClick={() => void load()}
          disabled={loading}
          title="Refresh table list"
        >
          {loading ? "…" : "↺"}
        </button>
      </div>
      {error ? <div className="px-2 text-xs text-destructive">{error}</div> : null}
      {tables.map((t) => (
        <button
          key={t.name}
          className={`w-full rounded px-2 py-1.5 text-left text-sm hover:bg-card/60 ${selected === t.name ? "bg-card font-medium" : ""}`}
          onClick={() => onSelect(t.name)}
        >
          {t.name}
          <span className="ml-1 text-xs text-muted-foreground">({t.documentCount})</span>
        </button>
      ))}
    </div>
  );
}
