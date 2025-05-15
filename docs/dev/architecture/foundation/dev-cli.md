---
title: Foundation — `stackbase dev` CLI
status: design (implementation-ready)
slice: Foundation
component: dev-cli
depends_on: [embedded-runtime, schema-codegen]
audience: engineering (internal)
---

# Foundation — `stackbase dev` CLI

> The DX front door. `stackbase dev` watches `convex/`, bundles + analyzes the app,
> runs codegen, pushes functions/schema into the embedded Tier 0 runtime, and serves sync
> — a tight hot-reload loop with **Convex-grade error messages** and **fast startup**. It
> also wires the top-level command surface (`stackbase dev` now; `stackbase deploy`,
> `run`, `codegen`, `data`, `init`, `build` around it) so the command tree is *real, not
> aspirational*.
>
> Clean-room: we studied the concave CLI/`runtime-embedded` contracts for *shape only*
> (see [internals/06](../internals/06-runtimes-topology.md), [internals/05](../internals/05-udf-execution.md)).
> This is our own design. Grounding: [system-design §6](../system-design.md#6-the-tiered-architecture-how-light-and-scalable-coexist),
> [strategy (DX bar + locked divergences)](../strategy.md), [scalability-spectrum §3/§5](../scalability-spectrum.md).

---

## 1. Purpose & boundaries

### 1.1 What it owns

The dev-cli is an **orchestrator and a presentation layer**. It owns:

1. **The command surface.** A small dispatcher (`stackbase <command>`) that parses argv,
   resolves options (flags > env > config file > defaults), and routes to a `CommandHandler`.
   Foundation ships `dev`, `codegen`, `run`, `init`, `data` as real commands and reserves
   `deploy`/`build` as seams (`deploy` is the Tier-2 twin of `dev` — §6).
2. **The hot-reload loop** — `WatchLoop` (filesystem watch + debounce/coalesce of `convex/`),
   `PushPipeline` (bundle → analyze → codegen ∥ push), and `DevServer` (lifecycle, fast
   startup, event surface, signal handling).
3. **The deploy-target seam** — the `DeployTarget` interface and its Tier 0 implementation
   `EmbeddedDeployTarget`. This is the one piece of indirection that makes `dev` and (later)
   `deploy` the *same loop pointed at a different endpoint* (§6). The dev-cli **declares**
   `RemoteDeployTarget` but does not build it (Foundation obligation, scalability-spectrum §5.9).
4. **The bundler wrapper** (`Bundler`) — turning `convex/*.ts` into a serializable
   `CompiledBundle`. It wraps a build tool (esbuild / `Bun.build`) behind an adapter so the
   CLI does not hard-depend on one bundler or one host.
5. **The DX bar: diagnostics.** The `DevDiagnostic` model and `DiagnosticReporter` renderers
   (TTY code-frames + remediation hints; NDJSON for tools/CI). This is where "Convex-grade
   error messages" lives — mapping bundle/type/analyze/schema/runtime failures back to the
   user's source line with a fix hint.

### 1.2 What it does NOT own

| Concern | Owner | dev-cli relationship |
|---|---|---|
| The engine (transactor, executor, query engine, sync protocol, HTTP/WS server, loopback) | **embedded-runtime** | Consumes `RuntimeHost` / `createStackbase`. Never re-implements engine logic. |
| Codegen + static/runtime analysis (`_generated/api.d.ts`, `dataModel.d.ts`, `server.d.ts`, validator → TS) | **schema-codegen** | Consumes `Analyzer` + `Codegen`. The CLI never parses validators or emits TS itself. |
| `DocStore` / SQLite, OCC, the order-preserving index-key codec, the sync tier | core / lower foundation components | Reached *only* through the runtime behind the `DeployTarget`. |
| The actual remote deploy protocol + Cloudflare assembly | **deploy slice (#6)** | Only the `DeployTarget`/`PushRequest` *shape* is reserved here. |
| The dashboard UI | **Dashboard slice (#2)** | The CLI mounts it via the runtime's HTTP handler and prints its URL; it ships no UI. |

The boundary rule: **the dev-cli moves bytes and renders status; it does not implement
storage, execution, reactivity, analysis, or codegen.** If a change requires understanding
document semantics or the wire protocol, it belongs below the `DeployTarget` seam, not here.

---

## 2. Concrete TypeScript interfaces & types

> These are the contracts other code (the command dispatcher, tests, the future `deploy`
> command, and the dependency components) bind to. Types imported from dependencies are
> marked `// from schema-codegen` / `// from embedded-runtime` and shown structurally so the
> doc is self-contained; their authoritative definition lives in that component.

### 2.1 Command surface

```ts
// commands/types.ts
export interface CommandContext {
  readonly cwd: string;
  readonly argv: readonly string[];                       // args AFTER the command word
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly stdout: NodeJS.WritableStream;
  readonly stderr: NodeJS.WritableStream;
  readonly isTTY: boolean;
}

/** Every command returns a process exit code. */
export type CommandHandler = (ctx: CommandContext) => Promise<number>;

export interface Cli {
  register(name: string, handler: CommandHandler, aliases?: readonly string[]): void;
  /** Parse argv[0] as the command word, dispatch the rest. Unknown → help, code 1. */
  run(ctx: CommandContext): Promise<number>;
}
```

### 2.2 `DevCommandOptions` (raw, user-facing) and `ResolvedDevOptions` (normalized)

```ts
// dev/options.ts
export type RuntimeKind = "bun" | "node" | "cf" | "auto";
export type AnalysisStrategy = "runtime" | "static";
export type ReporterKind = "tty" | "json";

/** Exactly the surface a user controls via flags / config / env. All optional. */
export interface DevCommandOptions {
  convexDir?: string;          // default "./convex"
  configPath?: string;         // default "./stackbase.config.ts" (if present)
  runtime?: RuntimeKind;       // default "auto"  (--bun | --node | --cf)
  port?: number;               // default 3000     (--port)
  hostname?: string;           // default per-runtime (--ip | --hostname)
  dataDir?: string;            // default "./.stackbase/local" (--data-dir)
  dashboard?: boolean;         // default true     (--no-dashboard)
  typecheck?: boolean;         // default true; off the hot path, never blocks a push
  codegen?: boolean;           // default true     (--no-codegen)
  analysis?: AnalysisStrategy; // default "runtime" (--static → "static")
  reporter?: ReporterKind;     // default tty if isTTY else json (--reporter)
  verbose?: boolean;           // default false    (--verbose)
  once?: boolean;              // default false; do ONE push then exit (CI / pre-build)
  clear?: boolean;             // default false; wipe dataDir before start
}

/** Fully resolved, absolute, defaulted. Frozen. Produced by resolveDevOptions(). */
export interface ResolvedDevOptions {
  readonly convexDir: string;            // absolute
  readonly configPath: string | null;    // absolute or null
  readonly runtime: Exclude<RuntimeKind, "auto">;
  readonly port: number;
  readonly hostname: string;
  readonly dataDir: string;              // absolute
  readonly dashboard: boolean;
  readonly typecheck: boolean;
  readonly codegen: boolean;
  readonly analysis: AnalysisStrategy;
  readonly reporter: ReporterKind;
  readonly verbose: boolean;
  readonly once: boolean;
  readonly clear: boolean;
}

/**
 * Precedence: explicit flag > STACKBASE_* env > stackbase.config.ts > per-runtime default.
 * Per-runtime hostname default: bun → "0.0.0.0", node → "127.0.0.1", cf → n/a.
 * runtime:"auto" resolves by probing: Bun global present → "bun"; else node>=22.5 → "node".
 */
export function resolveDevOptions(
  raw: DevCommandOptions,
  ctx: Pick<CommandContext, "cwd" | "env" | "isTTY">,
): Promise<ResolvedDevOptions>;
```

### 2.3 `DeployTarget` — THE scale seam

```ts
// targets/deploy-target.ts
import type { AnalyzedApp, SerializedSchema } from "@stackbase/schema-codegen";

/** A compiled, serializable module artifact: module path -> emitted JS (+ optional map). */
export type CompiledBundle = Readonly<
  Record<string, { readonly code: string; readonly map?: string }>
>;

export interface PushRequest {
  /** Content hash of `bundle` (+ schema). Lets a target skip a no-op apply. */
  readonly revision: string;
  /** The functions/schema to install. Serializable on purpose (must cross to a fleet). */
  readonly bundle: CompiledBundle;
  /** Static/runtime analysis: functions, http routes, crons, schema. From schema-codegen. */
  readonly app: AnalyzedApp;
  /** Tables + indexes + shard-key hints (rows 1/2). Null when the app has no schema.ts. */
  readonly schema: SerializedSchema | null;
  /** Opaque engine config fingerprint (durability, exec mode, etc.). */
  readonly configVersion: string;
  /** Aborts an in-flight apply when a newer edit supersedes this push. */
  readonly signal?: AbortSignal;
}

export interface PushTargetResult {
  readonly revision: string;
  readonly accepted: boolean;
  readonly functionsChanged: number;
  readonly schemaApplied: boolean;
  /** Schema-validation progress + warnings, Convex-grade (phase: "schema" | "push"). */
  readonly diagnostics: readonly DevDiagnostic[];
  readonly applyMs: number;
}

export interface DeployTargetStatus {
  readonly ready: boolean;
  readonly clientUrl: string | null;
  readonly revision: string | null;   // last accepted push, or null pre-first-push
  readonly detail?: string;
}

export type DeployTargetKind = "embedded" | "remote";

/**
 * The endpoint the PushPipeline pushes to and the client connects to. Tier 0 ==
 * EmbeddedDeployTarget (in-process single binary). Tier 2 == RemoteDeployTarget
 * (distributed sharded fleet). The pipeline NEVER knows which it is talking to.
 */
export interface DeployTarget {
  readonly kind: DeployTargetKind;
  /** For logs: "embedded (Tier 0)" | "https://fleet.example.com". */
  readonly description: string;

  /** Install a revision. Idempotent: same revision ⇒ accepted no-op. Serialized internally. */
  push(request: PushRequest): Promise<PushTargetResult>;

  /** URL the CLIENT (useQuery) connects to for sync+http. Loopback-backed localhost vs fleet. */
  clientUrl(): Promise<string>;

  /** Health/ready probe — gates fast-startup "ready" and reconnect. */
  ready(timeoutMs?: number): Promise<DeployTargetStatus>;

  close(): Promise<void>;
}
```

```ts
// targets/embedded-target.ts  (Tier 0 — built now)
import type { RuntimeHost, StackbaseOptions } from "@stackbase/runtime-node"; // or -bun

/**
 * Wraps an embedded RuntimeHost. push() hot-swaps the runtime's module registry to the new
 * bundle and calls refreshSchema() to reapply index metadata + run schema validation WITHOUT
 * tearing down live sync sessions (internals/06: refreshSchema is exactly the dev-loop hook).
 * Binds a REAL localhost socket so browsers connect over WS (the pure loopback transport is
 * reserved for `stackbase run` / tests in the same process).
 */
export class EmbeddedDeployTarget implements DeployTarget {
  readonly kind = "embedded" as const;
  readonly description: string;
  constructor(deps: {
    createRuntime: (opts: StackbaseOptions) => Promise<RuntimeHost>;
    runtimeOptions: StackbaseOptions;           // convexDir, docstore(dataDir), schema:"auto"
    listen: { port: number; hostname: string };
  });
  push(request: PushRequest): Promise<PushTargetResult>;
  clientUrl(): Promise<string>;                 // e.g. http://127.0.0.1:3000
  ready(timeoutMs?: number): Promise<DeployTargetStatus>;
  close(): Promise<void>;
}
```

```ts
// targets/remote-target.ts  (Tier 2 — DECLARED, not implemented in Foundation)
/**
 * RESERVED. The Tier-2 twin used by `stackbase deploy`. Same DeployTarget interface; push()
 * POSTs the (already-serializable) PushRequest to a deployment endpoint that distributes the
 * bundle to a sharded committer fleet; clientUrl() returns the sync-fleet address (behind the
 * rendezvous-hash router). Building it is the deploy slice's job — its existence here proves
 * EmbeddedDeployTarget is "one implementation of a known interface" (scalability-spectrum §5.9).
 */
export declare class RemoteDeployTarget implements DeployTarget {
  readonly kind: "remote";
  readonly description: string;
  constructor(config: { deploymentUrl: string; adminKey: string });
  push(request: PushRequest): Promise<PushTargetResult>;
  clientUrl(): Promise<string>;
  ready(timeoutMs?: number): Promise<DeployTargetStatus>;
  close(): Promise<void>;
}
```

### 2.4 `Bundler`

```ts
// dev/bundler.ts
export interface BundleInput {
  readonly convexDir: string;
  /** default: every *.ts/*.js under convexDir EXCEPT _generated/** and *.d.ts. */
  readonly entryPoints?: readonly string[];
  readonly external?: readonly string[];        // bundleExternals globs (e.g. "convex/*")
  readonly sourcemap: boolean;                   // true in dev (for runtime-error mapping)
  readonly signal?: AbortSignal;
}
export interface BundleOutput {
  readonly ok: boolean;
  readonly revision: string;                     // sha256 over sorted output `code`
  readonly bundle: CompiledBundle;
  readonly modulePaths: readonly string[];       // normalized specifiers ("messages", "auth/util")
  readonly diagnostics: readonly DevDiagnostic[]; // esbuild/Bun errors mapped to DevDiagnostic
}
export interface Bundler {
  bundle(input: BundleInput): Promise<BundleOutput>;
}
```

### 2.5 Consumed from `schema-codegen` (dependency contracts)

```ts
// from @stackbase/schema-codegen — shown for reference; owned there.
export interface Analyzer {
  /** "runtime": load modules in a sandbox + introspect (accurate validators).
   *  "static": parse TS AST without executing (fallback when modules can't load). */
  analyze(input: {
    bundle: CompiledBundle;
    convexDir: string;
    strategy: AnalysisStrategy;
    signal?: AbortSignal;
  }): Promise<{ app: AnalyzedApp; schema: SerializedSchema | null; diagnostics: DevDiagnostic[] }>;
}
export interface Codegen {
  /** Emit _generated/* from analysis. Atomic writes; skip-if-content-unchanged. */
  generate(input: {
    app: AnalyzedApp;
    schema: SerializedSchema | null;
    outDir: string;                              // <convexDir>/_generated
    signal?: AbortSignal;
  }): Promise<CodegenResult>;
}
export interface CodegenResult {
  readonly filesWritten: readonly string[];      // [] when nothing changed on disk
  readonly diagnostics: readonly DevDiagnostic[];
  readonly contentHash: string;
}
// AnalyzedApp ≈ { functions: AnalyzedFunction[]; httpRoutes; cronSpecs; schemaTables }
// SerializedSchema ≈ { tables: { name, fields, indexes, shardKeyField? }[] }
```

### 2.6 `PushPipeline`

```ts
// dev/push-pipeline.ts
export type WatchTriggerReason = "initial" | "change" | "manual";

export interface PushInput {
  readonly reason: WatchTriggerReason;
  readonly changedPaths?: readonly string[];
  readonly signal?: AbortSignal;                 // newer settle aborts an in-flight push
}

export interface PhaseTimings {
  readonly bundleMs: number;
  readonly analyzeMs: number;
  readonly codegenMs: number;                    // overlaps pushMs (run concurrently)
  readonly pushMs: number;
  readonly totalMs: number;
}

export interface PushResult {
  readonly revision: string;
  readonly ok: boolean;                          // false if any phase produced an error diag
  readonly skipped: boolean;                     // revision unchanged ⇒ no-op
  readonly phaseTimings: PhaseTimings;
  readonly codegen: CodegenResult | null;
  readonly target: PushTargetResult | null;
  readonly diagnostics: readonly DevDiagnostic[]; // merged, sorted error→warning→info
}

/**
 * Tier-AGNOSTIC. Constructed with a Bundler, an Analyzer + Codegen (schema-codegen), and a
 * DeployTarget. push() is the same code for `dev` (EmbeddedDeployTarget) and `deploy`
 * (RemoteDeployTarget). codegen ∥ push fan out from one analysis (§3.2).
 */
export interface PushPipeline {
  push(input: PushInput): Promise<PushResult>;
  /** last accepted revision, for idempotency short-circuit. */
  readonly lastRevision: string | null;
}

export interface PushPipelineDeps {
  readonly options: ResolvedDevOptions;
  readonly bundler: Bundler;
  readonly analyzer: Analyzer;                    // schema-codegen
  readonly codegen: Codegen;                      // schema-codegen
  readonly target: DeployTarget;                  // the seam
}
export function createPushPipeline(deps: PushPipelineDeps): PushPipeline;
```

### 2.7 `WatchLoop`

```ts
// dev/watch-loop.ts
export type Unsubscribe = () => void;

export type WatchEvent =
  | { kind: "settled"; reason: WatchTriggerReason; changedPaths: readonly string[]; at: number }
  | { kind: "error"; error: Error };

export interface WatchLoopOptions {
  readonly convexDir: string;
  /** ALWAYS includes _generated/**, *.d.ts, *.tmp, dotfiles. Codegen output is never watched. */
  readonly ignore: readonly (string | RegExp)[];
  readonly debounceMs: number;                   // default 60
  readonly stabilityThresholdMs?: number;        // wait for size to settle (atomic-save editors)
}

export interface WatchLoop {
  start(): Promise<void>;                         // emits one {reason:"initial"} settle on start
  stop(): Promise<void>;
  trigger(reason?: WatchTriggerReason): void;     // force a settle now (default "manual")
  on(listener: (event: WatchEvent) => void): Unsubscribe;
}
export function createWatchLoop(options: WatchLoopOptions): WatchLoop;
```

### 2.8 Diagnostics — the Convex-grade DX bar

```ts
// dev/diagnostics.ts
export type DevPhase =
  | "config" | "bundle" | "typecheck" | "analyze" | "codegen" | "schema" | "push" | "runtime";
export type Severity = "error" | "warning" | "info";

export interface SourceLocation {
  readonly file: string;        // absolute, original .ts (sourcemap-resolved)
  readonly line: number;        // 1-based
  readonly column: number;      // 1-based
  readonly endLine?: number;
  readonly endColumn?: number;
}

export interface DevDiagnostic {
  readonly phase: DevPhase;
  readonly severity: Severity;
  readonly code: string;        // stable + greppable, e.g. "SB1003" (table in §7)
  readonly message: string;     // one line
  readonly location?: SourceLocation;
  readonly codeFrame?: string;  // ±2 lines with a caret under the span
  readonly hint?: string;       // remediation, e.g. "Move fetch() into an action."
  readonly cause?: unknown;     // original error, dev/--verbose only
}

export interface DiagnosticReporter {
  report(diagnostics: readonly DevDiagnostic[]): void;
  pushStarted(reason: WatchTriggerReason): void;
  pushFinished(result: PushResult): void;
  ready(handle: DevServerHandle): void;           // prints banner (tty) OR ready JSON line
  fatal(error: Error): void;                       // prints + flags non-zero exit
}
export function createReporter(kind: ReporterKind, ctx: Pick<CommandContext,"stdout"|"stderr"|"isTTY">): DiagnosticReporter;
```

### 2.9 `DevServer`

```ts
// dev/dev-server.ts
export interface DevServerHandle {
  readonly url: string;                  // == target.clientUrl()
  readonly port: number;
  readonly hostname: string;
  readonly dashboardUrl: string | null;  // `${url}/_dashboard` when dashboard enabled
  readonly target: DeployTarget;
  readonly revision: string | null;
  [Symbol.asyncDispose](): Promise<void>;
}

export interface DevServerEvents {
  ready: DevServerHandle;
  "push:start": { reason: WatchTriggerReason };
  "push:done": PushResult;
  diagnostic: DevDiagnostic;
  stopped: void;
}

export interface DevServer {
  start(): Promise<DevServerHandle>;
  stop(): Promise<void>;
  on<E extends keyof DevServerEvents>(event: E, fn: (p: DevServerEvents[E]) => void): Unsubscribe;
}

export interface DevServerDeps {
  readonly target: DeployTarget;          // inject to override Tier 0 default (tests / deploy)
  readonly pipeline: PushPipeline;
  readonly watch: WatchLoop;
  readonly reporter: DiagnosticReporter;
}

/** Wires Tier 0 defaults (EmbeddedDeployTarget + esbuild Bundler + schema-codegen) when deps omitted. */
export function createDevServer(
  options: ResolvedDevOptions,
  deps?: Partial<DevServerDeps>,
): DevServer;

/** The `stackbase dev` command body: resolve → create → start → wait on signals → exit code. */
export const devCommand: CommandHandler;
```

---

## 3. Key data structures & algorithms

### 3.1 Fast startup — boot the server and the first bundle concurrently

`ready` is gated on the **server listening**, not on the first push completing. The browser
sees a URL and a dashboard in a few hundred ms; query results arrive once the first push lands
(the client reconnect/resync path already handles the gap — scalability-spectrum row 6).

```
t0  resolveDevOptions(); loadConfig(); (optionally clear dataDir)
t0  ┌ target = EmbeddedDeployTarget(...)                       ┐
    │   → createRuntime(): open DocStore@dataDir,              │  run CONCURRENTLY
    │     primeBootstrap()/primeTableRegistry() (internals/05),│  (Promise.all)
    │     listen(port, hostname)                               │
    └ bundle #0  (warm esbuild, compile convex/)               ┘
t1  runtime listening  →  reporter.ready(handle)  →  emit "ready"     // SERVE NOW
t2  pipeline.push({reason:"initial"})  →  codegen + schema apply  →  "push:done"
t3  watch.start()      // begins emitting settles on subsequent edits
```

Budget targets (Tier 0, warm): listening < 150 ms, first push < 400 ms on a small app.
Type-check is **never** on this path (§3.5).

### 3.2 The push pipeline DAG (one analysis fans out to codegen ∥ push)

```
            bundle(convexDir, signal)
                   │  BundleOutput{revision, bundle, diagnostics}
   ok? ───no──►  report(bundle diagnostics); keep last-good serving; RETURN {ok:false}
                   │ yes
            analyze(bundle, strategy)         // schema-codegen; "runtime" w/ "static" fallback
                   │  { app, schema, diagnostics }
        ┌──────────┴───────────────────────────────┐
   codegen.generate(app, schema)            target.push({revision, bundle, app, schema, signal})
   → write _generated/* (atomic,            → hot-swap modules + refreshSchema()  (Tier 0)
     skip-if-unchanged)                        → PushTargetResult{schemaApplied, diagnostics}
        └──────────┬───────────────────────────────┘
            await Promise.all([...])
            merge+sort diagnostics; PhaseTimings; emit PushResult
```

Rationale: codegen and push are **independent given the analysis** (both only read it), so they
run concurrently. They both await before "done" so types and live data move together. If
`push` fails (e.g. schema-incompatible) but codegen succeeded, that is *desirable*: the
generated types reflect the author's intent while the error explains why data did not update.

### 3.3 Revision hashing & idempotency (no-op short-circuit, no watch thrash)

- `revision = sha256(canonicalize(bundle.code) ++ canonicalize(schema))`. Maps/comments excluded.
- `PushPipeline` keeps `lastRevision`. On a `"change"` settle whose recomputed revision equals
  `lastRevision`, the push is `skipped` (no analyze, no codegen write, no target apply).
- `Codegen.generate` independently content-hashes its output and writes **only changed files**
  (`filesWritten: []` on a no-op). Combined with the watcher ignoring `_generated/**`, this
  gives belt-and-suspenders against the classic "codegen writes a file → watcher fires →
  codegen runs again" infinite loop, and avoids needless `tsserver` churn in the editor.

### 3.4 Watch debounce + coalesce (latest-wins, generated-output-blind)

`WatchLoop` maintains a pending set of changed paths and a debounce timer:

```
on fs event (add|change|unlink) for path p:
  if matchesIgnore(p): return                     // _generated/**, *.d.ts, dotfiles, tmp
  pending.add(p)
  resetTimer(debounceMs)                          // editors emit bursts; collapse them
on timer fire:
  batch = drain(pending)
  emit { kind:"settled", reason, changedPaths: batch }
```

`DevServer` serializes pushes with **latest-wins cancellation**: if a settle arrives while a
push is in flight, it `abort()`s the in-flight push (the `AbortSignal` threads into bundler,
analyzer, codegen, and `target.push`) and starts a fresh one for the newest state. The
`EmbeddedDeployTarget` additionally serializes `push()` through an internal queue (one
`refreshSchema` apply at a time) — mirroring the engine's single-writer discipline so a racing
apply can never interleave index metadata.

### 3.5 Type-check off the hot path

When `typecheck:true`, the CLI runs `tsc --noEmit` (TS compiler API) in a worker thread,
re-triggered on settle but **decoupled** from the push promise. Its results surface as
`phase:"typecheck"` diagnostics (warnings) that never block a push — Convex parity: a type
error must not stop you from iterating against live data.

### 3.6 Diagnostic construction (code-frame + sourcemap resolution)

Each upstream failure is normalized into a `DevDiagnostic`:
- **Bundle** (esbuild) errors carry file/line/col already → wrap, add a code-frame from the
  source, attach a hint when the message matches a known pattern.
- **Runtime determinism** violations (a query calling `fetch`/`Date.now`) throw inside the V8
  isolate; the dev-cli resolves the isolate stack frame back to the original `.ts` via the
  bundle sourcemap and emits `SB1003` with the "use an action" hint.
- **Schema** validation failures from the target carry table + dotted field path + an offending
  example document id (Convex-grade specificity), emitted as `SB2001`.

---

## 4. Package / module / file layout

```
packages/cli/                         # published as @stackbase/cli  (bin: stackbase)
  package.json                        # "bin": { "stackbase": "./dist/bin.js" }
  src/
    bin.ts                            # #!/usr/bin/env node|bun — build CommandContext → cli.run
    cli.ts                            # Cli dispatcher (register/run); --help, --version
    commands/
      types.ts                        # CommandContext, CommandHandler, Cli
      dev.ts                          # devCommand → resolveDevOptions → createDevServer
      codegen.ts                      # bundle → analyze → codegen (NO target; CI-safe)
      run.ts                          # one-shot fn call over target.clientUrl() loopback/http
      data.ts                         # table browse via system functions over the target
      init.ts                         # scaffold convex/ + sample fn + stackbase.config.ts
      deploy.ts                       # RESERVED: RemoteDeployTarget + pipeline.push (Tier 2)
      build.ts                        # RESERVED: standalone-binary compile (deploy slice)
    dev/
      dev-server.ts                   # DevServer lifecycle, fast-start, events, signals
      watch-loop.ts                   # WatchLoop (chokidar/native fs.watch adapter)
      push-pipeline.ts                # PushPipeline (DAG in §3.2)
      bundler.ts                      # Bundler interface + esbuild & Bun.build adapters
      diagnostics.ts                  # DevDiagnostic, DiagnosticReporter (tty + json)
      options.ts                      # DevCommandOptions, ResolvedDevOptions, resolveDevOptions
    targets/
      deploy-target.ts                # DeployTarget, PushRequest, PushTargetResult  (the seam)
      embedded-target.ts              # EmbeddedDeployTarget (Tier 0)
      remote-target.ts                # RemoteDeployTarget (declared, throws "not implemented")
    config/
      config.ts                       # load+validate stackbase.config.ts; env (STACKBASE_*)
    util/
      ports.ts                        # findPort / "port in use" detection
      paths.ts                        # convexDir resolution, _generated path, ignore globs
      json-line.ts                    # machine-readable {"ready":true,...} emitter
      runtime-detect.ts               # "auto" → bun|node probing (Bun global, node>=22.5)
  test/
    unit/   property/   e2e/          # see §8
```

**Runtime selection without a hard dep:** `commands/dev.ts` *dynamically imports* the host
package (`@stackbase/runtime-node` or `@stackbase/runtime-bun`) chosen by
`resolveDevOptions().runtime`, so installing the CLI does not force one host. `--cf` shells out
to `wrangler dev` (a different `DeployTarget` — out of Foundation scope, command stub present).

**Dependencies:** `@stackbase/schema-codegen` (Analyzer + Codegen), `@stackbase/runtime-node`
/ `-bun` (peer/optional, dynamic), a bundler (`esbuild` default; `Bun.build` adapter), a file
watcher (`chokidar` default; native `fs.watch` fallback), `convex` (peer, validator types).

---

## 5. Tier 0 now (single binary)

`stackbase dev` at Tier 0 is the whole product's hot path made real:

1. **One process, no sidecar.** `EmbeddedDeployTarget` boots a `RuntimeHost`
   (`createStackbase`) that co-locates transactor + executor + sync handler + HTTP/WS server +
   (optional) dashboard over **embedded SQLite (WAL)** at `./.stackbase/local`
   (internals/06 "embedded single-binary runtime"). `--clear` wipes that dir.
2. **The client connects over a real localhost socket.** Dev binds `port`/`hostname` so a
   browser app's `useQuery` connects via real WS. (The in-memory `LoopbackWebSocket` transport
   is used by `stackbase run`/tests in the same process — no port needed — but a browser needs a
   real socket, so dev listens.)
3. **Hot reload = re-register modules + `refreshSchema()`.** A push swaps the runtime's module
   registry to the new `CompiledBundle` and reapplies index/schema metadata **without dropping
   live sync sessions** (internals/06). Open subscriptions re-run against the new code; a schema
   metadata bump advances the protocol version so clients resync cleanly (row 6).
4. **Reactivity is in-process and synchronous.** A pushed mutation commits and `notifyWrites`
   fans out to local subscribers immediately — instant feedback, zero network.
5. **Codegen keeps `_generated/` fresh** on every settle, so editor types track the running
   backend within the same debounce tick.

`stackbase codegen` is the same bundle → analyze → codegen path **without a target** — so types
generate in CI with no server. `stackbase run` / `stackbase data` call functions through the
target's `clientUrl()` (loopback in-process, or `--url` to a running dev server).

---

## 6. The scale seam — reserved, attaches later with NO app/engine rewrite

> *"The push/codegen pipeline is tier-agnostic and the deploy target is an injected endpoint:
> `stackbase dev` runs the single-binary Tier 0 engine while the same watch→push→codegen loop
> (later `stackbase deploy`) targets a distributed, sharded fleet — pointing at a single binary
> vs a sync fleet is a config flag, not an app change (seam-table rows 1, 3, 9). Holds the DX
> bar constant across the spectrum."*

The entire seam is the **`DeployTarget` injection** plus the discipline that `PushRequest` is
serializable from day one. `PushPipeline`, `WatchLoop`, `Codegen`, the bundle, the schema, and
all app code are byte-identical across the spectrum; only which `DeployTarget` is constructed
changes.

```
                       ┌──────────────── identical ────────────────┐
  WatchLoop ─► PushPipeline.push() ─► [Bundler ─► Analyzer ─► Codegen]
                       │                                   └────────────► writes _generated/*
                       └──► DeployTarget.push(PushRequest) ─┐
                                                            ▼
            ┌───────────────────────────────┬──────────────────────────────────┐
   `stackbase dev`                    `stackbase deploy` (later)
   EmbeddedDeployTarget               RemoteDeployTarget
   • one in-process engine            • POSTs PushRequest to a deployment endpoint
   • one shard "default"              • fleet shards writes by conversationId (row 1)
   • clientUrl → http://127.0.0.1     • clientUrl → sync-fleet URL behind the
   • refreshSchema() hot-reload         rendezvous-hash router (row 3)
                                      • coordinator + autoscaled shard map (row 9)
```

How each mandated row is *carried, not built*, by this component:

- **Row 1 (unbounded write throughput / shard key → single-writer-per-shard).** `PushRequest`
  carries the **schema including the shard-key field hint** (`SerializedSchema.tables[].shardKeyField`).
  The pipeline pushes the *same* schema whether the target runs one shard (`"default"`, Tier 0)
  or N (Tier 2). Nothing in the pipeline encodes shard count. Promoting `conversationId` to the
  partition key is a target/config concern; the dev-cli's push is unchanged.
- **Row 3 (hundreds of millions of connections / connection-sharded sync fleet).**
  `DeployTarget.clientUrl()` is the single point that decides where the client connects. Tier 0
  returns the in-process localhost URL; Tier 2 returns the sync-fleet URL. The dev-cli hands
  that string to the client verbatim — **single binary vs sync fleet is `clientUrl()` returning
  a different string**, i.e. a config flag, not an app change.
- **Row 9 (multi-region + autoscaling / `ShardRouter`).** `RemoteDeployTarget` may front a
  coordinator + autoscaled `SyncShardMap`; the dev-cli's push and the client's connect are
  oblivious. By **declaring** `RemoteDeployTarget` now (without building it), Foundation makes
  the Tier 0 `EmbeddedDeployTarget` "one implementation of a known interface"
  (scalability-spectrum §5.9) — the obligation this component owes the mandate.

**Serializability discipline (the thing that must not be fudged):** `PushRequest` uses
`CompiledBundle` (strings), `AnalyzedApp`, and `SerializedSchema` — all JSON-serializable, no
in-memory engine handles, no `ArrayBuffer`s — *because* the same object must one day be POSTed
to a fleet. If Foundation let the embedded target receive live module objects or runtime
references, `deploy` would be a rewrite. It does not: even at Tier 0 the bundle crosses the
target boundary as data.

**DX bar held constant:** `deploy` reuses `PushPipeline` + `DiagnosticReporter`, so a schema
error or a bad bundle reads identically whether you are iterating locally or shipping to the
fleet. The error UX is a property of the pipeline, not of the tier.

---

## 7. Failure & edge handling

| # | Situation | Behavior |
|---|---|---|
| 1 | **Bundle/syntax error** (esbuild) | `SB1001`, code-frame at the offending span. **Keep serving last-good** code; the push returns `{ok:false}`. On *first* boot there is no last-good → serve empty, report prominently, keep watching. |
| 2 | **Forbidden capability in a query/mutation** (`fetch`, `Date.now`, `setTimeout`) | Static lint emits `SB1002` (warning) at push time; if it reaches runtime, the isolate throws and we map it back to source as `SB1003` (error) with hint "Move it into an `action`." |
| 3 | **Schema-incompatible push** (existing doc violates a new validator; index change needs backfill) | `SB2001`/`SB2002` from the target with table + dotted field path + example doc id. Codegen still emits the new types; data update is rejected; loop stays alive. |
| 4 | **`_generated/` write storms** | Watcher hard-ignores `_generated/**` + `*.d.ts`; codegen skips unchanged files. The infinite-rebuild loop is structurally impossible (§3.3). |
| 5 | **Rapid multi-file save** | Debounce + coalesce into one settle; in-flight push aborted, latest-wins (§3.4). |
| 6 | **Port in use** | `SB3001` with the bound pid (if discoverable) + hint `--port <n>`; non-zero exit (fatal, pre-listen). |
| 7 | **Node < 22.5 / missing `--experimental-sqlite`** | `SB3002` with exact remediation (the CLI re-execs node with the flag when it can; else instructs). |
| 8 | **`convexDir` missing** | `SB3004` "no `convex/` found — run `stackbase init`." |
| 9 | **Runtime analysis fails to load a module** (broken import / env side effect) | Auto-fallback `"runtime"→"static"`, emit a warning that validators may be coarser; never hard-fail codegen on a transient. |
| 10 | **UDF throws at runtime** (user bug) | Isolated to that invocation (V8 isolate); never crashes the dev server. Error surfaces in the reporter + dashboard logs ring buffer, mapped to source. |
| 11 | **DocStore open/corruption / disk full** | Fatal pre-ready → `SB3005`, non-zero exit. Suggest `--clear` for a corrupt *dev* db. |
| 12 | **SIGINT / SIGTERM** | Graceful: stop watch → stop accepting connections → drain in-flight push (abort if mid-bundle) → close runtime/DocStore → exit 0. `DevServerHandle` is `AsyncDisposable`. |
| 13 | **`--once` (CI)** | One push, print result, exit `0` on success / `1` if any `error` diagnostic. No watch, no listen-forever. |
| 14 | **Slow first bundle** | `ready` still fires on listen (§3.1); the client connects and resyncs when the first push lands. |

Severity → exit: in non-watch commands (`codegen`, `dev --once`, `run`) any `error` diagnostic
⇒ exit `1`. In the long-lived `dev` loop, errors are reported and the loop continues (exit code
is decided only at shutdown by signal).

---

## 8. Test strategy

### 8.1 Unit

- **Option resolution** (`resolveDevOptions`): precedence flag > env > config > default;
  per-runtime hostname defaults (bun `0.0.0.0`, node `127.0.0.1`); `runtime:"auto"` probing;
  path absolutization of `convexDir`/`dataDir`.
- **Dispatcher** (`Cli`): command/alias routing; unknown command → help + exit 1; `--help`/`--version`.
- **Diagnostics rendering**: snapshot tests of TTY code-frames (caret alignment, ±2 context,
  color off under non-TTY) and NDJSON shape; the `{"ready":true,port,url}` line for `--reporter json`.
- **Bundler adapter**: a 2-file `convex/` fixture → `BundleOutput` with stable `revision`,
  normalized `modulePaths`, esbuild errors mapped to `DevDiagnostic` with locations.
- **PushPipeline ordering**: with fakes, assert analyze runs once and **feeds both** codegen and
  `target.push` (codegen+push observe the *same* `AnalyzedApp`); a bundle error short-circuits
  before analyze; a push error still lets codegen write.

### 8.2 Property tests

1. **Watch coalescing invariant.** For any random sequence of N file events (mix add/change/
   unlink, arbitrary inter-arrival ≤ debounce) the loop emits **exactly one** settle whose
   `changedPaths` is the set-union of non-ignored paths, and **never** a settle containing a
   `_generated/**` or `*.d.ts` path. (Generators: random path sets including generated paths.)
2. **Push idempotency / no-op stability.** Pushing the same bundle twice ⇒ second result
   `skipped:true`, `codegen.filesWritten === []`, and the target records one accepted no-op.
   (Guards against rebuild thrash.)
3. **Codegen determinism.** Same `AnalyzedApp` ⇒ byte-identical `_generated` output across runs
   (so an unrelated edit never rewrites unchanged generated files). Owned by schema-codegen but
   asserted here as a pipeline-level contract because the watch loop depends on it.
4. **`DeployTarget` contract parity (proves the seam).** A shared contract suite runs against
   **both** `EmbeddedDeployTarget` (real Tier 0 runtime over `:memory:` SQLite) and a
   `FakeRemoteDeployTarget` (in-memory stand-in implementing the same interface). For an
   identical sequence of `PushRequest`s, both must agree on: `accepted`, idempotent no-op on
   repeated `revision`, `schemaApplied` transitions, and a monotonic `revision` history. This is
   the executable proof that `dev` and `deploy` ride the same pipeline.
5. **`PushRequest` serializability.** Property: `structuredClone`/`JSON.parse(JSON.stringify(req))`
   round-trips every `PushRequest` the pipeline emits (no `ArrayBuffer`/function/handle leaks) —
   the Tier-2 readiness gate from §6.

### 8.3 Integration / E2E (the loop, end-to-end)

- **Edit → push → live result.** Boot `DevServer` on `:memory:` + an ephemeral port; connect a
  real `ConvexHttpClient`/WS client; write a new `convex/messages.ts`; assert (a) `_generated/`
  updates, (b) `useQuery("messages:list")` returns the new result without a manual restart,
  (c) `push:done` timings are within the fast-start budget.
- **OCC-under-concurrent-edit smoke.** Drive two concurrent mutations through the live target so
  the engine's 3-phase OCC retry path executes end-to-end via the dev loop, asserting the final
  committed state is serializable (the deep OCC-conflict *property* tests are owned by the
  transactor component; here we assert the loop wires them correctly).
- **Hot-reload session survival.** With an open subscription, push a code change; assert the
  subscription re-runs against new code and the client receives a `Transition` (no socket drop);
  push a schema/index change and assert the client performs a clean version-gap resync.
- **Crash isolation.** A user UDF that throws does not kill the server; the next good push
  recovers. A bundle error keeps the last-good server serving.

> Note on the prompt's "order-preserving codec round-trip / OCC conflict" property tests: those
> load-bearing properties are **owned by schema-codegen (codec) and the transactor (OCC)**. The
> dev-cli's analogous property tests are watch-coalescing (#1), push/codegen idempotency
> (#2/#3), and `DeployTarget` contract parity (#4) — and its E2E asserts the codec/OCC machinery
> is correctly *driven* through the loop.

---

## 9. Cross-references

- [system-design §6 (tiers)](../system-design.md#6-the-tiered-architecture-how-light-and-scalable-coexist) ·
  [strategy (DX bar + locked divergences)](../strategy.md)
- [scalability-spectrum §3 (seam table rows 1/3/9) + §5 (Foundation obligations)](../scalability-spectrum.md)
- [internals/06 — embedded runtime, `refreshSchema`, loopback, write-fanout](../internals/06-runtimes-topology.md) ·
  [internals/05 — module loader, analysis, executor bootstrap](../internals/05-udf-execution.md)
- depends on: **embedded-runtime** (`RuntimeHost`/`createStackbase`), **schema-codegen**
  (`Analyzer`/`Codegen`, `AnalyzedApp`, `SerializedSchema`).
