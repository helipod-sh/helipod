/* @jsxImportSource @opentui/react */
/**
 * Screen 5 — Schema. Tables → fields (with their validator types) → indexes,
 * exactly as declared in the project's `schema.ts`. Component-owned tables are
 * marked, since they are managed by their component rather than the app.
 */
import { useMemo } from "react";
import { useTerminalDimensions } from "@opentui/react";
import { useTheme } from "@/components/ui/theme-provider";
import { objectFields, type ValidatorJSON } from "@/lib/validator";
import type { TuiBridge } from "../bridge";

interface TableDef {
  documentType?: ValidatorJSON;
  indexes?: Array<{ indexDescriptor: string; fields?: string[] }>;
  shardKey?: string | null;
}

export function SchemaScreen({ bridge }: { bridge: TuiBridge }) {
  const theme = useTheme();
  const { height } = useTerminalDimensions();

  const tables = useMemo(() => {
    const schema = bridge.data?.schema() as { tables?: Record<string, TableDef> } | undefined;
    return Object.entries(schema?.tables ?? {}).sort(([a], [b]) => a.localeCompare(b));
  }, [bridge]);

  if (!bridge.data) {
    return <text fg={theme.colors.mutedForeground}>{"schema is unavailable on this host"}</text>;
  }
  if (tables.length === 0) {
    return <text fg={theme.colors.border}>{"no tables declared in schema.ts"}</text>;
  }

  let budget = Math.max(1, height - 6);
  return (
    <box flexDirection="column" flexGrow={1}>
      <text fg={theme.colors.mutedForeground}>{`schema  ${tables.length} tables`}</text>
      {tables.map(([name, def]) => {
        if (budget <= 0) return null;
        const fields = objectFields(def.documentType);
        const indexes = def.indexes ?? [];
        budget -= 2 + fields.length + (indexes.length ? 1 : 0);
        return (
          <box key={name} flexDirection="column">
            <text>
              <span fg={theme.colors.primary}>{`● ${name}`}</span>
              {def.shardKey ? (
                <span fg={theme.colors.border}>{`   shardBy ${def.shardKey}`}</span>
              ) : null}
            </text>
            {fields.map((f, i) => (
              <text key={f.name}>
                <span fg={theme.colors.border}>{`  ${i === fields.length - 1 && !indexes.length ? "└" : "├"} `}</span>
                <span fg={theme.colors.foreground}>{f.name.padEnd(18)}</span>
                <span fg={theme.colors.info}>{f.type}</span>
                {f.optional ? <span fg={theme.colors.border}>{"  optional"}</span> : null}
              </text>
            ))}
            {indexes.length ? (
              <text>
                <span fg={theme.colors.border}>{"  └ "}</span>
                <span fg={theme.colors.mutedForeground}>
                  {indexes.map((ix) => ix.indexDescriptor).join(" · ")}
                </span>
              </text>
            ) : null}
          </box>
        );
      })}
    </box>
  );
}
