import { q } from '../db.js';
import { r2Enabled } from '../env.js';

export default async function healthRoutes(app) {
  app.get('/health', async () => ({ ok: true, ts: new Date().toISOString() }));

  app.get('/health/db', async (req, reply) => {
    try {
      const r = await q('SELECT 1 AS up');
      return { db: r.rows[0].up === 1, r2: r2Enabled };
    } catch (err) {
      req.log.error(err);
      return reply.code(503).send({ db: false, error: 'db_unreachable' });
    }
  });
}
