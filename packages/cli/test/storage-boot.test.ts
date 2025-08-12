/**
 * Task 10 boot smoke test: prove the always-on file-storage feature is actually wired into the
 * real boot + HTTP server — `ctx.storage` works inside a function AND `GET /api/storage/:id`
 * serves a stored file's bytes. The exhaustive FS+MinIO round trip is Task 11; this just proves
 * the integration crux (backend selection, provider, `_storage` table/modules, engine routes).
 */
import { describe, it, expect, afterEach } from "vitest";
import { rmSync } from "node:fs";
import { defineSchema, defineTable, v } from "@stackbase/values";
import { mutation, query, action, type RegisteredFunction } from "@stackbase/executor";
import { createStorageToken } from "@stackbase/storage";
import { bootLoaded } from "../src/boot";
import { startDevServer } from "../src/server";
import type { LoadedProject } from "../src/project";

const TMP = "./.tmp-storage-boot";
const DATA = `${TMP}/db.sqlite`;
afterEach(() => rmSync(TMP, { recursive: true, force: true }));

/* eslint-disable @typescript-eslint/no-explicit-any */
const appModules: Record<string, Record<string, RegisteredFunction>> = {
  files: {
    genUpload: mutation(async (ctx: any) => ctx.storage.generateUploadUrl()),
    // Store PUBLIC bytes so the serve endpoint streams them without a capability token.
    storePublic: action(async (ctx: any, { text }: { text: string }) =>
      ctx.storage.store(new TextEncoder().encode(text), { visibility: "public", contentType: "text/plain" }),
    ),
  },
};
/* eslint-enable @typescript-eslint/no-explicit-any */

const loaded: LoadedProject = {
  schema: defineSchema({ notes: defineTable({ body: v.string() }) }),
  modules: appModules,
};

describe("storage wiring (boot smoke)", () => {
  it("exposes ctx.storage in a mutation: generateUploadUrl returns a proxied target + creates a pending _storage row", async () => {
    const { runtime, store } = await bootLoaded({ loaded, components: [], dataPath: DATA, adminKey: "boot-key" });
    try {
      const { value } = await runtime.run<{ storageId: string; target: { kind: string; url: string } }>(
        "files:genUpload",
        {},
      );
      expect(typeof value.storageId).toBe("string");
      // FS backend → a proxied upload target, capability-token-gated on our own endpoint.
      expect(value.target.kind).toBe("proxied");
      expect(value.target.url.startsWith("/api/storage/upload")).toBe(true);
      expect(value.target.url).toContain("token=");

      // A pending row was actually written to the `_storage` table (privileged read).
      const doc = (await runtime.runSystem("_storage:_get", { id: value.storageId })).value as {
        status: string;
      } | null;
      expect(doc?.status).toBe("pending");
    } finally {
      await store.close();
    }
  });

  it("GET /api/storage/:id serves a stored public file's exact bytes through the real server", async () => {
    const { runtime, storageRoutes, store } = await bootLoaded({
      loaded,
      components: [],
      dataPath: DATA,
      adminKey: "boot-key",
    });
    const server = await startDevServer(runtime, { port: 0, ip: "127.0.0.1", storageRoutes });
    try {
      const text = "hello storage wiring";
      const id = (await runtime.runAction<string>("files:storePublic", { text })).value;

      const res = await fetch(`${server.url}/api/storage/${id}`);
      expect(res.status).toBe(200);
      expect(await res.text()).toBe(text);
    } finally {
      await server.close();
      await store.close();
    }
  });

  // Fix 1 regression: `stackbase serve`/`dev` on Node reads the storage-route body via
  // `node:http`'s `req.on("data"/"end")`. Before the fix, that body was decoded to a utf8 STRING
  // (`readBody`) before being handed to `new Request(...)`, so `handleUpload`'s
  // `new Uint8Array(await request.arrayBuffer())` re-encoded the string — mangling any byte
  // sequence that isn't valid UTF-8 (e.g. a real PNG/PDF upload). This test runs under Node (see
  // `startDevServer`'s `detectRuntime()` — Bun isn't defined here), so it exercises exactly the
  // vulnerable dispatch path end-to-end: POST raw non-UTF8 bytes to `/api/storage/upload`, then
  // GET them back through `/api/storage/:id` and assert byte-for-byte equality.
  it("preserves exact non-UTF8 bytes through the Node backend's proxied upload dispatch", async () => {
    const { runtime, storageRoutes, store } = await bootLoaded({
      loaded,
      components: [],
      dataPath: DATA,
      adminKey: "boot-key",
    });
    const server = await startDevServer(runtime, { port: 0, ip: "127.0.0.1", storageRoutes });
    try {
      // Mint a pending `_storage` row the same way `ctx.storage.generateUploadUrl()` does.
      const { value } = await runtime.run<{ storageId: string }>("files:genUpload", {});
      const { storageId } = value;

      // The FS backend's `createUploadTarget` doesn't embed `id` in its returned url (a separate,
      // pre-existing gap outside this task's two fixes), so build the authorized upload url the
      // same way `packages/storage/test/http.test.ts`'s fixtures do: mint our own capability
      // token over the same `(signingKey, id)` the upload endpoint verifies against — `exp` need
      // only be in the future, it's independent of whatever `generateUploadUrl` picked.
      const uploadToken = createStorageToken("boot-key", storageId, Date.now() + 60_000);
      const nonUtf8Bytes = new Uint8Array([0xff, 0x00, 0xfe, 0x80, 0x01]);

      const uploadRes = await fetch(
        `${server.url}/api/storage/upload?id=${storageId}&token=${uploadToken}`,
        { method: "POST", headers: { "content-type": "application/octet-stream" }, body: nonUtf8Bytes },
      );
      expect(uploadRes.status).toBe(200);
      expect((await uploadRes.json()) as { storageId: string }).toEqual({ storageId });

      // Read it back — private by default, so gate the GET the same way a private `getUrl()`
      // would (a capability token, verified via the same no-authz fallback in `handleServe`).
      const getToken = createStorageToken("boot-key", storageId, Date.now() + 60_000);
      const downloadRes = await fetch(`${server.url}/api/storage/${storageId}?token=${getToken}`);
      expect(downloadRes.status).toBe(200);
      const roundTripped = new Uint8Array(await downloadRes.arrayBuffer());

      // Byte-identical, NOT U+FFFD-replaced: a `toString("utf8")` round trip before the fix would
      // have replaced every invalid byte with the 3-byte UTF-8 replacement character sequence,
      // so the corrupted round trip would come back longer than the original and full of 0xEF 0xBF 0xBD.
      expect(roundTripped).toEqual(nonUtf8Bytes);
    } finally {
      await server.close();
      await store.close();
    }
  });
});
