/* @jsxImportSource @opentui/react */
/**
 * Screen 1 — Overview. Deployment facts, live engine metrics, and the activity feed.
 *
 * The metrics are derived from the engine's own execution log (the same sink the
 * Logs screen reads), so they are real measurements rather than a second
 * accounting path that could disagree with it: calls per 5s bucket for the
 * sparkline, a per-kind breakdown, p50/p95 duration, and the error count.
 */
import { useEffect, useMemo, useState } from "react";
import { useTerminalDimensions } from "@opentui/react";
import { Card } from "@/components/ui/card";
import { Sparkline } from "@/components/ui/dither-sparkline";
import { useTheme } from "@/components/ui/theme-provider";
import { Activity, type ActivityRow } from "@/components/activity";
import type { TuiBridge, TuiEvent, TuiLogEntry } from "../bridge";

const RING_MAX = 500;
const CHROME_ROWS = 18;
const BUCKETS = 24;
const BUCKET_MS = 5_000;
const METRICS_MS = 1_000;

function percentile(sorted: number[], p: number): number {
  if (!sorted.length) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p))] ?? 0;
}

export function OverviewScreen({ bridge, active }: { bridge: TuiBridge; active: boolean }) {
  const theme = useTheme();
  const { height, width } = useTerminalDimensions();
  const [events, setEvents] = useState<TuiEvent[]>([]);
  const [logs, setLogs] = useState<TuiLogEntry[]>([]);
  const counts = bridge.counts();

  // Host events (reloads etc.) — coalesced on a frame tick, bounded ring.
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

  // Engine metrics, sampled only while this screen is visible.
  useEffect(() => {
    if (!active || !bridge.data) return;
    let alive = true;
    const tick = () => {
      if (!alive) return;
      try {
        setLogs(bridge.data!.queryLogs({ limit: 400 }));
      } catch {
        /* best effort */
      }
    };
    tick();
    const id = setInterval(tick, METRICS_MS);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [active, bridge.data]);

  const metrics = useMemo(() => {
    const now = Date.now();
    const series = new Array<number>(BUCKETS).fill(0);
    const byKind = new Map<string, number>();
    const durations: number[] = [];
    let errors = 0;
    for (const l of logs) {
      const age = now - l.ts;
      if (age >= 0 && age < BUCKETS * BUCKET_MS) {
        const idx = BUCKETS - 1 - Math.floor(age / BUCKET_MS);
        series[idx] = (series[idx] ?? 0) + 1;
      }
      byKind.set(l.kind, (byKind.get(l.kind) ?? 0) + 1);
      durations.push(l.durationMs);
      if (l.status === "error") errors++;
    }
    durations.sort((a, b) => a - b);
    return {
      series,
      byKind: [...byKind.entries()].sort((a, b) => b[1] - a[1]),
      p50: percentile(durations, 0.5),
      p95: percentile(durations, 0.95),
      errors,
      total: logs.length,
      recent: series.reduce((a, b) => a + b, 0),
    };
  }, [logs]);

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
  const cardWidth = Math.max(26, Math.floor((width - 6) / 3) - 1);

  return (
    <box flexDirection="column" flexGrow={1} paddingLeft={1} paddingRight={1}>
      <box flexDirection="row" flexShrink={0}>
        <Card title="deployment" width={cardWidth} borderColor={theme.colors.primary}>
          <text>
            <span fg={theme.colors.mutedForeground}>{"api        "}</span>
            <span fg={theme.colors.info}>{d.url}</span>
          </text>
          <text>
            <span fg={theme.colors.mutedForeground}>{"web        "}</span>
            <span fg={theme.colors.info}>{d.dashboardUrl ? "/_dashboard" : "—"}</span>
          </text>
          <text>
            <span fg={theme.colors.mutedForeground}>{"key        "}</span>
            <span fg={theme.colors.foreground}>{d.adminKeyPreview}</span>
          </text>
          <text>
            <span fg={theme.colors.mutedForeground}>{"storage    "}</span>
            <span fg={theme.colors.foreground}>{d.storage}</span>
            <span fg={theme.colors.border}>{`   v${d.version}`}</span>
          </text>
        </Card>

        <Card title="project" width={cardWidth}>
          <text>
            <span fg={theme.colors.mutedForeground}>{"functions  "}</span>
            <span fg={theme.colors.foreground}>{String(counts.functions).padEnd(6)}</span>
            <span fg={theme.colors.mutedForeground}>{"tables  "}</span>
            <span fg={theme.colors.foreground}>{String(counts.tables)}</span>
          </text>
          <text>
            <span fg={theme.colors.mutedForeground}>{"components "}</span>
            <span fg={theme.colors.foreground}>{String(counts.components).padEnd(6)}</span>
            <span fg={theme.colors.mutedForeground}>{"runtime "}</span>
            <span fg={theme.colors.foreground}>{"bun"}</span>
          </text>
          <text>
            <span fg={theme.colors.mutedForeground}>{"watching   "}</span>
            <span fg={theme.colors.foreground}>{d.functionsDir}</span>
          </text>
          {metrics.byKind.length ? (
            <text>
              <span fg={theme.colors.mutedForeground}>{"calls      "}</span>
              <span fg={theme.colors.foreground}>
                {metrics.byKind.map(([k, n]) => `${k.slice(0, 8)} ${n}`).join("  ")}
              </span>
            </text>
          ) : null}
        </Card>

        <Card title="engine" width={cardWidth} borderColor={metrics.errors ? theme.colors.error : undefined}>
          <text>
            <span fg={theme.colors.mutedForeground}>{"runs       "}</span>
            <span fg={theme.colors.foreground}>{String(metrics.total).padEnd(6)}</span>
            <span fg={theme.colors.mutedForeground}>{"errors  "}</span>
            <span fg={metrics.errors ? theme.colors.error : theme.colors.foreground}>{String(metrics.errors)}</span>
          </text>
          <text>
            <span fg={theme.colors.mutedForeground}>{"p50        "}</span>
            <span fg={theme.colors.foreground}>{`${metrics.p50}ms`.padEnd(6)}</span>
            <span fg={theme.colors.mutedForeground}>{"p95     "}</span>
            <span fg={theme.colors.foreground}>{`${metrics.p95}ms`}</span>
          </text>
          <text>
            <span fg={theme.colors.mutedForeground}>{"last 2m    "}</span>
            <span fg={theme.colors.foreground}>{`${metrics.recent} calls`}</span>
          </text>
          {metrics.recent > 0 ? (
            <Sparkline
              data={metrics.series}
              // The chart palette is a named set, not free-form hex; "pink" is the
              // closest to the helipod crimson.
              color="pink"
              width={Math.max(8, cardWidth - 6)}
              height={2}
            />
          ) : (
            <text fg={theme.colors.border}>{"no calls in the last 2 minutes"}</text>
          )}
        </Card>
      </box>

      <box flexDirection="column" flexGrow={1} paddingTop={1}>
        <text>
          <span fg={theme.colors.mutedForeground}>{"activity"}</span>
          <span fg={theme.colors.border}>{rows.length ? `   ${rows.length}` : ""}</span>
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
