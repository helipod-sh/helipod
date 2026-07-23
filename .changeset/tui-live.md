---
"@helipod/tui": patch
"@helipod/cli": patch
---

The terminal dashboard is now live: it subscribes to the engine's write fan-out,
so a committed mutation repaints the visible table, row counts, metrics, and
logs immediately — no polling, no manual refresh.
