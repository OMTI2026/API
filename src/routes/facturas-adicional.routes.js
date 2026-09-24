import { z } from 'zod';
import { q } from '../db.js';
import { canSeeBU, visibleBUs } from '../lib/scope.js';

// Facturas de adicional: cada flete puede tener VARIAS, cada una con su folio,
// fecha de factura y fecha de cobro propias (independientes de la factura del
// servicio). Agrupan gastos_extra (via gastos_extra.factura_adic_id) y se
// proyectan en el Flujo Neto Semanal por su fecha de cobro estimada.

async function fleteBU(fleteId) {
  const { rows } = await q('SELECT bu FROM fletes WHERE id = $1', [fleteId]);
  return rows[0] || null;
}

// Estatus derivado de las fechas (fuente única, no lo decide el cliente):
//   sin fecha de factura            -> por-facturar
//   con fecha de factura, sin cobro -> facturado
//   con fecha de cobro real         -> cobrado
function calcStatus({ fecha_factura, fecha_cobrado }) {
  if (fecha_cobrado) return 'cobrado';
  if (fecha_factura) return 'facturado';
  return 'por-facturar';
}

// Suma el cobro de los gastos asignados a una factura de adicional.
async function sumaGastos(facturaId) {
  const { rows } = await q(
    'SELECT COALESCE(SUM(cobro), 0) AS total FROM gastos_extra WHERE factura_adic_id = $1',
    [facturaId],
  );
  return Number(rows[0]?.total || 0);
}

// Reasigna los gastos_extra de una factura: quita los que ya no están en la lista
// y agrega los nuevos (solo gastos del mismo flete). Devuelve la nueva suma.
async function reasignaGastos(facturaId, fleteId, gastoIds) {
  await q(
    'UPDATE gastos_extra SET factura_adic_id = NULL WHERE factura_adic_id = $1 AND NOT (id = ANY($2::uuid[]))',
    [facturaId, gastoIds],
  );
  if (gastoIds.length) {
    await q(
      'UPDATE gastos_extra SET factura_adic_id = $1 WHERE flete_id = $2 AND id = ANY($3::uuid[])',
      [facturaId, fleteId, gastoIds],
    );
  }
  return sumaGastos(facturaId);
}

