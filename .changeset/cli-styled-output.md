---
"@helipod/cli": patch
---

`helipod dev` output gets a proper terminal presentation on interactive
terminals: a branded startup block with aligned URLs, a truncated admin key,
a functions/tables/components summary, styled reload lines, and actionable
multi-line error blocks. Piped/CI output (and `NO_COLOR`/`HELIPOD_PLAIN`)
stays byte-identical to the previous plain format.
