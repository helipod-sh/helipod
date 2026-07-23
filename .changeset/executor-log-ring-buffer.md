---
"@helipod/executor": patch
---

The in-memory execution log is now a true circular buffer (fixed array + head
pointer) instead of an array with `shift()` on overflow, so `push` — which runs
on every function call — stays O(1) once the 1000-entry buffer is full. `query`
walks newest-first directly and short-circuits at `limit`, avoiding a full copy
and reverse of the buffer on every read.
