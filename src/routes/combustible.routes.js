import { z } from 'zod';
import { q } from '../db.js';
import { visibleBUs, canSeeBU } from '../lib/scope.js';

// Cargas de combustible por unidad (módulo Combustible / Rendimientos, Flota
// Propia). Cada fila es una carga del reporte del proveedor + el odómetro que
// captura el usuario. El rendimiento se calcula en el frontend. Sigue el patrón
// de mantenimientos.routes.js / documentos.routes.js.

const buEnum = z.enum(['broker', 'flota', 'ambos']);

const createSchema = z.object({
  bu: buEnum,
  fecha: z.string().optional().nullable(),
  placa: z.string().min(1),
  economico: z.string().optional().nullable(),
  descripcion: z.string().optional().nullable(),
  departamento: z.string().optional().nullable(),
  producto: z.string().optional().nullable(),
  litros: z.number().optional().nullable(),
  precio: z.number().optional().nullable(),
  total: z.number().optional().nullable(),
  odometro: z.number().optional().nullable(),
  ticket: z.string().optional().nullable(),
  estacion: z.string().optional().nullable(),
  factura: z.string().optional().nullable(),
  data: z.record(z.any()).optional(),
});

export default async function combustibleRoutes(app) {
  app.addHook('preHandler', app.authenticate);

  // Lista por BU visible. Filtros opcionales: placa, producto, q (placa/desc/
  // económico/ticket).
  app.get('/', async (req) => {
    const params = [visibleBUs(req.user)];
    let sql = 'SELECT * FROM combustible_cargas WHERE bu = ANY($1)';
    const { placa, producto, q: term } = req.query || {};
    if (placa) { params.push(String(placa).toLowerCase()); sql += ` AND lower(placa) = $${params.length}`; }
    if (producto) { params.push(producto); sql += ` AND producto = $${params.length}`; }
    if (term) {
      params.push(`%${String(term).toLowerCase()}%`);
      sql += ` AND (lower(placa) LIKE $${params.length} OR lower(descripcion) LIKE $${params.length} OR lower(economico) LIKE $${params.length} OR lower(ticket) LIKE $${params.length})`;
    }
    sql += ' ORDER BY fecha DESC NULLS LAST, created_at DESC';
    const { rows } = await q(sql, params);
    return rows;
  });

  app.post('/', { preHandler: [app.requirePerm('combustible', 'edit')] }, async (req, reply) => {
    const p = createSchema.safeParse(req.body);
    if (!p.success) return reply.code(400).send({ error: 'bad_request', detail: p.error.flatten() });
    if (!canSeeBU(req.user, p.data.bu)) return reply.code(403).send({ error: 'bu_forbidden' });
    const d = p.data;
    const { rows } = await q(
      `INSERT INTO combustible_cargas
         (bu, fecha, placa, economico, descripcion, departamento, producto, litros, precio, total, odometro, ticket, estacion, factura, data)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING *`,
      [
        d.bu, d.fecha ?? null, d.placa, d.economico ?? null, d.descripcion ?? null,
        d.departamento ?? null, d.producto ?? null, d.litros ?? null, d.precio ?? null,
        d.total ?? null, d.odometro ?? null, d.ticket ?? null, d.estacion ?? null,
        d.factura ?? null, d.data ?? {},
      ],
    );
    return rows[0];
  });

  app.put('/:id', { preHandler: [app.requirePerm('combustible', 'edit')] }, async (req, reply) => {
    const p = createSchema.partial().safeParse(req.body);
    if (!p.success) return reply.code(400).send({ error: 'bad_request', detail: p.error.flatten() });
    const cur = await q('SELECT bu FROM combustible_cargas WHERE id = $1', [req.params.id]);
    if (!cur.rows[0]) return reply.code(404).send({ error: 'not_found' });
    if (!canSeeBU(req.user, cur.rows[0].bu)) return reply.code(403).send({ error: 'bu_forbidden' });
    const d = p.data;
    const { rows } = await q(
      `UPDATE combustible_cargas SET
         fecha        = COALESCE($2, fecha),
         placa        = COALESCE($3, placa),
         economico    = COALESCE($4, economico),
         descripcion  = COALESCE($5, descripcion),
         departamento = COALESCE($6, departamento),
         producto     = COALESCE($7, producto),
         litros       = COALESCE($8, litros),
         precio       = COALESCE($9, precio),
         total        = COALESCE($10, total),
         odometro     = COALESCE($11, odometro),
         ticket       = COALESCE($12, ticket),
         estacion     = COALESCE($13, estacion),
         factura      = COALESCE($14, factura),
         data         = COALESCE($15, data),
         updated_at   = now()
       WHERE id = $1 RETURNING *`,
      [
        req.params.id, d.fecha ?? null, d.placa ?? null, d.economico ?? null,
        d.descripcion ?? null, d.departamento ?? null, d.producto ?? null,
        d.litros ?? null, d.precio ?? null, d.total ?? null, d.odometro ?? null,
        d.ticket ?? null, d.estacion ?? null, d.factura ?? null, d.data ?? null,
      ],
    );
    return rows[0];
  });

  app.delete('/:id', { preHandler: [app.requireAdmin()] }, async (req, reply) => {
    const cur = await q('SELECT bu FROM combustible_cargas WHERE id = $1', [req.params.id]);
    if (!cur.rows[0]) return reply.code(404).send({ error: 'not_found' });
    if (!canSeeBU(req.user, cur.rows[0].bu)) return reply.code(403).send({ error: 'bu_forbidden' });
    await q('DELETE FROM combustible_cargas WHERE id = $1', [req.params.id]);
    return { ok: true };
  });
}
