import { describe, it, expect } from "vitest";
import { runBlobStoreConformance } from "@helipod/blobstore/test-support/conformance";
import { S3BlobStore } from "../src/s3-blobstore";

const endpoint = process.env.HELIPOD_TEST_S3_ENDPOINT;
const bucket = process.env.HELIPOD_TEST_S3_BUCKET ?? "helipod-test";

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
        accessKeyId: process.env.HELIPOD_TEST_S3_KEY ?? "minioadmin",
        secretAccessKey: process.env.HELIPOD_TEST_S3_SECRET ?? "minioadmin",
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

  it("read() propagates a non-404 error (e.g. connection failure) instead of returning null", async () => {
    // Unreachable endpoint: a connection-refused error is NOT a "not found" — it must
    // surface, not be silently swallowed into a `null` that looks like a missing blob.
    const store = new S3BlobStore({
      bucket: "x",
      endpoint: "http://127.0.0.1:1",
      forcePathStyle: true,
      region: "us-east-1",
      accessKeyId: "dummy",
      secretAccessKey: "dummy",
    });

    await expect(store.read("k")).rejects.toThrow();
  }, 10000);
});
