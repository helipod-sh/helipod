import { describe, it, expect } from "vitest";
import { FsObjectStore } from "@helipod/objectstore-fs";
import { S3ObjectStore } from "@helipod/objectstore-s3";
import {
  resolveObjectStore,
  parseS3ObjectStoreUrl,
  parseFsObjectStorePath,
  defaultObjectStoreNodeConfig,
} from "../src/objectstore-select";

describe("resolveObjectStore", () => {
  it("returns null when unset or empty (object-store mode not requested)", () => {
    expect(resolveObjectStore(undefined)).toBeNull();
    expect(resolveObjectStore("")).toBeNull();
    expect(resolveObjectStore("   ")).toBeNull();
  });

  it("file:// URL selects FsObjectStore rooted at the path", () => {
    const r = resolveObjectStore("file:///tmp/x");
    expect(r).not.toBeNull();
    expect(r!.kind).toBe("fs");
    expect(r!.objectStore).toBeInstanceOf(FsObjectStore);
  });

  it("a bare filesystem path (no ://) selects FsObjectStore", () => {
    const r = resolveObjectStore("./data/objects");
    expect(r).not.toBeNull();
    expect(r!.kind).toBe("fs");
    expect(r!.objectStore).toBeInstanceOf(FsObjectStore);

    const r2 = resolveObjectStore("/var/lib/helipod/objects");
    expect(r2!.kind).toBe("fs");
    expect(r2!.objectStore).toBeInstanceOf(FsObjectStore);
  });

  it("resolves the fs directory correctly for file:// and bare paths (parseFsObjectStorePath)", () => {
    expect(parseFsObjectStorePath("file:///abs/path")).toBe("/abs/path");
    expect(parseFsObjectStorePath("./data/objects")).toBe("./data/objects");
  });

  it("s3+http:// forces an http endpoint, parsed into the same S3ObjectStore config as s3://", () => {
    const r = resolveObjectStore("s3+http://key:sec@host:9000/bucket");
    expect(r).not.toBeNull();
    expect(r!.kind).toBe("s3");
    expect(r!.objectStore).toBeInstanceOf(S3ObjectStore);

    const parsed = parseS3ObjectStoreUrl("s3+http://key:sec@host:9000/bucket", {});
    expect(parsed.endpoint).toBe("http://host:9000");
    expect(parsed.bucket).toBe("bucket");
    expect(parsed.accessKeyId).toBe("key");
    expect(parsed.secretAccessKey).toBe("sec");
  });

  it("s3+https:// forces an https endpoint", () => {
    const r = resolveObjectStore("s3+https://key:sec@host:9000/bucket");
    expect(r).not.toBeNull();
    expect(r!.kind).toBe("s3");
    expect(r!.objectStore).toBeInstanceOf(S3ObjectStore);

    const parsed = parseS3ObjectStoreUrl("s3+https://key:sec@host:9000/bucket", {});
    expect(parsed.endpoint).toBe("https://host:9000");
  });

  it("an explicit ?endpoint= still wins over the s3+https:// scheme-implied protocol", () => {
    const parsed = parseS3ObjectStoreUrl(
      "s3+https://key:sec@host:9000/bucket?endpoint=http%3A%2F%2Foverride.example.com",
      {},
    );
    expect(parsed.endpoint).toBe("http://override.example.com");
  });

  it("CRITICAL: rejects unrecognized schemes instead of silently falling back to a local FsObjectStore", () => {
    // Before the fix, any scheme other than the literal "s3://" fell through to the fs branch
    // and would have constructed an FsObjectStore rooted at the whole URL string — silently
    // writing to local disk instead of the intended shared bucket. Now it must throw.
    expect(() => resolveObjectStore("gs://bucket/x")).toThrow(/unsupported scheme/i);
    expect(() => resolveObjectStore("azure://bucket/x")).toThrow(/unsupported scheme/i);
    expect(() => resolveObjectStore("http://bucket/x")).toThrow(/unsupported scheme/i);
    // A same-name-different-case typo must also be rejected, not silently normalized to s3://.
    expect(() => resolveObjectStore("S3://key:secret@localhost:9000/bucket")).toThrow(/unsupported scheme/i);

    try {
      resolveObjectStore("gs://bucket/x");
      throw new Error("expected resolveObjectStore to throw");
    } catch (e) {
      expect((e as Error).message).not.toMatch(/FsObjectStore/);
      expect((e as Error).message).toMatch(/s3:\/\//);
      expect((e as Error).message).toMatch(/file:\/\//);
    }
  });

  it("s3:// URL with userinfo creds selects S3ObjectStore, parsing bucket/endpoint/region", () => {
    const r = resolveObjectStore("s3://key:secret@localhost:9000/my-bucket?region=us-east-1");
    expect(r).not.toBeNull();
    expect(r!.kind).toBe("s3");
    expect(r!.objectStore).toBeInstanceOf(S3ObjectStore);
  });

  it("s3:// URL with no host (empty authority) means real AWS S3 — no custom endpoint", () => {
    const parsed = parseS3ObjectStoreUrl("s3:///my-prod-bucket?region=us-west-2", {
      AWS_ACCESS_KEY_ID: "envkey",
      AWS_SECRET_ACCESS_KEY: "envsecret",
    });
    expect(parsed.bucket).toBe("my-prod-bucket");
    expect(parsed.endpoint).toBeUndefined();
    expect(parsed.region).toBe("us-west-2");
    expect(parsed.accessKeyId).toBe("envkey");
    expect(parsed.secretAccessKey).toBe("envsecret");
  });

  it("credentials fall back to AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY env when no userinfo", () => {
    const parsed = parseS3ObjectStoreUrl("s3://localhost:9000/bucket", {
      AWS_ACCESS_KEY_ID: "envkey",
      AWS_SECRET_ACCESS_KEY: "envsecret",
    });
    expect(parsed.accessKeyId).toBe("envkey");
    expect(parsed.secretAccessKey).toBe("envsecret");
    expect(parsed.endpoint).toBe("http://localhost:9000");
  });

  it("an explicit ?endpoint= query param wins over the host-derived endpoint", () => {
    const parsed = parseS3ObjectStoreUrl(
      "s3://key:secret@localhost:9000/bucket?endpoint=https%3A%2F%2Fcustom.example.com&forcePathStyle=false",
      {},
    );
    expect(parsed.endpoint).toBe("https://custom.example.com");
    expect(parsed.forcePathStyle).toBe(false);
  });

  it("throws a clear error on a missing bucket", () => {
    expect(() => parseS3ObjectStoreUrl("s3://key:secret@localhost:9000", {})).toThrow(/bucket/i);
  });

  it("throws a clear error on missing credentials (no userinfo, no env)", () => {
    expect(() => parseS3ObjectStoreUrl("s3://localhost:9000/bucket", {})).toThrow(/credentials/i);
  });

  it("throws a clear error on a malformed s3 URL", () => {
    expect(() => parseS3ObjectStoreUrl("s3://[not a valid url", {})).toThrow(/invalid --object-store URL/i);
  });

  it("throws a clear error on an invalid forcePathStyle value", () => {
    expect(() =>
      parseS3ObjectStoreUrl("s3://key:secret@localhost:9000/bucket?forcePathStyle=maybe", {}),
    ).toThrow(/forcePathStyle/);
  });
});

describe("defaultObjectStoreNodeConfig", () => {
  it("is a single shard '0' of 1 for Slice 6 (multi-shard-node is out of scope)", () => {
    expect(defaultObjectStoreNodeConfig()).toEqual({ shard: "0", numShards: 1 });
  });
});
