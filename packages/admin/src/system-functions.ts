import { mutation, type RegisteredFunction } from "@helipod/executor";
import { DocumentNotFoundError } from "@helipod/errors";

/** Built-in privileged mutations the admin API invokes by id. Registered under `_system:*`. */
export function systemModules(): Record<string, RegisteredFunction> {
  return {
    "_system:patchDocument": mutation(async (ctx, args: { id: string; fields: Record<string, unknown> }) => {
      const existing = await ctx.db.get(args.id);
      if (!existing) throw new DocumentNotFoundError(`cannot edit missing document ${args.id}`);
      // Whole-document replace: the dashboard editor submits the full (user-field) document, so a
      // field removed in the editor is actually removed. _id/_creationTime are preserved by the kernel.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await ctx.db.replace(args.id, args.fields as any);
      return await ctx.db.get(args.id);
    }),
    "_system:deleteDocument": mutation(async (ctx, args: { id: string }) => {
      await ctx.db.delete(args.id);
      return null;
    }),
    "_system:insertDocument": mutation(async (ctx, args: { table: string; fields: Record<string, unknown> }) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const id = await ctx.db.insert(args.table, args.fields as any);
      return await ctx.db.get(id);
    }),
  };
}
