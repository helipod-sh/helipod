import { query, mutation } from "@stackbase/executor";
import type { QueryCtx, MutationCtx } from "@stackbase/executor";
import { DocumentNotFoundError } from "@stackbase/errors";
import { STORAGE_TABLE } from "./system-table";

/**
 * Internal `_storage` metadata mutations/queries for `@stackbase/storage` — the low-level ops
 * the Task 6 context provider, Task 7 HTTP endpoints, and Task 9 reaper call. Registered under
 * fully-qualified keys (`storageModules`, below) meant for `EmbeddedRuntime.systemModules` /
 * `ctx.runMutation`-style trusted callers, mirroring `@stackbase/admin`'s `_system:*` built-ins
 * (`packages/admin/src/system-functions.ts`) — NOT `@stackbase/component`'s namespaced-component
 * `modules` map, since `_storage` is an APP-ROOT system table (see `./system-table.ts`'s doc
 * comment), not a component's own namespace.
 *
 * Because these are always invoked privileged (bypassing namespace prefixing entirely — see
 * `packages/executor/src/kernel.ts`'s `requireTable`), `ctx.db` here uses the bare `STORAGE_TABLE`
 * name (`"_storage"`), exactly like `@stackbase/admin`'s built-ins use bare table names such as
 * the dashboard's edited table.
 */

export interface StorageDoc {
  _id: string;
  _creationTime: number;
  status: "pending" | "ready";
  key: string;
  size: number | null;
  contentType: string | null;
  sha256: string | null;
  visibility: "private" | "public";
  expiresAt: number | null;
  [key: string]: unknown;
}

/**
 * `_storage:_createPending` — a MUTATION: inserts a `status:"pending"` `_storage` row (the
 * upload has been registered but its bytes/hash/size aren't known yet — e.g. an in-flight HTTP
 * upload). `size`/`sha256` start `null`; the Task 7 upload endpoint later calls `_finalize` once
 * the blob is fully written. Returns the new row's id.
 */
export const _createPending = mutation(
  async (
    ctx: MutationCtx,
    args: { key: string; contentType: string | null; visibility: "private" | "public"; expiresAt: number | null },
  ): Promise<string> =>
    ctx.db.insert(STORAGE_TABLE, {
      status: "pending",
      key: args.key,
      size: null,
      contentType: args.contentType,
      sha256: null,
      visibility: args.visibility,
      expiresAt: args.expiresAt,
    }),
);

/**
 * `_storage:_insertReady` — a MUTATION: inserts a `status:"ready"` row directly, with a known
 * size/sha256 up front. Used by the action-mode `store()` path (Task 6), where the full blob is
 * already written and hashed by the time the metadata row is created — there's no in-flight
 * "pending" phase to model, unlike `_createPending`'s streamed-upload use case. `expiresAt` is
 * always `null` here: a directly-stored blob is never provisional/reapable the way a
 * not-yet-finalized pending upload is.
 */
export const _insertReady = mutation(
  async (
    ctx: MutationCtx,
    args: { key: string; size: number; sha256: string; contentType: string | null; visibility: "private" | "public" },
  ): Promise<string> =>
    ctx.db.insert(STORAGE_TABLE, {
      status: "ready",
      key: args.key,
      size: args.size,
      contentType: args.contentType,
      sha256: args.sha256,
      visibility: args.visibility,
      expiresAt: null,
    }),
);

/**
 * `_storage:_finalize` — a MUTATION: flips a `status:"pending"` row to `"ready"`, setting its
 * final `size`/`sha256`.
 *
 * Idempotent-no-op (mirroring the scheduler's `_claim`/`_complete` style of guard — see
 * `components/scheduler/src/modules.ts` — rather than throwing) if the row is already `"ready"`:
 * a retried finalize call (e.g. an upload client that resends after a dropped response) must not
 * clobber already-committed metadata with a second, possibly-stale size/hash. Returns the row's
 * current state either way (the freshly-finalized doc, or the pre-existing ready doc unchanged),
 * so a caller never needs a follow-up `_get` to learn the outcome. Throws if the row doesn't
 * exist at all — unlike a race between two finalizes of the SAME upload, a missing id is a
 * caller bug (the id came from `_createPending`, which the caller must not have discarded).
 */
export const _finalize = mutation(
  async (ctx: MutationCtx, args: { id: string; size: number; sha256: string }): Promise<StorageDoc> => {
    const existing = await ctx.db.get(args.id);
    if (existing === null) throw new DocumentNotFoundError(`_storage:_finalize: no such document ${args.id}`);
    if (existing["status"] === "ready") return existing as unknown as StorageDoc; // idempotent no-op
    const updated = { ...existing, status: "ready" as const, size: args.size, sha256: args.sha256 };
    await ctx.db.replace(args.id, updated);
    return updated as unknown as StorageDoc;
  },
);

/**
 * `_storage:_delete` — a MUTATION: deletes the `_storage` row and returns its `key`, so a caller
 * (Task 9's reaper, an explicit user delete) can reclaim the underlying blob by that key.
 */
export const _delete = mutation(async (ctx: MutationCtx, args: { id: string }): Promise<{ key: string }> => {
  const existing = await ctx.db.get(args.id);
  if (existing === null) throw new DocumentNotFoundError(`_storage:_delete: no such document ${args.id}`);
  await ctx.db.delete(args.id);
  return { key: existing["key"] as string };
});

/**
 * `_storage:_reapExpired` — a MUTATION: deletes every `status:"pending"` row whose `expiresAt`
 * is set and has passed (`expiresAt !== null && expiresAt <= now`) — an upload that was
 * registered (`_createPending`) but never finalized before its expiry, e.g. an abandoned
 * client-side upload. `"ready"` rows and pending rows with no `expiresAt` (or a future one) are
 * left untouched. Scans the default `by_creation` index (no dedicated `_storage` index exists —
 * the reaper is a periodic sweep, not a hot path) and returns the reclaimed rows' `key`s so the
 * Task 9 reaper can delete the corresponding blobs.
 */
export const _reapExpired = mutation(async (ctx: MutationCtx, args: { now: number }): Promise<{ keys: string[] }> => {
  const rows = await ctx.db.query(STORAGE_TABLE, "by_creation").collect();
  const keys: string[] = [];
  for (const row of rows) {
    if (row["status"] !== "pending") continue;
    const expiresAt = row["expiresAt"] as number | null;
    if (expiresAt === null || expiresAt > args.now) continue;
    await ctx.db.delete(row["_id"] as string);
    keys.push(row["key"] as string);
  }
  return { keys };
});

/** `_storage:_get` — a QUERY: the `_storage` doc for `id`, or `null` if it doesn't exist. */
export const _get = query(async (ctx: QueryCtx, args: { id: string }): Promise<StorageDoc | null> => {
  const doc = await ctx.db.get(args.id);
  return doc as unknown as StorageDoc | null;
});

/** The privileged built-in registry for `_storage:*` — see this file's module doc comment. */
export const storageModules = {
  "_storage:_createPending": _createPending,
  "_storage:_insertReady": _insertReady,
  "_storage:_finalize": _finalize,
  "_storage:_delete": _delete,
  "_storage:_reapExpired": _reapExpired,
  "_storage:_get": _get,
};
