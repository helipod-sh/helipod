---
"@helipod/cli": patch
---

`helipod dev` hot reload now refreshes the admin API's function manifest and
schema, so `GET /_admin/functions` and the dashboard's Functions list pick up
newly added functions immediately instead of serving the boot-time catalog
until restart. (#1)
