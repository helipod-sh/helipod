# helipod

## 0.1.5

### Patch Changes

- [#13](https://github.com/helipod-sh/helipod/pull/13) [`6e857cd`](https://github.com/helipod-sh/helipod/commit/6e857cd3338a8b9604ab1e4014740ab91567c6ac) Thanks [@dbjpanda](https://github.com/dbjpanda)! - The helipod terminal dashboard (phase 1): a new `@helipod/tui` package —
  OpenTUI-rendered, with vendored termcn components and the helipod dark theme
  (the website's palette) — attaches automatically to `helipod dev` on an
  interactive terminal under Bun. Ships the Overview screen (deployment facts,
  project summary, live reload activity) with `o` open-dashboard and `q` quit
  keys. Opt out with `--no-ui` or `HELIPOD_TUI=0`; non-TTY, CI, and Node hosts
  keep the plain/styled output unchanged.
- Updated dependencies [[`f171b07`](https://github.com/helipod-sh/helipod/commit/f171b07bb4cfb8ca76b3a0903ab0ed458354e281), [`6e857cd`](https://github.com/helipod-sh/helipod/commit/6e857cd3338a8b9604ab1e4014740ab91567c6ac), [`6e857cd`](https://github.com/helipod-sh/helipod/commit/6e857cd3338a8b9604ab1e4014740ab91567c6ac), [`6e857cd`](https://github.com/helipod-sh/helipod/commit/6e857cd3338a8b9604ab1e4014740ab91567c6ac), [`6e857cd`](https://github.com/helipod-sh/helipod/commit/6e857cd3338a8b9604ab1e4014740ab91567c6ac), [`6e857cd`](https://github.com/helipod-sh/helipod/commit/6e857cd3338a8b9604ab1e4014740ab91567c6ac), [`6e857cd`](https://github.com/helipod-sh/helipod/commit/6e857cd3338a8b9604ab1e4014740ab91567c6ac), [`6e857cd`](https://github.com/helipod-sh/helipod/commit/6e857cd3338a8b9604ab1e4014740ab91567c6ac), [`6e857cd`](https://github.com/helipod-sh/helipod/commit/6e857cd3338a8b9604ab1e4014740ab91567c6ac), [`6e857cd`](https://github.com/helipod-sh/helipod/commit/6e857cd3338a8b9604ab1e4014740ab91567c6ac), [`6e857cd`](https://github.com/helipod-sh/helipod/commit/6e857cd3338a8b9604ab1e4014740ab91567c6ac)]:
  - @helipod/cli@0.1.5
  - @helipod/executor@0.1.5
  - @helipod/tui@0.1.5
  - @helipod/client@0.1.5
  - @helipod/component@0.1.5
  - @helipod/values@0.1.5

## 0.1.4

### Patch Changes

- Updated dependencies [[`c906588`](https://github.com/helipod-sh/helipod/commit/c90658831380d0a9f4717f0a9d34c4fffcc9a95e)]:
  - @helipod/cli@0.1.4
  - @helipod/client@0.1.4
  - @helipod/component@0.1.4
  - @helipod/executor@0.1.4
  - @helipod/values@0.1.4

## 0.1.3

### Patch Changes

- [#3](https://github.com/helipod-sh/helipod/pull/3) [`50fb88f`](https://github.com/helipod-sh/helipod/commit/50fb88fa4ac89adfcfcea040d3197c72a314353c) Thanks [@dbjpanda](https://github.com/dbjpanda)! - Republish every package through OIDC trusted publishing — the first release
  with no publish token anywhere; all packages gain provenance attestations.
- Updated dependencies []:
  - @helipod/cli@0.1.3
  - @helipod/client@0.1.3
  - @helipod/component@0.1.3
  - @helipod/executor@0.1.3
  - @helipod/values@0.1.3
