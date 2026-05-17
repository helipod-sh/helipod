import { describe, it, expect } from "vitest";
import { stripJsonc, reconcileWrangler } from "../src/wrangler-reconcile";

describe("stripJsonc", () => {
  it("removes line and block comments but not // inside strings", () => {
    const src = `{
      // a comment
      "url": "https://example.com", /* trailing */
      "name": "x",
    }`;
    expect(JSON.parse(stripJsonc(src))).toEqual({ url: "https://example.com", name: "x" });
  });
});

describe("reconcileWrangler", () => {
  it("adds the DO binding + sqlite migration + nodejs_compat to a bare config, preserving user fields", () => {
    const r = reconcileWrangler({ name: "my-app", main: "worker.ts", vars: { CUSTOM: "keep" } }, {});
    expect(r.changed).toBe(true);
    expect(r.config).toMatchObject({
      name: "my-app",
      main: "worker.ts",
      vars: { CUSTOM: "keep" }, // user field untouched
      durable_objects: { bindings: [{ name: "STACKBASE_DO", class_name: "StackbaseDO" }] },
      migrations: [{ tag: "v1", new_sqlite_classes: ["StackbaseDO"] }],
      compatibility_flags: ["nodejs_compat"],
    });
    expect(r.added).toContain("durable_objects.STACKBASE_DO");
  });

  it("is a no-op when everything is already present (comments would be preserved by the caller)", () => {
    const complete = {
      name: "x", main: "w.ts",
      durable_objects: { bindings: [{ name: "STACKBASE_DO", class_name: "StackbaseDO" }] },
      migrations: [{ tag: "v1", new_sqlite_classes: ["StackbaseDO"] }],
      compatibility_flags: ["nodejs_compat"],
    };
    const r = reconcileWrangler(complete, {});
    expect(r.changed).toBe(false);
    expect(r.added).toEqual([]);
  });

  it("adds the R2 bucket binding only when needsR2 is set", () => {
    const r = reconcileWrangler({ name: "x" }, { needsR2: true, r2BucketName: "my-bucket" });
    expect(r.config).toMatchObject({ r2_buckets: [{ binding: "STORAGE_BUCKET", bucket_name: "my-bucket" }] });
    expect(r.added).toContain("r2_buckets.STORAGE_BUCKET");
  });

  it("preserves an existing nodejs_compat among other flags", () => {
    const r = reconcileWrangler({ name: "x", compatibility_flags: ["nodejs_compat", "streams_enable_constructors"] }, {});
    expect(r.config.compatibility_flags).toEqual(["nodejs_compat", "streams_enable_constructors"]);
  });
});
