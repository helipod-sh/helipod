import { describe, it, expect } from "vitest";
import { runBlobStoreConformance } from "@stackbase/blobstore/test-support/conformance";
import { S3BlobStore } from "../src/s3-blobstore";

const endpoint = process.env.STACKBASE_TEST_S3_ENDPOINT;
const bucket = process.env.STACKBASE_TEST_S3_BUCKET ?? "stackbase-test";

const suite = endpoint ? describe : describe.skip;

suite("S3BlobStore conformance (real endpoint)", () => {
  runBlobStoreConformance(
    "s3-minio",
    () =>
      new S3BlobStore({
        bucket,
        endpoint,
        forcePathStyle: true,
        region: "us-east-1",
        accessKeyId: process.env.STACKBASE_TEST_S3_KEY ?? "minioadmin",
        secretAccessKey: process.env.STACKBASE_TEST_S3_SECRET ?? "minioadmin",
      }),
  );
});

describe("S3BlobStore specifics", () => {
  it("publicUrl returns null without a publicBaseUrl and joins the key when set", () => {
    const noBase = new S3BlobStore({ bucket: "b" });
    expect(noBase.publicUrl("k")).toBeNull();

    const withBase = new S3BlobStore({ bucket: "b", publicBaseUrl: "https://cdn.example.com/files/" });
    expect(withBase.publicUrl("some/key")).toBe("https://cdn.example.com/files/some/key");
  });
});
