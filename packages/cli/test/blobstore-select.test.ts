import { describe, it, expect, vi } from "vitest";
import { isS3Config, makeBlobStore } from "../src/blobstore-select";
import { warnIfS3ConfigIgnored } from "../src/boot";
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

// Fix 2 regression: S3-shaped settings (endpoint/region/publicBaseUrl) with no bucket used to
// silently fall back to FS storage with zero indication anything was ignored.
describe("warnIfS3ConfigIgnored", () => {
  it("stays silent when nothing S3-shaped is configured", () => {
    const spy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      warnIfS3ConfigIgnored(undefined);
      warnIfS3ConfigIgnored({});
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it("stays silent when a bucket IS set (real S3 config, not a misconfiguration)", () => {
    const spy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      warnIfS3ConfigIgnored({ bucket: "b", endpoint: "http://localhost:9000", region: "us-east-1" });
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it("warns once when endpoint/region/publicBaseUrl are set but no bucket is provided", () => {
    const spy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      warnIfS3ConfigIgnored({ endpoint: "http://localhost:9000" });
      expect(spy).toHaveBeenCalledTimes(1);
      const [message] = spy.mock.calls[0]!;
      expect(message).toContain("STACKBASE_STORAGE_BUCKET");
      expect(message).toContain("IGNORED");
    } finally {
      spy.mockRestore();
    }
  });

  it("also warns when only region or only publicBaseUrl is set without a bucket", () => {
    const spy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      warnIfS3ConfigIgnored({ region: "us-east-1" });
      warnIfS3ConfigIgnored({ publicBaseUrl: "https://cdn.example.com" });
      expect(spy).toHaveBeenCalledTimes(2);
    } finally {
      spy.mockRestore();
    }
  });
});
