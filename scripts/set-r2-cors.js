// Configura la política CORS del bucket de objetos (Tigris/R2/S3) para que el
// navegador pueda hacer el PUT directo de la subida firmada y el GET de
// descarga. Sin esto el PUT del cliente falla con `TypeError: Failed to fetch`
// (el preflight OPTIONS regresa 200 pero sin cabeceras Access-Control-Allow-*).
//
// La autorización real de cada operación la da la URL firmada (presigned), no
// el origen — por eso el default de orígenes es `*`. Si quieres restringirlo,
// pasa CORS_ALLOWED_ORIGINS con una lista separada por comas.
//
// Uso (las credenciales R2_* viven en Railway, no en local):
//   railway run --service <api-dev>  node scripts/set-r2-cors.js
//   railway run --service <api-prod> node scripts/set-r2-cors.js
//
// O localmente exportando R2_ENDPOINT/R2_KEY/R2_SECRET/R2_BUCKET a mano.
import { S3Client, PutBucketCorsCommand, GetBucketCorsCommand } from '@aws-sdk/client-s3';
import { env, r2Enabled } from '../src/env.js';

if (!r2Enabled) {
  console.error('R2 no configurado: faltan R2_ENDPOINT/R2_KEY/R2_SECRET/R2_BUCKET en el entorno.');
  process.exit(1);
}

const origins = (process.env.CORS_ALLOWED_ORIGINS || '*')
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean);

const client = new S3Client({
  region: 'auto',
  endpoint: env.R2_ENDPOINT,
  credentials: { accessKeyId: env.R2_KEY, secretAccessKey: env.R2_SECRET },
});

const corsConfig = {
  CORSRules: [
    {
      AllowedOrigins: origins,
      AllowedMethods: ['GET', 'PUT', 'HEAD'],
      AllowedHeaders: ['*'],
      ExposeHeaders: ['ETag'],
      MaxAgeSeconds: 3600,
    },
  ],
};

async function main() {
  console.log(`Bucket:  ${env.R2_BUCKET}`);
  console.log(`Endpoint: ${env.R2_ENDPOINT}`);
  console.log(`Orígenes: ${origins.join(', ')}`);

  await client.send(new PutBucketCorsCommand({ Bucket: env.R2_BUCKET, CORSConfiguration: corsConfig }));
  console.log('✓ Política CORS aplicada.');

  const current = await client.send(new GetBucketCorsCommand({ Bucket: env.R2_BUCKET }));
  console.log('CORS actual:', JSON.stringify(current.CORSRules, null, 2));
}

main().catch((err) => {
  console.error('✗ No se pudo configurar CORS:', err?.message || err);
  process.exit(1);
});
