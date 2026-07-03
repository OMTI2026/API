import { env } from '../env.js';
import { checkFlotaAlerts } from '../lib/flota-alerts.js';

// Rutas de tareas programadas. NO usan autenticación de usuario: se protegen con
// un token compartido (CRON_SECRET) que sólo conoce el disparador (Railway cron).
export default async function cronRoutes(app) {
  // Genera los avisos proactivos de flota (vencimientos + pagos vencidos) hacia
  // los usuarios con la capacidad `recibe_alertas_flota`. Idempotente.
  app.get('/check-alerts', async (req, reply) => {
    const bearer = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    const token = req.query.token || bearer;
    if (!env.CRON_SECRET || token !== env.CRON_SECRET) {
      return reply.code(401).send({ error: 'unauthorized' });
    }
    const creadas = await checkFlotaAlerts();
    req.log.info({ creadas }, 'cron check-alerts');
    return { ok: true, creadas };
  });
}
