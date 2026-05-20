# DeployTarget Seam — Design Spec

**Date:** 2026-05-15
**Status:** Design (pre-plan). Brainstorming complete; awaiting user review before writing the implementation plan.
**Author:** clean-room design, grounded in a four-way study of Convex, Supabase, concave (alpha.19), and lunora (alpha.88) CLIs — see "Research basis" below.

## Goal

Give Stackbase a **flexible, multi-provider deploy system** — one `stackbase deploy` that can target Cloudflare (DO-native), a container host (Railway/Fly/AWS), a running `serve` (live hot-swap), or the local machine — across **environments** (dev/staging/production) — behind a seam, without bloating the CLI or reimplementing any provider's API. Same app code, many targets. Deploy-anywhere is the thesis; this seam is how it stays honest as we add providers.

## Non-goals (v1)

- **Not** a managed cloud control plane (deployments/versions/promote/rollback/metrics/quota). Concave alpha.19 grew this as its paid tier; for us it is a future `ee/` concern, not this slice.
- **Not** multi-tenancy / Worker Loader (user-deferred).
- **Not** the Convex multi-phase incremental push (`start → wait_for_schema → finish`, hash-delta modules). Worthwhile, but a **push-mode enhancement** documented as a follow-on, not built here.
- **Not** the CF-native single-origin Vite dev integration (`@cloudflare/vite-plugin`). Related but separate (a dev-experience slice); noted at the end, not built here.
- **Not** bundling any provider SDK. Providers are reached by shelling out to their own CLI.

## Research basis (why these decisions)

Four incumbent CLIs were studied (2026-05-15). The convergence is strong and directly shapes this design:

| Tool | Remote deploy mechanism | Provider tool | Bundled cloud deps | Config location |
|---|---|---|---|---|
| **Convex** | HTTP push to a running backend (`deploy2`: start→wait_for_schema→finish), brotli, hash-delta modules | none (own engine) | esbuild, prettier, ws only | `convex.json` + `CONVEX_DEPLOYMENT`/`CONVEX_DEPLOY_KEY` |
| **Supabase** | Management API upload (functions); embedded pg driver (migrations) | Docker for **local only** | Go libs, no cloud SDK | `supabase/config.toml` + `env()` + gitignored `.env` |
| **concave alpha.19** | `--cloud`: HTTP push · `--cf`: **generate wrangler.jsonc + shell `wrangler deploy`** | **wrangler as peerDependency** | esbuild; wrangler NOT bundled | `DeploymentConfig.mode: push\|bundle\|auto` |
| **lunora alpha.88** | **wrap `wrangler deploy`** via injectable Spawner; **reconcile** wrangler.jsonc bindings | wrangler (project-local, `npx`/`pnpm exec`) | `@cloudflare/vite-plugin`; wrangler NOT bundled | template `wrangler.jsonc` + `--env` → wrangler envs |

Load-bearing conclusions:

1. **Nobody bundles a cloud SDK; nobody reimplements a provider API.** Remote work is a thin HTTP push (own backend) or a shell-out to the provider's own CLI. This is the definitive answer to "will deploy make the CLI heavy / bottleneck it?" — **no**: provider CLIs are subprocesses invoked only at deploy time, off the runtime path.
2. **The two Cloudflare-native reactive backends (concave, lunora) — our closest analogs — both generate/reconcile `wrangler.jsonc` and shell `wrangler deploy`, wrangler as a peer/project dependency.** That is exactly the approach this spec adopts.
3. **Deploy is two modes, not one:** *push* (to a running backend — Convex, concave-`--cloud`) and *provision* (package + push to provider infra — concave-`--cf`, lunora, Supabase functions). Stackbase already ships push mode (`stackbase deploy` → `POST /_admin/deploy`, slice 6b).
4. **Reconcile beats regenerate.** Lunora *reconciles/augments* a user's `wrangler.jsonc` (respecting hand-edits); concave *regenerates* it. Reconcile is safer.
5. **Environments:** the CF-native tools just pass `--env <name>` through to wrangler; Convex/Supabase use per-project linking (deploy key / `link`). Supabase's real gap — *no first-class environments model, no pluggable targets* — is precisely what deploy-anywhere must supply.
6. **A `Spawner` seam** (lunora `util/spawn.ts`) makes every shell-out unit-testable without invoking the real provider CLI.

## Current state this builds on

