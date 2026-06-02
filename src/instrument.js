// Inicializa Sentry ANTES de importar Fastify (requisito de la auto-instrumentacion v8+).
// Por eso server.js importa este archivo en su PRIMERA linea.
//
// Si no hay SENTRY_DSN configurado, Sentry queda inactivo (no-op): el API corre
// igual en local/dev sin necesidad de una cuenta de Sentry.
import 'dotenv/config';
import * as Sentry from '@sentry/node';

export const sentryEnabled = Boolean(process.env.SENTRY_DSN);

// Release para Release Health: cada deploy = un release unico.
// Railway inyecta RAILWAY_GIT_COMMIT_SHA al desplegar desde GitHub; permitimos
// override manual con SENTRY_RELEASE. Sin ninguno (ej. local), queda sin release.
export const sentryRelease =
  process.env.SENTRY_RELEASE || process.env.RAILWAY_GIT_COMMIT_SHA || undefined;

if (sentryEnabled) {
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    environment: process.env.NODE_ENV || 'development',
    // Atribuye sesiones/errores a una version (Release Health). El tracking de
    // sesiones request-mode ya viene activo por defecto en @sentry/node v8+.
    release: sentryRelease,
    // Trazas de performance: 0 por defecto (solo errores). Subir en prod si se desea.
    tracesSampleRate: Number(process.env.SENTRY_TRACES_SAMPLE_RATE) || 0,
    // No mandar PII (correos, IPs, cuerpos) salvo que se active explicitamente.
    sendDefaultPii: false,
  });
}
