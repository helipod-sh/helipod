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
import { SeriesChart } from "@/components/series-chart";
import { useTheme } from "@/components/ui/theme-provider";
import { Activity, type ActivityRow } from "@/components/activity";
import { coalesce } from "@/lib/coalesce";
import type { TuiBridge, TuiEvent, TuiLogEntry } from "../bridge";

const RING_MAX = 500;
const WINDOW_MS = 600_000; // the "last 10m" window
const MIN_BUCKETS = 12;
const WINDOW_LABEL = "10m";
const METRICS_MS = 3_000; // safety tick — reads never commit, so they need one
const COMMIT_COALESCE_MS = 200; // cap commit-driven refreshes to ~5/s
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

/**
 * Peak concurrency within [b0, b1): the largest number of the given intervals
 * that are simultaneously in flight at any instant in the bucket. This is the
 * "running functions" metric — computed by a sweep line over interval endpoints,
 * with ends processed before starts at equal timestamps so back-to-back calls
 * (one ends exactly as the next begins) are not counted as overlapping.
 */
function peakConcurrency(intervals: Array<[number, number]>, b0: number, b1: number): number {
  const evs: Array<[number, number]> = [];
  for (const [s0, e0] of intervals) {
    const s = Math.max(s0, b0);
    const e = Math.min(e0, b1);
    if (e <= s) continue;
    evs.push([s, 1]);
    evs.push([e, -1]);
  }
  evs.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let cur = 0;
  let peak = 0;
  for (const [, d] of evs) {
    cur += d;
    if (cur > peak) peak = cur;
  }
  return peak;
}

/**
 * System traffic: the engine's own functions (`_admin:*`, `_system:*`) and the
 * `_`-prefixed internals components register. Everything else is app code.
 */
