import { z } from 'zod';
import { q } from '../db.js';
import { canSeeBU } from '../lib/scope.js';

const WRITE = ['admin', 'gerente', 'operaciones'];

async function fleteBU(fleteId) {
  const { rows } = await q('SELECT bu, mon_finalizado FROM fletes WHERE id = $1', [fleteId]);
  return rows[0] || null;
}

export default async function gastosRoutes(app) {
  app.addHook('preHandler', app.authenticate);

  app.get('/by-flete/:fleteId', async (req, reply) => {
    const f = await fleteBU(req.params.fleteId);
    if (!f) return reply.code(404).send({ error: 'not_found' });
    if (!canSeeBU(req.user, f.bu)) return reply.code(403).send({ error: 'bu_forbidden' });
    const { rows } = await q('SELECT * FROM gastos_extra WHERE flete_id = $1 ORDER BY fecha', [req.params.fleteId]);
    return rows;
  });

  const createSchema = z.object({
    flete_id: z.string().uuid(),
    tipo: z.string().optional(),
    descripcion: z.string().optional(),
    cobro: z.number().optional(),
    pago: z.number().optional(),
    fecha: z.string().optional(),
  });

  app.post('/', { preHandler: [app.requireRole(...WRITE)] }, async (req, reply) => {
    const p = createSchema.safeParse(req.body);
    if (!p.success) return reply.code(400).send({ error: 'bad_request' });
    const f = await fleteBU(p.data.flete_id);
    if (!f) return reply.code(404).send({ error: 'flete_not_found' });
    if (!canSeeBU(req.user, f.bu)) return reply.code(403).send({ error: 'bu_forbidden' });
    const d = p.data;
    const { rows } = await q(
      `INSERT INTO gastos_extra (flete_id, tipo, descripcion, cobro, pago, fecha)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [d.flete_id, d.tipo ?? null, d.descripcion ?? null, d.cobro ?? null, d.pago ?? null, d.fecha ?? null],
    );
    return rows[0];
  });

  app.delete('/:id', { preHandler: [app.requireRole(...WRITE)] }, async (req, reply) => {
    const { rows } = await q(
      'SELECT g.id, f.bu FROM gastos_extra g JOIN fletes f ON f.id = g.flete_id WHERE g.id = $1',
      [req.params.id],
    );
    if (!rows[0]) return reply.code(404).send({ error: 'not_found' });
    if (!canSeeBU(req.user, rows[0].bu)) return reply.code(403).send({ error: 'bu_forbidden' });
    await q('DELETE FROM gastos_extra WHERE id = $1', [req.params.id]);
    return { ok: true };
  });

  // Liberar finanzas: requiere monitoreo finalizado y >=1 gasto. Desbloquea CxC/CxP.
  app.post('/liberar/:fleteId', { preHandler: [app.requireRole(...WRITE)] }, async (req, reply) => {
    const f = await fleteBU(req.params.fleteId);
    if (!f) return reply.code(404).send({ error: 'not_found' });
    if (!canSeeBU(req.user, f.bu)) return reply.code(403).send({ error: 'bu_forbidden' });
    if (!f.mon_finalizado) return reply.code(409).send({ error: 'monitoreo_no_finalizado' });
    const { rows: g } = await q('SELECT count(*)::int AS n FROM gastos_extra WHERE flete_id = $1', [req.params.fleteId]);
    if (g[0].n < 1) return reply.code(409).send({ error: 'sin_gastos' });
    const { rows } = await q('UPDATE fletes SET gastos_liberado = true, updated_at = now() WHERE id = $1 RETURNING *', [req.params.fleteId]);
    return rows[0];
  });
}
