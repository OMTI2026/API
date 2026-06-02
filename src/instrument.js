// Inicializa Sentry ANTES de importar Fastify (requisito de la auto-instrumentacion v8+).
// Por eso server.js importa este archivo en su PRIMERA linea.
//
// Si no hay SENTRY_DSN configurado, Sentry queda inactivo (no-op): el API corre
// igual en local/dev sin necesidad de una cuenta de Sentry.
import 'dotenv/config';
import * as Sentry from '@sentry/node';

export const sentryEnabled = Boolean(process.env.SENTRY_DSN);

if (sentryEnabled) {
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    environment: process.env.NODE_ENV || 'development',
    // Trazas de performance: 0 por defecto (solo errores). Subir en prod si se desea.
    tracesSampleRate: Number(process.env.SENTRY_TRACES_SAMPLE_RATE) || 0,
    // No mandar PII (correos, IPs, cuerpos) salvo que se active explicitamente.
    sendDefaultPii: false,
  });
}
