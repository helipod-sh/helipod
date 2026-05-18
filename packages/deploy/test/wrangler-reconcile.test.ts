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

  it("preserves an escaped quote inside a string", () => {
    expect(JSON.parse(stripJsonc(`{ "a": "x\\"y" }`))).toEqual({ a: 'x"y' });
  });

  it("preserves comment markers and URLs inside strings", () => {
    const src = `{ "url": "http://a.com", "b": "/* not a comment */" }`;
    expect(JSON.parse(stripJsonc(src))).toEqual({ url: "http://a.com", b: "/* not a comment */" });
  });

  it("does not strip a comma inside a string adjacent to a brace", () => {
    expect(JSON.parse(stripJsonc(`{ "a": "foo,}" }`))).toEqual({ a: "foo,}" });
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

  it("does not collide with a non-sequential existing migration tag", () => {
    const r = reconcileWrangler(
      { name: "x", migrations: [{ tag: "v1", new_classes: ["Other"] }, { tag: "v3", new_classes: ["Another"] }] },
      {},
    );
    const tags = (r.config.migrations as Array<{ tag: string }>).map((m) => m.tag);
    expect(new Set(tags).size).toBe(tags.length); // no duplicate tags
    const sqliteMig = (r.config.migrations as Array<{ tag: string; new_sqlite_classes?: string[] }>).find((m) => m.new_sqlite_classes?.includes("StackbaseDO"));
    expect(sqliteMig).toBeDefined();
    expect(["v1", "v3"]).not.toContain(sqliteMig!.tag);
  });
});
