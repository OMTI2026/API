import { z } from 'zod';
import { q } from '../db.js';
import { visibleBUs, canSeeBU } from '../lib/scope.js';

const WRITE = ['admin', 'gerente', 'operaciones'];
const buEnum = z.enum(['broker', 'flota', 'ambos']);

const createSchema = z.object({
  bu: buEnum,
  empresa: z.string().min(1),
  rfc: z.string().optional(),
  contacto: z.string().optional(),
  credito: z.number().optional(),
  dias_pago: z.number().int().optional(),
  data: z.record(z.any()).optional(),
});

export default async function clientsRoutes(app) {
  app.addHook('preHandler', app.authenticate);

  app.get('/', async (req) => {
    const { rows } = await q(
      'SELECT * FROM clients WHERE bu = ANY($1) ORDER BY empresa',
      [visibleBUs(req.user)],
    );
    return rows;
  });

  app.post('/', { preHandler: [app.requireRole(...WRITE)] }, async (req, reply) => {
    const p = createSchema.safeParse(req.body);
    if (!p.success) return reply.code(400).send({ error: 'bad_request', detail: p.error.flatten() });
    if (!canSeeBU(req.user, p.data.bu)) return reply.code(403).send({ error: 'bu_forbidden' });
    const d = p.data;
    const { rows } = await q(
      `INSERT INTO clients (bu, empresa, rfc, contacto, credito, dias_pago, data)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [d.bu, d.empresa, d.rfc ?? null, d.contacto ?? null, d.credito ?? null, d.dias_pago ?? null, d.data ?? {}],
    );
    return rows[0];
  });

  app.put('/:id', { preHandler: [app.requireRole(...WRITE)] }, async (req, reply) => {
    const p = createSchema.partial().safeParse(req.body);
    if (!p.success) return reply.code(400).send({ error: 'bad_request' });
    const cur = await q('SELECT bu FROM clients WHERE id = $1', [req.params.id]);
    if (!cur.rows[0]) return reply.code(404).send({ error: 'not_found' });
    if (!canSeeBU(req.user, cur.rows[0].bu)) return reply.code(403).send({ error: 'bu_forbidden' });
    const d = p.data;
    const { rows } = await q(
      `UPDATE clients SET empresa = COALESCE($2,empresa), rfc = COALESCE($3,rfc),
        contacto = COALESCE($4,contacto), credito = COALESCE($5,credito),
        dias_pago = COALESCE($6,dias_pago), data = COALESCE($7,data)
       WHERE id = $1 RETURNING *`,
      [req.params.id, d.empresa ?? null, d.rfc ?? null, d.contacto ?? null, d.credito ?? null, d.dias_pago ?? null, d.data ?? null],
    );
    return rows[0];
  });

  app.delete('/:id', { preHandler: [app.requireRole('admin', 'gerente')] }, async (req, reply) => {
    const cur = await q('SELECT bu FROM clients WHERE id = $1', [req.params.id]);
    if (!cur.rows[0]) return reply.code(404).send({ error: 'not_found' });
    if (!canSeeBU(req.user, cur.rows[0].bu)) return reply.code(403).send({ error: 'bu_forbidden' });
    await q('DELETE FROM clients WHERE id = $1', [req.params.id]);
    return { ok: true };
  });
}
