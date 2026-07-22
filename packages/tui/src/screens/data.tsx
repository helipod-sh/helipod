/* @jsxImportSource @opentui/react */
/**
 * Screen 2 — Data. The table browser: tables on the left with live document
 * counts, the selected table's rows on the right, cursor-paginated.
 *
 * Only one server-side page is ever held in memory; navigating tables discards
 * the previous page rather than accumulating them.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { useKeyboard, useTerminalDimensions } from "@opentui/react";
import { DataTable } from "@/components/data-table";
import { Pagination } from "@/components/ui/pagination";
import { useTheme } from "@/components/ui/theme-provider";
import type { TuiBridge, TuiPage, TuiTable } from "../bridge";

const PAGE_SIZE = 50;
const CHROME_ROWS = 8;

function cell(v: unknown, width: number): string {
  const s =
    v === null || v === undefined
      ? "—"
      : typeof v === "object"
        ? JSON.stringify(v)
        : String(v);
  const flat = s.replace(/\s+/g, " ");
  return flat.length > width ? `${flat.slice(0, width - 1)}…` : flat.padEnd(width);
}

export function DataScreen({
  bridge,
  active,
  jumpTo,
}: {
  bridge: TuiBridge;
  active: boolean;
  /** Table the command palette asked for. */
  jumpTo?: string | null;
}) {
  const theme = useTheme();
  const { height, width } = useTerminalDimensions();
  const [tables, setTables] = useState<TuiTable[]>([]);
  const [selected, setSelected] = useState(0);
  const [page, setPage] = useState<TuiPage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [row, setRow] = useState(0);
  const [inspecting, setInspecting] = useState(false);
  const [filtering, setFiltering] = useState(false);
  const [filter, setFilter] = useState("");
  // Cursor stack: index N holds the cursor that opened page N+1, so `[` can walk back.
  const [cursors, setCursors] = useState<Array<string | null>>([]);
  const [pageNo, setPageNo] = useState(1);

  const data = bridge.data;

  // App tables first, then component/system tables (`_storage`, `triggers/cursors`).
  // Sorting raw table names put underscore-prefixed internals at the top, so the
  // screen opened on an empty system table and looked broken.
  const ordered = useMemo(() => {
    const isInternal = (n: string) => n.startsWith("_") || n.includes("/");
    const app = tables.filter((t) => !isInternal(t.name));
    const internal = tables.filter((t) => isInternal(t.name));
    return { app, internal, all: [...app, ...internal] };
  }, [tables]);
  const table = ordered.all[selected];

  // Table list: refreshed whenever this screen becomes active (counts move as
  // mutations commit) — not polled, so an idle dashboard is idle.
  useEffect(() => {
    if (!active || !data) return;
    let alive = true;
    data
      .listTables()
      .then((t) => {
        if (!alive) return;
        setTables(t);
        // Open on something worth looking at: the first app table with rows.
        const isInternal = (n: string) => n.startsWith("_") || n.includes("/");
        const app = t.filter((x) => !isInternal(x.name));
        const firstWithRows = app.findIndex((x) => x.documentCount > 0);
        setSelected(firstWithRows >= 0 ? firstWithRows : 0);
      })
      .catch((e) => alive && setError(String(e?.message ?? e)));
    return () => {
      alive = false;
    };
  }, [active, data]);

  const load = useCallback(
    (name: string, expr = "", cursor: string | null = null) => {
      if (!data) return;
      setPage(null);
      setRow(0);
      setError(null);
      // `field=value` — equality is what the admin browse query supports; anything
      // else is treated as a free-text match applied to the returned page.
      const eq = expr.match(/^\s*([A-Za-z_][\w.]*)\s*=\s*(.+?)\s*$/);
      const filterArg = eq ? [{ field: eq[1]!, op: "eq", value: eq[2]! }] : undefined;
      data
        .getTableData(name, { pageSize: PAGE_SIZE, filter: filterArg, cursor })
        .then(setPage)
        .catch((e) => setError(String(e?.message ?? e)));
    },
    [data],
  );

  // A palette jump selects that table once the list is loaded.
  useEffect(() => {
    if (!jumpTo) return;
    const i = ordered.all.findIndex((t) => t.name === jumpTo);
    if (i >= 0) setSelected(i);
  }, [jumpTo, ordered.all]);

  useEffect(() => {
    setCursors([]);
    setPageNo(1);
    if (active && table) load(table.name, filter);
    // `filter` is applied explicitly on submit, not on every keystroke.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, table, load]);

  const docsRef = page?.documents ?? [];

  useKeyboard((key) => {
    if (!active) return;

    // Filter entry captures typing until submitted or cancelled.
    if (filtering) {
      if (key.name === "return") {
        setFiltering(false);
        if (table) load(table.name, filter);
      } else if (key.name === "escape") {
        setFiltering(false);
        setFilter("");
        if (table) load(table.name, "");
      } else if (key.name === "backspace") {
        setFilter((f) => f.slice(0, -1));
      } else if (key.sequence && key.sequence.length === 1 && !key.ctrl && !key.meta) {
        setFilter((f) => f + key.sequence);
      }
      return;
    }

    if (inspecting) {
      if (key.name === "escape" || key.name === "return" || key.name === "i") setInspecting(false);
      else if (key.name === "j" || key.name === "down") setRow((r) => Math.min(docsRef.length - 1, r + 1));
      else if (key.name === "k" || key.name === "up") setRow((r) => Math.max(0, r - 1));
      return;
    }

    if (key.name === "f" || key.name === "/") return setFiltering(true);
    if (key.sequence === "]" && page?.cursor && table) {
      setCursors((c) => [...c, page.cursor]);
      setPageNo((n) => n + 1);
      return void load(table.name, filter, page.cursor);
    }
    if (key.sequence === "[" && pageNo > 1 && table) {
      const prev = cursors.slice(0, -1);
      setCursors(prev);
      setPageNo((n) => n - 1);
      return void load(table.name, filter, prev[prev.length - 1] ?? null);
    }
    if (key.name === "return" || key.name === "i") return setInspecting(docsRef.length > 0);
    if (key.name === "J") return setRow((r) => Math.min(docsRef.length - 1, r + 1));
    if (key.name === "K") return setRow((r) => Math.max(0, r - 1));
    if (ordered.all.length === 0) return;
    if (key.name === "j" || key.name === "down") setSelected((i) => Math.min(ordered.all.length - 1, i + 1));
    else if (key.name === "k" || key.name === "up") setSelected((i) => Math.max(0, i - 1));
    else if (key.name === "r" && table) load(table.name, filter);
  });

  if (!data) {
    return <text fg={theme.colors.mutedForeground}>{"data browsing is unavailable on this host"}</text>;
  }

  const listWidth = 26;
  const rowsVisible = Math.max(1, height - CHROME_ROWS);
  const docs = page?.documents ?? [];
  const columns = docs.length
    ? Object.keys(docs[0]!).filter((k) => k !== "_creationTime").slice(0, 4)
    : [];
  // Each column costs `colWidth + 3` cells (a space, the value, a space, the
  // border), plus one trailing border — the previous math ignored the borders and
  // the table wrapped.
  const avail = width - listWidth - 5;
  const colWidth = Math.max(8, Math.floor((avail - 1) / Math.max(1, columns.length)) - 3);

  return (
    <box flexDirection="row" flexGrow={1} paddingLeft={1} paddingRight={1}>
      {/* table list */}
      <box flexDirection="column" width={listWidth} flexShrink={0}>
        <text fg={theme.colors.mutedForeground}>{`tables  ${tables.length}`}</text>
        {ordered.app.length ? <text fg={theme.colors.border}>{"app"}</text> : null}
        {ordered.all.slice(0, rowsVisible).map((t, i) => (
          <box key={t.name} flexDirection="column">
            {i === ordered.app.length && ordered.internal.length ? (
              <text fg={theme.colors.border}>{"system"}</text>
            ) : null}
            <text>
              <span fg={i === selected ? theme.colors.primary : theme.colors.foreground}>
                {`${i === selected ? " ▸ " : "   "}${t.name.slice(0, 16).padEnd(17)}`}
              </span>
              <span fg={t.documentCount ? theme.colors.mutedForeground : theme.colors.border}>
                {String(t.documentCount)}
              </span>
            </text>
          </box>
        ))}
      </box>

      {/* rows */}
      <box flexDirection="column" flexGrow={1}>
        <text>
          <span fg={theme.colors.mutedForeground}>{table ? table.name : "—"}</span>
          <span fg={theme.colors.border}>
            {table ? `   ${table.documentCount} rows${table.shardKey ? ` · shardBy ${table.shardKey}` : ""}` : ""}
          </span>
          {filtering || filter ? (
            <span fg={filtering ? theme.colors.primary : theme.colors.warning}>
              {`   filter: ${filter}${filtering ? "█" : ""}`}
            </span>
          ) : (
            <span fg={theme.colors.border}>{"   f filter · ⏎ inspect · J/K row"}</span>
          )}
        </text>
        {error ? (
          <text fg={theme.colors.error}>{error}</text>
        ) : !page ? (
          <text fg={theme.colors.border}>{"loading…"}</text>
        ) : docs.length === 0 ? (
          <text fg={theme.colors.border}>
            {`no documents in ${table?.name ?? "this table"} yet — write one from your app or the runner`}
          </text>
        ) : (
          <box flexDirection="column">
            <DataTable
              columns={columns.map((c) => ({ key: c, header: c, width: colWidth }))}
              rows={docs}
              selected={row}
              maxRows={Math.max(1, rowsVisible - 4)}
            />
            {page.cursor || pageNo > 1 ? (
              <box flexDirection="row">
                <Pagination total={page.cursor ? pageNo + 1 : pageNo} current={pageNo} siblings={1} />
                <text fg={theme.colors.border}>{"   [ prev · ] next"}</text>
              </box>
            ) : null}
            {page.scanCapped ? (
              <text fg={theme.colors.warning}>{"⚠ scan capped — narrow the filter to see the tail"}</text>
            ) : null}
            {inspecting && docs[row] ? (
              <box flexDirection="column" borderColor={theme.colors.primary} paddingLeft={1} paddingRight={1}>
                <text fg={theme.colors.mutedForeground}>
                  {`document ${row + 1}/${docs.length}   esc close · J/K row`}
                </text>
                {Object.entries(docs[row]!).map(([k, val]) => (
                  <text key={k}>
                    <span fg={theme.colors.info}>{`${k}`.padEnd(18)}</span>
                    <span fg={theme.colors.foreground}>
                      {(typeof val === "object" && val !== null ? JSON.stringify(val) : String(val)).slice(0, 70)}
                    </span>
                  </text>
                ))}
              </box>
            ) : null}
          </box>
        )}
      </box>
    </box>
  );
}
