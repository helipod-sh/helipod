/**
 * `@stackbase/cli` — the `stackbase` dev tooling: project loading, the push pipeline (load →
 * codegen → register), the HTTP dev server, hot-reload watch loop, and the command dispatch.
 */
export type { LoadedProject, ProjectArtifacts } from "./project";
export { loadProject, DEFAULT_INDEX } from "./project";

export type { PushResult } from "./push-pipeline";
export { push } from "./push-pipeline";

export type { DevOptions, ResolvedDevOptions, RuntimeKind } from "./dev-options";
export { resolveDevOptions, detectRuntime } from "./dev-options";

export type { HttpRequest, HttpResponse, ServerInfo } from "./http-handler";
export { handleHttpRequest } from "./http-handler";

export type { DevServer, DevServerOptions } from "./server";
export { startDevServer, ProcessRuntimeHost } from "./server";

export type { WatchLoop, WatchLoopOptions, WatchTriggerReason } from "./watch";
export { createWatchLoop } from "./watch";

export { loadFunctionsDir, loadConvexDir } from "./load-modules";
export type { StackbaseConfig } from "@stackbase/component";
export { loadConfig } from "./load-config";
export type { ResolvedFunctionsDir } from "./functions-dir";
export { resolveFunctionsDir, functionsDirNotFoundMessage, DEFAULT_FUNCTIONS_DIR } from "./functions-dir";
export { runCli, devCommand, codegenCommand } from "./cli";

// The shared boot core + codegen writer, re-exported so an out-of-CLI host (e.g. `@stackbase/vite`'s
// in-process embed mode) can boot the engine and write `_generated` through the package boundary
// rather than reaching into deep source paths. All already-existing internals — purely additive.
export { bootProject, withStorageModules } from "./boot";
export type { BootResult, BootProjectOptions, BootLoadedOptions } from "./boot";
export { writeGenerated } from "@stackbase/codegen";

export { runBinaryServer, startBinaryServer, resolveBinaryOptions } from "./binary-main";
