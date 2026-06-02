import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { env, r2Enabled } from '../env.js';

export const ALLOWED_MIME = new Set([
  'application/pdf',
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/heic',
]);

export const MAX_BYTES = 15 * 1024 * 1024; // 15 MB

let client = null;
if (r2Enabled) {
  client = new S3Client({
    region: 'auto',
    endpoint: env.R2_ENDPOINT,
    credentials: { accessKeyId: env.R2_KEY, secretAccessKey: env.R2_SECRET },
  });
}

function assertEnabled() {
  if (!client) throw new Error('R2 no configurado (faltan R2_ENDPOINT/R2_KEY/R2_SECRET/R2_BUCKET)');
}

// PUT firmado para que el cliente suba el binario directo a R2.
export function presignPut(key, contentType, expiresIn = 300) {
  assertEnabled();
  const cmd = new PutObjectCommand({ Bucket: env.R2_BUCKET, Key: key, ContentType: contentType });
  return getSignedUrl(client, cmd, { expiresIn });
}

// GET firmado para mostrar/descargar un archivo (expira pronto).
export function presignGet(key, expiresIn = 600) {
  assertEnabled();
  const cmd = new GetObjectCommand({ Bucket: env.R2_BUCKET, Key: key });
  return getSignedUrl(client, cmd, { expiresIn });
}

export function deleteObject(key) {
  assertEnabled();
  return client.send(new DeleteObjectCommand({ Bucket: env.R2_BUCKET, Key: key }));
}