function isSystemPath(path: string): boolean {
  return path.startsWith("_") || path.includes(":_");
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
    // Commits refresh the metrics, but coalesced — a write burst can't turn into
    // a redraw storm that steals event-loop time from the engine.
    const commit = coalesce(tick, COMMIT_COALESCE_MS);
    const off = bridge.data.onCommit?.(commit.call);
    return () => {
      alive = false;
      clearInterval(id);
      commit.cancel();
      off?.();
    };
  }, [active, bridge.data]);

  // One bucket per chart column: the series then spans the full card width
  // instead of stopping wherever a fixed bucket count happened to end.
  // The dither renderer caps its own plot area, so more buckets only thins the
  // series rather than widening it — this is the resolution that reads best.
  const chartCols = Math.max(MIN_BUCKETS, Math.floor((width - 4) / 3));
  const bucketMs = Math.max(1000, Math.round(WINDOW_MS / chartCols));

  const metrics = useMemo(() => {
    const now = Date.now();
    const series = new Array<number>(chartCols).fill(0);
    // Per-kind buckets: the composition of traffic (reads vs writes vs actions)
    // says more than a single count — a shift to write-heavy is visible at a glance.
    const byBucket = Array.from({ length: chartCols }, (_, i) => {
      // Bucket start as wall-clock time — an axis of bucket indices means nothing
      // to a reader; "2:39 AM" does.
      const t = new Date(now - (chartCols - 1 - i) * bucketMs);
      return {
        at: `${((t.getHours() + 11) % 12) + 1}:${String(t.getMinutes()).padStart(2, "0")}`,
        query: 0,
        mutation: 0,
        other: 0,
        system: 0,
      };
    });
    const byKind = new Map<string, number>();
    const durations: number[] = [];
    // Intervals per kind for the concurrency series. A function that ran took
    // nonzero time, so floor sub-millisecond durations at 1ms — otherwise a
    // zero-length interval never overlaps anything and would read as idle.
    const intervals: Record<"query" | "mutation" | "other" | "system", Array<[number, number]>> = {
      query: [], mutation: [], other: [], system: [],
    };
    const kindOf = (l: (typeof logs)[number]): keyof typeof intervals =>
      isSystemPath(l.path) ? "system" : l.kind === "query" ? "query" : l.kind === "mutation" ? "mutation" : "other";
    let errors = 0;
    let systemTotal = 0;
    for (const l of logs) {
      const age = now - l.ts;
      if (age >= 0 && age < WINDOW_MS) {
        const idx = chartCols - 1 - Math.floor(age / bucketMs);
        // App-only, to match the `app calls` total beside it.
        if (!isSystemPath(l.path)) series[idx] = (series[idx] ?? 0) + 1;
        const slot = byBucket[idx]!;
        // The dashboard observes through the same executor it measures: its own
        // `_admin:browseTable`/`queryLogs` calls, component internals and system
        // functions all reach the log sink. Counting them alongside app traffic
        // would mean the graph partly plots the observer, so they get their own
        // line instead of inflating the app's.
        if (isSystemPath(l.path)) slot.system += 1;
        else if (l.kind === "query") slot.query += 1;
        else if (l.kind === "mutation") slot.mutation += 1;
        else slot.other += 1;
      }
      if (age >= 0 && age < WINDOW_MS + 60_000) {
        intervals[kindOf(l)].push([l.ts, l.ts + Math.max(1, l.durationMs)]);
      }
      if (isSystemPath(l.path)) {
        systemTotal++;
        continue; // app metrics below describe the app, not the engine's own traffic
      }
      byKind.set(l.kind, (byKind.get(l.kind) ?? 0) + 1);
      durations.push(l.durationMs);
      if (l.status === "error") errors++;
    }
    // Per-bucket counts are inherently spiky (burst, zero, burst), so every point
    // rendered as an isolated vertical. A trailing-window rate — each point is
    // the calls in the preceding minute — is the continuous metric a line chart
    // is actually for, and matches how dashboards plot throughput.
    const smoothingBuckets = Math.max(1, Math.round(60_000 / bucketMs));
    const rate = (pick: (b: (typeof byBucket)[number]) => number) =>
      byBucket.map((_, i) => {
        let sum = 0;
        for (let k = Math.max(0, i - smoothingBuckets + 1); k <= i; k++) sum += pick(byBucket[k]!);
        return sum;
      });

    const bucketStart = (i: number) => now - (chartCols - 1 - i) * bucketMs;
    const concurrency = (kind: keyof typeof intervals) =>
      byBucket.map((_, i) => peakConcurrency(intervals[kind], bucketStart(i), bucketStart(i) + bucketMs));
    // App functions only — the chart no longer plots system traffic, so the peak
    // beside it should describe the same thing.
    const peakOverall = Math.max(
      0,
      ...(["query", "mutation", "other"] as const).flatMap((k) => concurrency(k)),
    );

    durations.sort((a, b) => a - b);
    return {
      concurrency: {
        query: concurrency("query"),
        mutation: concurrency("mutation"),
        other: concurrency("other"),
        system: concurrency("system"),
      },
      peakOverall,
      rates: {
        query: rate((b) => b.query),
        mutation: rate((b) => b.mutation),
        other: rate((b) => b.other),
        system: rate((b) => b.system),
      },
      series,
      stacked: byBucket,
      byKind: [...byKind.entries()].sort((a, b) => b[1] - a[1]),
      p50: percentile(durations, 0.5),
      p95: percentile(durations, 0.95),
      histogram: histogram(durations),
      errors,
      systemTotal,
      total: logs.length - systemTotal,
      recent: series.reduce((a, b) => a + b, 0),
    };
  }, [logs, chartCols, bucketMs]);

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
          {row("app calls", `${metrics.total}  (${WINDOW_LABEL}: ${metrics.recent})`)}
          {row("peak concurrent", String(metrics.peakOverall), metrics.peakOverall > 1 ? theme.colors.warning : undefined)}
          {row("errors", String(metrics.errors), metrics.errors ? theme.colors.error : theme.colors.success)}
          {row("latency", `p50 ${metrics.p50}ms  p95 ${metrics.p95}ms`)}
        </Card>
      </box>

      {showCharts ? (
        <box flexDirection="row" flexShrink={0} paddingTop={1}>
          <Card title={`calls/min · last ${WINDOW_LABEL}`} width={cardW * 2}>
            <SeriesChart
              width={cardW * 2 - 4}
              height={7}
              labels={metrics.stacked.map((b) => b.at)}
              series={[
                { key: "query", label: "queries", color: theme.colors.info, values: metrics.rates.query },
                { key: "mutation", label: "mutations", color: theme.colors.warning, values: metrics.rates.mutation },
                { key: "other", label: "actions", color: theme.colors.success, values: metrics.rates.other },
              ]}
            />
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
