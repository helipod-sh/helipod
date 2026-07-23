/* @jsxImportSource @opentui/react */
/**
 * A connected multi-series line chart.
 *
 * termcn's dither charts plot each sample as an isolated dot, which reads as a
 * scatter rather than a line. This draws real strokes the way terminal charting
 * tools do: a horizontal rule along a run of equal values, and a vertical
 * connector spanning the gap whenever the value changes — so a spike appears as
 * an actual peak, matching a browser-style line chart.
 *
 * Rendering is a character grid built once per data change: one `<text>` per row
 * of spans, so a row is exactly one terminal line and the cost is O(rows × cols)
 * regardless of how many samples are behind it.
 */
import { useMemo } from "react";
import { useTheme } from "@/components/ui/theme-provider";

export interface Series {
  key: string;
  label: string;
  color: string;
  values: number[];
}

interface Cell {
  ch: string;
  color: string;
}

/** Nice axis maximum: 1, 2, 5, 10, 20, 50 … so ticks land on readable numbers. */
function niceMax(raw: number): number {
  if (raw <= 1) return 1;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const norm = raw / mag;
  const step = norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10;
  return step * mag;
}

export function SeriesChart({
  series,
  labels,
  width,
  height,
}: {
  series: Series[];
  /** X-axis tick labels, one per column; only a few are drawn. */
  labels: string[];
  width: number;
  height: number;
}) {
  const theme = useTheme();

  const { grid, max, gutter } = useMemo(() => {
    const rows = Math.max(3, height);
    const peak = Math.max(1, ...series.flatMap((s) => s.values));
    const axisMax = niceMax(peak);
    const gutterW = String(axisMax).length + 1;
    const cols = Math.max(4, width - gutterW - 1);

    const canvas: Cell[][] = Array.from({ length: rows }, () =>
      Array.from({ length: cols }, () => ({ ch: " ", color: theme.colors.background })),
    );

    // Row 0 is the top of the range; the last row is the zero line.
    const yFor = (v: number) => rows - 1 - Math.round((Math.min(v, axisMax) / axisMax) * (rows - 1));
    const put = (x: number, y: number, ch: string, color: string) => {
      if (x < 0 || x >= cols || y < 0 || y >= rows) return;
      const cell = canvas[y]![x]!;
      // Later series win a shared cell, but never erase a stroke with blank space.
      if (ch !== " ") canvas[y]![x] = { ch, color };
      else if (cell.ch === " ") canvas[y]![x] = { ch, color };
    };

    for (const s of series) {
      // Draw a CONNECTED path: horizontal runs joined to vertical risers by real
      // corner glyphs. Emitting only "─" and "│" (as this did before) left the run
      // and the riser touching nothing, which renders as fragments floating in
      // space rather than a line:
      //
      //   ────┘          the run turns UP into the riser
      //       │
      //       ┌────      the riser turns RIGHT into the next run
      //
      const n = s.values.length;
      const rowAt = (x: number) => {
        const idx = n <= 1 ? 0 : Math.min(n - 1, Math.round((x / Math.max(1, cols - 1)) * (n - 1)));
        return yFor(s.values[idx] ?? 0);
      };
      for (let x = 0; x < cols; x++) {
        const y = rowAt(x);
        const prev = x > 0 ? rowAt(x - 1) : null;
        if (prev === null || prev === y) {
          put(x, y, "─", s.color);
          continue;
        }
        // Row indices grow downward, so a SMALLER row is a HIGHER value.
        const goingUp = y < prev;
        put(x, prev, goingUp ? "┘" : "┐", s.color);
        const [lo, hi] = goingUp ? [y + 1, prev - 1] : [prev + 1, y - 1];
        for (let r = lo; r <= hi; r++) put(x, r, "│", s.color);
        put(x, y, goingUp ? "┌" : "└", s.color);
      }
    }

    return { grid: canvas, max: axisMax, gutter: gutterW };
  }, [series, width, height, theme.colors.background]);

  const rows = grid.length;
  const cols = grid[0]?.length ?? 0;

  // Y ticks at the top, middle and zero line.
  const tickAt = new Map<number, string>([
    [0, String(max)],
    [Math.floor((rows - 1) / 2), String(Math.round(max / 2))],
    [rows - 1, "0"],
  ]);

  // X labels: first, middle, last — enough to read the span without crowding.
  const xLabel = (() => {
    if (!labels.length) return "";
    const pick = [0, Math.floor(labels.length / 2), labels.length - 1].map((i) => labels[i] ?? "");
    const pad = Math.max(0, cols - pick.join("").length);
    const half = Math.floor(pad / 2);
    return `${pick[0]}${" ".repeat(half)}${pick[1]}${" ".repeat(pad - half)}${pick[2]}`;
  })();

  return (
    <box flexDirection="column">
      {grid.map((line, y) => (
        <text key={y}>
          <span fg={theme.colors.mutedForeground}>{(tickAt.get(y) ?? "").padStart(gutter)}</span>
          <span fg={theme.colors.border}>{y === rows - 1 ? "└" : "┤"}</span>
          {line.map((c, x) => (
            <span key={x} fg={c.color}>
              {c.ch === " " && y === rows - 1 ? "─" : c.ch}
            </span>
          ))}
        </text>
      ))}
      <text>
        <span fg={theme.colors.border}>{`${" ".repeat(gutter + 1)}${xLabel}`}</span>
      </text>
      <text>
        {series.map((s) => (
          <span key={s.key}>
            <span fg={s.color}>{"  ── "}</span>
            <span fg={theme.colors.mutedForeground}>{s.label}</span>
          </span>
        ))}
      </text>
    </box>
  );
}
