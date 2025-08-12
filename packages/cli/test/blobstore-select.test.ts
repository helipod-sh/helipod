import { describe, it, expect } from "vitest";
import { isS3Config, makeBlobStore } from "../src/blobstore-select";
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