- `packages/cli/src/cli.ts` — plain `switch(cmd)` dispatch (no command framework); commands are `(args) => Promise<number>` functions.
- `packages/cli/src/deploy.ts` — **push mode already exists**: `resolveDeployOptions` → refresh codegen → `packageApp()` (esbuild `transform`, TS→JS, specifiers untouched) → `POST /_admin/deploy` with `Bearer STACKBASE_ADMIN_KEY`. This becomes the **`serve` target**.
- `packages/runtime-embedded/src/host.ts` — the `RuntimeHost` seam (`ProcessRuntimeHost`; a Durable Object host in `packages/runtime-cloudflare`). Validated twice by the research (concave `ConcaveServerBase` platform-ports; lunora structural DI). **Unchanged by this spec.**
- `packages/runtime-cloudflare` — the DO host, already proven this session (133ms writes, a deployed chat app). The CF target's `push` deploys *this* Worker+DO.
- `StackbaseConfig` (`packages/component/src/config.ts`) — currently `{ components }`. Extended here with an optional `deploy` block.

## Architecture

### The two modes

- **Push mode** — send transpiled functions/schema to an already-running Stackbase (`serve --allow-deploy`). Live hot-swap, no restart. *Already shipped* (slice 6b); reframed as the `serve` target.
- **Provision mode** — package a deployable artifact and push it to provider infrastructure that isn't running yet:
  - `cloudflare` → reconcile `wrangler.jsonc` bindings from schema/components, then shell `wrangler deploy` of the `runtime-cloudflare` Worker+DO.
  - `docker` → run the packaged artifact locally via `docker compose up` / the built image — the "test the real production artifact" target, distinct from the in-process `stackbase dev` loop (named `docker`, not `local`, precisely because `stackbase dev` is *also* local — the distinction is in-process dev vs. the real containerized artifact).
  - `railway` / `fly` / `aws` (follow-ons) → build the Docker image, shell the provider CLI (`railway up` / `flyctl deploy` / …).

### The `DeployTarget` seam

New package **`packages/deploy`** (`@stackbase/deploy`) holds the seam + adapters, keeping the CLI thin. Adapters are **lazy-loaded** — the `cloudflare` adapter's module (and its dep on `runtime-cloudflare`) loads only when `--target cloudflare` is used, mirroring how the CLI already dynamically imports `@stackbase/fleet`. The engine never imports this package (build-time orchestration only).

```ts
// @stackbase/deploy — the seam

export interface Spawner {
  run(
    cmd: string,
    args: string[],
    opts?: { cwd?: string; env?: Record<string, string>; stdio?: "inherit" | "capture" },
  ): Promise<{ code: number; stdout: string; stderr: string }>;
}

export interface FileTree {
  files: Array<{ path: string; code: string }>; // the packageApp() output shape (reused verbatim)
}

export interface DeployContext {
  cwd: string;
  convexDir: string;
  env: string;                       // resolved environment name, e.g. "production"
  targetConfig: ResolvedTargetConfig; // this target's config merged with the env overrides
  interactive: boolean;              // stdin.isTTY && !process.env.CI — gates any prompt; false in CI
  spawn: Spawner;                    // injectable — real subprocess in prod, fake in tests
  log: (msg: string) => void;
  packageApp: () => Promise<FileTree>; // shared esbuild transpile (from deploy.ts, extracted)
  codegen: () => Promise<void>;        // refresh convex/_generated
}

export interface DeployResult {
  ok: boolean;
  url?: string;      // the deployed URL (auto-linked back into project state)
  detail?: string;   // rev/version/functions-count etc. for the success line
  error?: string;
}

export interface DeployTarget {
  readonly name: string; // "serve" | "cloudflare" | "docker" | ...
  /** Fail fast with a clear, actionable message: wrangler not installed, admin key unset,
   *  Docker not running, required config missing. Runs BEFORE any packaging. MUST NOT prompt or
   *  block on stdin when `ctx.interactive` is false (CI) — require every credential up front and
   *  error, so a missing secret is a fail-fast, never a hang. */
  preflight(ctx: DeployContext): Promise<void>;
  /** Produce the artifact: transpile the app, and for provision targets reconcile the
   *  provider config (wrangler.jsonc bindings) / build the image. Idempotent, no push. */
  package(ctx: DeployContext): Promise<void>;
  /** Push/provision: HTTP push (serve) or shell the provider CLI (cloudflare/local/...). */
  push(ctx: DeployContext): Promise<DeployResult>;
}
```

Three named phases (not one `deploy()`) so a reviewer/tester can gate each independently and the CLI can print progress — this mirrors lunora's flow (codegen → drift-gate → reconcile → validate → secrets → build → spawn → link) decomposed into testable steps. `preflight` is where "is wrangler installed?" lives, so a missing provider CLI is a clean message, never a stack trace mid-deploy.

### Config: extend `StackbaseConfig`

