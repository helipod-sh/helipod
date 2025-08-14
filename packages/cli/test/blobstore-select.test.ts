import { describe, it, expect } from "vitest";
import { isS3Config, makeBlobStore } from "../src/blobstore-select";
import { assertStorageConfigCoherent } from "../src/boot";
import { FsBlobStore } from "@stackbase/blobstore-fs";
import { S3BlobStore } from "@stackbase/blobstore-s3";

describe("makeBlobStore selection", () => {
  it("defaults to FS when no bucket configured", () => {
    expect(isS3Config(undefined)).toBe(false);
    expect(isS3Config({})).toBe(false);
    expect(makeBlobStore({ dataPath: "/tmp/x" })).toBeInstanceOf(FsBlobStore);
  });

  it("selects S3 when a bucket is configured", () => {
    expect(isS3Config({ bucket: "b" })).toBe(true);
    expect(
      makeBlobStore({ dataPath: "/tmp/x", storage: { bucket: "b", endpoint: "http://localhost:9000" } }),
    ).toBeInstanceOf(S3BlobStore);
  });
});

// Fix 2 (escalated to fail-fast): S3-shaped settings (endpoint/region/publicBaseUrl) with no bucket
// used to silently fall back to FS storage. That's a data-durability footgun (uploads land on
// ephemeral local disk instead of the object store the operator configured), so it now refuses to
// boot rather than warn-and-continue.
describe("assertStorageConfigCoherent", () => {
  it("accepts config with nothing S3-shaped set (plain FS)", () => {
    expect(() => assertStorageConfigCoherent(undefined)).not.toThrow();
    expect(() => assertStorageConfigCoherent({})).not.toThrow();
  });

  it("accepts a real S3 config (bucket set)", () => {
    expect(() =>
      assertStorageConfigCoherent({ bucket: "b", endpoint: "http://localhost:9000", region: "us-east-1" }),
    ).not.toThrow();
  });

  it("does NOT treat bare AWS credentials as S3 intent (they're common on FS deployments)", () => {
    expect(() =>
      assertStorageConfigCoherent({ accessKeyId: "AKIA...", secretAccessKey: "secret" }),
    ).not.toThrow();
  });

  it("throws when endpoint/region/publicBaseUrl is set but no bucket is provided", () => {
    for (const bad of [
      { endpoint: "http://localhost:9000" },
      { region: "us-east-1" },
      { publicBaseUrl: "https://cdn.example.com" },
    ]) {
      expect(() => assertStorageConfigCoherent(bad)).toThrow(/STACKBASE_STORAGE_BUCKET/);
    }
  });
});
