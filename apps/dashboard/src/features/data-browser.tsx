import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useReactTable, getCoreRowModel, flexRender, type ColumnDef } from "@tanstack/react-table";
import { adminGet, adminSend, type TableData } from "@/lib/admin";
import { Button } from "@/components/ui/button";
import { Input, Textarea } from "@/components/ui/input";
import { Dialog } from "@/components/ui/dialog";

type Row = Record<string, unknown>;
const SYS = ["_id", "_creationTime"];

function cell(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

function DocEditor({ table, doc, onClose }: { table: string; doc?: Row; onClose: () => void }) {
  const qc = useQueryClient();
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
      fields = JSON.parse(text);
    } catch {
      setError("Invalid JSON");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      if (id) await adminSend("PATCH", `/tables/${encodeURIComponent(table)}/docs/${id}`, fields);
      else await adminSend("POST", `/tables/${encodeURIComponent(table)}/docs`, fields);
      await qc.invalidateQueries({ queryKey: ["data", table] });
      await qc.invalidateQueries({ queryKey: ["tables"] });
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

export function DataBrowser({ table }: { table: string }) {
  const qc = useQueryClient();
  const [filter, setFilter] = useState("");
  const [applied, setApplied] = useState("");
  const [editing, setEditing] = useState<Row | null>(null);
  const [creating, setCreating] = useState(false);
  const [opError, setOpError] = useState<string | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ["data", table, applied],
    queryFn: () => adminGet<TableData>(`/tables/${encodeURIComponent(table)}/data?pageSize=100${applied ? `&filter=${encodeURIComponent(applied)}` : ""}`),
  });
  const docs = useMemo(() => data?.documents ?? [], [data]);

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
      await qc.invalidateQueries({ queryKey: ["data", table] });
      await qc.invalidateQueries({ queryKey: ["tables"] });
    } catch (e) {
      setOpError(e instanceof Error ? e.message : String(e));
    }
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

  return (
    <div>
      <div className="mb-4 flex items-center gap-3">
        <h1 className="text-lg font-semibold">{table}</h1>
        <span className="text-sm text-muted-foreground">{data?.total ?? "…"} docs</span>
        <Input
          className="ml-auto max-w-72"
          placeholder="filter  field:value"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && setApplied(filter)}
        />
        <Button variant="secondary" onClick={() => setApplied(filter)}>Filter</Button>
        <Button onClick={() => setCreating(true)}>+ New</Button>
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

      {editing || creating ? (
        <DocEditor table={table} doc={editing ?? undefined} onClose={() => { setEditing(null); setCreating(false); }} />
      ) : null}
    </div>
  );
}
