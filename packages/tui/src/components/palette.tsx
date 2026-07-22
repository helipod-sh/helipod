/* @jsxImportSource @opentui/react */
/**
 * The command palette (`:`), k9s-style: one fuzzy-matched list over every screen,
 * table, and function, so nothing in the dashboard is more than a few keystrokes
 * away. Matching is subsequence-based (`msnd` finds `messages:send`) and ranks
 * exact prefixes first.
 */
import { useMemo, useState } from "react";
import { useKeyboard } from "@opentui/react";
import { useTheme } from "@/components/ui/theme-provider";

export interface PaletteItem {
  /** What the user types against. */
  label: string;
  /** Right-hand annotation (kind, row count, …). */
  hint?: string;
  /** Grouping label. */
  group: string;
  run: () => void;
}

/** Subsequence match with a small score: prefix > word-start > scattered. */
function score(query: string, label: string): number | null {
  if (!query) return 0;
  const q = query.toLowerCase();
  const l = label.toLowerCase();
  if (l.startsWith(q)) return 1000;
  let li = 0;
  let hits = 0;
  let streak = 0;
  let best = 0;
  for (const ch of q) {
    const found = l.indexOf(ch, li);
    if (found === -1) return null;
    streak = found === li ? streak + 1 : 1;
    best = Math.max(best, streak);
    li = found + 1;
    hits++;
  }
  return hits * 10 + best * 5 - li;
}

export function Palette({ items, onClose }: { items: PaletteItem[]; onClose: () => void }) {
  const theme = useTheme();
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(0);

  const matches = useMemo(() => {
    const scored = items
      .map((it) => ({ it, s: score(query, it.label) }))
      .filter((x): x is { it: PaletteItem; s: number } => x.s !== null)
      .sort((a, b) => b.s - a.s);
    return scored.slice(0, 12).map((x) => x.it);
  }, [items, query]);

  useKeyboard((key) => {
    if (key.name === "escape") return onClose();
    if (key.name === "return") {
      matches[Math.min(cursor, matches.length - 1)]?.run();
      return onClose();
    }
    if (key.name === "down") return setCursor((c) => Math.min(matches.length - 1, c + 1));
    if (key.name === "up") return setCursor((c) => Math.max(0, c - 1));
    if (key.name === "backspace") {
      setCursor(0);
      return setQuery((q) => q.slice(0, -1));
    }
    if (key.sequence && key.sequence.length === 1 && !key.ctrl && !key.meta) {
      setCursor(0);
      setQuery((q) => q + key.sequence);
    }
  });

  return (
    <box flexDirection="column" borderColor={theme.colors.primary} paddingLeft={1} paddingRight={1}>
      <text>
        <span fg={theme.colors.primary}>{": "}</span>
        <span fg={theme.colors.foreground}>{query}</span>
        <span fg={theme.colors.primary}>{"█"}</span>
        <span fg={theme.colors.border}>{matches.length ? `   ${matches.length}` : "   no matches"}</span>
      </text>
      {matches.map((m, i) => (
        <text key={`${m.group}:${m.label}`}>
          <span fg={i === cursor ? theme.colors.primary : theme.colors.border}>{i === cursor ? " ▸ " : "   "}</span>
          <span fg={theme.colors.border}>{m.group.padEnd(10)}</span>
          <span fg={i === cursor ? theme.colors.foreground : theme.colors.mutedForeground}>
            {m.label.padEnd(30)}
          </span>
          <span fg={theme.colors.border}>{m.hint ?? ""}</span>
        </text>
      ))}
      <text fg={theme.colors.border}>{" ⏎ go · esc cancel"}</text>
    </box>
  );
}
