import { describe, it, expect } from "vitest";
import { SqliteDocStore, NodeSqliteAdapter } from "@stackbase/docstore-sqlite";
import { composeComponents } from "@stackbase/component";
import { EmbeddedRuntime } from "@stackbase/runtime-embedded";
import { defineSchema } from "@stackbase/values";
import { decodeDocumentId } from "@stackbase/id-codec";
import { DocumentNotFoundError } from "@stackbase/errors";
import { STORAGE_TABLE, STORAGE_TABLE_NUMBER, storageTableDefinition } from "../src/system-table";
import { storageModules } from "../src/modules";

/**
 * Test harness mirroring `components/scheduler/test/helpers.ts`, adapted for modules that are
 * PRIVILEGED built-ins rather than a component's own namespaced modules: the `_storage` table
 * lives in the APP-root schema (see `src/system-table.ts`'s doc comment), and `storageModules`'
 * `"_storage:_op"` keys are exactly the `EmbeddedRuntime.systemModules` shape (mirroring
 * `@stackbase/admin`'s `_system:*` modules — see `packages/admin/src/system-functions.ts`) —
 * the intended integration point for later tasks' `ctx.runMutation("_storage:_op", ...)` /
 * `runSystem` callers. `runtime.run(...)` (the public, client-facing surface) rejects ANY
 * `_`-prefixed path segment, so these are invoked here via `runtime.runSystem(...)`, the same
 * trusted entrypoint `@stackbase/admin`'s API uses for `_system:*`. Privileged calls bypass
 * namespace prefixing entirely, so `ctx.db`'s bare `"_storage"` table name resolves correctly.
 *
 * `existingTableNumbers` seeds the registry with `_storage`'s reserved, forever-stable number
 * (`STORAGE_TABLE_NUMBER` — see `./system-table.ts`'s doc comment) — the same seam a real boot
 * uses (`composeComponents`'s `existingTableNumbers` param) to pin it, rather than letting the
 * registry auto-allocate whatever system number happens to be next. That real boot-time seeding
 * is flagged as a follow-up for a later task in Task 4's report; this harness seeds it directly
 * so this test proves the id round-trips through the RESERVED number, not just "a" number.
 */
async function makeRuntime(now?: () => number): Promise<EmbeddedRuntime> {
  const schema = defineSchema({ [STORAGE_TABLE]: storageTableDefinition });
  const c = composeComponents(
    { schemaJson: schema.export(), moduleMap: {} },
    [],
    { [STORAGE_TABLE]: STORAGE_TABLE_NUMBER },
  );
  return EmbeddedRuntime.create({
    store: new SqliteDocStore(new NodeSqliteAdapter()),
    catalog: c.catalog,
    modules: c.moduleMap,
    systemModules: storageModules,
    componentNames: c.componentNames,
    contextProviders: c.contextProviders,
    policyRegistry: c.policyRegistry,
    policyProviders: c.policyProviders,
    relationRegistry: c.relationRegistry,
    bootSteps: c.bootSteps,
    drivers: c.drivers,
    tableNumbers: c.tableNumbers,
    now,
  });
}

