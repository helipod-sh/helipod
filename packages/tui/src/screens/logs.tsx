/* @jsxImportSource @opentui/react */
/**
 * Screen 4 — Logs. The engine's execution log: every query, mutation, action and
 * HTTP action run, with duration and status. Polls the in-process log sink on a
 * slow cadence only while this screen is visible (an unfocused dashboard is idle),
 * and renders a window of the newest entries rather than the whole buffer.
 */
import { useEffect, useState } from "react";
import { useKeyboard, useTerminalDimensions } from "@opentui/react";
import { useTheme } from "@/components/ui/theme-provider";
import { coalesce } from "@/lib/coalesce";
import type { TuiBridge, TuiLogEntry } from "../bridge";

const POLL_MS = 2_000; // safety tick for read-only traffic; commits push instantly
const CHROME_ROWS = 7;

function clock(ts: number): string {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}:${String(
    d.getSeconds(),
  ).padStart(2, "0")}`;
}

export function LogsScreen({ bridge, active }: { bridge: TuiBridge; active: boolean }) {
  const theme = useTheme();
  const { height, width } = useTerminalDimensions();
  const [entries, setEntries] = useState<TuiLogEntry[]>([]);
  const [errorsOnly, setErrorsOnly] = useState(false);

  useEffect(() => {
    if (!active || !bridge.data) return;
    let alive = true;
    const tick = () => {
      if (!alive) return;
      try {
        setEntries(bridge.data!.queryLogs({ limit: 300 }));
      } catch {
        /* the sink is best-effort */
      }
    };
    tick();
    const id = setInterval(tick, POLL_MS);
    const commit = coalesce(tick, 200);
    const off = bridge.data.onCommit?.(commit.call);
    return () => {
      alive = false;
      clearInterval(id);
      commit.cancel();
      off?.();
    };
  }, [active, bridge.data]);

  useKeyboard((key) => {
    if (active && key.name === "e") setErrorsOnly((v) => !v);
  });

  if (!bridge.data) {
    return <text fg={theme.colors.mutedForeground}>{"logs are unavailable on this host"}</text>;
  }

  const shown = (errorsOnly ? entries.filter((e) => e.status === "error") : entries).slice(
    0,
    Math.max(1, height - CHROME_ROWS),
  );
  // Prefix columns: clock(8) + status(4) + kind(11) + path(26) + duration(8).
  const msgWidth = Math.max(12, width - 59);

  return (
    <box flexDirection="column" flexGrow={1} paddingLeft={1} paddingRight={1}>
      <text>
        <span fg={theme.colors.mutedForeground}>{`logs  ${entries.length}`}</span>
        <span fg={errorsOnly ? theme.colors.error : theme.colors.border}>
          {errorsOnly ? "   errors only  (e)" : "   e errors only"}
        </span>
      </text>
      {shown.length === 0 ? (
        <text fg={theme.colors.border}>{"no function runs yet — call one from your app or the runner"}</text>
      ) : (
        shown.map((e) => (
          <text key={e.id}>
            <span fg={theme.colors.border}>{clock(e.ts)}</span>
            <span fg={e.status === "error" ? theme.colors.error : theme.colors.success}>
              {`  ${e.status === "error" ? "✗" : "✓"} `}
            </span>
            <span fg={theme.colors.mutedForeground}>{e.kind.padEnd(11)}</span>
            <span fg={theme.colors.foreground}>{e.path.padEnd(26).slice(0, 26)}</span>
            <span fg={theme.colors.border}>{`${String(e.durationMs).padStart(5)}ms `}</span>
            {e.error ? (
              <span fg={theme.colors.error}>{e.error.replace(/\s+/g, " ").slice(0, msgWidth)}</span>
            ) : null}
          </text>
        ))
      )}
    </box>
  );
}