export default async function facturasAdicionalRoutes(app) {
  app.addHook('preHandler', app.authenticate);

  // LISTA en bloque (BU-scoped) — alimenta cobranza/aging y el Flujo Neto Semanal.
  app.get('/', async (req) => {
    const { rows } = await q(
      `SELECT fa.* FROM facturas_adicional fa
         JOIN fletes f ON f.id = fa.flete_id
        WHERE f.bu = ANY($1)
        ORDER BY fa.fecha_cobro_est NULLS LAST, fa.created_at`,
      [visibleBUs(req.user)],
    );
    return rows;
  });

  app.get('/by-flete/:fleteId', async (req, reply) => {
    const f = await fleteBU(req.params.fleteId);
    if (!f) return reply.code(404).send({ error: 'not_found' });
    if (!canSeeBU(req.user, f.bu)) return reply.code(403).send({ error: 'bu_forbidden' });
    const { rows } = await q(
      'SELECT * FROM facturas_adicional WHERE flete_id = $1 ORDER BY created_at',
      [req.params.fleteId],
    );
    return rows;
  });

  const createSchema = z.object({
    flete_id: z.string().uuid(),
    folio: z.string().optional(),
    fecha_factura: z.string().optional(),
    fecha_autoriza: z.string().optional(),
    monto: z.number().optional(),
    fecha_cobro_est: z.string().optional(),
    fecha_cobrado: z.string().optional(),
    gastoIds: z.array(z.string().uuid()).optional(),
  });

  app.post('/', { preHandler: [app.requirePerm('cobranza', 'edit')] }, async (req, reply) => {
    const p = createSchema.safeParse(req.body);
    if (!p.success) return reply.code(400).send({ error: 'bad_request' });
    const f = await fleteBU(p.data.flete_id);
    if (!f) return reply.code(404).send({ error: 'flete_not_found' });
    if (!canSeeBU(req.user, f.bu)) return reply.code(403).send({ error: 'bu_forbidden' });
    const d = p.data;
    const status = calcStatus(d);
    const { rows } = await q(
      `INSERT INTO facturas_adicional
         (flete_id, bu, folio, fecha_factura, fecha_autoriza, monto, fecha_cobro_est, fecha_cobrado, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [
        d.flete_id, f.bu, d.folio ?? null, d.fecha_factura ?? null, d.fecha_autoriza ?? null,
        d.monto ?? 0, d.fecha_cobro_est ?? null, d.fecha_cobrado ?? null, status,
      ],
    );
    const factura = rows[0];
    if (d.gastoIds) {
      const suma = await reasignaGastos(factura.id, d.flete_id, d.gastoIds);
      // Si no capturaron monto manual, el total sale de los gastos asignados.
      if (d.monto == null) {
        const { rows: u } = await q(
          'UPDATE facturas_adicional SET monto = $2, updated_at = now() WHERE id = $1 RETURNING *',
          [factura.id, suma],
        );
        return u[0];
      }
    }
    return factura;
  });

  const updateSchema = z.object({
    folio: z.string().nullable().optional(),
    fecha_factura: z.string().nullable().optional(),
    fecha_autoriza: z.string().nullable().optional(),
    monto: z.number().nullable().optional(),
    fecha_cobro_est: z.string().nullable().optional(),
    fecha_cobrado: z.string().nullable().optional(),
    gastoIds: z.array(z.string().uuid()).optional(),
  });

  app.put('/:id', { preHandler: [app.requirePerm('cobranza', 'edit')] }, async (req, reply) => {
    const p = updateSchema.safeParse(req.body);
    if (!p.success) return reply.code(400).send({ error: 'bad_request' });
    const { rows: fr } = await q(
      `SELECT fa.*, f.bu AS flete_bu FROM facturas_adicional fa
         JOIN fletes f ON f.id = fa.flete_id WHERE fa.id = $1`,
      [req.params.id],
    );
    const cur = fr[0];
    if (!cur) return reply.code(404).send({ error: 'not_found' });
    if (!canSeeBU(req.user, cur.flete_bu)) return reply.code(403).send({ error: 'bu_forbidden' });
    const d = p.data;

    // Reasignación de gastos (si viene) — puede recalcular el monto.
    let montoDeGastos = null;
    if (d.gastoIds) montoDeGastos = await reasignaGastos(cur.id, cur.flete_id, d.gastoIds);

    // Valores efectivos para derivar el estatus.
    const fecha_factura = d.fecha_factura !== undefined ? d.fecha_factura : cur.fecha_factura;
    const fecha_cobrado = d.fecha_cobrado !== undefined ? d.fecha_cobrado : cur.fecha_cobrado;
    const status = calcStatus({ fecha_factura, fecha_cobrado });
    // Monto: manual si lo mandan; si no, el de los gastos reasignados; si no, el actual.
    const monto = d.monto != null ? d.monto : (montoDeGastos != null ? montoDeGastos : cur.monto);

    const { rows } = await q(
      `UPDATE facturas_adicional SET
          folio = $2, fecha_factura = $3, fecha_autoriza = $4, monto = $5,
          fecha_cobro_est = $6, fecha_cobrado = $7, status = $8, updated_at = now()
        WHERE id = $1 RETURNING *`,
      [
        cur.id,
        d.folio !== undefined ? d.folio : cur.folio,
        fecha_factura,
        d.fecha_autoriza !== undefined ? d.fecha_autoriza : cur.fecha_autoriza,
        monto,
        d.fecha_cobro_est !== undefined ? d.fecha_cobro_est : cur.fecha_cobro_est,
        fecha_cobrado,
        status,
      ],
    );
    return rows[0];
  });

  // Marcar cobrada (registra fecha real de cobro y pasa a 'cobrado').
  const cobrarSchema = z.object({ fecha_cobrado: z.string().optional() });
  app.post('/:id/cobrar', { preHandler: [app.requirePerm('cobranza', 'edit')] }, async (req, reply) => {
    const p = cobrarSchema.safeParse(req.body);
    if (!p.success) return reply.code(400).send({ error: 'bad_request' });
    const { rows: fr } = await q(
      `SELECT fa.id, f.bu FROM facturas_adicional fa JOIN fletes f ON f.id = fa.flete_id WHERE fa.id = $1`,
      [req.params.id],
    );
    if (!fr[0]) return reply.code(404).send({ error: 'not_found' });
    if (!canSeeBU(req.user, fr[0].bu)) return reply.code(403).send({ error: 'bu_forbidden' });
    const fecha = p.data.fecha_cobrado || new Date().toISOString().slice(0, 10);
    const { rows } = await q(
      `UPDATE facturas_adicional SET fecha_cobrado = $2, status = 'cobrado', updated_at = now()
        WHERE id = $1 RETURNING *`,
      [req.params.id, fecha],
    );
    return rows[0];
  });

  app.delete('/:id', { preHandler: [app.requireAdmin()] }, async (req, reply) => {
    const { rows } = await q(
      `SELECT fa.id, f.bu FROM facturas_adicional fa JOIN fletes f ON f.id = fa.flete_id WHERE fa.id = $1`,
      [req.params.id],
    );
    if (!rows[0]) return reply.code(404).send({ error: 'not_found' });
    if (!canSeeBU(req.user, rows[0].bu)) return reply.code(403).send({ error: 'bu_forbidden' });
    // Los gastos ligados se liberan solos (ON DELETE SET NULL) y regresan al servicio.
    await q('DELETE FROM facturas_adicional WHERE id = $1', [req.params.id]);
    return { ok: true };
  });
}
