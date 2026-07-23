# @helipod/executor

## 0.1.5

### Patch Changes

- [#13](https://github.com/helipod-sh/helipod/pull/13) [`6e857cd`](https://github.com/helipod-sh/helipod/commit/6e857cd3338a8b9604ab1e4014740ab91567c6ac) Thanks [@dbjpanda](https://github.com/dbjpanda)! - The in-memory execution log is now a true circular buffer (fixed array + head
  pointer) instead of an array with `shift()` on overflow, so `push` — which runs
  on every function call — stays O(1) once the 1000-entry buffer is full. `query`
  walks newest-first directly and short-circuits at `limit`, avoiding a full copy
  and reverse of the buffer on every read.
- Updated dependencies []:
  - @helipod/docstore@0.1.5
  - @helipod/docstore-d1@0.1.5
  - @helipod/errors@0.1.5
  - @helipod/id-codec@0.1.5
  - @helipod/index-key-codec@0.1.5
  - @helipod/query-engine@0.1.5
  - @helipod/transactor@0.1.5
  - @helipod/values@0.1.5

## 0.1.4

### Patch Changes

- Updated dependencies []:
  - @helipod/docstore@0.1.4
  - @helipod/docstore-d1@0.1.4
  - @helipod/errors@0.1.4
  - @helipod/id-codec@0.1.4
  - @helipod/index-key-codec@0.1.4
  - @helipod/query-engine@0.1.4
  - @helipod/transactor@0.1.4
  - @helipod/values@0.1.4

## 0.1.3

### Patch Changes

- Updated dependencies []:
  - @helipod/docstore@0.1.3
  - @helipod/docstore-d1@0.1.3
  - @helipod/errors@0.1.3
  - @helipod/id-codec@0.1.3
  - @helipod/index-key-codec@0.1.3
  - @helipod/query-engine@0.1.3
  - @helipod/transactor@0.1.3
  - @helipod/values@0.1.3
