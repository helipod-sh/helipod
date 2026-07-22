/* @jsxImportSource @opentui/react */
/**
 * Screen 3 — Functions, with the runner.
 *
 * Left: every registered function grouped by module, with its kind.
 * Right: a form generated from the selected function's OWN argument validators
 * (`v.string()` → text, `v.number()` → numeric, `v.id("t")` → id) — the same
 * `argsType` metadata codegen emits, so the form can never drift from the code.
 * Enter runs it through the admin API and shows the result, timing, and whether
 * it committed.
 */
import { useEffect, useMemo, useState } from "react";
import { useKeyboard, useTerminalDimensions } from "@opentui/react";
import { useTheme } from "@/components/ui/theme-provider";
import { coerce, objectFields, type ValidatorJSON } from "@/lib/validator";
import type { TuiBridge } from "../bridge";

type Pane = "list" | "form";

interface RunResult {
  ok: boolean;
  value?: unknown;
  committed?: boolean;
  error?: string;
  ms: number;
}

export function FunctionsScreen({ bridge, active }: { bridge: TuiBridge; active: boolean }) {
  const theme = useTheme();
  const { height } = useTerminalDimensions();
  const fns = useMemo(() => bridge.data?.listFunctions() ?? [], [bridge]);

  const [selected, setSelected] = useState(0);
  const [pane, setPane] = useState<Pane>("list");
  const [field, setField] = useState(0);
  const [values, setValues] = useState<Record<string, string>>({});
  const [result, setResult] = useState<RunResult | null>(null);
  const [running, setRunning] = useState(false);

  const fn = fns[selected];
  const args = useMemo(
    () => objectFields(fn?.argsType as ValidatorJSON | undefined),
    [fn],
  );

  // Selecting a different function clears the form — stale values from another
  // signature would silently produce wrong calls.
  useEffect(() => {
    setValues({});
    setField(0);
    setResult(null);
  }, [fn?.path]);

  const run = async () => {
    if (!fn || !bridge.data || running) return;
    const payload: Record<string, unknown> = {};
    for (const a of args) {
      const raw = values[a.name] ?? "";
      const v = coerce(raw, a.raw);
      if (v !== undefined) payload[a.name] = v;
    }
    setRunning(true);
    const started = Date.now();
    try {
      const r = await bridge.data.runFunction(fn.path, payload);
      setResult({ ok: true, value: r.value, committed: r.committed, ms: Date.now() - started });
    } catch (e) {
      setResult({ ok: false, error: e instanceof Error ? e.message : String(e), ms: Date.now() - started });
    } finally {
      setRunning(false);
    }
  };

  useKeyboard((key) => {
    if (!active) return;
    if (key.name === "tab") {
      setPane((p) => (p === "list" ? "form" : "list"));
      return;
    }
    if (pane === "list") {
      if (key.name === "j" || key.name === "down") setSelected((i) => Math.min(fns.length - 1, i + 1));
      else if (key.name === "k" || key.name === "up") setSelected((i) => Math.max(0, i - 1));
      else if (key.name === "return") setPane("form");
      return;
    }
    // form pane
    if (key.name === "return") {
      void run();
    } else if (key.name === "down") {
      setField((i) => Math.min(Math.max(0, args.length - 1), i + 1));
    } else if (key.name === "up") {
      setField((i) => Math.max(0, i - 1));
    } else if (key.name === "escape") {
      setPane("list");
    } else if (key.name === "backspace") {
      const a = args[field];
      if (a) setValues((v) => ({ ...v, [a.name]: (v[a.name] ?? "").slice(0, -1) }));
    } else if (key.sequence && key.sequence.length === 1 && !key.ctrl && !key.meta) {
      const a = args[field];
      if (a) setValues((v) => ({ ...v, [a.name]: (v[a.name] ?? "") + key.sequence }));
    }
  });

  if (!bridge.data) {
    return <text fg={theme.colors.mutedForeground}>{"function listing is unavailable on this host"}</text>;
  }

  const listWidth = 34;
  const rows = Math.max(1, height - 7);
  let lastModule = "";

  return (
    <box flexDirection="row" flexGrow={1}>
      {/* list */}
      <box flexDirection="column" width={listWidth} flexShrink={0}>
        <text fg={pane === "list" ? theme.colors.primary : theme.colors.mutedForeground}>
          {`functions  ${fns.length}`}
        </text>
        {fns.slice(0, rows).map((f, i) => {
          const [mod = "", name = f.path] = f.path.split(":");
          const header = mod !== lastModule ? mod : null;
          lastModule = mod;
          return (
            <box key={f.path} flexDirection="column">
              {header ? <text fg={theme.colors.border}>{header}</text> : null}
              <text>
                <span fg={i === selected ? theme.colors.primary : theme.colors.foreground}>
                  {`${i === selected ? " ▸ " : "   "}${name.padEnd(20).slice(0, 20)}`}
                </span>
                <span fg={theme.colors.mutedForeground}>{f.kind}</span>
              </text>
            </box>
          );
        })}
      </box>

      {/* runner */}
      <box flexDirection="column" flexGrow={1}>
        <text fg={pane === "form" ? theme.colors.primary : theme.colors.mutedForeground}>
          {fn ? `run  ${fn.path}` : "run"}
        </text>
        {args.length === 0 ? (
          <text fg={theme.colors.border}>{"(no arguments)"}</text>
        ) : (
          args.map((a, i) => (
            <box key={a.name} flexDirection="column">
              <text>
                <span fg={theme.colors.mutedForeground}>{`${a.name}${a.optional ? "?" : ""}  `}</span>
                <span fg={theme.colors.border}>{a.type}</span>
              </text>
              <text>
                <span fg={pane === "form" && i === field ? theme.colors.primary : theme.colors.border}>
                  {pane === "form" && i === field ? " ▸ " : "   "}
                </span>
                <span fg={theme.colors.foreground}>
                  {`${values[a.name] ?? ""}${pane === "form" && i === field ? "█" : ""}`}
                </span>
              </text>
            </box>
          ))
        )}
        <text fg={theme.colors.border}>
          {pane === "form" ? "  ⏎ run · ↑↓ field · esc back" : "  tab or ⏎ to fill arguments"}
        </text>
        {running ? <text fg={theme.colors.warning}>{"  running…"}</text> : null}
        {result ? (
          <box flexDirection="column">
            <text>
              <span fg={result.ok ? theme.colors.success : theme.colors.error}>
                {result.ok ? "  ✓ ok" : "  ✗ failed"}
              </span>
              <span fg={theme.colors.border}>{`  ${result.ms}ms${result.committed ? " · committed" : ""}`}</span>
            </text>
            <text fg={result.ok ? theme.colors.foreground : theme.colors.error}>
              {`  ${(result.ok ? JSON.stringify(result.value) : result.error) ?? "undefined"}`.slice(0, 200)}
            </text>
          </box>
        ) : null}
      </box>
    </box>
  );
}
