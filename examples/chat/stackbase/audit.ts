import { mutation } from "./_generated/server";
import type { LogChange } from "@stackbase/component";

// `@stackbase/triggers` reference pattern (see `../stackbase.config.ts`): a durable audit log of
// every `messages` insert/update/delete, driven entirely by the `defineTriggers({ messages: {...} })`
// composition below — nothing in `messages.ts`'s own mutations knows this handler exists. `_onChange`
// is INTERNAL by Stackbase's `_`-prefix convention (see `docs/enduser/triggers.md`'s "Handlers"
// section) — an ordinary `mutation`, not a separate factory; the trigger's boot step validates the
// path resolves to exactly this and rejects anything else at boot.
export const _onChange = mutation<{ changes: LogChange[] }, null>({
  handler: async (ctx, { changes }) => {
    for (const change of changes) {
      // Idempotency: dedup on the log's own stable `changeId` (the delivery contract — see
      // `docs/enduser/triggers.md`) rather than assuming this handler only ever sees a change once.
      const dup = await ctx.db.query("auditLog", "by_changeId").eq("changeId", change.changeId).take(1).collect();
      if (dup.length > 0) continue;
      await ctx.db.insert("auditLog", {
        changeId: change.changeId,
        table: change.table,
        docId: change.id,
        op: change.op,
      });
    }
    return null;
  },
});
