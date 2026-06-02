import { z } from 'zod';
import { q } from '../db.js';
import { canSeeBU } from '../lib/scope.js';

const WRITE = ['admin', 'gerente', 'finanzas'];

// Builder de rutas para los seguimientos secuenciales CxC y CxP.
// `table` debe ser 'cxc' o 'cxp' (whitelisted, no interpolar input del usuario).
export function seguimientoRoutes(table, closedStatus) {
  if (!['cxc', 'cxp'].includes(table)) throw new Error('tabla inválida');

  return async function (app) {
    app.addHook('preHandler', app.authenticate);

    app.get('/by-flete/:fleteId', async (req, reply) => {
      const { rows } = await q(`SELECT * FROM ${table} WHERE flete_id = $1`, [req.params.fleteId]);
      if (!rows[0]) return reply.code(404).send({ error: 'not_found' });
      if (!canSeeBU(req.user, rows[0].bu)) return reply.code(403).send({ error: 'bu_forbidden' });
      return rows[0];
    });

    // Actualiza el seguimiento: status calculado por el cliente + merge de data.
    const updSchema = z.object({ status: z.string().optional(), data: z.record(z.any()).optional() });
    app.put('/by-flete/:fleteId', { preHandler: [app.requireRole(...WRITE)] }, async (req, reply) => {
      const p = updSchema.safeParse(req.body);
      if (!p.success) return reply.code(400).send({ error: 'bad_request' });
      const cur = await q(`SELECT bu FROM ${table} WHERE flete_id = $1`, [req.params.fleteId]);
      if (!cur.rows[0]) return reply.code(404).send({ error: 'not_found' });
      if (!canSeeBU(req.user, cur.rows[0].bu)) return reply.code(403).send({ error: 'bu_forbidden' });
      const d = p.data;
      const { rows } = await q(
        `UPDATE ${table} SET status = COALESCE($2,status),
           data = data || COALESCE($3,'{}'::jsonb), updated_at = now()
         WHERE flete_id = $1 RETURNING *`,
        [req.params.fleteId, d.status ?? null, d.data ? JSON.stringify(d.data) : null],
      );
      return rows[0];
    });

    // Cierra el proceso (COBRADO / CERRADO).
    app.post('/cerrar/:fleteId', { preHandler: [app.requireRole(...WRITE)] }, async (req, reply) => {
      const cur = await q(`SELECT bu FROM ${table} WHERE flete_id = $1`, [req.params.fleteId]);
      if (!cur.rows[0]) return reply.code(404).send({ error: 'not_found' });
      if (!canSeeBU(req.user, cur.rows[0].bu)) return reply.code(403).send({ error: 'bu_forbidden' });
      const { rows } = await q(
        `UPDATE ${table} SET status = $2, updated_at = now() WHERE flete_id = $1 RETURNING *`,
        [req.params.fleteId, closedStatus],
      );
      return rows[0];
    });

    // Reset del seguimiento — solo admin.
    app.post('/reset/:fleteId', { preHandler: [app.requireRole('admin')] }, async (req, reply) => {
      const cur = await q(`SELECT bu FROM ${table} WHERE flete_id = $1`, [req.params.fleteId]);
      if (!cur.rows[0]) return reply.code(404).send({ error: 'not_found' });
      if (!canSeeBU(req.user, cur.rows[0].bu)) return reply.code(403).send({ error: 'bu_forbidden' });
      const initial = table === 'cxc' ? 'por-facturar' : 'pendiente-prog';
      const { rows } = await q(
        `UPDATE ${table} SET status = $2, data = '{}'::jsonb, updated_at = now() WHERE flete_id = $1 RETURNING *`,
        [req.params.fleteId, initial],
      );
      return rows[0];
    });
  };
}
