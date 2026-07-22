/* @jsxImportSource @opentui/react */
/**
 * The helipod terminal dashboard shell.
 *
 * Layout is a three-row flex column that owns the full terminal: a header line,
 * a growing content region, and a status bar pinned to the bottom. (termcn's
 * AppShell.Content hard-codes a 20-row height and its Hints render inline, which
 * leaves dead space and a floating footer — so the frame is ours, and the screens
 * compose vendored components inside it.)
 *
 * Phase 1 ships the Overview screen; Data / Functions / Logs / Schema land on
 * this same skeleton (number-key navigation is already wired).
 */
import React, { useEffect, useMemo, useState } from "react";
import { useKeyboard, useTerminalDimensions, type createRoot } from "@opentui/react";
import { ThemeProvider, useTheme } from "@/components/ui/theme-provider";
import { helipodTheme } from "@/lib/terminal-themes/helipod";
import { OverviewScreen } from "./screens/overview";
import { DataScreen } from "./screens/data";
import { FunctionsScreen } from "./screens/functions";
import { LogsScreen } from "./screens/logs";
import { SchemaScreen } from "./screens/schema";
import { Sidebar, type SidebarItem } from "@/components/ui/sidebar";
import { CommandPalette, type Command } from "@/components/ui/command-palette";
import type { TuiBridge } from "./bridge";

const SIDEBAR_W = 16;
const SCREENS = ["overview", "data", "functions", "logs", "schema"] as const;
type Screen = (typeof SCREENS)[number];

const HINTS: Array<[key: string, label: string]> = [
  ["1", "overview"],
  ["2", "data"],
  ["3", "functions"],
  ["4", "logs"],
  ["5", "schema"],
  [":", "palette"],
  ["o", "browser"],
  ["q", "quit"],
];

/**
 * The status bar drops labels (keeping the keys) when the terminal is too narrow
 * to hold them — the full row is ~95 cells, and it used to wrap onto a second
 * line on an 100-column terminal, pushing itself off the bottom.
 */
function StatusBar({ screen, width }: { screen: Screen; width: number }) {
  const theme = useTheme();
  const full = HINTS.reduce((n, [k, l]) => n + k.length + l.length + 4, 2);
  const labelled = full <= width;
  return (
    <box flexDirection="row" paddingLeft={1} paddingRight={1} flexShrink={0}>
      <text>
        {HINTS.map(([key, label], i) => {
          const isActive = label === screen;
          return (
            <span key={key}>
              {i > 0 ? <span fg={theme.colors.border}>{labelled ? "   " : " "}</span> : null}
              <span fg={isActive ? theme.colors.foreground : theme.colors.primary}>{key}</span>
              {labelled ? (
                <span fg={isActive ? theme.colors.foreground : theme.colors.mutedForeground}>{` ${label}`}</span>
              ) : null}
            </span>
          );
        })}
      </text>
    </box>
  );
}

function Frame({ bridge }: { bridge: TuiBridge }) {
  const theme = useTheme();
  const { height, width } = useTerminalDimensions();
  const [screen, setScreen] = useState<Screen>("overview");
  const [palette, setPalette] = useState(false);
  const [jumpTable, setJumpTable] = useState<string | null>(null);
  const [tables, setTables] = useState<string[]>([]);

  // Table names for the palette — fetched once, refreshed when it opens.
  useEffect(() => {
    if (!palette || !bridge.data) return;
    let alive = true;
    void bridge.data.listTables().then((t) => alive && setTables(t.map((x) => x.name)));
    return () => {
      alive = false;
    };
  }, [palette, bridge.data]);

  const commands = useMemo<Command[]>(() => {
    const out: Command[] = SCREENS.map((s) => ({
      id: `screen:${s}`,
      label: s,
      group: "screen",
      onSelect: () => setScreen(s),
    }));
    for (const t of tables) {
      out.push({
        id: `table:${t}`,
        label: t,
        group: "table",
        onSelect: () => {
          setJumpTable(t);
          setScreen("data");
        },
      });
    }
    for (const f of bridge.data?.listFunctions() ?? []) {
      out.push({ id: `fn:${f.path}`, label: f.path, group: "function", description: f.kind, onSelect: () => setScreen("functions") });
    }
    out.push({
      id: "action:browser",
      label: "open dashboard in browser",
      group: "action",
      onSelect: () => bridge.openUrl?.(bridge.deployment.dashboardUrl ?? bridge.deployment.url),
    });
    out.push({ id: "action:quit", label: "quit", group: "action", onSelect: () => bridge.requestQuit() });
    return out;
  }, [tables, bridge]);

  useKeyboard((key) => {
    if (palette) return; // the palette owns input while open
    if (key.sequence === ":") return setPalette(true);
    if (key.name === "q" || (key.ctrl && key.name === "c")) bridge.requestQuit();
    else if (key.name === "o") bridge.openUrl?.(bridge.deployment.dashboardUrl ?? bridge.deployment.url);
    else if (key.name === "1") setScreen("overview");
    else if (key.name === "2") setScreen("data");
    else if (key.name === "3") setScreen("functions");
    else if (key.name === "4") setScreen("logs");
    else if (key.name === "5") setScreen("schema");
  });

  const navItems: SidebarItem[] = SCREENS.map((s, i) => ({ key: s, label: s, icon: String(i + 1) }));

  return (
    <box flexDirection="column" height={height} backgroundColor={theme.colors.background}>
      {/* header */}
      <box flexDirection="row" paddingLeft={1} paddingRight={1} paddingBottom={1} flexShrink={0}>
        <text>
          <span fg={theme.colors.primary}>{"◆ helipod"}</span>
          <span fg={theme.colors.mutedForeground}>{`  dev  ·  ${bridge.deployment.url}`}</span>
        </text>
      </box>
      {/* nav sidebar + content */}
      <box flexDirection="row" flexGrow={1} width="100%">
        <Sidebar items={navItems} activeKey={screen} width={SIDEBAR_W} onSelect={(k) => setScreen(k as Screen)} />
        <box flexDirection="column" flexGrow={1} flexBasis={0} paddingLeft={1} paddingRight={1}>
        {screen === "overview" && <OverviewScreen bridge={bridge} active={screen === "overview"} />}
        {screen === "data" && (
          <DataScreen bridge={bridge} active={screen === "data" && !palette} jumpTo={jumpTable} />
        )}
        {screen === "functions" && <FunctionsScreen bridge={bridge} active={screen === "functions" && !palette} />}
        {screen === "logs" && <LogsScreen bridge={bridge} active={screen === "logs" && !palette} />}
        {screen === "schema" && <SchemaScreen bridge={bridge} />}
        </box>
      </box>
      {palette ? (
        <box paddingLeft={1} paddingRight={1} flexShrink={0}>
          <CommandPalette commands={commands} isOpen onClose={() => setPalette(false)} maxItems={8} />
        </box>
      ) : null}
      {/* status bar, pinned to the bottom */}
      <StatusBar screen={screen} width={width} />
    </box>
  );
}

export function mount(root: ReturnType<typeof createRoot>, bridge: TuiBridge) {
  root.render(<App bridge={bridge} />);
}

export function App({ bridge }: { bridge: TuiBridge }) {
  return (
    <ThemeProvider theme={helipodTheme}>
      <Frame bridge={bridge} />
    </ThemeProvider>
  );
}
