# @helipod/tui

## 0.1.5

### Patch Changes

- [#13](https://github.com/helipod-sh/helipod/pull/13) [`6e857cd`](https://github.com/helipod-sh/helipod/commit/6e857cd3338a8b9604ab1e4014740ab91567c6ac) Thanks [@dbjpanda](https://github.com/dbjpanda)! - The terminal dashboard gains its remaining screens: logs (execution log with
  an errors-only filter), schema (tables, validator-typed fields, indexes,
  shard keys), and a function runner whose argument form is generated from each
  function's own `args` validators and executes through the admin API. Five
  screens now switch on the number keys.

- [#13](https://github.com/helipod-sh/helipod/pull/13) [`6e857cd`](https://github.com/helipod-sh/helipod/commit/6e857cd3338a8b9604ab1e4014740ab91567c6ac) Thanks [@dbjpanda](https://github.com/dbjpanda)! - The terminal dashboard drops the sidebar and turns the bottom bar into buttons:
  each destination is a clickable target as well as a keyboard shortcut, with the
  active screen drawn filled.

- [#13](https://github.com/helipod-sh/helipod/pull/13) [`6e857cd`](https://github.com/helipod-sh/helipod/commit/6e857cd3338a8b9604ab1e4014740ab91567c6ac) Thanks [@dbjpanda](https://github.com/dbjpanda)! - The overview gains a chart row: calls over time as a line chart, a latency
  histogram with fixed buckets, and a success-rate gauge — all from the engine's
  execution log, refreshed on every commit.

- [#13](https://github.com/helipod-sh/helipod/pull/13) [`6e857cd`](https://github.com/helipod-sh/helipod/commit/6e857cd3338a8b9604ab1e4014740ab91567c6ac) Thanks [@dbjpanda](https://github.com/dbjpanda)! - The terminal dashboard gains its interactive surfaces: press `⏎` on the data
  screen to inspect a document field by field (`J`/`K` walks rows), `f` to filter
  a table (`field=value` becomes a server-side equality condition), and `:` to
  open a fuzzy command palette over every screen, table, and function.

- [#13](https://github.com/helipod-sh/helipod/pull/13) [`6e857cd`](https://github.com/helipod-sh/helipod/commit/6e857cd3338a8b9604ab1e4014740ab91567c6ac) Thanks [@dbjpanda](https://github.com/dbjpanda)! - The terminal dashboard is now live: it subscribes to the engine's write fan-out,
  so a committed mutation repaints the visible table, row counts, metrics, and
  logs immediately — no polling, no manual refresh.

- [#13](https://github.com/helipod-sh/helipod/pull/13) [`6e857cd`](https://github.com/helipod-sh/helipod/commit/6e857cd3338a8b9604ab1e4014740ab91567c6ac) Thanks [@dbjpanda](https://github.com/dbjpanda)! - The terminal dashboard adopts termcn's navigation components: a persistent
  sidebar listing every screen with its shortcut, the registry command palette,
  and cursor-based pagination on the data browser (`[` / `]` walk pages).

- [#13](https://github.com/helipod-sh/helipod/pull/13) [`6e857cd`](https://github.com/helipod-sh/helipod/commit/6e857cd3338a8b9604ab1e4014740ab91567c6ac) Thanks [@dbjpanda](https://github.com/dbjpanda)! - The overview screen is redesigned around the numbers that matter: live client
  connections, active subscriptions, and uptime now come from a new admin stats
  surface, the latency histogram derives its buckets from the data instead of
  fixed guesses, duplicate visualizations are gone, and the activity feed is a
  bordered panel rather than floating text.

- [#13](https://github.com/helipod-sh/helipod/pull/13) [`6e857cd`](https://github.com/helipod-sh/helipod/commit/6e857cd3338a8b9604ab1e4014740ab91567c6ac) Thanks [@dbjpanda](https://github.com/dbjpanda)! - The helipod terminal dashboard (phase 1): a new `@helipod/tui` package —
  OpenTUI-rendered, with vendored termcn components and the helipod dark theme
  (the website's palette) — attaches automatically to `helipod dev` on an
  interactive terminal under Bun. Ships the Overview screen (deployment facts,
  project summary, live reload activity) with `o` open-dashboard and `q` quit
  keys. Opt out with `--no-ui` or `HELIPOD_TUI=0`; non-TTY, CI, and Node hosts
  keep the plain/styled output unchanged.

- [#13](https://github.com/helipod-sh/helipod/pull/13) [`6e857cd`](https://github.com/helipod-sh/helipod/commit/6e857cd3338a8b9604ab1e4014740ab91567c6ac) Thanks [@dbjpanda](https://github.com/dbjpanda)! - The terminal dashboard gains real engine metrics and proper layout: overview
  cards now show run counts, error counts, p50/p95 durations, a per-kind call
  breakdown, and a live sparkline of call volume — all derived from the engine's
  own execution log. The data browser renders a bordered table, and every screen
  has consistent padding.
