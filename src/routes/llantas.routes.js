import { z } from 'zod';
import { q } from '../db.js';
import { visibleBUs, canSeeBU } from '../lib/scope.js';

// Llantas (módulo Llantas, Flota Propia). CRUD de llantas físicas: costo, medida,
// vida, instalación en unidad+posición, profundidad y km acumulados. El historial
// de movimientos vive en data.movimientos. Sigue el patrón de combustible.routes.js
// / mantenimientos.routes.js. Permiso de escritura: 'mantenimiento'.

const buEnum = z.enum(['broker', 'flota', 'ambos']);

const createSchema = z.object({
  bu: buEnum,
  codigo: z.string().optional().nullable(),
  marca: z.string().optional().nullable(),
  medida: z.string().optional().nullable(),
  costo: z.number().optional().nullable(),
  fechaCompra: z.string().optional().nullable(),
  estado: z.string().optional().nullable(),
  unidadPlaca: z.string().optional().nullable(),
  posicion: z.string().optional().nullable(),
  odometroInstalacion: z.number().optional().nullable(),
  kmAcumulados: z.number().optional().nullable(),
  vidaEsperadaKm: z.number().optional().nullable(),
  profInicialMm: z.number().optional().nullable(),
  profActualMm: z.number().optional().nullable(),
  profMinMm: z.number().optional().nullable(),
  data: z.record(z.any()).optional(),
});

export default async function llantasRoutes(app) {
  app.addHook('preHandler', app.authenticate);

  // Lista por BU visible. Filtros opcionales: placa, estado, q (código/marca/medida).
  app.get('/', async (req) => {
    const params = [visibleBUs(req.user)];
    let sql = 'SELECT * FROM llantas WHERE bu = ANY($1)';
    const { placa, estado, q: term } = req.query || {};
    if (placa) { params.push(String(placa).toLowerCase()); sql += ` AND lower(unidad_placa) = $${params.length}`; }
    if (estado) { params.push(estado); sql += ` AND estado = $${params.length}`; }
    if (term) {
      params.push(`%${String(term).toLowerCase()}%`);
      sql += ` AND (lower(codigo) LIKE $${params.length} OR lower(marca) LIKE $${params.length} OR lower(medida) LIKE $${params.length})`;
    }
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
      `INSERT INTO llantas
         (bu, codigo, marca, medida, costo, fecha_compra, estado, unidad_placa, posicion,
          odometro_instalacion, km_acumulados, vida_esperada_km, prof_inicial_mm, prof_actual_mm, prof_min_mm, data)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING *`,
      [
        d.bu, d.codigo ?? null, d.marca ?? null, d.medida ?? null, d.costo ?? null,
        d.fechaCompra ?? null, d.estado ?? 'inventario', d.unidadPlaca ?? null, d.posicion ?? null,
        d.odometroInstalacion ?? null, d.kmAcumulados ?? 0, d.vidaEsperadaKm ?? null,
        d.profInicialMm ?? null, d.profActualMm ?? null, d.profMinMm ?? null, d.data ?? {},
      ],
    );
    return rows[0];
  });

  app.put('/:id', { preHandler: [app.requirePerm('mantenimiento', 'edit')] }, async (req, reply) => {
    const p = createSchema.partial().safeParse(req.body);
    if (!p.success) return reply.code(400).send({ error: 'bad_request', detail: p.error.flatten() });
    const cur = await q('SELECT bu FROM llantas WHERE id = $1', [req.params.id]);
    if (!cur.rows[0]) return reply.code(404).send({ error: 'not_found' });
    if (!canSeeBU(req.user, cur.rows[0].bu)) return reply.code(403).send({ error: 'bu_forbidden' });
    const d = p.data;
    const { rows } = await q(
      `UPDATE llantas SET
         codigo               = COALESCE($2, codigo),
         marca                = COALESCE($3, marca),
         medida               = COALESCE($4, medida),
         costo                = COALESCE($5, costo),
         fecha_compra         = COALESCE($6, fecha_compra),
         estado               = COALESCE($7, estado),
         unidad_placa         = $8,
         posicion             = $9,
         odometro_instalacion = $10,
         km_acumulados        = COALESCE($11, km_acumulados),
         vida_esperada_km     = COALESCE($12, vida_esperada_km),
         prof_inicial_mm      = COALESCE($13, prof_inicial_mm),
         prof_actual_mm       = COALESCE($14, prof_actual_mm),
         prof_min_mm          = COALESCE($15, prof_min_mm),
         data                 = COALESCE($16, data),
         updated_at           = now()
       WHERE id = $1 RETURNING *`,
      [
        req.params.id, d.codigo ?? null, d.marca ?? null, d.medida ?? null, d.costo ?? null,
        d.fechaCompra ?? null, d.estado ?? null, d.unidadPlaca ?? null, d.posicion ?? null,
        d.odometroInstalacion ?? null, d.kmAcumulados ?? null, d.vidaEsperadaKm ?? null,
        d.profInicialMm ?? null, d.profActualMm ?? null, d.profMinMm ?? null, d.data ?? null,
      ],
    );
    return rows[0];
  });

  app.delete('/:id', { preHandler: [app.requireAdmin()] }, async (req, reply) => {
    const cur = await q('SELECT bu FROM llantas WHERE id = $1', [req.params.id]);
    if (!cur.rows[0]) return reply.code(404).send({ error: 'not_found' });
    if (!canSeeBU(req.user, cur.rows[0].bu)) return reply.code(403).send({ error: 'bu_forbidden' });
    await q('DELETE FROM llantas WHERE id = $1', [req.params.id]);
    return { ok: true };
  });
}
