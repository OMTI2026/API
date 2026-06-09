import { z } from 'zod';
import { q } from '../db.js';
import { visibleBUs, canSeeBU } from '../lib/scope.js';

const buEnum = z.enum(['broker', 'flota', 'ambos']);
const estatusEnum = z.enum(['activo', 'baja', 'inactivo']);

// El frontend envía la ficha completa en cada save (create y update), por eso
// el update también usa el schema completo y asigna directo (permite limpiar
// referencias a null). Campos extra (dirección, contacto de emergencia, etc.)
// viajan en `data`.
const empleadoSchema = z.object({
  bu: buEnum,
  nombre: z.string().min(1),
  apellido_paterno: z.string().optional(),
  apellido_materno: z.string().optional(),
  email: z.string().optional(),
  telefono: z.string().optional(),
  area_id: z.string().uuid().nullable().optional(),
  puesto_id: z.string().uuid().nullable().optional(),
  jefe_id: z.string().uuid().nullable().optional(),
  fecha_ingreso: z.string().nullable().optional(),
  estatus: estatusEnum.optional(),
  rfc: z.string().optional(),
  curp: z.string().optional(),
  nss: z.string().optional(),
  fecha_nacimiento: z.string().nullable().optional(),
  data: z.record(z.any()).optional(),
});

// '' o undefined -> null (para columnas uuid/date/text nulables).
const nn = (v) => (v === '' || v === undefined ? null : v);

const SELECT = `
  SELECT e.*,
         a.nombre AS area_nombre,
         p.nombre AS puesto_nombre,
         NULLIF(TRIM(CONCAT(j.nombre,' ',COALESCE(j.apellido_paterno,''))),'') AS jefe_nombre
  FROM empleados e
  LEFT JOIN areas a   ON a.id = e.area_id
  LEFT JOIN puestos p ON p.id = e.puesto_id
  LEFT JOIN empleados j ON j.id = e.jefe_id`;

export default async function empleadosRoutes(app) {
  app.addHook('preHandler', app.authenticate);

  app.get('/', { preHandler: [app.requirePerm('empleados', 'view')] }, async (req) => {
    const { rows } = await q(
      `${SELECT} WHERE e.bu = ANY($1) ORDER BY e.nombre, e.apellido_paterno`,
      [visibleBUs(req.user)],
    );
    return rows;
  });

  app.post('/', { preHandler: [app.requirePerm('empleados', 'edit')] }, async (req, reply) => {
    const p = empleadoSchema.safeParse(req.body);
    if (!p.success) return reply.code(400).send({ error: 'bad_request', detail: p.error.flatten() });
    if (!canSeeBU(req.user, p.data.bu)) return reply.code(403).send({ error: 'bu_forbidden' });
    const d = p.data;
    const { rows } = await q(
      `INSERT INTO empleados
         (bu,nombre,apellido_paterno,apellido_materno,email,telefono,area_id,puesto_id,jefe_id,
          fecha_ingreso,estatus,rfc,curp,nss,fecha_nacimiento,data)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING *`,
      [d.bu, d.nombre, nn(d.apellido_paterno), nn(d.apellido_materno), nn(d.email), nn(d.telefono),
       nn(d.area_id), nn(d.puesto_id), nn(d.jefe_id), nn(d.fecha_ingreso), d.estatus ?? 'activo',
       nn(d.rfc), nn(d.curp), nn(d.nss), nn(d.fecha_nacimiento), d.data ?? {}],
    );
    return rows[0];
  });

  app.put('/:id', { preHandler: [app.requireAdmin()] }, async (req, reply) => {
    const p = empleadoSchema.safeParse(req.body);
    if (!p.success) return reply.code(400).send({ error: 'bad_request', detail: p.error.flatten() });
    const cur = await q('SELECT bu FROM empleados WHERE id = $1', [req.params.id]);
    if (!cur.rows[0]) return reply.code(404).send({ error: 'not_found' });
    if (!canSeeBU(req.user, cur.rows[0].bu)) return reply.code(403).send({ error: 'bu_forbidden' });
    if (nn(p.data.jefe_id) === req.params.id) return reply.code(400).send({ error: 'jefe_invalido' });
    const d = p.data;
    const { rows } = await q(
      `UPDATE empleados SET
         bu=$2, nombre=$3, apellido_paterno=$4, apellido_materno=$5, email=$6, telefono=$7,
         area_id=$8, puesto_id=$9, jefe_id=$10, fecha_ingreso=$11, estatus=$12,
         rfc=$13, curp=$14, nss=$15, fecha_nacimiento=$16, data=COALESCE($17,data), updated_at=now()
       WHERE id=$1 RETURNING *`,
      [req.params.id, d.bu, d.nombre, nn(d.apellido_paterno), nn(d.apellido_materno), nn(d.email),
       nn(d.telefono), nn(d.area_id), nn(d.puesto_id), nn(d.jefe_id), nn(d.fecha_ingreso),
       d.estatus ?? 'activo', nn(d.rfc), nn(d.curp), nn(d.nss), nn(d.fecha_nacimiento), d.data ?? null],
    );
    return rows[0];
  });

  app.delete('/:id', { preHandler: [app.requireAdmin()] }, async (req, reply) => {
    const cur = await q('SELECT bu FROM empleados WHERE id = $1', [req.params.id]);
    if (!cur.rows[0]) return reply.code(404).send({ error: 'not_found' });
    if (!canSeeBU(req.user, cur.rows[0].bu)) return reply.code(403).send({ error: 'bu_forbidden' });
    await q('DELETE FROM empleados WHERE id = $1', [req.params.id]);
    return { ok: true };
  });
}
