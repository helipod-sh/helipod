/* @jsxImportSource @opentui/react */
/**
 * Screen 1 — Overview.
 *
 * Three bands: identity/health cards, a chart band, and the activity feed, which
 * GROWS to fill whatever is left (as two floating lines of grey text it made the
 * page look unfinished — half the screen was empty).
 *
 * Every number comes from the engine itself — the execution log for call
 * metrics, the sync handler for live connections and subscriptions — refreshed
 * by the write fan-out rather than a poll.
 */
import { useEffect, useMemo, useState } from "react";
import { useTerminalDimensions } from "@opentui/react";
import { Card } from "@/components/ui/card";
import { BarChart } from "@/components/ui/bar-chart";
import { LineChart } from "@/components/ui/line-chart";
import { useTheme } from "@/components/ui/theme-provider";
import { Activity, type ActivityRow } from "@/components/activity";
import type { TuiBridge, TuiEvent, TuiLogEntry } from "../bridge";

const RING_MAX = 500;
const BUCKETS = 24;
const BUCKET_MS = 5_000;
const WINDOW_LABEL = "2m";
const METRICS_MS = 3_000; // safety tick — reads never commit, so they need one
const CHROME_BASE = 20; // header + info cards + activity card chrome + status bar
const CHART_ROWS = 9;

function percentile(sorted: number[], p: number): number {
  if (!sorted.length) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p))] ?? 0;
}

/**
 * Histogram edges derived from the data. Fixed 1/5/10/25/50ms buckets left four
 * of six rows empty on a sub-millisecond engine — and an empty bar still draws a
 * full-width track, which reads as data at a glance.
 */
function histogram(sorted: number[]): Array<{ label: string; value: number }> {
  if (!sorted.length) return [];
  const max = sorted[sorted.length - 1] ?? 1;
  const step = Math.max(1, Math.ceil(max / 4));
  const edges = [step, step * 2, step * 3, step * 4];
  const counts = [0, 0, 0, 0];
  for (const d of sorted) {
    const i = edges.findIndex((e) => d <= e);
    counts[i === -1 ? 3 : i]! += 1;
  }
  return edges
    .map((e, i) => ({ label: `<=${e}ms`, value: counts[i] ?? 0 }))
    .filter((b) => b.value > 0);
}

function uptime(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}h ${m % 60}m` : `${Math.floor(h / 24)}d ${h % 24}h`;
}

export function OverviewScreen({ bridge, active }: { bridge: TuiBridge; active: boolean }) {
  const theme = useTheme();
  const { height, width } = useTerminalDimensions();
  const [events, setEvents] = useState<TuiEvent[]>([]);
  const [logs, setLogs] = useState<TuiLogEntry[]>([]);
  const [live, setLive] = useState({ connections: 0, subscriptions: 0, uptimeMs: 0 });
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

  useEffect(() => {
    if (!active || !bridge.data) return;
    let alive = true;
    const tick = () => {
      if (!alive) return;
      try {
        setLogs(bridge.data!.queryLogs({ limit: 400 }));
        const s = bridge.data!.stats?.();
        if (s) setLive(s);
      } catch {
        /* best effort */
      }
    };
    tick();
    const id = setInterval(tick, METRICS_MS);
    const off = bridge.data.onCommit?.(() => tick());
    return () => {
      alive = false;
      clearInterval(id);
      off?.();
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
      histogram: histogram(durations),
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
  const showCharts = metrics.total > 0 && height >= 30;
  const usable = width - 4;
  const cardW = Math.max(20, Math.floor(usable / 3));
  const lastW = Math.max(20, usable - cardW * 2);
  // Rows the feed can show: everything the bands above and the status bar leave.
  const activityRows = Math.max(1, height - CHROME_BASE - (showCharts ? CHART_ROWS : 0));
  const trim = (s: string, w: number) => (s.length > w ? `${s.slice(0, w - 1)}…` : s);

  const healthy = metrics.errors === 0;
  const okPct = Math.round(((metrics.total - metrics.errors) / Math.max(1, metrics.total)) * 100);
  const row = (label: string, value: string, color?: string) => (
    <text>
      <span fg={theme.colors.mutedForeground}>{label.padEnd(14)}</span>
      <span fg={color ?? theme.colors.foreground}>{value}</span>
    </text>
  );

  return (
    <box flexDirection="column" flexGrow={1} paddingLeft={1} paddingRight={1}>
      <box flexDirection="row" flexShrink={0}>
        <Card title="deployment" width={cardW}>
          {row("api", trim(d.url, cardW - 17), theme.colors.info)}
          {row("dashboard", d.dashboardUrl ? "/_dashboard" : "—", theme.colors.info)}
          {row("admin key", d.adminKeyPreview)}
          {row("storage", `${d.storage}  v${d.version}`)}
          {row("uptime", uptime(live.uptimeMs))}
        </Card>

        <Card title="project" width={cardW}>
          {row("functions", String(counts.functions))}
          {row("tables", String(counts.tables))}
          {row("components", String(counts.components))}
          {row("runtime", "bun")}
          {row("watching", trim(d.functionsDir, cardW - 17))}
        </Card>

        {/* The reactive numbers — the ones that make this engine what it is. */}
        <Card title="live" width={lastW} borderColor={healthy ? undefined : theme.colors.error}>
          {row("clients", String(live.connections), live.connections ? theme.colors.success : undefined)}
          {row("subscriptions", String(live.subscriptions), live.subscriptions ? theme.colors.success : undefined)}
          {row("calls", `${metrics.total}  (${WINDOW_LABEL}: ${metrics.recent})`)}
          {row("errors", String(metrics.errors), metrics.errors ? theme.colors.error : theme.colors.success)}
          {row("latency", `p50 ${metrics.p50}ms  p95 ${metrics.p95}ms`)}
        </Card>
      </box>

      {showCharts ? (
        <box flexDirection="row" flexShrink={0} paddingTop={1}>
          <Card title={`calls · last ${WINDOW_LABEL}`} width={cardW * 2}>
            <LineChart data={metrics.series} width={cardW * 2 - 8} height={5} color={theme.colors.info} showAxes />
            <text fg={theme.colors.border}>
              {`  -${WINDOW_LABEL}${" ".repeat(Math.max(1, cardW * 2 - 20))}now`}
            </text>
          </Card>
          <Card title="latency" width={lastW}>
            {metrics.histogram.length ? (
              <BarChart data={metrics.histogram} width={lastW - 10} height={4} showValues />
            ) : (
              <text fg={theme.colors.border}>{"no samples yet"}</text>
            )}
            <text>
              <span fg={healthy ? theme.colors.success : theme.colors.error}>{`  ${okPct}% ok`}</span>
              <span fg={theme.colors.border}>{`  ${metrics.total - metrics.errors}/${metrics.total}`}</span>
            </text>
          </Card>
        </box>
      ) : null}

      {/* Activity fills whatever is left. */}
      <box flexDirection="column" flexGrow={1} paddingTop={1}>
        <Card title="activity" width={usable}>
          {rows.length === 0 ? (
            <text fg={theme.colors.border}>
              {"waiting — save a file in the functions dir, or write data from your app"}
            </text>
          ) : (
            <Activity rows={rows} height={activityRows} />
          )}
        </Card>
      </box>
    </box>
  );
}
