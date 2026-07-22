/* @jsxImportSource @opentui/react */
/**
 * Screen 2 — Data. The table browser: tables on the left with live document
 * counts, the selected table's rows on the right, cursor-paginated.
 *
 * Only one server-side page is ever held in memory; navigating tables discards
 * the previous page rather than accumulating them.
 */
import { useCallback, useEffect, useState } from "react";
import { useKeyboard, useTerminalDimensions } from "@opentui/react";
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

export function DataScreen({ bridge, active }: { bridge: TuiBridge; active: boolean }) {
  const theme = useTheme();
  const { height, width } = useTerminalDimensions();
  const [tables, setTables] = useState<TuiTable[]>([]);
  const [selected, setSelected] = useState(0);
  const [page, setPage] = useState<TuiPage | null>(null);
  const [error, setError] = useState<string | null>(null);

  const data = bridge.data;
  const table = tables[selected];

  // Table list: refreshed whenever this screen becomes active (counts move as
  // mutations commit) — not polled, so an idle dashboard is idle.
  useEffect(() => {
    if (!active || !data) return;
    let alive = true;
    data
      .listTables()
      .then((t) => alive && setTables(t))
      .catch((e) => alive && setError(String(e?.message ?? e)));
    return () => {
      alive = false;
    };
  }, [active, data]);

  const load = useCallback(
    (name: string) => {
      if (!data) return;
      setPage(null);
      data
        .getTableData(name, { pageSize: PAGE_SIZE })
        .then(setPage)
        .catch((e) => setError(String(e?.message ?? e)));
    },
    [data],
  );

  useEffect(() => {
    if (active && table) load(table.name);
  }, [active, table, load]);

  useKeyboard((key) => {
    if (!active || tables.length === 0) return;
    if (key.name === "j" || key.name === "down") setSelected((i) => Math.min(tables.length - 1, i + 1));
    else if (key.name === "k" || key.name === "up") setSelected((i) => Math.max(0, i - 1));
    else if (key.name === "r" && table) load(table.name);
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
  const colWidth = Math.max(10, Math.floor((width - listWidth - 6) / Math.max(1, columns.length)) - 2);

  return (
    <box flexDirection="row" flexGrow={1}>
      {/* table list */}
      <box flexDirection="column" width={listWidth} flexShrink={0}>
        <text fg={theme.colors.mutedForeground}>{`tables  ${tables.length}`}</text>
        {tables.slice(0, rowsVisible).map((t, i) => (
          <text key={t.name}>
            <span fg={i === selected ? theme.colors.primary : theme.colors.foreground}>
              {`${i === selected ? "▸ " : "  "}${t.name.slice(0, 16).padEnd(17)}`}
            </span>
            <span fg={theme.colors.border}>{String(t.documentCount)}</span>
          </text>
        ))}
      </box>

      {/* rows */}
      <box flexDirection="column" flexGrow={1}>
        <text>
          <span fg={theme.colors.mutedForeground}>{table ? table.name : "—"}</span>
          <span fg={theme.colors.border}>
            {table ? `   ${table.documentCount} rows${table.shardKey ? ` · shardBy ${table.shardKey}` : ""}` : ""}
          </span>
        </text>
        {error ? (
          <text fg={theme.colors.error}>{error}</text>
        ) : !page ? (
          <text fg={theme.colors.border}>{"loading…"}</text>
        ) : docs.length === 0 ? (
          <text fg={theme.colors.border}>{"(empty table)"}</text>
        ) : (
          <box flexDirection="column">
            <text fg={theme.colors.border}>{columns.map((c) => cell(c, colWidth)).join(" ")}</text>
            {docs.slice(0, rowsVisible - 1).map((d, i) => (
              <text key={String(d._id ?? i)} fg={theme.colors.foreground}>
                {columns.map((c) => cell(d[c], colWidth)).join(" ")}
              </text>
            ))}
            {page.scanCapped ? (
              <text fg={theme.colors.warning}>{"⚠ scan capped — narrow the query to see the tail"}</text>
            ) : null}
          </box>
        )}
      </box>
    </box>
  );
}
