import { z } from 'zod';
import { q } from '../db.js';
import { visibleBUs, canSeeBU } from '../lib/scope.js';

// Registros de mantenimiento de flota. Cada fila es un checklist diligenciado
// para una unidad. Sigue el patrón de documentos.routes.js / carriers.routes.js.

const buEnum = z.enum(['broker', 'flota', 'ambos']);

const createSchema = z.object({
  bu: buEnum,
  checklist_id: z.string().min(1),
  referencia: z.string().min(1),
  data: z.record(z.any()).optional(),
});

export default async function mantenimientosRoutes(app) {
  app.addHook('preHandler', app.authenticate);

  // Lista por BU visible. Filtros opcionales: checklist_id, q (referencia).
  app.get('/', async (req) => {
    const params = [visibleBUs(req.user)];
    let sql = 'SELECT * FROM mantenimientos WHERE bu = ANY($1)';
    const { checklist_id, q: term } = req.query || {};
    if (checklist_id) { params.push(checklist_id); sql += ` AND checklist_id = $${params.length}`; }
    if (term) { params.push(`%${String(term).toLowerCase()}%`); sql += ` AND lower(referencia) LIKE $${params.length}`; }
    sql += ' ORDER BY created_at DESC';
    const { rows } = await q(sql, params);
    return rows;
  });

  app.post('/', { preHandler: [app.requirePerm('mantenimiento', 'edit')] }, async (req, reply) => {
    const p = createSchema.safeParse(req.body);
    if (!p.success) return reply.code(400).send({ error: 'bad_request', detail: p.error.flatten() });
    if (!canSeeBU(req.user, p.data.bu)) return reply.code(403).send({ error: 'bu_forbidden' });
    const d = p.data;
    const { rows } = await q(
      `INSERT INTO mantenimientos (bu, checklist_id, referencia, data)
       VALUES ($1,$2,$3,$4) RETURNING *`,
      [d.bu, d.checklist_id, d.referencia, d.data ?? {}],
    );
    return rows[0];
  });

  app.put('/:id', { preHandler: [app.requirePerm('mantenimiento', 'edit')] }, async (req, reply) => {
    const p = createSchema.partial().safeParse(req.body);
    if (!p.success) return reply.code(400).send({ error: 'bad_request', detail: p.error.flatten() });
    const cur = await q('SELECT bu FROM mantenimientos WHERE id = $1', [req.params.id]);
    if (!cur.rows[0]) return reply.code(404).send({ error: 'not_found' });
    if (!canSeeBU(req.user, cur.rows[0].bu)) return reply.code(403).send({ error: 'bu_forbidden' });
    const d = p.data;
    const { rows } = await q(
      `UPDATE mantenimientos SET
         checklist_id = COALESCE($2, checklist_id),
         referencia   = COALESCE($3, referencia),
         data         = COALESCE($4, data),
         updated_at   = now()
       WHERE id = $1 RETURNING *`,
      [req.params.id, d.checklist_id ?? null, d.referencia ?? null, d.data ?? null],
    );
    return rows[0];
  });

  app.delete('/:id', { preHandler: [app.requireAdmin()] }, async (req, reply) => {
    const cur = await q('SELECT bu FROM mantenimientos WHERE id = $1', [req.params.id]);
    if (!cur.rows[0]) return reply.code(404).send({ error: 'not_found' });
    if (!canSeeBU(req.user, cur.rows[0].bu)) return reply.code(403).send({ error: 'bu_forbidden' });
    await q('DELETE FROM mantenimientos WHERE id = $1', [req.params.id]);
    return { ok: true };
  });
}
