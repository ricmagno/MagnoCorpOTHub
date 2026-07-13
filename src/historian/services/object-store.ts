import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import config from '../config';

const s3 = new S3Client({
  endpoint: config.s3.endpoint,
  region: config.s3.region,
  credentials: { accessKeyId: config.s3.accessKey, secretAccessKey: config.s3.secretKey },
  forcePathStyle: true, // required for MinIO
});

export async function uploadScreenshot(key: string, body: Buffer): Promise<void> {
  await s3.send(new PutObjectCommand({
    Bucket: config.s3.bucket, Key: key, Body: body, ContentType: 'image/png',
  }));
}

/** Download to a temp file; returns local path for the embedder */
export async function downloadToTemp(key: string): Promise<string> {
  const res = await s3.send(new GetObjectCommand({ Bucket: config.s3.bucket, Key: key }));
  const bytes = Buffer.from(await res.Body!.transformToByteArray());
  const localPath = join(tmpdir(), key.replace(/\//g, '_'));
  await writeFile(localPath, bytes);
  return localPath;
}

/**
 * Fetch object bytes for serving to a browser. Proxied through the API rather than a
 * presigned URL: MinIO's Service is ClusterIP-only in production (historian-minio-deployment.yaml)
 * and unreachable from outside the cluster, whereas the API is exposed via the ingress.
 */
export async function downloadBuffer(key: string): Promise<Buffer> {
  const res = await s3.send(new GetObjectCommand({ Bucket: config.s3.bucket, Key: key }));
  return Buffer.from(await res.Body!.transformToByteArray());
}
