# Contributing to Helipod

Thanks for helping build the open-source reactive backend. This document is the
complete path from clone to merged PR.

## Setup

```bash
git clone https://github.com/helipod-sh/helipod
cd helipod
bun install
bun run build        # build all packages (required before running tests)
bun run test         # fast lane — should pass before you start
```

Bun is the package manager and primary runtime. Tests run under Node via vitest.

## How changes ship

**Every change lands through a pull request — including from maintainers.**
`main` is protected: direct pushes are rejected, and the merge button unlocks
only when CI passes.

1. **Branch** off `main`: `git checkout -b fix/what-you-are-fixing`
   (prefixes: `feat/`, `fix/`, `docs/`, `test/`, `refactor/`, `ci/`, `chore/`)
2. **Make the change.** Match the surrounding code's style. If you change
   behavior, add or update tests — a cross-package feature needs an end-to-end
   test through the real `helipod dev`/`serve` server
   (see `packages/cli/test/*-e2e.test.ts` for the pattern).
3. **Add a changeset** if the change affects any published package:
   ```bash
   bunx changeset
   ```
   Pick the bump (patch = fix, minor = feature, major = breaking) and write a
   short paragraph — it becomes the changelog entry. Docs-only, test-only, and
   CI-only changes don't need one.
4. **Open the PR.** The title must be a conventional commit
   (`fix(scheduler): honor runAfter when runAt is unset`) — a bot checks it,
   and it becomes the commit message on `main` (we squash-merge).
5. **Sign the CLA** (first PR only): comment
   `I have read the CLA Document and I hereby sign the CLA` on your PR.
   The terms are in [CLA.md](CLA.md).
6. **CI must pass** — build, typecheck, and the fast test lane run on every PR.
   Merges are squash-only; your branch is deleted automatically.

## Tests

Two lanes, kept deliberately separate:

- `bun run test` — the fast parallel lane (unit + in-process integration).
  Runs on every PR. Must pass reliably.
- `bun run test:e2e` — the serial lane for heavy real-process E2Es (multi-node
  fleet, real containers, child-spawning tests). Runs on `main`.

When you add a real-process E2E, name it `*-e2e.test.ts` (or `*.e2e.test.ts`)
and wire it to the package's `test:e2e` script — never let it into the default
`test` script. Prefer deterministic constructions (injected clocks, explicit
triggers) over wall-clock waits; CI runners are slow and will find your race.

Run one package's tests with `bun run --filter @helipod/<name> test`.
Note that cross-package tests resolve dependencies via built `dist/` — rebuild
(`bun run build`) after editing a dependency or your change is invisible.

## Releases (maintainers)

Releases are automated with changesets. Merged changesets accumulate in a
bot-maintained "Version Packages" PR; merging that PR publishes to npm via
OIDC trusted publishing (no tokens), creates git tags, and updates changelogs.
Core engine packages version in lockstep; components version independently.

## Licensing

The repository is FSL-1.1-Apache-2.0, except `ee/`, which is source-available
under a commercial license (see `ee/LICENSE`). Contributions to either area
require the signed CLA.

## Questions

Open a GitHub issue or discussion. Sample apps under `examples/` are the
fastest way to see the expected end-to-end behavior of any feature.
