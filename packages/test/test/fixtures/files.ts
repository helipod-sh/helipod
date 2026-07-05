import { mutation, action } from "@helipod/executor";
export const makeUpload = mutation(async (ctx: any) => ctx.storage.generateUploadUrl({}));
export const storeBytes = action(async (ctx: any, { text }: { text: string }) =>
  ctx.storage.store(new TextEncoder().encode(text), { contentType: "text/plain" }));
export const readBytes = action(async (ctx: any, { id }: { id: string }) => {
  const s = await ctx.storage.get(id);
  return s === null ? null : new TextDecoder().decode(await new Response(s).arrayBuffer());
});
