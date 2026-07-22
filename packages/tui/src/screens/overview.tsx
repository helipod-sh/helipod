/* @jsxImportSource @opentui/react */
/**
 * Screen 1 — Overview. Design source of truth: the approved mock
 * (helipod-tui-design.html) — deployment facts and project summary on top,
 * live activity filling the rest.
 *
 * Host events land in a bounded ring buffer and are coalesced on a ~frame tick
 * before touching React, so a burst of reloads or log lines costs one render,
 * and a long session never grows the retained set.
 */
import { useEffect, useMemo, useState } from "react";
import { useTerminalDimensions } from "@opentui/react";
import { InfoBox } from "@/components/ui/info-box";
import { useTheme } from "@/components/ui/theme-provider";
import { Activity, type ActivityRow } from "@/components/activity";
import type { TuiBridge, TuiEvent } from "../bridge";

const RING_MAX = 500;
/** Rows consumed by the header, panels, section label, and status bar. */
const CHROME_ROWS = 14;

export function OverviewScreen({ bridge }: { bridge: TuiBridge }) {
  const theme = useTheme();
  const { height } = useTerminalDimensions();
  const [events, setEvents] = useState<TuiEvent[]>([]);
  const counts = bridge.counts();

  useEffect(() => {
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

  const rows = useMemo<ActivityRow[]>(
    () =>
      events.map((e) => {
        if (e.kind === "reload") {
          return e.ok
            ? { at: e.at, level: "ok", source: "reload", message: `${e.functions} functions · ${e.durationMs}ms` }
            : { at: e.at, level: "error", source: "reload", message: e.message };
        }
        return { at: e.at, level: e.level, source: e.source, message: e.message };
      }),
    [events],
  );

  const d = bridge.deployment;
  return (
    <box flexDirection="column" flexGrow={1}>
      <box flexDirection="row" flexShrink={0}>
        <InfoBox width="full">
          <InfoBox.Header icon="◆" iconColor={theme.colors.primary} label="deployment" version={d.version} />
          <InfoBox.Row label="API" value={d.url} valueColor={theme.colors.info} />
          <InfoBox.Row label="Dashboard" value={d.dashboardUrl ?? "(SPA not built)"} valueColor={theme.colors.info} />
          <InfoBox.Row label="Admin key" value={d.adminKeyPreview} />
        </InfoBox>
        <InfoBox width="full">
          <InfoBox.Header icon="▲" iconColor={theme.colors.success} label="project" />
          <InfoBox.Row label="Functions" value={String(counts.functions)} bold />
          <InfoBox.Row label="Tables" value={String(counts.tables)} bold />
          <InfoBox.Row label="Components" value={String(counts.components)} bold />
        </InfoBox>
        <InfoBox width="full">
          <InfoBox.Header icon="●" iconColor={theme.colors.info} label="engine" />
          <InfoBox.Row label="Storage" value={d.storage} />
          <InfoBox.Row label="Watching" value={d.functionsDir} />
          <InfoBox.Row label="Runtime" value="bun" />
        </InfoBox>
      </box>

      <box flexDirection="column" flexGrow={1} paddingTop={1}>
        <text>
          <span fg={theme.colors.mutedForeground}>{"activity"}</span>
          <span fg={theme.colors.border}>{rows.length ? `   ${rows.length} events` : ""}</span>
        </text>
        {rows.length === 0 ? (
          <text fg={theme.colors.border}>{"waiting — save a file in the functions dir to hot-reload…"}</text>
        ) : (
          <Activity rows={rows} height={Math.max(1, height - CHROME_ROWS)} />
        )}
      </box>
    </box>
  );
}
