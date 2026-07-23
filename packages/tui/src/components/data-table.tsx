/* @jsxImportSource @opentui/react */
/**
 * A compact bordered table.
 *
 * termcn's vendored `table` composes each row from several `<text>` nodes inside a
 * row-`<box>`; at our column counts OpenTUI gives those boxes two rows of height,
 * so every data row rendered with a blank line under it and the left border fell
 * off the first column. Rows here are a SINGLE `<text>` of spans — the same shape
 * that made the activity feed render cleanly — so a row is always exactly one line.
 */
import { useTheme } from "@/components/ui/theme-provider";

export interface DataTableColumn {
  key: string;
  header: string;
  width: number;
}

function fit(value: unknown, width: number): string {
  const s =
    value === null || value === undefined
      ? "—"
      : typeof value === "object"
        ? JSON.stringify(value)
        : String(value);
  const flat = s.replace(/\s+/g, " ");
  return flat.length > width ? `${flat.slice(0, width - 1)}…` : flat.padEnd(width);
}

export function DataTable({
  columns,
  rows,
  selected,
  maxRows,
}: {
  columns: DataTableColumn[];
  rows: Array<Record<string, unknown>>;
  selected?: number;
  maxRows: number;
}) {
  const theme = useTheme();
  const rule = (l: string, m: string, r: string) =>
    l + columns.map((c) => "─".repeat(c.width + 2)).join(m) + r;
  const shown = rows.slice(0, maxRows);

  return (
    <box flexDirection="column">
      <text fg={theme.colors.border}>{rule("╭", "┬", "╮")}</text>
      <text>
        {columns.map((c, i) => (
          <span key={c.key}>
            <span fg={theme.colors.border}>{i === 0 ? "│ " : " │ "}</span>
            <span fg={theme.colors.mutedForeground}>{fit(c.header, c.width)}</span>
          </span>
        ))}
        <span fg={theme.colors.border}>{" │"}</span>
      </text>
      <text fg={theme.colors.border}>{rule("├", "┼", "┤")}</text>
      {shown.map((row, ri) => (
        <text key={String(row._id ?? ri)}>
          {columns.map((c, i) => (
            <span key={c.key}>
              <span fg={theme.colors.border}>{i === 0 ? "│ " : " │ "}</span>
              <span fg={ri === selected ? theme.colors.primary : theme.colors.foreground}>
                {fit(row[c.key], c.width)}
              </span>
            </span>
          ))}
          <span fg={theme.colors.border}>{" │"}</span>
        </text>
      ))}
      {rows.length > shown.length ? (
        <text fg={theme.colors.border}>{`│ … ${rows.length - shown.length} more rows`}</text>
      ) : null}
      <text fg={theme.colors.border}>{rule("╰", "┴", "╯")}</text>
    </box>
  );
}
