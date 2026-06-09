import { z } from 'zod';
import { q } from '../db.js';
import { visibleBUs, canSeeBU } from '../lib/scope.js';

const buEnum = z.enum(['broker', 'flota', 'ambos']);
const areaSchema = z.object({
  bu: buEnum,
  nombre: z.string().min(1),
  descripcion: z.string().optional(),
  responsable_id: z.string().uuid().nullable().optional(),
  activo: z.boolean().optional(),
  data: z.record(z.any()).optional(),
});
const nn = (v) => (v === '' || v === undefined ? null : v);

const SELECT = `
  SELECT a.*,
    NULLIF(TRIM(CONCAT(r.nombre,' ',COALESCE(r.apellido_paterno,''))),'') AS responsable_nombre,
    (SELECT count(*)::int FROM empleados e WHERE e.area_id = a.id) AS empleados_count
  FROM areas a LEFT JOIN empleados r ON r.id = a.responsable_id`;

export default async function areasRoutes(app) {
  app.addHook('preHandler', app.authenticate);

  app.get('/', { preHandler: [app.requirePerm('empleados', 'view')] }, async (req) => {
    const { rows } = await q(`${SELECT} WHERE a.bu = ANY($1) ORDER BY a.nombre`, [visibleBUs(req.user)]);
    return rows;
  });

  app.post('/', { preHandler: [app.requirePerm('empleados', 'edit')] }, async (req, reply) => {
    const p = areaSchema.safeParse(req.body);
    if (!p.success) return reply.code(400).send({ error: 'bad_request', detail: p.error.flatten() });
    if (!canSeeBU(req.user, p.data.bu)) return reply.code(403).send({ error: 'bu_forbidden' });
    const d = p.data;
    const { rows } = await q(
      `INSERT INTO areas (bu,nombre,descripcion,responsable_id,activo,data)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [d.bu, d.nombre, nn(d.descripcion), nn(d.responsable_id), d.activo ?? true, d.data ?? {}],
    );
    return rows[0];
  });

  app.put('/:id', { preHandler: [app.requireAdmin()] }, async (req, reply) => {
    const p = areaSchema.safeParse(req.body);
    if (!p.success) return reply.code(400).send({ error: 'bad_request' });
    const cur = await q('SELECT bu FROM areas WHERE id = $1', [req.params.id]);
    if (!cur.rows[0]) return reply.code(404).send({ error: 'not_found' });
    if (!canSeeBU(req.user, cur.rows[0].bu)) return reply.code(403).send({ error: 'bu_forbidden' });
    const d = p.data;
    const { rows } = await q(
      `UPDATE areas SET bu=$2,nombre=$3,descripcion=$4,responsable_id=$5,activo=$6,
         data=COALESCE($7,data) WHERE id=$1 RETURNING *`,
      [req.params.id, d.bu, d.nombre, nn(d.descripcion), nn(d.responsable_id), d.activo ?? true, d.data ?? null],
    );
    return rows[0];
  });

  app.delete('/:id', { preHandler: [app.requireAdmin()] }, async (req, reply) => {
    const cur = await q('SELECT bu FROM areas WHERE id = $1', [req.params.id]);
    if (!cur.rows[0]) return reply.code(404).send({ error: 'not_found' });
    if (!canSeeBU(req.user, cur.rows[0].bu)) return reply.code(403).send({ error: 'bu_forbidden' });
    await q('DELETE FROM areas WHERE id = $1', [req.params.id]);
    return { ok: true };
  });
}
