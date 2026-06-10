import { z } from 'zod';
import { q } from '../db.js';
import { visibleBUs, canSeeBU } from '../lib/scope.js';

// Gastos operativos (solo Flota Propia). Cada fila es un gasto que registra
// operación; puede ligarse OPCIONALMENTE a un viaje (flete_id) o quedar sin
// viaje. Distinto de gastos_extra (cobro/pago por servicio con liberación).
// Permiso: módulo 'gastos'. Sigue el patrón de mantenimientos.routes.js.

const buEnum = z.enum(['broker', 'flota', 'ambos']);

const baseSchema = z.object({
  bu: buEnum,
  flete_id: z.string().uuid().nullable().optional(), // viaje opcional
  fecha: z.string().optional(),
  concepto: z.string().optional(),
  monto: z.number().optional(),
  categoria: z.string().optional(),
  metodo_pago: z.string().optional(),
  proveedor: z.string().optional(),
  comprobante: z.string().optional(),
  data: z.record(z.any()).optional(),
});

// Si se liga un viaje, debe existir y ser de una BU visible para el usuario.
async function assertFleteVisible(user, fleteId, reply) {
  if (!fleteId) return true;
  const { rows } = await q('SELECT bu FROM fletes WHERE id = $1', [fleteId]);
  if (!rows[0]) {
    reply.code(404).send({ error: 'flete_not_found' });
    return false;
  }
  if (!canSeeBU(user, rows[0].bu)) {
    reply.code(403).send({ error: 'bu_forbidden' });
    return false;
  }
  return true;
}

export default async function gastosOperativosRoutes(app) {
  app.addHook('preHandler', app.authenticate);

  // Lista por BU visible. Filtro opcional: flete_id (gastos de un viaje).
  app.get('/', async (req) => {
    const params = [visibleBUs(req.user)];
    let sql = 'SELECT * FROM gastos_operativos WHERE bu = ANY($1)';
    const { flete_id } = req.query || {};
    if (flete_id) {
      params.push(flete_id);
      sql += ` AND flete_id = $${params.length}`;
    }
    sql += ' ORDER BY fecha DESC NULLS LAST, created_at DESC';
    const { rows } = await q(sql, params);
    return rows;
  });

  app.post('/', { preHandler: [app.requirePerm('gastos', 'edit')] }, async (req, reply) => {
    const p = baseSchema.safeParse(req.body);
    if (!p.success) return reply.code(400).send({ error: 'bad_request', detail: p.error.flatten() });
    if (!canSeeBU(req.user, p.data.bu)) return reply.code(403).send({ error: 'bu_forbidden' });
    const d = p.data;
    if (!(await assertFleteVisible(req.user, d.flete_id, reply))) return reply;
    const { rows } = await q(
      `INSERT INTO gastos_operativos
         (bu, flete_id, fecha, concepto, monto, categoria, metodo_pago, proveedor, comprobante, data)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [
        d.bu,
        d.flete_id ?? null,
        d.fecha ?? null,
        d.concepto ?? null,
        d.monto ?? null,
        d.categoria ?? null,
        d.metodo_pago ?? null,
        d.proveedor ?? null,
        d.comprobante ?? null,
        d.data ?? {},
      ],
    );
    return rows[0];
  });

  app.put('/:id', { preHandler: [app.requirePerm('gastos', 'edit')] }, async (req, reply) => {
    const p = baseSchema.partial().safeParse(req.body);
    if (!p.success) return reply.code(400).send({ error: 'bad_request', detail: p.error.flatten() });
    const cur = await q('SELECT bu, flete_id FROM gastos_operativos WHERE id = $1', [req.params.id]);
    if (!cur.rows[0]) return reply.code(404).send({ error: 'not_found' });
    if (!canSeeBU(req.user, cur.rows[0].bu)) return reply.code(403).send({ error: 'bu_forbidden' });
    const d = p.data;
    if (d.flete_id !== undefined && !(await assertFleteVisible(req.user, d.flete_id, reply))) return reply;
    const { rows } = await q(
      `UPDATE gastos_operativos SET
         flete_id    = $2,
         fecha       = COALESCE($3, fecha),
         concepto    = COALESCE($4, concepto),
         monto       = COALESCE($5, monto),
         categoria   = COALESCE($6, categoria),
         metodo_pago = COALESCE($7, metodo_pago),
         proveedor   = COALESCE($8, proveedor),
         comprobante = COALESCE($9, comprobante),
         data        = COALESCE($10, data),
         updated_at  = now()
       WHERE id = $1 RETURNING *`,
      [
        req.params.id,
        // flete_id se sobreescribe explícito (permite des-ligar pasando null);
        // si no viene en el body, conserva el actual.
        d.flete_id !== undefined ? d.flete_id : cur.rows[0].flete_id ?? null,
        d.fecha ?? null,
        d.concepto ?? null,
        d.monto ?? null,
        d.categoria ?? null,
        d.metodo_pago ?? null,
        d.proveedor ?? null,
        d.comprobante ?? null,
        d.data ?? null,
      ],
    );
    return rows[0];
  });

  app.delete('/:id', { preHandler: [app.requireAdmin()] }, async (req, reply) => {
    const cur = await q('SELECT bu FROM gastos_operativos WHERE id = $1', [req.params.id]);
    if (!cur.rows[0]) return reply.code(404).send({ error: 'not_found' });
    if (!canSeeBU(req.user, cur.rows[0].bu)) return reply.code(403).send({ error: 'bu_forbidden' });
    await q('DELETE FROM gastos_operativos WHERE id = $1', [req.params.id]);
    return { ok: true };
  });
}
