import { z } from 'zod';
import { q } from '../db.js';
import { visibleBUs } from '../lib/scope.js';
import { cicloVacacional, contarDiasVacaciones } from '../lib/vacaciones.js';

// Vacaciones (LFT). Flujo: el empleado solicita desde su usuario vinculado y
// resuelve su JEFE DIRECTO (empleados.jefe_id) o un admin. El saldo se deriva
// del ciclo vigente (vence al siguiente aniversario, sin acumulación) y solo
// las solicitudes APROBADAS lo consumen; las pendientes lo comprometen para
// no sobre-solicitar.
//
// Permisos: /mias, /equipo, solicitar y resolver son por IDENTIDAD (usuario
// vinculado / jefe directo / admin), no por módulo. Solo el listado global
// exige empleados:view (vista RRHH y calendario del módulo).

const solicitudSchema = z.object({
  fecha_inicio: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  fecha_fin: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  comentario: z.string().optional(),
});

const rechazoSchema = z.object({ motivo: z.string().min(1) });

// Fecha de hoy en México (los servidores corren en UTC).
const hoyMx = () =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Mexico_City' }).format(new Date());

const SELECT = `
  SELECT v.*,
         NULLIF(TRIM(CONCAT(e.nombre,' ',COALESCE(e.apellido_paterno,''))),'') AS empleado_nombre,
         e.jefe_id,
         NULLIF(TRIM(CONCAT(j.nombre,' ',COALESCE(j.apellido_paterno,''))),'') AS jefe_nombre,
         ru.nombre AS resuelto_por_nombre
  FROM vacaciones v
  JOIN empleados e ON e.id = v.empleado_id
  LEFT JOIN empleados j ON j.id = e.jefe_id
  LEFT JOIN users ru ON ru.id = v.resuelto_por`;

