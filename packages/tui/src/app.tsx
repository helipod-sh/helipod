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
import React, { useState } from "react";
import { useKeyboard, useTerminalDimensions, type createRoot } from "@opentui/react";
import { ThemeProvider, useTheme } from "@/components/ui/theme-provider";
import { helipodTheme } from "@/lib/terminal-themes/helipod";
import { OverviewScreen } from "./screens/overview";
import type { TuiBridge } from "./bridge";

const SCREENS = ["overview"] as const;
type Screen = (typeof SCREENS)[number];

const HINTS: Array<[key: string, label: string]> = [
  ["1", "overview"],
  ["o", "open dashboard"],
  ["q", "quit"],
];

function StatusBar({ screen }: { screen: Screen }) {
  const theme = useTheme();
  return (
    <box flexDirection="row" paddingLeft={1} paddingRight={1} flexShrink={0}>
      <text>
        {HINTS.map(([key, label], i) => (
          <span key={key}>
            {i > 0 ? <span fg={theme.colors.border}>{"   "}</span> : null}
            <span fg={theme.colors.primary}>{key}</span>
            <span fg={theme.colors.mutedForeground}>{` ${label}`}</span>
          </span>
        ))}
        <span fg={theme.colors.border}>{"      "}</span>
        <span fg={theme.colors.mutedForeground}>{screen}</span>
      </text>
    </box>
  );
}

function Frame({ bridge }: { bridge: TuiBridge }) {
  const theme = useTheme();
  const { height } = useTerminalDimensions();
  const [screen, setScreen] = useState<Screen>("overview");

  useKeyboard((key) => {
    if (key.name === "q" || (key.ctrl && key.name === "c")) bridge.requestQuit();
    else if (key.name === "o") bridge.openUrl?.(bridge.deployment.dashboardUrl ?? bridge.deployment.url);
    else if (key.name === "1") setScreen("overview");
  });

  return (
    <box flexDirection="column" height={height} backgroundColor={theme.colors.background}>
      {/* header */}
      <box flexDirection="row" paddingLeft={1} paddingRight={1} paddingBottom={1} flexShrink={0}>
        <text>
          <span fg={theme.colors.primary}>{"◆ helipod"}</span>
          <span fg={theme.colors.mutedForeground}>{`  dev  ·  ${bridge.deployment.url}`}</span>
        </text>
      </box>
      {/* content — the only growing row */}
      <box flexDirection="column" flexGrow={1} paddingLeft={1} paddingRight={1}>
        {screen === "overview" && <OverviewScreen bridge={bridge} />}
      </box>
      {/* status bar, pinned to the bottom */}
      <StatusBar screen={screen} />
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
