import { defineConfig } from "@stackbase/component";
import { auth } from "@stackbase/auth";
import { defineScheduler } from "@stackbase/scheduler";

// `@stackbase/scheduler` is opt-in like every other component (see `packages/cli/src/
// load-config.ts` — there is no CLI-level auto-install list). It's listed here, alongside `auth`,
// as the reference pattern real projects copy from: this is what "default-installed" means in
// this config-driven architecture — every new project that starts from this template gets
// `ctx.scheduler`/`cronJobs()` for free, Convex-parity, out of the box.
export default defineConfig({ components: [auth, defineScheduler()] });
