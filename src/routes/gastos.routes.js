import { z } from 'zod';
import { q } from '../db.js';
import { canSeeBU, visibleBUs } from '../lib/scope.js';

const WRITE = ['admin', 'gerente', 'operaciones'];

async function fleteBU(fleteId) {
  const { rows } = await q('SELECT bu, mon_finalizado FROM fletes WHERE id = $1', [fleteId]);
  return rows[0] || null;
}

export default async function gastosRoutes(app) {
  app.addHook('preHandler', app.authenticate);

  // LISTA en bloque (BU-scoped). Sustituye el N+1 que Pago de Proveedores hacía
  // pidiendo gastos by-flete por cada flete: ahora trae todos los gastos visibles
  // en UNA request y el front los suma por flete en memoria.
  app.get('/', async (req) => {
    const { rows } = await q(
      `SELECT g.* FROM gastos_extra g
         JOIN fletes f ON f.id = g.flete_id
        WHERE f.bu = ANY($1)
        ORDER BY g.fecha`,
      [visibleBUs(req.user)],
    );
    return rows;
  });

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

  app.post('/', { preHandler: [app.requirePerm('gastos', 'edit')] }, async (req, reply) => {
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

  app.delete('/:id', { preHandler: [app.requireAdmin()] }, async (req, reply) => {
    const { rows } = await q(
      'SELECT g.id, f.bu FROM gastos_extra g JOIN fletes f ON f.id = g.flete_id WHERE g.id = $1',
      [req.params.id],
    );
    if (!rows[0]) return reply.code(404).send({ error: 'not_found' });
    if (!canSeeBU(req.user, rows[0].bu)) return reply.code(403).send({ error: 'bu_forbidden' });
    await q('DELETE FROM gastos_extra WHERE id = $1', [req.params.id]);
    return { ok: true };
  });

  // Liberar finanzas: requiere monitoreo finalizado. Desbloquea CxC/CxP.
  // No se exige capturar gastos extra: liberar sin gastos significa que el
  // servicio no tuvo gastos extra y se libera sin cobro/pago.
  app.post('/liberar/:fleteId', { preHandler: [app.requirePerm('gastos', 'edit')] }, async (req, reply) => {
    const f = await fleteBU(req.params.fleteId);
    if (!f) return reply.code(404).send({ error: 'not_found' });
    if (!canSeeBU(req.user, f.bu)) return reply.code(403).send({ error: 'bu_forbidden' });
    if (!f.mon_finalizado) return reply.code(409).send({ error: 'monitoreo_no_finalizado' });
    const { rows } = await q('UPDATE fletes SET gastos_liberado = true, updated_at = now() WHERE id = $1 RETURNING *', [req.params.fleteId]);
    return rows[0];
  });
}
