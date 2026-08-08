import { env } from '../env.js';
import { checkFlotaAlerts } from '../lib/flota-alerts.js';
import { crmDigest } from '../lib/crm-digest.js';

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
    // Resumen diario del CRM al dueño/admins (idempotente por día). Best-effort:
    // un fallo aquí no debe tumbar los avisos de flota.
    let crmResumen = 0;
    try {
      crmResumen = await crmDigest();
    } catch (err) {
      req.log.error(err, 'cron crm-digest fallo');
    }
    req.log.info({ creadas, crmResumen }, 'cron check-alerts');
    return { ok: true, creadas, crmResumen };
  });
}
