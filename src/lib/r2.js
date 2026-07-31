import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  GetBucketCorsCommand,
  PutBucketCorsCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { env, r2Enabled } from '../env.js';

// Reglas CORS requeridas para que el navegador pueda subir (PUT) y descargar
// (GET) directo al bucket con la URL firmada. Es la MISMA config que aplica
// scripts/set-r2-cors.js; se mantiene aquí para auto-repararla al arrancar.
// La autorización real la da la URL firmada, por eso los orígenes son `*` por
// defecto (override con CORS_ALLOWED_ORIGINS separado por comas).
const CORS_ORIGINS = (process.env.CORS_ALLOWED_ORIGINS || '*')
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean);
const CORS_RULE = {
  AllowedOrigins: CORS_ORIGINS,
  AllowedMethods: ['GET', 'PUT', 'HEAD'],
  AllowedHeaders: ['*'],
  ExposeHeaders: ['ETag'],
  MaxAgeSeconds: 3600,
};

export const ALLOWED_MIME = new Set([
  'application/pdf',
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/heic',
  // XML de la Carta Porte (CFDI). Los navegadores reportan text/xml o application/xml.
  'application/xml',
  'text/xml',
]);

export const MAX_BYTES = 15 * 1024 * 1024; // 15 MB

let client = null;
if (r2Enabled) {
  client = new S3Client({
    region: 'auto',
    endpoint: env.R2_ENDPOINT,
    // Path-style (t3.storageapi.dev/<bucket>/<key>) en vez del virtual-hosted
    // por defecto (<bucket>.t3.storageapi.dev): el subdominio virtual-hosted de
    // Tigris NO devuelve cabeceras CORS en el preflight, así que el PUT directo
    // del navegador al bucket se bloquea. Path-style sí responde CORS.
    forcePathStyle: true,
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

// ¿La config CORS actual permite el PUT directo del navegador? (existe al menos
// una regla que incluye el método PUT).
function corsAllowsPut(rules) {
  return Array.isArray(rules) && rules.some((r) => (r.AllowedMethods || []).includes('PUT'));
}

// Auto-reparación de la CORS del bucket. Tigris ha perdido la config CORS al
// menos una vez, lo que bloquea TODAS las subidas del navegador (preflight sin
// cabeceras Access-Control-Allow-*). Al arrancar el API verificamos y, si falta
// o no permite PUT, la re-aplicamos. Devuelve el resultado para que el llamador
// lo registre/avise (no lanza: nunca debe tumbar el arranque del servidor).
//   → { status: 'ok' | 'healed' | 'error' | 'skip', detail? }
export async function ensureBucketCors() {
  if (!client) return { status: 'skip', detail: 'R2 no configurado' };
  let rules;
  try {
    const res = await client.send(new GetBucketCorsCommand({ Bucket: env.R2_BUCKET }));
    rules = res.CORSRules;
  } catch (err) {
    // Algunos back-ends S3 lanzan NoSuchCORSConfiguration en vez de devolver
    // vacío; se trata como "falta config" y se intenta aplicar.
    const code = err?.name || err?.Code;
    if (code && !/NoSuchCORSConfiguration/i.test(code)) {
      return { status: 'error', detail: `GetBucketCors falló: ${err?.message || code}` };
    }
    rules = undefined;
  }

  if (corsAllowsPut(rules)) return { status: 'ok' };

  try {
    await client.send(
      new PutBucketCorsCommand({
        Bucket: env.R2_BUCKET,
        CORSConfiguration: { CORSRules: [CORS_RULE] },
      }),
    );
    return {
      status: 'healed',
      detail: `CORS del bucket ${env.R2_BUCKET} estaba ausente/incompleta; re-aplicada (orígenes: ${CORS_ORIGINS.join(', ')}).`,
    };
  } catch (err) {
    return { status: 'error', detail: `PutBucketCors falló: ${err?.message || err}` };
  }
}
