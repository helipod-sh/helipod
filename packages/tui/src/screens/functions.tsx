/* @jsxImportSource @opentui/react */
/**
 * Screen 3 — Functions. Every registered function grouped by module, with its
 * kind. (The argument-form runner from the design mock lands in the next phase;
 * this ships the listing the web dashboard's dropdown provided.)
 */
import { useMemo } from "react";
import { useTerminalDimensions } from "@opentui/react";
import { useTheme } from "@/components/ui/theme-provider";
import type { TuiBridge } from "../bridge";

const KIND_COLOR: Record<string, keyof ReturnType<typeof useTheme>["colors"]> = {
  query: "info",
  mutation: "primary",
  action: "warning",
  httpAction: "success",
};

export function FunctionsScreen({ bridge }: { bridge: TuiBridge }) {
  const theme = useTheme();
  const { height } = useTerminalDimensions();
  const fns = bridge.data?.listFunctions() ?? [];

  const grouped = useMemo(() => {
    const byModule = new Map<string, Array<{ name: string; kind: string }>>();
    for (const f of fns) {
      const [mod = "", name = f.path] = f.path.split(":");
      const list = byModule.get(mod) ?? [];
      list.push({ name, kind: f.kind });
      byModule.set(mod, list);
    }
    return [...byModule.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [fns]);

  if (!bridge.data) {
    return <text fg={theme.colors.mutedForeground}>{"function listing is unavailable on this host"}</text>;
  }

  let budget = Math.max(1, height - 6);
  return (
    <box flexDirection="column" flexGrow={1}>
      <text fg={theme.colors.mutedForeground}>{`functions  ${fns.length}`}</text>
      {grouped.map(([mod, list]) => {
        if (budget <= 0) return null;
        budget -= 1 + list.length;
        return (
          <box key={mod} flexDirection="column">
            <text fg={theme.colors.border}>{mod}</text>
            {list.map((f) => (
              <text key={`${mod}:${f.name}`}>
                <span fg={theme.colors.foreground}>{`  ${f.name.padEnd(24)}`}</span>
                <span fg={theme.colors[KIND_COLOR[f.kind] ?? "mutedForeground"]}>{f.kind}</span>
              </text>
            ))}
          </box>
        );
      })}
    </box>
  );
}
