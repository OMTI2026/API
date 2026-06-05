import { z } from 'zod';
import { q } from '../db.js';
import { visibleBUs, canSeeBU } from '../lib/scope.js';

const buEnum = z.enum(['broker', 'flota', 'ambos']);
const puestoSchema = z.object({
  bu: buEnum,
  nombre: z.string().min(1),
  area_id: z.string().uuid().nullable().optional(),
  nivel: z.number().int().min(1).max(9).optional(),
  descripcion: z.string().optional(),
  activo: z.boolean().optional(),
  data: z.record(z.any()).optional(),
});
const nn = (v) => (v === '' || v === undefined ? null : v);

const SELECT = `
  SELECT p.*,
    a.nombre AS area_nombre,
    (SELECT count(*)::int FROM empleados e WHERE e.puesto_id = p.id) AS empleados_count
  FROM puestos p LEFT JOIN areas a ON a.id = p.area_id`;

export default async function puestosRoutes(app) {
  app.addHook('preHandler', app.authenticate);

  app.get('/', async (req) => {
    const { rows } = await q(`${SELECT} WHERE p.bu = ANY($1) ORDER BY p.nivel, p.nombre`, [visibleBUs(req.user)]);
    return rows;
  });

  app.post('/', { preHandler: [app.requirePerm('empleados', 'edit')] }, async (req, reply) => {
    const p = puestoSchema.safeParse(req.body);
    if (!p.success) return reply.code(400).send({ error: 'bad_request', detail: p.error.flatten() });
    if (!canSeeBU(req.user, p.data.bu)) return reply.code(403).send({ error: 'bu_forbidden' });
    const d = p.data;
    const { rows } = await q(
      `INSERT INTO puestos (bu,nombre,area_id,nivel,descripcion,activo,data)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [d.bu, d.nombre, nn(d.area_id), d.nivel ?? 3, nn(d.descripcion), d.activo ?? true, d.data ?? {}],
    );
    return rows[0];
  });

  app.put('/:id', { preHandler: [app.requireAdmin()] }, async (req, reply) => {
    const p = puestoSchema.safeParse(req.body);
    if (!p.success) return reply.code(400).send({ error: 'bad_request' });
    const cur = await q('SELECT bu FROM puestos WHERE id = $1', [req.params.id]);
    if (!cur.rows[0]) return reply.code(404).send({ error: 'not_found' });
    if (!canSeeBU(req.user, cur.rows[0].bu)) return reply.code(403).send({ error: 'bu_forbidden' });
    const d = p.data;
    const { rows } = await q(
      `UPDATE puestos SET bu=$2,nombre=$3,area_id=$4,nivel=$5,descripcion=$6,activo=$7,
         data=COALESCE($8,data) WHERE id=$1 RETURNING *`,
      [req.params.id, d.bu, d.nombre, nn(d.area_id), d.nivel ?? 3, nn(d.descripcion), d.activo ?? true, d.data ?? null],
    );
    return rows[0];
  });

  app.delete('/:id', { preHandler: [app.requireAdmin()] }, async (req, reply) => {
    const cur = await q('SELECT bu FROM puestos WHERE id = $1', [req.params.id]);
    if (!cur.rows[0]) return reply.code(404).send({ error: 'not_found' });
    if (!canSeeBU(req.user, cur.rows[0].bu)) return reply.code(403).send({ error: 'bu_forbidden' });
    await q('DELETE FROM puestos WHERE id = $1', [req.params.id]);
    return { ok: true };
  });
}
