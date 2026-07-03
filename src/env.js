import 'dotenv/config';
import { z } from 'zod';

const schema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().default(3000),

  // Railway expone DATABASE_PRIVATE_URL en deploy; preferirla si existe.
  DATABASE_URL: z.string().min(1),
  DATABASE_PRIVATE_URL: z.string().optional(),

  JWT_ACCESS_SECRET: z.string().min(32, 'JWT_ACCESS_SECRET debe tener >=32 chars'),
  JWT_REFRESH_SECRET: z.string().min(32, 'JWT_REFRESH_SECRET debe tener >=32 chars'),
  ACCESS_TTL: z.string().default('15m'),
  REFRESH_TTL_DAYS: z.coerce.number().default(7),

  CORS_ORIGIN: z.string().default('*'),

  R2_ENDPOINT: z.string().optional(),
  R2_KEY: z.string().optional(),
  R2_SECRET: z.string().optional(),
  R2_BUCKET: z.string().optional(),

  // Sentry (opcional). Sin DSN, el monitoreo queda inactivo (ver src/instrument.js).
  SENTRY_DSN: z.string().optional(),
  SENTRY_TRACES_SAMPLE_RATE: z.coerce.number().min(0).max(1).default(0),

  // Token del endpoint /cron/check-alerts (avisos proactivos de flota). Sin él,
  // el endpoint responde 401 y no genera avisos. Lo dispara Railway cron.
  CRON_SECRET: z.string().optional(),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  console.error('❌ Variables de entorno inválidas:');
  console.error(parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const env = parsed.data;

// En deploy de Railway, la URL interna evita egress y es más rápida.
export const databaseUrl =
  env.NODE_ENV === 'production' && env.DATABASE_PRIVATE_URL
    ? env.DATABASE_PRIVATE_URL
    : env.DATABASE_URL;

export const r2Enabled = Boolean(env.R2_ENDPOINT && env.R2_KEY && env.R2_SECRET && env.R2_BUCKET);
