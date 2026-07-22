/**
 * Terminal output styling for the helipod CLI — zero dependencies, degradation-first.
 *
 * Rules of the house:
 *  - Styling activates ONLY on a real interactive terminal (`isTTY`), and never when
 *    `NO_COLOR` (https://no-color.org) or `TERM=dumb` is set. Piped/CI output — including
 *    our own e2e tests, which scrape exact plain lines — stays byte-identical to the
 *    pre-styling CLI.
 *  - `helipod serve` never imports this module's styled paths: production logs are a
 *    machine contract (grep-able lines, the `{"ready":…}` JSON handshake).
 *  - No frameworks here. The interactive dashboard (@helipod/tui) is a separate,
 *    dynamically-imported package; this module is plain ANSI for run-and-exit commands.
 */

export const styled: boolean =
  Boolean(process.stdout.isTTY) &&
  process.env.NO_COLOR === undefined &&
  process.env.TERM !== "dumb" &&
  process.env.HELIPOD_PLAIN === undefined;

const wrap = (open: string, close: string) => (s: string) => (styled ? `[${open}m${s}[${close}m` : s);

export const bold = wrap("1", "22");
export const dim = wrap("2", "22");
export const red = wrap("31", "39");
export const green = wrap("32", "39");
export const yellow = wrap("33", "39");
export const blue = wrap("34", "39");
export const magenta = wrap("35", "39");
export const cyan = wrap("36", "39");
/** The helipod brand crimson (website `--color-fd-primary`, dark), truecolor with 256-color fallback. */
export const brand = (s: string) =>
  styled ? `[38;2;224;70;103m${s}[39m` : s;

export const sym = {
  ok: green("✓"),
  fail: red("✗"),
  warn: yellow("⚠"),
  run: cyan("▸"),
  reload: cyan("↻"),
  mark: brand("◆"),
  arrow: dim("➜"),
} as const;

/** `◆ helipod v0.1.4` header for run-and-exit commands. */
export function banner(subtitle?: string, version = ""): string {
  const parts = [`${sym.mark} ${bold("helipod")}`, version ? dim(`v${version}`) : "", subtitle ? dim(subtitle) : ""];
  return parts.filter(Boolean).join(" ");
}

/** Aligned key→value rows: `  ➜  API        http://…` */
export function keyValues(rows: Array<[string, string]>): string {
  const w = Math.max(...rows.map(([k]) => k.length));
  return rows.map(([k, v]) => `  ${sym.arrow}  ${bold(k.padEnd(w + 2))}${v}`).join("\n");
}

/** One status line: `  ✓ transpiled 12 modules   0.4s` */
export function status(kind: "ok" | "fail" | "warn" | "run", text: string, meta?: string): string {
  const icon = sym[kind === "run" ? "run" : kind];
  return `  ${icon} ${text}${meta ? `   ${dim(meta)}` : ""}`;
}

/**
 * The error block — errors are the product. Always multi-line, always actionable:
 * what failed, the detail, and (when the caller knows one) the way out.
 */
export function errorBlock(title: string, detail?: string, hint?: string): string {
  const lines = [`  ${sym.fail} ${bold(red(title))}`];
  if (detail) lines.push(...detail.trimEnd().split("\n").map((l) => `    ${l}`));
  if (hint) lines.push(`    ${cyan("→")} ${hint}`);
  return lines.join("\n");
}