```ts
// packages/component/src/config.ts

export interface StackbaseConfig {
  components: ComponentDefinition[];
  deploy?: DeployConfig;
}

export interface DeployConfig {
  /** Used when --target is omitted. Defaults to "serve" for backward-compat with slice 6b. */
  defaultTarget?: string;
  /** Keyed by target name (the --target value). */
  targets?: Record<string, TargetConfig>;
}

export interface TargetConfig {
  provider: "serve" | "cloudflare" | "docker" | "railway" | "fly" | "aws";
  /** Provider-shared settings (provider-specific fields typed per provider). */
  [k: string]: unknown;
  /** Per-environment overrides, merged over the shared settings. --env selects one. */
  environments?: Record<string, Record<string, unknown>>;
}

/** Supabase-style deferred env resolution: reads process.env / a gitignored .env at load time. */
export function env(name: string, fallback?: string): string;
```

Example a project ships:

```ts
// stackbase.config.ts
export default defineConfig({
  components: [ /* ... */ ],
  deploy: {
    defaultTarget: "serve",
    targets: {
      serve: {
        provider: "serve",
        environments: {
          production: { url: env("STACKBASE_DEPLOY_URL"), adminKey: env("STACKBASE_ADMIN_KEY") },
        },
      },
      cloudflare: {
        provider: "cloudflare",
        // wrangler.jsonc is the source of truth; the adapter reconciles bindings into it.
        environments: {
          production: {},           // → `wrangler deploy` (top-level env)
          staging: { wranglerEnv: "staging" }, // → `wrangler deploy --env staging`
        },
      },
    },
  },
});
```

