import { S3Client } from "@aws-sdk/client-s3";
import type { S3Config } from "./s3-blobstore";

export function makeS3Client(c: S3Config): S3Client {
  return new S3Client({
    region: c.region ?? "us-east-1",
    endpoint: c.endpoint,
    forcePathStyle: c.forcePathStyle ?? Boolean(c.endpoint),
    credentials:
      c.accessKeyId && c.secretAccessKey
        ? { accessKeyId: c.accessKeyId, secretAccessKey: c.secretAccessKey }
        : undefined,
  });
}
