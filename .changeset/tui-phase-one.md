---
"@helipod/tui": patch
"@helipod/cli": patch
"helipod": patch
---

The helipod terminal dashboard (phase 1): a new `@helipod/tui` package —
OpenTUI-rendered, with vendored termcn components and the helipod dark theme
(the website's palette) — attaches automatically to `helipod dev` on an
interactive terminal under Bun. Ships the Overview screen (deployment facts,
project summary, live reload activity) with `o` open-dashboard and `q` quit
keys. Opt out with `--no-ui` or `HELIPOD_TUI=0`; non-TTY, CI, and Node hosts
keep the plain/styled output unchanged.
