---
"@helipod/tui": patch
"@helipod/cli": patch
---

The terminal dashboard gains its remaining screens: logs (execution log with
an errors-only filter), schema (tables, validator-typed fields, indexes,
shard keys), and a function runner whose argument form is generated from each
function's own `args` validators and executes through the admin API. Five
screens now switch on the number keys.