export default async function vacacionesRoutes(app) {
  app.addHook('preHandler', app.authenticate);

  // Usuario de la app → su ficha de empleado. Auto-vincula por email si aún no
  // tiene empleado_id (mismo criterio que el backfill de la migración 0008).
  async function usuarioConEmpleado(userId) {
    const { rows } = await q('SELECT id, rol, empleado_id, email FROM users WHERE id = $1', [userId]);
    const u = rows[0];
    if (!u) return null;
    if (!u.empleado_id) {
      const m = await q(
        `UPDATE users u SET empleado_id = e.id, updated_at = now()
           FROM empleados e
          WHERE u.id = $1 AND e.email IS NOT NULL AND e.email = u.email
          RETURNING u.empleado_id`,
        [userId],
      );
      if (m.rows[0]) u.empleado_id = m.rows[0].empleado_id;
    }
    return u;
  }

  // Resumen del ciclo vigente del empleado: derecho LFT, usados (aprobadas del
  // ciclo), pendientes (comprometidos) y saldo disponible.
  async function resumenEmpleado(empleadoId) {
    const emp = (await q('SELECT * FROM empleados WHERE id = $1', [empleadoId])).rows[0];
    if (!emp) return null;
    const fechaIngreso = emp.fecha_ingreso ? String(emp.fecha_ingreso instanceof Date ? emp.fecha_ingreso.toISOString().slice(0, 10) : emp.fecha_ingreso).slice(0, 10) : null;
    const ciclo = fechaIngreso ? cicloVacacional(fechaIngreso, hoyMx()) : null;
    let usados = 0;
    let pendientes = 0;
    if (ciclo && ciclo.inicio) {
      const { rows } = await q(
        `SELECT estado, COALESCE(SUM(dias),0) AS dias FROM vacaciones
          WHERE empleado_id = $1 AND estado IN ('aprobada','pendiente')
            AND fecha_inicio >= $2 AND fecha_inicio < $3
          GROUP BY estado`,
        [empleadoId, ciclo.inicio, ciclo.fin],
      );
      for (const r of rows) {
        if (r.estado === 'aprobada') usados = Number(r.dias);
        if (r.estado === 'pendiente') pendientes = Number(r.dias);
      }
    }
    const derecho = ciclo ? ciclo.derecho : 0;
    return {
      fecha_ingreso: fechaIngreso,
      anios: ciclo ? ciclo.anios : 0,
      derecho,
      usados,
      pendientes,
      saldo: Math.max(0, derecho - usados - pendientes),
      ciclo_inicio: ciclo ? ciclo.inicio : null,
      ciclo_fin: ciclo ? ciclo.fin : null,
    };
  }

  // ── Mis vacaciones (cualquier usuario autenticado) ─────────────────────────
  app.get('/mias', async (req) => {
    const u = await usuarioConEmpleado(req.user.id);
    if (!u || !u.empleado_id) return { vinculado: false, resumen: null, solicitudes: [] };
    const resumen = await resumenEmpleado(u.empleado_id);
    const { rows } = await q(
      `${SELECT} WHERE v.empleado_id = $1 ORDER BY v.fecha_inicio DESC`,
      [u.empleado_id],
    );
    return { vinculado: true, empleado_id: u.empleado_id, resumen, solicitudes: rows };
  });

  // ── Solicitudes de mi equipo (jefe directo) ────────────────────────────────
  app.get('/equipo', async (req) => {
    const u = await usuarioConEmpleado(req.user.id);
    if (!u || !u.empleado_id) return [];
    const { rows } = await q(
      `${SELECT} WHERE e.jefe_id = $1 ORDER BY (v.estado = 'pendiente') DESC, v.fecha_inicio DESC`,
      [u.empleado_id],
    );
    return rows;
  });

  // ── Listado global (vista RRHH + calendario del módulo) ──────────────────
  app.get('/', { preHandler: [app.requirePerm('empleados', 'view')] }, async (req) => {
    const { rows } = await q(
      `${SELECT} WHERE v.bu = ANY($1) ORDER BY (v.estado = 'pendiente') DESC, v.fecha_inicio DESC`,
      [visibleBUs(req.user)],
    );
    return rows;
  });

  // ── Solicitar ──────────────────────────────────────────────────────────────
  app.post('/', async (req, reply) => {
    const p = solicitudSchema.safeParse(req.body);
    if (!p.success) return reply.code(400).send({ error: 'bad_request', detail: p.error.flatten() });
    const u = await usuarioConEmpleado(req.user.id);
    if (!u || !u.empleado_id) return reply.code(409).send({ error: 'sin_empleado' });
    const d = p.data;
    if (d.fecha_fin < d.fecha_inicio) return reply.code(400).send({ error: 'rango_invalido' });
    if (d.fecha_inicio < hoyMx()) return reply.code(400).send({ error: 'fecha_pasada' });

    const dias = contarDiasVacaciones(d.fecha_inicio, d.fecha_fin);
    if (dias < 1) return reply.code(400).send({ error: 'sin_dias_habiles' });

    const resumen = await resumenEmpleado(u.empleado_id);
    if (!resumen || !resumen.fecha_ingreso) return reply.code(409).send({ error: 'sin_fecha_ingreso' });
    if (resumen.derecho === 0) return reply.code(409).send({ error: 'sin_derecho_aun', detail: { primer_aniversario: resumen.ciclo_fin } });
    if (dias > resumen.saldo) return reply.code(409).send({ error: 'saldo_insuficiente', detail: { dias, saldo: resumen.saldo } });

    const tras = await q(
      `SELECT 1 FROM vacaciones
        WHERE empleado_id = $1 AND estado IN ('pendiente','aprobada')
          AND NOT (fecha_fin < $2 OR fecha_inicio > $3)`,
      [u.empleado_id, d.fecha_inicio, d.fecha_fin],
    );
    if (tras.rows[0]) return reply.code(409).send({ error: 'traslape' });

    const emp = (await q('SELECT bu FROM empleados WHERE id = $1', [u.empleado_id])).rows[0];
    const ins = await q(
      `INSERT INTO vacaciones (bu, empleado_id, fecha_inicio, fecha_fin, dias, comentario)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
      [emp.bu, u.empleado_id, d.fecha_inicio, d.fecha_fin, dias, d.comentario || null],
    );
    const { rows } = await q(`${SELECT} WHERE v.id = $1`, [ins.rows[0].id]);
    return rows[0];
  });

  // ¿Puede este usuario resolver la solicitud? Jefe directo del empleado o admin.
  async function puedeResolver(userId, solicitud) {
    const u = await usuarioConEmpleado(userId);
    if (!u) return false;
    if (u.rol === 'admin') return true;
    return Boolean(u.empleado_id && solicitud.jefe_id && String(u.empleado_id) === String(solicitud.jefe_id));
  }

  async function solicitudConJefe(id) {
    const { rows } = await q(`${SELECT} WHERE v.id = $1`, [id]);
    return rows[0] || null;
  }

  // ── Aprobar ────────────────────────────────────────────────────────────────
  app.post('/:id/aprobar', async (req, reply) => {
    const s = await solicitudConJefe(req.params.id);
    if (!s) return reply.code(404).send({ error: 'not_found' });
    if (!(await puedeResolver(req.user.id, s))) return reply.code(403).send({ error: 'forbidden' });
    if (s.estado !== 'pendiente') return reply.code(409).send({ error: 'no_pendiente' });
    await q(
      `UPDATE vacaciones SET estado = 'aprobada', resuelto_por = $2, resuelto_at = now(), updated_at = now() WHERE id = $1`,
      [s.id, req.user.id],
    );
    return await solicitudConJefe(s.id);
  });

  // ── Rechazar (motivo obligatorio) ─────────────────────────────────────────
  app.post('/:id/rechazar', async (req, reply) => {
    const p = rechazoSchema.safeParse(req.body);
    if (!p.success) return reply.code(400).send({ error: 'bad_request' });
    const s = await solicitudConJefe(req.params.id);
    if (!s) return reply.code(404).send({ error: 'not_found' });
    if (!(await puedeResolver(req.user.id, s))) return reply.code(403).send({ error: 'forbidden' });
    if (s.estado !== 'pendiente') return reply.code(409).send({ error: 'no_pendiente' });
    await q(
      `UPDATE vacaciones SET estado = 'rechazada', resuelto_por = $2, motivo_rechazo = $3, resuelto_at = now(), updated_at = now() WHERE id = $1`,
      [s.id, req.user.id, p.data.motivo],
    );
    return await solicitudConJefe(s.id);
  });

  // ── Cancelar ───────────────────────────────────────────────────────────────
  // El dueño cancela sus pendientes; jefe/admin también puede cancelar una
  // aprobada que aún no inicia (libera el saldo).
  app.post('/:id/cancelar', async (req, reply) => {
    const s = await solicitudConJefe(req.params.id);
    if (!s) return reply.code(404).send({ error: 'not_found' });
    const u = await usuarioConEmpleado(req.user.id);
    const esDueno = Boolean(u && u.empleado_id && String(u.empleado_id) === String(s.empleado_id));
    const esResolutor = await puedeResolver(req.user.id, s);
    const inicia = String(s.fecha_inicio instanceof Date ? s.fecha_inicio.toISOString().slice(0, 10) : s.fecha_inicio).slice(0, 10);
    const ok =
      (s.estado === 'pendiente' && (esDueno || esResolutor)) ||
      (s.estado === 'aprobada' && esResolutor && inicia > hoyMx());
    if (!ok) return reply.code(403).send({ error: 'forbidden' });
    await q(
      `UPDATE vacaciones SET estado = 'cancelada', resuelto_por = $2, resuelto_at = now(), updated_at = now() WHERE id = $1`,
      [s.id, req.user.id],
    );
    return await solicitudConJefe(s.id);
  });
}
