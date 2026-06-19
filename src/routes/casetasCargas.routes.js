import { z } from 'zod';
import { q } from '../db.js';
import { visibleBUs, canSeeBU } from '../lib/scope.js';

// Transacciones de casetas por unidad (TAG IAVE), Flota Propia. Cada fila es un
// cruce del reporte de IAVE + la unidad a la que pertenece (por económico). El
// rendimiento/CPK y el pago semanal a proveedor se calculan en el frontend.
// Sigue el patrón de combustible.routes.js. Se reutiliza el permiso de módulo
// `combustible` (misma audiencia de Flota / costos operativos por unidad).

const buEnum = z.enum(['broker', 'flota', 'ambos']);

const rowSchema = z.object({
  uuid_tx: z.string().optional().nullable(),
  tag: z.string().optional().nullable(),
  fecha_cruce: z.string().optional().nullable(),
  fecha_cobro: z.string().optional().nullable(),
  operador: z.string().optional().nullable(),
  plaza: z.string().optional().nullable(),
  carril: z.string().optional().nullable(),
  categoria: z.string().optional().nullable(),
  importe: z.number().optional().nullable(),
  economico: z.string().optional().nullable(),
  placa: z.string().optional().nullable(),
  vehiculo: z.string().optional().nullable(),
  serie_folio: z.string().optional().nullable(),
  decena: z.string().optional().nullable(),
  proveedor: z.string().optional().nullable(),
  data: z.record(z.any()).optional(),
});

const createSchema = rowSchema.extend({ bu: buEnum });
const importSchema = z.object({ bu: buEnum, rows: z.array(rowSchema).max(20000) });

const COLS = [
  'uuid_tx', 'tag', 'fecha_cruce', 'fecha_cobro', 'operador', 'plaza', 'carril',
  'categoria', 'importe', 'economico', 'placa', 'vehiculo', 'serie_folio',
  'decena', 'proveedor', 'data',
];

// forInsert=true aplica el default proveedor 'IAVE' y data {}; en UPDATE se pasan
// null para que el COALESCE conserve el valor existente cuando no vienen.
function values(d, forInsert) {
  return [
    d.uuid_tx ?? null, d.tag ?? null, d.fecha_cruce ?? null, d.fecha_cobro ?? null,
    d.operador ?? null, d.plaza ?? null, d.carril ?? null, d.categoria ?? null,
    d.importe ?? null, d.economico ?? null, d.placa ?? null, d.vehiculo ?? null,
    d.serie_folio ?? null, d.decena ?? null,
    d.proveedor ?? (forInsert ? 'IAVE' : null),
    d.data ?? (forInsert ? {} : null),
  ];
}

export default async function casetasCargasRoutes(app) {
  app.addHook('preHandler', app.authenticate);

  // Lista por BU visible. Filtros opcionales: economico, operador, q (plaza/
  // económico/placa/folio).
  app.get('/', async (req) => {
    const params = [visibleBUs(req.user)];
    let sql = 'SELECT * FROM casetas_cargas WHERE bu = ANY($1)';
    const { economico, operador, q: term } = req.query || {};
    if (economico) { params.push(String(economico).toLowerCase()); sql += ` AND lower(economico) = $${params.length}`; }
    if (operador) { params.push(operador); sql += ` AND operador = $${params.length}`; }
    if (term) {
      params.push(`%${String(term).toLowerCase()}%`);
      sql += ` AND (lower(plaza) LIKE $${params.length} OR lower(economico) LIKE $${params.length} OR lower(placa) LIKE $${params.length} OR lower(serie_folio) LIKE $${params.length})`;
    }
    sql += ' ORDER BY fecha_cruce DESC NULLS LAST, created_at DESC';
    const { rows } = await q(sql, params);
    return rows;
  });

  app.post('/', { preHandler: [app.requirePerm('combustible', 'edit')] }, async (req, reply) => {
    const p = createSchema.safeParse(req.body);
    if (!p.success) return reply.code(400).send({ error: 'bad_request', detail: p.error.flatten() });
    if (!canSeeBU(req.user, p.data.bu)) return reply.code(403).send({ error: 'bu_forbidden' });
    const { rows } = await q(
      `INSERT INTO casetas_cargas (bu, ${COLS.join(', ')})
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) RETURNING *`,
      [p.data.bu, ...values(p.data, true)],
    );
    return rows[0];
  });

  // Import masivo del reporte IAVE. Deduplica por uuid_tx (ON CONFLICT DO
  // NOTHING) → re-subir el mismo archivo no duplica. Devuelve { added, skipped }.
  app.post('/import', { preHandler: [app.requirePerm('combustible', 'edit')] }, async (req, reply) => {
    const p = importSchema.safeParse(req.body);
    if (!p.success) return reply.code(400).send({ error: 'bad_request', detail: p.error.flatten() });
    if (!canSeeBU(req.user, p.data.bu)) return reply.code(403).send({ error: 'bu_forbidden' });
    let added = 0;
    for (const r of p.data.rows) {
      const { rows } = await q(
        `INSERT INTO casetas_cargas (bu, ${COLS.join(', ')})
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
         ON CONFLICT (uuid_tx) WHERE uuid_tx IS NOT NULL DO NOTHING
         RETURNING id`,
        [p.data.bu, ...values(r, true)],
      );
      if (rows.length) added += 1;
    }
    return { added, skipped: p.data.rows.length - added };
  });

  app.put('/:id', { preHandler: [app.requirePerm('combustible', 'edit')] }, async (req, reply) => {
    const p = rowSchema.partial().safeParse(req.body);
    if (!p.success) return reply.code(400).send({ error: 'bad_request', detail: p.error.flatten() });
    const cur = await q('SELECT bu FROM casetas_cargas WHERE id = $1', [req.params.id]);
    if (!cur.rows[0]) return reply.code(404).send({ error: 'not_found' });
    if (!canSeeBU(req.user, cur.rows[0].bu)) return reply.code(403).send({ error: 'bu_forbidden' });
    const d = p.data;
    const { rows } = await q(
      `UPDATE casetas_cargas SET
         uuid_tx     = COALESCE($2, uuid_tx),
         tag         = COALESCE($3, tag),
         fecha_cruce = COALESCE($4, fecha_cruce),
         fecha_cobro = COALESCE($5, fecha_cobro),
         operador    = COALESCE($6, operador),
         plaza       = COALESCE($7, plaza),
         carril      = COALESCE($8, carril),
         categoria   = COALESCE($9, categoria),
         importe     = COALESCE($10, importe),
         economico   = COALESCE($11, economico),
         placa       = COALESCE($12, placa),
         vehiculo    = COALESCE($13, vehiculo),
         serie_folio = COALESCE($14, serie_folio),
         decena      = COALESCE($15, decena),
         proveedor   = COALESCE($16, proveedor),
         data        = COALESCE($17, data),
         updated_at  = now()
       WHERE id = $1 RETURNING *`,
      [req.params.id, ...values(d, false)],
    );
    return rows[0];
  });

  app.delete('/:id', { preHandler: [app.requireAdmin()] }, async (req, reply) => {
    const cur = await q('SELECT bu FROM casetas_cargas WHERE id = $1', [req.params.id]);
    if (!cur.rows[0]) return reply.code(404).send({ error: 'not_found' });
    if (!canSeeBU(req.user, cur.rows[0].bu)) return reply.code(403).send({ error: 'bu_forbidden' });
    await q('DELETE FROM casetas_cargas WHERE id = $1', [req.params.id]);
    return { ok: true };
  });
}
