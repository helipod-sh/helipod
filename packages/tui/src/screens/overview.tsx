/* @jsxImportSource @opentui/react */
/**
 * Screen 1 — Overview. The design source of truth is the approved mock
 * (helipod-tui-design.html): deployment facts up top, live activity below.
 * Host events land in a bounded ring buffer, coalesced before they touch
 * React — the render tree never sees unbounded or per-event state churn.
 */
import { useEffect, useMemo, useState } from "react";
import { InfoBox } from "@/components/ui/info-box";
import { Log, type LogEntry } from "@/components/ui/log";
import { useTheme } from "@/components/ui/theme-provider";
import type { TuiBridge, TuiEvent } from "../bridge";

const RING_MAX = 500;

export function OverviewScreen({ bridge }: { bridge: TuiBridge }) {
  const theme = useTheme();
  const [events, setEvents] = useState<TuiEvent[]>([]);
  const counts = bridge.counts();

  useEffect(() => {
    // Coalesce bursts: buffer synchronously, flush to React on a ~frame tick.
    let pending: TuiEvent[] = [];
    let timer: ReturnType<typeof setTimeout> | null = null;
    const flush = () => {
      timer = null;
      if (!pending.length) return;
      const batch = pending;
      pending = [];
      setEvents((prev) => {
        const next = prev.concat(batch);
        return next.length > RING_MAX ? next.slice(next.length - RING_MAX) : next;
      });
    };
    const off = bridge.onEvent((e) => {
      pending.push(e);
      timer ??= setTimeout(flush, 16);
    });
    return () => {
      if (timer) clearTimeout(timer);
      off();
    };
  }, [bridge]);

  const logEntries = useMemo<LogEntry[]>(
    () =>
      events.map((e) => {
        const timestamp = new Date(e.at);
        if (e.kind === "reload") {
          return e.ok
            ? { level: "info" as const, timestamp, message: `↻ reloaded in ${e.durationMs}ms · ${e.functions} functions` }
            : { level: "error" as const, timestamp, message: `reload failed — ${e.message}` };
        }
        return { level: e.level, timestamp, message: `${e.source}  ${e.message}` };
      }),
    [events],
  );

  const d = bridge.deployment;
  return (
    <box flexDirection="column" flexGrow={1}>
      <box flexDirection="row">
        <InfoBox width="full">
          <InfoBox.Header icon="◆" iconColor={theme.colors.primary} label="deployment" version={d.version} />
          <InfoBox.Row label="API" value={d.url} valueColor={theme.colors.info} />
          <InfoBox.Row label="Dashboard" value={d.dashboardUrl ?? "(SPA not built)"} valueColor={theme.colors.info} />
          <InfoBox.Row label="Admin key" value={d.adminKeyPreview} />
          <InfoBox.Row label="Storage" value={d.storage} />
          <InfoBox.TreeRow label="Watching" value={d.functionsDir} />
        </InfoBox>
        <InfoBox width="full">
          <InfoBox.Header icon="▲" iconColor={theme.colors.success} label="project" />
          <InfoBox.Row label="Functions" value={String(counts.functions)} bold />
          <InfoBox.Row label="Tables" value={String(counts.tables)} bold />
          <InfoBox.Row label="Components" value={String(counts.components)} bold />
        </InfoBox>
      </box>
      <box flexDirection="column" flexGrow={1} paddingTop={1}>
        {logEntries.length === 0 ? (
          <text fg={theme.colors.mutedForeground}>
            {"  waiting for activity — save a file in the functions dir to hot-reload…"}
          </text>
        ) : (
          <Log entries={logEntries} follow showTimestamp />
        )}
      </box>
    </box>
  );
}
