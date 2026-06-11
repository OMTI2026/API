import { z } from 'zod';
import { q } from '../db.js';
import { visibleBUs, canSeeBU } from '../lib/scope.js';

// Cotizaciones (solo Flota Propia). CRUD scopeado por BU, calcado de
// gastos-operativos/mantenimientos. El cliente es opcional. Insumos y desglose
// calculado viven en `data`; `precio` (sugerido) y `estado` son de primer nivel
// para listar/ordenar. Permiso: módulo 'fletes' (es cotización de servicios).

const buEnum = z.enum(['broker', 'flota', 'ambos']);

const baseSchema = z.object({
  bu: buEnum,
  cliente_id: z.string().uuid().nullable().optional(),
  origen: z.string().optional(),
  destino: z.string().optional(),
  precio: z.number().optional(),
  estado: z.enum(['borrador', 'enviada', 'aprobada', 'rechazada']).optional(),
  data: z.record(z.any()).optional(),
});

async function assertClienteVisible(user, clienteId, reply) {
  if (!clienteId) return true;
  const { rows } = await q('SELECT bu FROM clients WHERE id = $1', [clienteId]);
  if (!rows[0]) {
    reply.code(404).send({ error: 'cliente_not_found' });
    return false;
  }
  if (!canSeeBU(user, rows[0].bu)) {
    reply.code(403).send({ error: 'bu_forbidden' });
    return false;
  }
  return true;
}

export default async function cotizacionesRoutes(app) {
  app.addHook('preHandler', app.authenticate);

  // Lista por BU visible. Filtro opcional: estado.
  app.get('/', async (req) => {
    const params = [visibleBUs(req.user)];
    let sql = 'SELECT * FROM cotizaciones WHERE bu = ANY($1)';
    const { estado } = req.query || {};
    if (estado) {
      params.push(estado);
      sql += ` AND estado = $${params.length}`;
    }
    sql += ' ORDER BY created_at DESC';
    const { rows } = await q(sql, params);
    return rows;
  });

  app.post('/', { preHandler: [app.requirePerm('fletes', 'edit')] }, async (req, reply) => {
    const p = baseSchema.safeParse(req.body);
    if (!p.success) return reply.code(400).send({ error: 'bad_request', detail: p.error.flatten() });
    if (!canSeeBU(req.user, p.data.bu)) return reply.code(403).send({ error: 'bu_forbidden' });
    const d = p.data;
    if (!(await assertClienteVisible(req.user, d.cliente_id, reply))) return reply;
    const { rows } = await q(
      `INSERT INTO cotizaciones (bu, cliente_id, origen, destino, precio, estado, data)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [
        d.bu,
        d.cliente_id ?? null,
        d.origen ?? null,
        d.destino ?? null,
        d.precio ?? null,
        d.estado ?? 'borrador',
        d.data ?? {},
      ],
    );
    return rows[0];
  });

  app.put('/:id', { preHandler: [app.requirePerm('fletes', 'edit')] }, async (req, reply) => {
    const p = baseSchema.partial().safeParse(req.body);
    if (!p.success) return reply.code(400).send({ error: 'bad_request', detail: p.error.flatten() });
    const cur = await q('SELECT bu, cliente_id FROM cotizaciones WHERE id = $1', [req.params.id]);
    if (!cur.rows[0]) return reply.code(404).send({ error: 'not_found' });
    if (!canSeeBU(req.user, cur.rows[0].bu)) return reply.code(403).send({ error: 'bu_forbidden' });
    const d = p.data;
    if (d.cliente_id !== undefined && !(await assertClienteVisible(req.user, d.cliente_id, reply))) return reply;
    const { rows } = await q(
      `UPDATE cotizaciones SET
         cliente_id = $2,
         origen     = COALESCE($3, origen),
         destino    = COALESCE($4, destino),
         precio     = COALESCE($5, precio),
         estado     = COALESCE($6, estado),
         data       = COALESCE($7, data),
         updated_at = now()
       WHERE id = $1 RETURNING *`,
      [
        req.params.id,
        d.cliente_id !== undefined ? d.cliente_id : cur.rows[0].cliente_id ?? null,
        d.origen ?? null,
        d.destino ?? null,
        d.precio ?? null,
        d.estado ?? null,
        d.data ?? null,
      ],
    );
    return rows[0];
  });

  app.delete('/:id', { preHandler: [app.requireAdmin()] }, async (req, reply) => {
    const cur = await q('SELECT bu FROM cotizaciones WHERE id = $1', [req.params.id]);
    if (!cur.rows[0]) return reply.code(404).send({ error: 'not_found' });
    if (!canSeeBU(req.user, cur.rows[0].bu)) return reply.code(403).send({ error: 'bu_forbidden' });
    await q('DELETE FROM cotizaciones WHERE id = $1', [req.params.id]);
    return { ok: true };
  });
}
