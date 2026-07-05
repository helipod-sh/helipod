import { defineConfig } from "@helipod/component";
import { defineTriggers } from "@helipod/triggers";

// `@helipod/triggers` is opt-in like every other component (see `packages/cli/src/load-config.ts`
// — there is no CLI-level auto-install list). This is the reference pattern real projects copy from
// (mirrors `examples/auth-demo/helipod.config.ts` for `@helipod/scheduler`/`@helipod/workflow`):
// a durable audit log on `messages`, driven by `defineTriggers` reading the MVCC log rather than any
// code inline in `helipod/messages.ts`'s own mutations. See `docs/enduser/triggers.md` and
// `helipod/audit.ts`'s `_onChange` handler.
export default defineConfig({
  components: [defineTriggers({ messages: { handler: "audit:_onChange" } })],
});
