import { mutation, type RegisteredFunction } from "@stackbase/executor";
import { DocumentNotFoundError } from "@stackbase/errors";

/** Built-in privileged mutations the admin API invokes by id. Registered under `_system:*`. */
export function systemModules(): Record<string, RegisteredFunction> {
  return {
    "_system:patchDocument": mutation(async (ctx, args: { id: string; fields: Record<string, unknown> }) => {
      const existing = await ctx.db.get(args.id);
      if (!existing) throw new DocumentNotFoundError(`cannot patch missing document ${args.id}`);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await ctx.db.replace(args.id, { ...existing, ...args.fields } as any);
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
