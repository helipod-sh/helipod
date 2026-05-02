/* Stackbase Enterprise. Licensed under the Stackbase Commercial License — see ee/LICENSE. */

/**
 * The multi-shard Worker/DO entry — a hand-written stand-in for what `generateShardWorkerEntrySource`
 * codegens. It statically imports the fixture app (a Worker bundle can't dir-scan `convex/`), exports:
 *   - `export class StackbaseDO extends StackbaseDurableObject` — the shard-DO class (the UNMODIFIED
 *     free host; the multi-shard front addresses N instances of it by name), and
 *   - `export default createShardWorkerHandler("STACKBASE_DO", { mode: "key", loaded })` — the
 *     stateless multi-shard router (this ee package).
 *
 * The single-shard rig (`packages/runtime-cloudflare/rig`) default-exports `createWorkerHandler`
 * instead — the ONLY difference. That is the licensing switch: a free single-shard deploy links the
 * free package; a paid multi-shard deploy links this ee package. Neither reaches into the other's role.
 */
import { StackbaseDurableObject, createShardWorkerHandler, type DurableObjectAppConfig } from "@stackbase/runtime-cloudflare-shard";
import type { LoadedProject } from "@stackbase/cli/project";
import schema from "./convex/schema";
import * as messages from "./convex/messages";

const loaded: LoadedProject = { schema, modules: { messages } };

export class StackbaseDO extends StackbaseDurableObject {
  protected appConfig(env: Record<string, string>): DurableObjectAppConfig {
    return { loaded, adminKey: env.STACKBASE_ADMIN_KEY ?? "" };
  }
}

export default createShardWorkerHandler("STACKBASE_DO", { mode: "key", loaded });