describe("@stackbase/storage internal _storage metadata modules", () => {
  it("_createPending inserts a pending row and returns an id decoding to the _storage table", async () => {
    const runtime = await makeRuntime();
    const id = (
      await runtime.runSystem<string>("_storage:_createPending", {
        key: "u/abc",
        contentType: "image/png",
        visibility: "private",
        expiresAt: null,
      })
    ).value;
    expect(typeof id).toBe("string");
    expect(decodeDocumentId(id).tableNumber).toBe(STORAGE_TABLE_NUMBER);

    const doc = (await runtime.runSystem<Record<string, unknown> | null>("_storage:_get", { id })).value;
    expect(doc).not.toBeNull();
    expect(doc).toMatchObject({
      status: "pending",
      key: "u/abc",
      size: null,
      contentType: "image/png",
      sha256: null,
      visibility: "private",
      expiresAt: null,
    });
  });

  it("_insertReady inserts a ready row directly", async () => {
    const runtime = await makeRuntime();
    const id = (
      await runtime.runSystem<string>("_storage:_insertReady", {
        key: "u/def",
        size: 1234,
        sha256: "deadbeef",
        contentType: "text/plain",
        visibility: "public",
      })
    ).value;

    const doc = (await runtime.runSystem<Record<string, unknown> | null>("_storage:_get", { id })).value;
    expect(doc).toMatchObject({
      status: "ready",
      key: "u/def",
      size: 1234,
      sha256: "deadbeef",
      contentType: "text/plain",
      visibility: "public",
      expiresAt: null,
    });
  });

  it("_finalize flips a pending row to ready and sets size/sha256", async () => {
    const runtime = await makeRuntime();
    const id = (
      await runtime.runSystem<string>("_storage:_createPending", {
        key: "u/ghi",
        contentType: "application/octet-stream",
        visibility: "private",
        expiresAt: null,
      })
    ).value;

    await runtime.runSystem("_storage:_finalize", { id, size: 42, sha256: "cafebabe" });

    const doc = (await runtime.runSystem<Record<string, unknown> | null>("_storage:_get", { id })).value;
    expect(doc).toMatchObject({ status: "ready", size: 42, sha256: "cafebabe" });
  });

  it("_finalize REFUSES a tombstoned/expired-pending row — no resurrection — and stays pending", async () => {
    // Regression test for the delete->re-confirm resurrection hole: `ctx.storage.delete()`
    // tombstones a row to `status:"pending", expiresAt:<now>` (see `../src/context.ts`'s `delete`
    // doc comment), keeping `key` so the reaper reclaims the blob — but the upload/confirm
    // capability token stays valid for the full `uploadTtlMs` window, independent of the row's own
    // `expiresAt`. A client replaying `confirm`/`upload` with that still-valid token must not be
    // able to flip the tombstone BACK to `"ready"`. Simulate the tombstone directly (a pending row
    // whose `expiresAt` has already passed at the fixed deterministic `now`) rather than going
    // through the `ctx.storage` facade, since this test exercises `_finalize` in isolation.
    const NOW = 1_700_000_000_000;
    const runtime = await makeRuntime(() => NOW);
    const id = (
      await runtime.runSystem<string>("_storage:_createPending", {
        key: "u/tombstoned",
        contentType: "text/plain",
        visibility: "private",
        expiresAt: NOW - 1, // already expired at `NOW` — same shape as a delete() tombstone
      })
    ).value;

    await expect(runtime.runSystem("_storage:_finalize", { id, size: 999, sha256: "resurrected" })).rejects.toThrow(
      DocumentNotFoundError,
    );

    // The row was NOT resurrected: still pending, still carrying its pre-tombstone (null) size/hash,
    // not the replayed finalize's payload.
    const doc = (await runtime.runSystem<Record<string, unknown> | null>("_storage:_get", { id })).value;
    expect(doc).toMatchObject({ status: "pending", key: "u/tombstoned", size: null, sha256: null });
  });

  it("_finalize REFUSES a pending row whose expiresAt is exactly now (boundary — reclaimable, not future)", async () => {
    const NOW = 1_700_000_000_000;
    const runtime = await makeRuntime(() => NOW);
    const id = (
      await runtime.runSystem<string>("_storage:_createPending", {
        key: "u/boundary",
        contentType: null,
        visibility: "private",
        expiresAt: NOW, // expiresAt <= now, per `_reapExpired`'s own "due" condition
      })
    ).value;

    await expect(runtime.runSystem("_storage:_finalize", { id, size: 1, sha256: "x" })).rejects.toThrow(
      DocumentNotFoundError,
    );
    expect((await runtime.runSystem<Record<string, unknown> | null>("_storage:_get", { id })).value).toMatchObject({
      status: "pending",
    });
  });

  it("_finalize STILL SUCCEEDS for a genuinely in-flight pending row (future expiresAt)", async () => {
    const NOW = 1_700_000_000_000;
    const runtime = await makeRuntime(() => NOW);
    const id = (
      await runtime.runSystem<string>("_storage:_createPending", {
        key: "u/in-flight",
        contentType: null,
        visibility: "private",
        expiresAt: NOW + 100_000, // future — not yet expired, a legitimate in-flight upload
      })
    ).value;

    await runtime.runSystem("_storage:_finalize", { id, size: 7, sha256: "cafe" });
    expect((await runtime.runSystem<Record<string, unknown> | null>("_storage:_get", { id })).value).toMatchObject({
      status: "ready",
      size: 7,
      sha256: "cafe",
    });
  });

  it("_finalize is a no-op (idempotent) when the row is already ready", async () => {
    const runtime = await makeRuntime();
    const id = (
      await runtime.runSystem<string>("_storage:_insertReady", {
        key: "u/jkl",
        size: 1,
        sha256: "aaaa",
        contentType: "text/plain",
        visibility: "private",
      })
    ).value;

    await runtime.runSystem("_storage:_finalize", { id, size: 999, sha256: "zzzz" });

    const doc = (await runtime.runSystem<Record<string, unknown> | null>("_storage:_get", { id })).value;
    // unchanged — a second finalize on an already-ready row does not clobber its metadata
    expect(doc).toMatchObject({ status: "ready", size: 1, sha256: "aaaa" });
  });

  it("_reapExpired removes only pending rows past expiresAt, not ready rows or not-yet-expired pending rows", async () => {
    const runtime = await makeRuntime();
    const now = 1_000_000;

    const expiredId = (
      await runtime.runSystem<string>("_storage:_createPending", {
        key: "u/expired",
        contentType: null,
        visibility: "private",
        expiresAt: now - 1,
      })
    ).value;
    const futureId = (
      await runtime.runSystem<string>("_storage:_createPending", {
        key: "u/future",
        contentType: null,
        visibility: "private",
        expiresAt: now + 100_000,
      })
    ).value;
    const noExpiryId = (
      await runtime.runSystem<string>("_storage:_createPending", {
        key: "u/no-expiry",
        contentType: null,
        visibility: "private",
        expiresAt: null,
      })
    ).value;
    const readyId = (
      await runtime.runSystem<string>("_storage:_insertReady", {
        key: "u/ready-expired-looking",
        size: 1,
        sha256: "aaaa",
        contentType: null,
        visibility: "private",
      })
    ).value;

    const result = (await runtime.runSystem<{ keys: string[] }>("_storage:_reapExpired", { now })).value;
    expect(result.keys).toEqual(["u/expired"]);

    expect((await runtime.runSystem("_storage:_get", { id: expiredId })).value).toBeNull();
    expect((await runtime.runSystem("_storage:_get", { id: futureId })).value).not.toBeNull();
    expect((await runtime.runSystem("_storage:_get", { id: noExpiryId })).value).not.toBeNull();
    expect((await runtime.runSystem("_storage:_get", { id: readyId })).value).not.toBeNull();
  });

  it("_delete removes the row and returns its key", async () => {
    const runtime = await makeRuntime();
    const id = (
      await runtime.runSystem<string>("_storage:_insertReady", {
        key: "u/to-delete",
        size: 1,
        sha256: "aaaa",
        contentType: null,
        visibility: "private",
      })
    ).value;

    const result = (await runtime.runSystem<{ key: string }>("_storage:_delete", { id })).value;
    expect(result).toEqual({ key: "u/to-delete" });
    expect((await runtime.runSystem("_storage:_get", { id })).value).toBeNull();
  });

  it("_get returns null for a missing id", async () => {
    const runtime = await makeRuntime();
    const someId = (
      await runtime.runSystem<string>("_storage:_insertReady", {
        key: "u/z",
        size: 1,
        sha256: "aaaa",
        contentType: null,
        visibility: "private",
      })
    ).value;
    await runtime.runSystem("_storage:_delete", { id: someId });
    expect((await runtime.runSystem("_storage:_get", { id: someId })).value).toBeNull();
  });
});
