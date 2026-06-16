import { z } from 'zod';
import { q } from '../db.js';

// Catálogo nacional de casetas (plazas de cobro de la Red Nacional de Caminos).
// No es por BU: es un catálogo compartido. La `tarifa` la captura la operación
// (editable, reutilizable). Permiso de edición: módulo 'fletes' (cotizador).

export default async function casetasRoutes(app) {
  app.addHook('preHandler', app.authenticate);

  // Lista del catálogo. Filtro opcional ?q= (nombre/sección) y ?soloTarifa=1.
  app.get('/', async (req) => {
    const params = [];
    let sql = 'SELECT * FROM casetas';
    const where = [];
    const { q: term, soloTarifa } = req.query || {};
    if (term) {
      params.push(`%${String(term).toLowerCase()}%`);
      where.push(`(lower(nombre) LIKE $${params.length} OR lower(seccion) LIKE $${params.length})`);
    }
    if (soloTarifa === '1' || soloTarifa === 'true') where.push('tarifa IS NOT NULL');
    if (where.length) sql += ' WHERE ' + where.join(' AND ');
    sql += ' ORDER BY nombre, seccion';
    const { rows } = await q(sql, params);
    return rows;
  });

  const updateSchema = z.object({
    tarifa: z.number().nullable().optional(),
    data: z.record(z.any()).optional(),
  });

  // Actualiza la tarifa (y/o data) de una caseta. No se crean/borran casetas
  // desde la app: el catálogo viene de la RNC.
  app.put('/:id', { preHandler: [app.requirePerm('fletes', 'edit')] }, async (req, reply) => {
    const p = updateSchema.safeParse(req.body);
    if (!p.success) return reply.code(400).send({ error: 'bad_request', detail: p.error.flatten() });
    const d = p.data;
    const { rows } = await q(
      `UPDATE casetas SET
         tarifa = $2,
         data   = COALESCE($3, data),
         updated_at = now()
       WHERE id = $1 RETURNING *`,
      [req.params.id, d.tarifa ?? null, d.data ?? null],
    );
    if (!rows[0]) return reply.code(404).send({ error: 'not_found' });
    return rows[0];
  });
}
