import { z } from 'zod';
import { q } from '../db.js';
import { visibleBUs, canSeeBU } from '../lib/scope.js';

const buEnum = z.enum(['broker', 'flota', 'ambos']);

// Eventos de empresa del calendario de RRHH. Mismo modelo de permisos que el
// resto del módulo: ver = empleados:view, crear = empleados:edit,
// editar/eliminar = admin.
const eventoSchema = z.object({
  bu: buEnum,
  titulo: z.string().min(1),
  descripcion: z.string().optional(),
  fecha: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  data: z.record(z.any()).optional(),
});

// '' o undefined -> null (para columnas text nulables).
const nn = (v) => (v === '' || v === undefined ? null : v);

export default async function eventosRoutes(app) {
  app.addHook('preHandler', app.authenticate);

  app.get('/', { preHandler: [app.requirePerm('empleados', 'view')] }, async (req) => {
    const { rows } = await q(
      'SELECT * FROM eventos_empresa WHERE bu = ANY($1) ORDER BY fecha, titulo',
      [visibleBUs(req.user)],
    );
    return rows;
  });

  app.post('/', { preHandler: [app.requirePerm('empleados', 'edit')] }, async (req, reply) => {
    const p = eventoSchema.safeParse(req.body);
    if (!p.success) return reply.code(400).send({ error: 'bad_request', detail: p.error.flatten() });
    if (!canSeeBU(req.user, p.data.bu)) return reply.code(403).send({ error: 'bu_forbidden' });
    const d = p.data;
    const { rows } = await q(
      `INSERT INTO eventos_empresa (bu,titulo,descripcion,fecha,data)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [d.bu, d.titulo, nn(d.descripcion), d.fecha, d.data ?? {}],
    );
    return rows[0];
  });

  app.put('/:id', { preHandler: [app.requireAdmin()] }, async (req, reply) => {
    const p = eventoSchema.safeParse(req.body);
    if (!p.success) return reply.code(400).send({ error: 'bad_request', detail: p.error.flatten() });
    const cur = await q('SELECT bu FROM eventos_empresa WHERE id = $1', [req.params.id]);
    if (!cur.rows[0]) return reply.code(404).send({ error: 'not_found' });
    if (!canSeeBU(req.user, cur.rows[0].bu)) return reply.code(403).send({ error: 'bu_forbidden' });
    const d = p.data;
    const { rows } = await q(
      `UPDATE eventos_empresa SET
         bu=$2, titulo=$3, descripcion=$4, fecha=$5, data=COALESCE($6,data), updated_at=now()
       WHERE id=$1 RETURNING *`,
      [req.params.id, d.bu, d.titulo, nn(d.descripcion), d.fecha, d.data ?? null],
    );
    return rows[0];
  });

  app.delete('/:id', { preHandler: [app.requireAdmin()] }, async (req, reply) => {
    const cur = await q('SELECT bu FROM eventos_empresa WHERE id = $1', [req.params.id]);
    if (!cur.rows[0]) return reply.code(404).send({ error: 'not_found' });
    if (!canSeeBU(req.user, cur.rows[0].bu)) return reply.code(403).send({ error: 'bu_forbidden' });
    await q('DELETE FROM eventos_empresa WHERE id = $1', [req.params.id]);
    return { ok: true };
  });
}
