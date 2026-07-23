# @helipod/cli

## 0.1.5

### Patch Changes

- [#11](https://github.com/helipod-sh/helipod/pull/11) [`f171b07`](https://github.com/helipod-sh/helipod/commit/f171b07bb4cfb8ca76b3a0903ab0ed458354e281) Thanks [@dbjpanda](https://github.com/dbjpanda)! - `helipod dev` output gets a proper terminal presentation on interactive
  terminals: a branded startup block with aligned URLs, a truncated admin key,
  a functions/tables/components summary, styled reload lines, and actionable
  multi-line error blocks. Piped/CI output (and `NO_COLOR`/`HELIPOD_PLAIN`)
  stays byte-identical to the previous plain format.

- [#13](https://github.com/helipod-sh/helipod/pull/13) [`6e857cd`](https://github.com/helipod-sh/helipod/commit/6e857cd3338a8b9604ab1e4014740ab91567c6ac) Thanks [@dbjpanda](https://github.com/dbjpanda)! - The terminal dashboard gains its remaining screens: logs (execution log with
  an errors-only filter), schema (tables, validator-typed fields, indexes,
  shard keys), and a function runner whose argument form is generated from each
  function's own `args` validators and executes through the admin API. Five
  screens now switch on the number keys.

- [#13](https://github.com/helipod-sh/helipod/pull/13) [`6e857cd`](https://github.com/helipod-sh/helipod/commit/6e857cd3338a8b9604ab1e4014740ab91567c6ac) Thanks [@dbjpanda](https://github.com/dbjpanda)! - The terminal dashboard is now live: it subscribes to the engine's write fan-out,
  so a committed mutation repaints the visible table, row counts, metrics, and
  logs immediately — no polling, no manual refresh.

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
- Updated dependencies [[`6e857cd`](https://github.com/helipod-sh/helipod/commit/6e857cd3338a8b9604ab1e4014740ab91567c6ac), [`6e857cd`](https://github.com/helipod-sh/helipod/commit/6e857cd3338a8b9604ab1e4014740ab91567c6ac)]:
  - @helipod/executor@0.1.5
  - @helipod/admin@0.1.5
  - @helipod/sync@0.1.5
  - @helipod/component@0.1.5
  - @helipod/docstore-postgres@0.1.5
  - @helipod/runtime-embedded@0.1.5
  - @helipod/storage@0.1.5
  - @helipod/deploy@0.1.5
  - @helipod/receipts@0.1.5
  - @helipod/dashboard@0.1.5
  - @helipod/blobstore@0.1.5
  - @helipod/blobstore-fs@0.1.5
  - @helipod/blobstore-s3@0.1.5
  - @helipod/codegen@0.1.5
  - @helipod/docstore@0.1.5
  - @helipod/docstore-sqlite@0.1.5
  - @helipod/errors@0.1.5
  - @helipod/id-codec@0.1.5
  - @helipod/objectstore@0.1.5
  - @helipod/objectstore-fs@0.1.5
  - @helipod/objectstore-s3@0.1.5
  - @helipod/query-engine@0.1.5
  - @helipod/values@0.1.5

## 0.1.4

### Patch Changes

- [#7](https://github.com/helipod-sh/helipod/pull/7) [`c906588`](https://github.com/helipod-sh/helipod/commit/c90658831380d0a9f4717f0a9d34c4fffcc9a95e) Thanks [@dbjpanda](https://github.com/dbjpanda)! - `helipod dev` hot reload now refreshes the admin API's function manifest and
  schema, so `GET /_admin/functions` and the dashboard's Functions list pick up
  newly added functions immediately instead of serving the boot-time catalog
  until restart. ([#1](https://github.com/helipod-sh/helipod/issues/1))
- Updated dependencies []:
  - @helipod/dashboard@0.1.4
  - @helipod/admin@0.1.4
  - @helipod/blobstore@0.1.4
  - @helipod/blobstore-fs@0.1.4
  - @helipod/blobstore-s3@0.1.4
  - @helipod/codegen@0.1.4
  - @helipod/component@0.1.4
  - @helipod/deploy@0.1.4
  - @helipod/docstore@0.1.4
  - @helipod/docstore-postgres@0.1.4
  - @helipod/docstore-sqlite@0.1.4
  - @helipod/errors@0.1.4
  - @helipod/executor@0.1.4
  - @helipod/id-codec@0.1.4
  - @helipod/objectstore@0.1.4
  - @helipod/objectstore-fs@0.1.4
  - @helipod/objectstore-s3@0.1.4
  - @helipod/query-engine@0.1.4
  - @helipod/receipts@0.1.4
  - @helipod/runtime-embedded@0.1.4
  - @helipod/storage@0.1.4
  - @helipod/sync@0.1.4
  - @helipod/values@0.1.4

## 0.1.3

### Patch Changes

- Updated dependencies []:
  - @helipod/docstore-postgres@0.1.3
  - @helipod/dashboard@0.1.3
  - @helipod/admin@0.1.3
  - @helipod/blobstore@0.1.3
  - @helipod/blobstore-fs@0.1.3
  - @helipod/blobstore-s3@0.1.3
  - @helipod/codegen@0.1.3
  - @helipod/component@0.1.3
  - @helipod/deploy@0.1.3
  - @helipod/docstore@0.1.3
  - @helipod/docstore-sqlite@0.1.3
  - @helipod/errors@0.1.3
  - @helipod/executor@0.1.3
  - @helipod/id-codec@0.1.3
  - @helipod/objectstore@0.1.3
  - @helipod/objectstore-fs@0.1.3
  - @helipod/objectstore-s3@0.1.3
  - @helipod/query-engine@0.1.3
  - @helipod/receipts@0.1.3
  - @helipod/runtime-embedded@0.1.3
  - @helipod/storage@0.1.3
  - @helipod/sync@0.1.3
  - @helipod/values@0.1.3
