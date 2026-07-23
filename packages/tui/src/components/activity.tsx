/* @jsxImportSource @opentui/react */
/**
 * The activity feed.
 *
 * termcn's vendored `Log` renders each entry as sibling boxes whose columns
 * overlap at our widths (timestamps collided with messages, level badges wrapped
 * onto their own rows). Owning this one is the point of copy-paste components:
 * a single `<text>` per row, fixed-width columns, colored by severity.
 *
 * Rendering is windowed — only the rows that fit the visible height are turned
 * into elements, so a long-running dev session with thousands of buffered events
 * costs the same per frame as an empty one.
 */
import { useTheme } from "@/components/ui/theme-provider";

export type ActivityLevel = "info" | "warn" | "error" | "ok";

export interface ActivityRow {
  at: number;
  level: ActivityLevel;
  /** Left column: what produced this (function path, "reload", …). */
  source: string;
  message: string;
}

const GLYPH: Record<ActivityLevel, string> = { ok: "✓", info: "▸", warn: "⚠", error: "✗" };

function clock(at: number): string {
  const d = new Date(at);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}:${String(
    d.getSeconds(),
  ).padStart(2, "0")}`;
}

function pad(s: string, width: number): string {
  if (s.length === width) return s;
  return s.length > width ? `${s.slice(0, width - 1)}…` : s.padEnd(width);
}

export function Activity({ rows, height }: { rows: ActivityRow[]; height: number }) {
  const theme = useTheme();
  const color: Record<ActivityLevel, string> = {
    ok: theme.colors.success,
    info: theme.colors.info,
    warn: theme.colors.warning,
    error: theme.colors.error,
  };

  const visible = height > 0 ? rows.slice(Math.max(0, rows.length - height)) : [];

  return (
    <box flexDirection="column" flexGrow={1}>
      {visible.map((r, i) => (
        <text key={`${r.at}-${i}`}>
          <span fg={theme.colors.border}>{clock(r.at)}</span>
          <span fg={color[r.level]}>{`  ${GLYPH[r.level]} `}</span>
          <span fg={theme.colors.mutedForeground}>{pad(r.source, 14)}</span>
          <span fg={r.level === "error" ? theme.colors.error : theme.colors.foreground}>{` ${r.message}`}</span>
        </text>
      ))}
    </box>
  );
}
