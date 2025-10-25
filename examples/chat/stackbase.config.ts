import { defineConfig } from "@stackbase/component";
import { defineTriggers } from "@stackbase/triggers";

// `@stackbase/triggers` is opt-in like every other component (see `packages/cli/src/load-config.ts`
// — there is no CLI-level auto-install list). This is the reference pattern real projects copy from
// (mirrors `examples/auth-demo/stackbase.config.ts` for `@stackbase/scheduler`/`@stackbase/workflow`):
// a durable audit log on `messages`, driven by `defineTriggers` reading the MVCC log rather than any
// code inline in `convex/messages.ts`'s own mutations. See `docs/enduser/triggers.md` and
// `convex/audit.ts`'s `_onChange` handler.
export default defineConfig({
  components: [defineTriggers({ messages: { handler: "audit:_onChange" } })],
});
