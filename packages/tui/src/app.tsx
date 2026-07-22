/* @jsxImportSource @opentui/react */
/**
 * The helipod terminal dashboard shell. Phase 1 ships the Overview screen inside
 * the app-shell frame; Data / Functions / Logs / Schema screens land in the
 * following phases on the same skeleton (number-key navigation is already wired).
 */
import React, { useState } from "react";
import { useKeyboard, type createRoot } from "@opentui/react";
import { AppShell } from "@/components/ui/app-shell";
import { ThemeProvider, useTheme } from "@/components/ui/theme-provider";
import { helipodTheme } from "@/lib/terminal-themes/helipod";
import { OverviewScreen } from "./screens/overview";
import type { TuiBridge } from "./bridge";

const SCREENS = ["overview"] as const;

function Frame({ bridge }: { bridge: TuiBridge }) {
  const theme = useTheme();
  const [screen, setScreen] = useState<(typeof SCREENS)[number]>("overview");

  useKeyboard((key) => {
    if (key.name === "q" || (key.ctrl && key.name === "c")) bridge.requestQuit();
    if (key.name === "o") bridge.openUrl?.(bridge.deployment.dashboardUrl ?? bridge.deployment.url);
    if (key.name === "1") setScreen("overview");
  });

  return (
    <AppShell>
      <AppShell.Header>
        <text>
          <span fg={theme.colors.primary}>◆ helipod</span>
          <span fg={theme.colors.mutedForeground}> dev · {bridge.deployment.url}</span>
        </text>
      </AppShell.Header>
      <AppShell.Content>{screen === "overview" && <OverviewScreen bridge={bridge} />}</AppShell.Content>
      <AppShell.Hints items={["1 overview", "o open dashboard", "q quit"]} />
    </AppShell>
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
