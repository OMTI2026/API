import './instrument.js'; // DEBE ser el primer import (inicializa Sentry antes que Fastify)
import * as Sentry from '@sentry/node';
import { sentryEnabled, sentryRelease } from './instrument.js';

import Fastify from 'fastify';
import cors from '@fastify/cors';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';

import { env } from './env.js';
import authPlugin from './plugins/auth.js';
import rbacPlugin from './plugins/rbac.js';
import healthRoutes from './routes/health.routes.js';
import authRoutes from './routes/auth.routes.js';
import uploadRoutes from './routes/upload.routes.js';
import clientsRoutes from './routes/clients.routes.js';
import carriersRoutes from './routes/carriers.routes.js';
import fletesRoutes from './routes/fletes.routes.js';
import gastosRoutes from './routes/gastos.routes.js';
import cxcRoutes from './routes/cxc.routes.js';
import cxpRoutes from './routes/cxp.routes.js';
import usuariosRoutes from './routes/usuarios.routes.js';
import statsRoutes from './routes/stats.routes.js';
import sysconfigRoutes from './routes/sysconfig.routes.js';
import empleadosRoutes from './routes/empleados.routes.js';
import areasRoutes from './routes/areas.routes.js';
import puestosRoutes from './routes/puestos.routes.js';
import eventosRoutes from './routes/eventos.routes.js';
import vacacionesRoutes from './routes/vacaciones.routes.js';
import documentosRoutes from './routes/documentos.routes.js';
import mantenimientosRoutes from './routes/mantenimientos.routes.js';
import gastosOperativosRoutes from './routes/gastos-operativos.routes.js';
import cotizacionesRoutes from './routes/cotizaciones.routes.js';

export async function build() {
  const app = Fastify({
    logger: { level: env.NODE_ENV === 'production' ? 'info' : 'debug' },
    trustProxy: true, // detrás del proxy de Railway
  });

  await app.register(cors, {
    origin: env.CORS_ORIGIN === '*' ? true : env.CORS_ORIGIN.split(',').map((s) => s.trim()),
    credentials: true,
  });
  await app.register(cookie);
  await app.register(rateLimit, { max: 100, timeWindow: '1 minute' });

  // Captura de errores no manejados de rutas -> Sentry (no-op si no hay DSN).
  if (sentryEnabled) {
    Sentry.setupFastifyErrorHandler(app);
    app.log.info('Sentry activo (' + env.NODE_ENV + ', release: ' + (sentryRelease || 'sin release') + ')');
  }

  await app.register(authPlugin);
  await app.register(rbacPlugin);

  await app.register(healthRoutes);
  await app.register(authRoutes, { prefix: '/auth' });
  await app.register(uploadRoutes, { prefix: '/upload' });
  await app.register(clientsRoutes, { prefix: '/clients' });
  await app.register(carriersRoutes, { prefix: '/carriers' });
  await app.register(fletesRoutes, { prefix: '/fletes' });
  await app.register(gastosRoutes, { prefix: '/gastos' });
  await app.register(cxcRoutes, { prefix: '/cxc' });
  await app.register(cxpRoutes, { prefix: '/cxp' });
  await app.register(usuariosRoutes, { prefix: '/usuarios' });
  await app.register(statsRoutes, { prefix: '/stats' });
  await app.register(sysconfigRoutes, { prefix: '/sysconfig' });
  await app.register(empleadosRoutes, { prefix: '/empleados' });
  await app.register(areasRoutes, { prefix: '/areas' });
  await app.register(puestosRoutes, { prefix: '/puestos' });
  await app.register(eventosRoutes, { prefix: '/eventos' });
  await app.register(vacacionesRoutes, { prefix: '/vacaciones' });
  await app.register(documentosRoutes, { prefix: '/documentos' });
  await app.register(mantenimientosRoutes, { prefix: '/mantenimientos' });
  await app.register(gastosOperativosRoutes, { prefix: '/gastos-operativos' });
  await app.register(cotizacionesRoutes, { prefix: '/cotizaciones' });

  return app;
}

// Arranque directo (no en tests).
if (import.meta.url === `file://${process.argv[1]}`) {
  const app = await build();
  try {
    await app.listen({ port: env.PORT, host: '::' });
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}
