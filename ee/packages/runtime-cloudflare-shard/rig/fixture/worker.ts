/* Helipod Enterprise. Licensed under the Helipod Commercial License — see ee/LICENSE. */

/**
 * The multi-shard Worker/DO entry — a hand-written stand-in for what `generateShardWorkerEntrySource`
 * codegens. It statically imports the fixture app (a Worker bundle can't dir-scan `convex/`), exports:
 *   - `export class HelipodDO extends HelipodDurableObject` — the shard-DO class (the UNMODIFIED
 *     free host; the multi-shard front addresses N instances of it by name), and
 *   - `export default createShardWorkerHandler("HELIPOD_DO", { mode: "key", loaded })` — the
 *     stateless multi-shard router (this ee package).
 *
 * The single-shard rig (`packages/runtime-cloudflare/rig`) default-exports `createWorkerHandler`
 * instead — the ONLY difference. That is the licensing switch: a free single-shard deploy links the
 * free package; a paid multi-shard deploy links this ee package. Neither reaches into the other's role.
 */
import { HelipodDurableObject, createShardWorkerHandler, type DurableObjectAppConfig } from "@helipod/runtime-cloudflare-shard";
import type { LoadedProject } from "@helipod/cli/project";
import schema from "./convex/schema";
import * as messages from "./convex/messages";

const loaded: LoadedProject = { schema, modules: { messages } };

export class HelipodDO extends HelipodDurableObject {
  protected appConfig(env: Record<string, string>): DurableObjectAppConfig {
    return { loaded, adminKey: env.HELIPOD_ADMIN_KEY ?? "" };
  }
}

export default createShardWorkerHandler("HELIPOD_DO", { mode: "key", loaded });
