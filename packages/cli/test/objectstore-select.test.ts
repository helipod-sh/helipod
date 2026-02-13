import { describe, it, expect } from "vitest";
import { FsObjectStore } from "@stackbase/objectstore-fs";
import { S3ObjectStore } from "@stackbase/objectstore-s3";
import {
  resolveObjectStore,
  parseS3ObjectStoreUrl,
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

    const r2 = resolveObjectStore("/var/lib/stackbase/objects");
    expect(r2!.kind).toBe("fs");
    expect(r2!.objectStore).toBeInstanceOf(FsObjectStore);
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
