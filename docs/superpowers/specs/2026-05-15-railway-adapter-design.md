# Railway deploy adapter — design note

Small addition to `@stackbase/deploy`: a fourth `DeployTarget`, `railwayTarget`, alongside `serve`/`cloudflare`/`docker`. Mirrors `docker.ts` closely — Railway, like Docker, is a container/provision target driven entirely through an injectable `Spawner` shelling out to a CLI, not an API-token-and-fetch target like `cloudflare.ts`.

## CLI command: `railway up`, not `railway deploy`

Railway's CLI has both `railway up` and `railway deploy`, and they do different things:

- `railway up` uploads the current directory (respecting `.railwayignore`) to the linked service and triggers a build + deploy from that upload — the direct analog of `docker compose up --build`: take what's on disk right now and ship it.
- `railway deploy` provisions a **new service from a template** (`railway deploy -t <template>`) — a provisioning operation, not a "push my current code" operation.

We want the former. `railwayTarget.push` shells `railway up` in `ctx.cwd`, with `--service`/`--environment` appended when `ctx.target.settings.service`/`settings.environment` are configured (coerced to `String(...)` the same way `cloudflare.ts` coerces `wranglerEnv` — settings values arrive as `unknown` from parsed config/CLI flags).

## Auth: `RAILWAY_TOKEN` for non-interactive/CI

Railway's CLI recognizes `RAILWAY_TOKEN` as a project-scoped token that authenticates non-interactive invocations (CI runners, scripts) without `railway login`'s browser-based OAuth flow. Mirroring `cloudflareTarget`'s `CLOUDFLARE_API_TOKEN` check: `preflight` requires `RAILWAY_TOKEN` to be set whenever `!ctx.interactive`, and fails fast with a `DeployError` rather than letting `railway up` hang on a login prompt or (worse) block reading stdin. In interactive mode we don't require it — a developer with `railway login` state is authenticated some other way and Railway's own CLI will prompt/log in if it isn't.

Preflight also verifies the CLI itself is installed via `railway --version` (`stdio: "capture"`), throwing on `ENOENT` or non-zero exit — same shape as `dockerTarget.preflight`'s `docker version` check and `cloudflareTarget.preflight`'s `wrangler --version` check.

## Package: minimal, Railway builds the image

Railway builds the deployed image itself when `railway up` uploads the project: it detects and uses the repo's `Dockerfile` if one is present, and falls back to Nixpacks auto-detection (buildpack-style) otherwise. Because of this, `railwayTarget.package` does almost nothing — just `await ctx.codegen()` so the baked `convex/_generated/` matches the functions about to be deployed, same reasoning as `dockerTarget.package`'s comment. There is no wrangler.jsonc-style manifest to reconcile; a project deploying to Railway is expected to already have a working `Dockerfile` (the same one used for `docker compose up`, see `docs/enduser/self-hosting.md`) or to rely on Nixpacks. We don't generate one — an app without a `Dockerfile` and without Nixpacks-detectable structure will simply get whatever error `railway up` itself produces at build time; that's Railway's failure surface to own, not ours to preempt.

## Registration

Added `case "railway"` to `registry.ts`'s `loadTarget` switch (lazy dynamic import, consistent with the other three) and to the default-case error's provider list. Exported `railwayTarget` from `src/index.ts`. Widened the `provider` doc-comment in `@stackbase/component`'s `TargetConfig` and the CLI's `deploy` help text to include `railway`.
