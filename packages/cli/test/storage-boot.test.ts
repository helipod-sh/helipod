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
});
