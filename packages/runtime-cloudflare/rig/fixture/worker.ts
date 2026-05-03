// Hand-written stand-in for what `generateWorkerEntrySource` emits (Task 7) — the static-import
// Worker/DO entry. A real `stackbase build --target worker` would codegen exactly this shape from the
// app's `convex/` dir. Kept hand-written here so the deploy rig is self-contained and reviewable.
import * as messages from "./convex/messages";
import schema from "./convex/schema";
import { StackbaseDurableObject, createWorkerHandler, type DurableObjectAppConfig } from "@stackbase/runtime-cloudflare";
import type { LoadedProject } from "@stackbase/cli/project";

const loaded: LoadedProject = { schema, modules: { messages } };

export class StackbaseDO extends StackbaseDurableObject {
  protected appConfig(env: unknown): DurableObjectAppConfig {
    const adminKey = (env as { STACKBASE_ADMIN_KEY?: string }).STACKBASE_ADMIN_KEY ?? "";
    // On Cloudflare, stretch the driver backstop so an idle DO isn't cold-woken every 30s.
    return { loaded, adminKey, backstopMs: (d) => Math.max(d, 15 * 60_000) };
  }
}

export default createWorkerHandler("STACKBASE_DO");
