import { z } from 'zod';
import { q } from '../db.js';
import { canSeeBU, visibleBUs } from '../lib/scope.js';

const WRITE = ['admin', 'gerente', 'operaciones'];

async function fleteBU(fleteId) {
  const { rows } = await q('SELECT bu, mon_finalizado FROM fletes WHERE id = $1', [fleteId]);
  return rows[0] || null;
}

export default async function gastosRoutes(app) {
  app.addHook('preHandler', app.authenticate);

  // LISTA en bloque (BU-scoped). Sustituye el N+1 que Pago de Proveedores hacía
  // pidiendo gastos by-flete por cada flete: ahora trae todos los gastos visibles
  // en UNA request y el front los suma por flete en memoria.
  app.get('/', async (req) => {
    const { rows } = await q(
      `SELECT g.* FROM gastos_extra g
         JOIN fletes f ON f.id = g.flete_id
        WHERE f.bu = ANY($1)
        ORDER BY g.fecha`,
      [visibleBUs(req.user)],
    );
    return rows;
  });

  app.get('/by-flete/:fleteId', async (req, reply) => {
    const f = await fleteBU(req.params.fleteId);
    if (!f) return reply.code(404).send({ error: 'not_found' });
    if (!canSeeBU(req.user, f.bu)) return reply.code(403).send({ error: 'bu_forbidden' });
    const { rows } = await q('SELECT * FROM gastos_extra WHERE flete_id = $1 ORDER BY fecha', [req.params.fleteId]);
    return rows;
  });

  const createSchema = z.object({
    flete_id: z.string().uuid(),
    tipo: z.string().optional(),
    descripcion: z.string().optional(),
    cobro: z.number().optional(),
    pago: z.number().optional(),
    fecha: z.string().optional(),
  });

  app.post('/', { preHandler: [app.requirePerm('gastos', 'edit')] }, async (req, reply) => {
    const p = createSchema.safeParse(req.body);
    if (!p.success) return reply.code(400).send({ error: 'bad_request' });
    const f = await fleteBU(p.data.flete_id);
    if (!f) return reply.code(404).send({ error: 'flete_not_found' });
    if (!canSeeBU(req.user, f.bu)) return reply.code(403).send({ error: 'bu_forbidden' });
    const d = p.data;
    const { rows } = await q(
      `INSERT INTO gastos_extra (flete_id, tipo, descripcion, cobro, pago, fecha)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [d.flete_id, d.tipo ?? null, d.descripcion ?? null, d.cobro ?? null, d.pago ?? null, d.fecha ?? null],
    );
    return rows[0];
  });

  // EDITAR un gasto extra — permiso `gastos:edit`, SOLO mientras el servicio no
  // esté liberado. Tras liberar (gastos_liberado=true) el gasto ya está en cobro/
  // pago y no debe editarse (409 ya_liberado; primero se revierte la liberación).
  const updateSchema = z.object({
    tipo: z.string().optional(),
    descripcion: z.string().optional(),
    cobro: z.number().optional(),
    pago: z.number().optional(),
    fecha: z.string().optional(),
  });
  app.put('/:id', { preHandler: [app.requirePerm('gastos', 'edit')] }, async (req, reply) => {
    const p = updateSchema.safeParse(req.body);
    if (!p.success) return reply.code(400).send({ error: 'bad_request' });
    const { rows: gr } = await q(
      `SELECT g.id, f.bu, f.gastos_liberado
         FROM gastos_extra g JOIN fletes f ON f.id = g.flete_id
        WHERE g.id = $1`,
      [req.params.id],
    );
    const g = gr[0];
    if (!g) return reply.code(404).send({ error: 'not_found' });
    if (!canSeeBU(req.user, g.bu)) return reply.code(403).send({ error: 'bu_forbidden' });
    if (g.gastos_liberado) return reply.code(409).send({ error: 'ya_liberado' });
    const d = p.data;
    const { rows } = await q(
      `UPDATE gastos_extra
          SET tipo = COALESCE($2, tipo),
              descripcion = COALESCE($3, descripcion),
              cobro = COALESCE($4, cobro),
              pago = COALESCE($5, pago),
              fecha = COALESCE($6, fecha)
        WHERE id = $1 RETURNING *`,
      [req.params.id, d.tipo ?? null, d.descripcion ?? null, d.cobro ?? null, d.pago ?? null, d.fecha ?? null],
    );
    return rows[0];
  });

  app.delete('/:id', { preHandler: [app.requireAdmin()] }, async (req, reply) => {
    const { rows } = await q(
      'SELECT g.id, f.bu FROM gastos_extra g JOIN fletes f ON f.id = g.flete_id WHERE g.id = $1',
      [req.params.id],
    );
    if (!rows[0]) return reply.code(404).send({ error: 'not_found' });
    if (!canSeeBU(req.user, rows[0].bu)) return reply.code(403).send({ error: 'bu_forbidden' });
    await q('DELETE FROM gastos_extra WHERE id = $1', [req.params.id]);
    return { ok: true };
  });

  // Liberar finanzas: requiere monitoreo finalizado. Desbloquea CxC/CxP.
  // No se exige capturar gastos extra (ni broker ni flota): liberar sin gastos
  // significa que el servicio no tuvo gastos extra y se libera sin cobro/pago.
  app.post('/liberar/:fleteId', { preHandler: [app.requirePerm('gastos', 'edit')] }, async (req, reply) => {
    const f = await fleteBU(req.params.fleteId);
    if (!f) return reply.code(404).send({ error: 'not_found' });
    if (!canSeeBU(req.user, f.bu)) return reply.code(403).send({ error: 'bu_forbidden' });
    if (!f.mon_finalizado) return reply.code(409).send({ error: 'monitoreo_no_finalizado' });
    const { rows } = await q('UPDATE fletes SET gastos_liberado = true, updated_at = now() WHERE id = $1 RETURNING *', [req.params.fleteId]);
    return rows[0];
  });

  // REVERTIR liberación — SOLO administrador. Regresa el servicio a "gasto extra"
  // (gastos_liberado=false) para poder re-capturar cobro/pago cuando se liberó por
  // error. Se bloquea si el cobro ya se concretó (cxc=cobrado) o el pago se cerró
  // (cxp=cerrado), para no corromper la contabilidad: primero hay que revertir esos.
  app.post('/revertir/:fleteId', { preHandler: [app.requireAdmin()] }, async (req, reply) => {
    const { rows: fr } = await q(
      'SELECT bu, gastos_liberado FROM fletes WHERE id = $1',
      [req.params.fleteId],
    );
    const f = fr[0];
    if (!f) return reply.code(404).send({ error: 'not_found' });
    if (!canSeeBU(req.user, f.bu)) return reply.code(403).send({ error: 'bu_forbidden' });
    if (!f.gastos_liberado) return reply.code(409).send({ error: 'no_liberado' });
    const { rows: sr } = await q(
      `SELECT (SELECT status FROM cxc WHERE flete_id = $1) AS cxc,
              (SELECT status FROM cxp WHERE flete_id = $1) AS cxp`,
      [req.params.fleteId],
    );
    const s = sr[0] || {};
    if (s.cxc === 'cobrado' || s.cxp === 'cerrado') {
      return reply.code(409).send({ error: 'ya_cobrado_o_pagado' });
    }
    const { rows } = await q(
      'UPDATE fletes SET gastos_liberado = false, updated_at = now() WHERE id = $1 RETURNING *',
      [req.params.fleteId],
    );
    return rows[0];
  });

  // REGRESAR A MONITOREO — SOLO administrador. Cuando un servicio se finalizó por
  // error (status 19), quedó fuera de Monitoreo y pasó a Gastos Extra. Este endpoint
  // lo "des-finaliza": pone mon_finalizado=false, status='activo' y el monStatus de
  // regreso que indique el admin (el front sugiere uno y arma el historial). Se
  // bloquea si ya está liberado (primero se revierte la liberación) y no permite
  // volver a 'finalizado'.
  const regresarMonSchema = z.object({
    status: z.string().min(1),
    historial: z.array(z.any()).optional(),
  });
  app.post('/regresar-monitoreo/:fleteId', { preHandler: [app.requireAdmin()] }, async (req, reply) => {
    const p = regresarMonSchema.safeParse(req.body);
    if (!p.success) return reply.code(400).send({ error: 'bad_request' });
    if (p.data.status === 'finalizado') return reply.code(400).send({ error: 'status_invalido' });
    const { rows: fr } = await q(
      'SELECT bu, gastos_liberado, mon_finalizado FROM fletes WHERE id = $1',
      [req.params.fleteId],
    );
    const f = fr[0];
    if (!f) return reply.code(404).send({ error: 'not_found' });
    if (!canSeeBU(req.user, f.bu)) return reply.code(403).send({ error: 'bu_forbidden' });
    if (!f.mon_finalizado) return reply.code(409).send({ error: 'no_finalizado' });
    if (f.gastos_liberado) return reply.code(409).send({ error: 'ya_liberado' });
    const patch = { monStatus: p.data.status };
    if (p.data.historial) patch.monHistorial = p.data.historial;
    const { rows } = await q(
      `UPDATE fletes
          SET mon_finalizado = false, status = 'activo',
              data = data || $2::jsonb, updated_at = now()
        WHERE id = $1 RETURNING *`,
      [req.params.fleteId, JSON.stringify(patch)],
    );
    return rows[0];
  });
}
