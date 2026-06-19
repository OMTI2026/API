import { z } from 'zod';
import { q } from '../db.js';
import { visibleBUs, canSeeBU } from '../lib/scope.js';

// Pagos del programa semanal de casetas a IAVE (Flota Propia). Marcar una semana
// como pagada = UPSERT por (bu, semana); deshacer = DELETE. Reutiliza el permiso
// de módulo `combustible` (misma audiencia de Flota / costos por unidad).

const buEnum = z.enum(['broker', 'flota', 'ambos']);

const createSchema = z.object({
  bu: buEnum,
  semana: z.string().min(1),
  monto: z.number().optional().nullable(),
  fecha_pago: z.string().optional().nullable(),
  pagado_at: z.string().optional().nullable(),
  nota: z.string().optional().nullable(),
});

export default async function casetasPagosRoutes(app) {
  app.addHook('preHandler', app.authenticate);

  app.get('/', async (req) => {
    const { rows } = await q(
      'SELECT * FROM casetas_pagos WHERE bu = ANY($1) ORDER BY semana',
      [visibleBUs(req.user)],
    );
    return rows;
  });

  // Marca una semana como pagada (idempotente por bu+semana).
  app.post('/', { preHandler: [app.requirePerm('combustible', 'edit')] }, async (req, reply) => {
    const p = createSchema.safeParse(req.body);
    if (!p.success) return reply.code(400).send({ error: 'bad_request', detail: p.error.flatten() });
    if (!canSeeBU(req.user, p.data.bu)) return reply.code(403).send({ error: 'bu_forbidden' });
    const d = p.data;
    const { rows } = await q(
      `INSERT INTO casetas_pagos (bu, semana, monto, fecha_pago, pagado_at, nota)
       VALUES ($1,$2,$3,$4,COALESCE($5, (now() AT TIME ZONE 'America/Mexico_City')::date),$6)
       ON CONFLICT (bu, semana) DO UPDATE SET
         monto = EXCLUDED.monto,
         fecha_pago = EXCLUDED.fecha_pago,
         pagado_at = EXCLUDED.pagado_at,
         nota = EXCLUDED.nota,
         updated_at = now()
       RETURNING *`,
      [d.bu, d.semana, d.monto ?? null, d.fecha_pago ?? null, d.pagado_at ?? null, d.nota ?? null],
    );
    return rows[0];
  });

  // Deshacer (desmarcar pagado) por id.
  app.delete('/:id', { preHandler: [app.requirePerm('combustible', 'edit')] }, async (req, reply) => {
    const cur = await q('SELECT bu FROM casetas_pagos WHERE id = $1', [req.params.id]);
    if (!cur.rows[0]) return reply.code(404).send({ error: 'not_found' });
    if (!canSeeBU(req.user, cur.rows[0].bu)) return reply.code(403).send({ error: 'bu_forbidden' });
    await q('DELETE FROM casetas_pagos WHERE id = $1', [req.params.id]);
    return { ok: true };
  });
}
