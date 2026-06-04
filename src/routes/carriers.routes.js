import { z } from 'zod';
import { q } from '../db.js';
import { visibleBUs, canSeeBU } from '../lib/scope.js';

const WRITE = ['admin', 'gerente', 'operaciones'];
const buEnum = z.enum(['broker', 'flota', 'ambos']);

const createSchema = z.object({
  bu: buEnum,
  nombre: z.string().min(1),
  rfc: z.string().optional(),
  contacto: z.string().optional(),
  credito: z.number().optional(),
  tiene_gps: z.boolean().optional(),
  data: z.record(z.any()).optional(),
});

export default async function carriersRoutes(app) {
  app.addHook('preHandler', app.authenticate);

  app.get('/', async (req) => {
    const { rows } = await q(
      'SELECT * FROM carriers WHERE bu = ANY($1) ORDER BY nombre',
      [visibleBUs(req.user)],
    );
    return rows;
  });

  app.post('/', { preHandler: [app.requirePerm('transportistas', 'edit')] }, async (req, reply) => {
    const p = createSchema.safeParse(req.body);
    if (!p.success) return reply.code(400).send({ error: 'bad_request', detail: p.error.flatten() });
    if (!canSeeBU(req.user, p.data.bu)) return reply.code(403).send({ error: 'bu_forbidden' });
    const d = p.data;
    const { rows } = await q(
      `INSERT INTO carriers (bu, nombre, rfc, contacto, credito, tiene_gps, data)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [d.bu, d.nombre, d.rfc ?? null, d.contacto ?? null, d.credito ?? null, d.tiene_gps ?? false, d.data ?? {}],
    );
    return rows[0];
  });

  app.put('/:id', { preHandler: [app.requireAdmin()] }, async (req, reply) => {
    const p = createSchema.partial().safeParse(req.body);
    if (!p.success) return reply.code(400).send({ error: 'bad_request' });
    const cur = await q('SELECT bu FROM carriers WHERE id = $1', [req.params.id]);
    if (!cur.rows[0]) return reply.code(404).send({ error: 'not_found' });
    if (!canSeeBU(req.user, cur.rows[0].bu)) return reply.code(403).send({ error: 'bu_forbidden' });
    const d = p.data;
    const { rows } = await q(
      `UPDATE carriers SET nombre = COALESCE($2,nombre), rfc = COALESCE($3,rfc),
        contacto = COALESCE($4,contacto), credito = COALESCE($5,credito),
        tiene_gps = COALESCE($6,tiene_gps), data = COALESCE($7,data)
       WHERE id = $1 RETURNING *`,
      [req.params.id, d.nombre ?? null, d.rfc ?? null, d.contacto ?? null, d.credito ?? null, d.tiene_gps ?? null, d.data ?? null],
    );
    return rows[0];
  });

  app.delete('/:id', { preHandler: [app.requireAdmin()] }, async (req, reply) => {
    const cur = await q('SELECT bu FROM carriers WHERE id = $1', [req.params.id]);
    if (!cur.rows[0]) return reply.code(404).send({ error: 'not_found' });
    if (!canSeeBU(req.user, cur.rows[0].bu)) return reply.code(403).send({ error: 'bu_forbidden' });
    await q('DELETE FROM carriers WHERE id = $1', [req.params.id]);
    return { ok: true };
  });
}