**Environment model — the deploy-anywhere answer:**
- For `cloudflare` (and other wrangler targets): `--env` maps to wrangler's own `env.<name>` sections (don't reinvent — this is what concave/lunora do).
- For `serve`/container targets (no wrangler): `--env` selects a config block supplying `url` + `adminKey` (+ target-specific fields). This is the first-class environments model Supabase lacks.
- Secrets: `env("VAR")` interpolation from a **gitignored `.env`** (Supabase's proven pattern), never committed.

### CLI surface

```
stackbase deploy [--target <name>] [--env <name>] [--dir convex] [--dry-run] [--check]
```

- `--target` omitted → `deploy.defaultTarget` (→ `serve`, preserving slice-6b behavior exactly).
- `--env` omitted → `"production"`.
- Back-compat: `stackbase deploy --url <url>` with no `--target` still works — it resolves to the `serve` target with an inline url (existing `resolveDeployOptions` path, kept).
- `--dry-run` runs `preflight` + `package` and skips `push` (for CI validation; lunora/wrangler both support this).
- `--check` fails (non-zero exit) if codegen would change committed `convex/_generated/` files — a drift gate for CI, the equivalent of `wrangler types --check`.

### CI / non-interactive deploy

CI is a **first-class caller of the same seam**, not a separate path. A workflow runs the identical `stackbase deploy --target <t> --env <e>`; only auth and interactivity differ.

- **Token auth from CI secrets, never interactive login.** No `wrangler login` (browser OAuth). Provider CLIs read tokens from env, resolved through the same `env()` mechanism (which reads the CI secret instead of a `.env` file): `cloudflare` → `CLOUDFLARE_API_TOKEN` (+ `CLOUDFLARE_ACCOUNT_ID`); `serve` → `STACKBASE_ADMIN_KEY` + `--url`; `railway`/`fly` → `RAILWAY_TOKEN`/`FLY_API_TOKEN`.
- **Fully non-interactive deploy path — a hard design constraint.** `preflight` is **TTY-aware** (`process.stdin.isTTY`): in non-interactive mode it requires every credential up front and **fails fast with an actionable message**, and **never prompts or blocks on stdin**. This specifically gates the "offer to mint a missing secret" step (which lunora does interactively) behind a TTY check — in CI a missing secret is a fail-fast error, not a hang.
- **Provider CLI must be on the runner.** Because we shell out rather than bundle, the workflow installs `wrangler`/`docker`/`flyctl` in a setup step (needed anyway); `preflight` verifies presence with a clear "install X" error otherwise.
- **Branch→environment mapping is the workflow's job, not the CLI's.** PRs run `--dry-run`/`--check` (or deploy to `--env staging`); merges to `main` run `--env production`. The CLI just takes `--target`/`--env` and returns a proper **exit code** (commands already return `Promise<number>`), so CI fails on non-zero.
- **The `docker` target's CI role is a smoke gate, not a deploy destination** — build the image → `docker compose up` → probe `/api/health` → tear down, as a pre-deploy check. Real CI deployment goes to `cloudflare`/`serve`/`railway`.

A copy-paste **example GitHub Actions workflow** ships in `docs/enduser/deploy/` (PR: `--check` + `--dry-run`; merge-to-main: `--env production`), so the branch-mapping pattern is documented, not left as an exercise.

`runCli`'s `deploy` case grows from a direct `deployCommand` call to: load config → resolve `{target, env}` → lazy-import the adapter for `provider` → run `preflight → package → push` with a real `Spawner` → print the result line.

### The Cloudflare adapter (target #1)

`preflight`: `wrangler --version` via Spawner (clear "install wrangler" message on failure); `wrangler whoami` for auth; assert a `wrangler.jsonc` exists (or scaffold a template on first run, like lunora).
`package`: run codegen; transpile the app; **reconcile `wrangler.jsonc`** — infer required bindings from schema/components (DO for the reactive engine, R2 for blobstore if file storage is used, the `migrations`/`new_sqlite_classes` block for the DO-SQLite class) and *add missing ones without clobbering user edits*; bump `compatibility_date` if stale.
`push`: shell `wrangler deploy` (or `wrangler versions upload` for a `--preview`-style flag, follow-on); capture stdout to auto-link the deployed URL back into project state.

### The docker adapter (target #2)

`preflight`: Docker available (clear "Docker is not running / not installed" message otherwise — no silent fallback, since the whole point is to exercise the *container* artifact).
`package`: build/tag the image with the app's `convex/` baked or bind-mounted.
`push`: `docker compose up` / run the image; report the local URL. This runs the **real production artifact** locally — catching container-only bugs (`/data` chown, workspace symlinks) that the in-process `dev` loop structurally cannot.

## Testing

- **Unit (fast lane):** inject a fake `Spawner` that records `run(cmd, args)` calls and returns canned output. Assert the cloudflare adapter (a) preflights wrangler, (b) reconciles bindings into a fixture `wrangler.jsonc` additively (never dropping a user field), (c) issues `wrangler deploy` with the right `--env`. No real wrangler, no network. Assert config resolution: `--target`/`--env` defaulting, env-override merge, `env()` interpolation.
- **Non-interactive / CI (fast lane):** with `ctx.interactive = false` and a required credential absent, `preflight` **rejects with a clear error and reads no stdin** (assert it never blocks) — the CI fail-fast contract. `--check` exits non-zero when codegen would change committed `_generated/`.
- **Back-compat (fast lane):** `deploy --url <url>` against a real in-process `serve --allow-deploy` still hot-swaps (the existing slice-6b E2E, unchanged — the `serve` target must be byte-for-byte the old path).
- **E2E gate (serial lane, `*-e2e.test.ts`):** a real `wrangler deploy` of the `runtime-cloudflare` Worker+DO to a `--temporary`/throwaway or test account, then hit `/api/health` + a committing mutation. Deploy-pending / manual-smoke where a real CF account is required in CI; mark honestly, never fake a pass (per the container-smoke lesson).

## Package layout

- **New:** `packages/deploy` (`@stackbase/deploy`) — the `DeployTarget`/`Spawner`/`DeployContext` seam, the real `Spawner` (over `node:child_process`), config resolution, and the `serve`/`cloudflare`/`docker` adapters. The cloudflare adapter's `runtime-cloudflare` dep is behind a dynamic import so it's only loaded for `--target cloudflare`.
- **Modified:** `packages/component/src/config.ts` (add `deploy` to `StackbaseConfig`, add `env()`); `packages/cli/src/deploy.ts` (extract `packageApp` for reuse; the `serve` target wraps the existing push); `packages/cli/src/cli.ts` (deploy case resolves target/env and dispatches through the seam).
- **Unchanged:** the engine, `RuntimeHost`, `runtime-cloudflare` internals.

## Scope order (for the plan)

1. Seam + `Spawner` + config extension (`deploy` block, `env()`) + resolution logic — with the `serve` target wrapping the existing push (prove back-compat first).
2. `docker` target (cheap; wraps the shipped `docker compose up` / container path).
3. `cloudflare` target — reconcile wrangler.jsonc + shell `wrangler deploy`; unit tests with a fake Spawner; the real-CF E2E gate.
4. Docs (`docs/enduser/deploy/*`): the target/env model, adding a provider, and a **copy-paste GitHub Actions workflow** (PR → `--check`/`--dry-run`; merge-to-main → `--env production`) showing the token-from-CI-secrets + branch→env pattern.

Follow-ons (documented, not built): railway/fly/aws adapters; Convex-style multi-phase incremental push for the `serve` target; the `@cloudflare/vite-plugin` single-origin dev integration; `--preview`/throwaway-account deploys; managed-cloud control plane (`ee/`).
