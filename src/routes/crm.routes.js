import { z } from 'zod';
import { q, withTx } from '../db.js';
import { visibleBUs, canSeeBU } from '../lib/scope.js';

// CRM · Prospección de clientes (Fase 1). CRUD scopeado por BU, calcado de
// clients/cotizaciones. Un prospecto es una cuenta que estamos buscando; NO se
// liga a la operación hasta que se "gana" y se convierte en cliente (endpoint
// /:id/convertir, que crea el registro en `clients` y llena cliente_id).
// Permiso: módulo 'crm'. Los contactos y campos comerciales viven en `data`.

const buEnum = z.enum(['broker', 'flota', 'ambos']);
const etapaEnum = z.enum(['nuevo', 'contactado', 'propuesta', 'negociacion', 'ganado', 'perdido']);

const baseSchema = z.object({
  bu: buEnum,
  empresa: z.string().min(1),
  contacto: z.string().optional(),
  etapa: etapaEnum.optional(),
  data: z.record(z.any()).optional(),
});

const tipoActEnum = z.enum(['llamada', 'correo', 'visita', 'whatsapp', 'reunion', 'nota']);
const actividadSchema = z.object({
  tipo: tipoActEnum.optional(),
  fecha: z.string().optional(), // ISO; por defecto now() en la BD
  responsable: z.string().optional(),
  nota: z.string().optional(),
  data: z.record(z.any()).optional(),
});

// La edición/avance de un prospecto se restringe a su DUEÑO (owner_id = el
// usuario que lo registró). Excepción: admin y gerente editan cualquiera. Los
// prospectos sin dueño (previos a la regla) quedan abiertos para no bloquearlos.
function esPrivilegiado(user) {
  return user?.rol === 'admin' || user?.rol === 'gerente';
}
function puedeEditarProspecto(user, row) {
  return esPrivilegiado(user) || row.owner_id == null || String(row.owner_id) === String(user?.id);
}

export default async function crmRoutes(app) {
  app.addHook('preHandler', app.authenticate);

  // Lista por BU visible. Filtro opcional: etapa.
  app.get('/', async (req) => {
    const params = [visibleBUs(req.user)];
    let sql = 'SELECT * FROM prospectos WHERE bu = ANY($1)';
    const { etapa } = req.query || {};
    if (etapa) {
      params.push(etapa);
      sql += ` AND etapa = $${params.length}`;
    }
    sql += ' ORDER BY created_at DESC';
    const { rows } = await q(sql, params);
    return rows;
  });

  app.post('/', { preHandler: [app.requirePerm('crm', 'edit')] }, async (req, reply) => {
    const p = baseSchema.safeParse(req.body);
    if (!p.success) return reply.code(400).send({ error: 'bad_request', detail: p.error.flatten() });
    if (!canSeeBU(req.user, p.data.bu)) return reply.code(403).send({ error: 'bu_forbidden' });
    const d = p.data;
    // El creador queda como dueño del prospecto (control de edición).
    const { rows } = await q(
      `INSERT INTO prospectos (bu, empresa, contacto, etapa, data, owner_id)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [d.bu, d.empresa, d.contacto ?? null, d.etapa ?? 'nuevo', d.data ?? {}, req.user.id],
    );
    return rows[0];
  });

  app.put('/:id', { preHandler: [app.requirePerm('crm', 'edit')] }, async (req, reply) => {
    const p = baseSchema.partial().safeParse(req.body);
    if (!p.success) return reply.code(400).send({ error: 'bad_request', detail: p.error.flatten() });
    const cur = await q('SELECT bu, owner_id FROM prospectos WHERE id = $1', [req.params.id]);
    if (!cur.rows[0]) return reply.code(404).send({ error: 'not_found' });
    if (!canSeeBU(req.user, cur.rows[0].bu)) return reply.code(403).send({ error: 'bu_forbidden' });
    if (!puedeEditarProspecto(req.user, cur.rows[0])) return reply.code(403).send({ error: 'not_owner' });
    const d = p.data;
    const { rows } = await q(
      `UPDATE prospectos SET
         empresa    = COALESCE($2, empresa),
         contacto   = COALESCE($3, contacto),
         etapa      = COALESCE($4, etapa),
         data       = COALESCE($5, data),
         updated_at = now()
       WHERE id = $1 RETURNING *`,
      [req.params.id, d.empresa ?? null, d.contacto ?? null, d.etapa ?? null, d.data ?? null],
    );
    return rows[0];
  });

  // Conversión: el prospecto se GANA → se crea el cliente en el TMS y se liga
  // (cliente_id) marcando etapa 'ganado'. Transaccional. A partir de aquí opera
  // como cualquier cliente del TMS. Idempotente: si ya se convirtió, 409.
  app.post('/:id/convertir', { preHandler: [app.requirePerm('crm', 'edit')] }, async (req, reply) => {
    const cur = await q('SELECT * FROM prospectos WHERE id = $1', [req.params.id]);
    const pr = cur.rows[0];
    if (!pr) return reply.code(404).send({ error: 'not_found' });
    if (!canSeeBU(req.user, pr.bu)) return reply.code(403).send({ error: 'bu_forbidden' });
    if (!puedeEditarProspecto(req.user, pr)) return reply.code(403).send({ error: 'not_owner' });
    if (pr.cliente_id) return reply.code(409).send({ error: 'ya_convertido', cliente_id: pr.cliente_id });

    const result = await withTx(async (client) => {
      const cli = await client.query(
        `INSERT INTO clients (bu, empresa, rfc, contacto, data)
         VALUES ($1,$2,$3,$4,$5) RETURNING *`,
        [pr.bu, pr.empresa, pr.data?.rfc ?? null, pr.contacto ?? null, { origenProspectoId: pr.id }],
      );
      const upd = await client.query(
        `UPDATE prospectos SET cliente_id = $2, etapa = 'ganado', updated_at = now()
         WHERE id = $1 RETURNING *`,
        [pr.id, cli.rows[0].id],
      );
      return { prospecto: upd.rows[0], cliente: cli.rows[0] };
    });
    return result;
  });

  app.delete('/:id', { preHandler: [app.requireAdmin()] }, async (req, reply) => {
    const cur = await q('SELECT bu FROM prospectos WHERE id = $1', [req.params.id]);
    if (!cur.rows[0]) return reply.code(404).send({ error: 'not_found' });
    if (!canSeeBU(req.user, cur.rows[0].bu)) return reply.code(403).send({ error: 'bu_forbidden' });
    await q('DELETE FROM prospectos WHERE id = $1', [req.params.id]);
    return { ok: true };
  });

  // ── Bitácora de actividades (Fase 2) ─────────────────────────────────────
  // Feed global para la vista de dueño: actividades por BU visible, filtrable
  // por rango de fechas (?desde, ?hasta ISO) y ?responsable. Incluye la empresa
  // del prospecto. (Ruta estática: no choca con /:id, que no tiene GET.)
  app.get('/actividades', async (req) => {
    const params = [visibleBUs(req.user)];
    let sql = `SELECT a.*, p.empresa
               FROM prospecto_actividades a
               JOIN prospectos p ON p.id = a.prospecto_id
               WHERE a.bu = ANY($1)`;
    const { desde, hasta, responsable } = req.query || {};
    if (desde) { params.push(desde); sql += ` AND a.fecha >= $${params.length}`; }
    if (hasta) { params.push(hasta); sql += ` AND a.fecha < $${params.length}`; }
    if (responsable) { params.push(responsable); sql += ` AND a.responsable = $${params.length}`; }
    sql += ' ORDER BY a.fecha DESC LIMIT 500';
    const { rows } = await q(sql, params);
    return rows;
  });

  // Borrar una actividad (limpieza/corrección). Solo admin. (Ruta estática antes
  // que /:id/…, sin ambigüedad porque tiene dos segmentos.)
  app.delete('/actividades/:aid', { preHandler: [app.requireAdmin()] }, async (req, reply) => {
    const cur = await q('SELECT bu FROM prospecto_actividades WHERE id = $1', [req.params.aid]);
    if (!cur.rows[0]) return reply.code(404).send({ error: 'not_found' });
    if (!canSeeBU(req.user, cur.rows[0].bu)) return reply.code(403).send({ error: 'bu_forbidden' });
    await q('DELETE FROM prospecto_actividades WHERE id = $1', [req.params.aid]);
    return { ok: true };
  });

  // Línea de tiempo de un prospecto (ficha).
  app.get('/:id/actividades', async (req, reply) => {
    const cur = await q('SELECT bu FROM prospectos WHERE id = $1', [req.params.id]);
    if (!cur.rows[0]) return reply.code(404).send({ error: 'not_found' });
    if (!canSeeBU(req.user, cur.rows[0].bu)) return reply.code(403).send({ error: 'bu_forbidden' });
    const { rows } = await q(
      'SELECT * FROM prospecto_actividades WHERE prospecto_id = $1 ORDER BY fecha DESC',
      [req.params.id],
    );
    return rows;
  });

  // Registrar una actividad; actualiza `ultimo_contacto` del prospecto (semáforo).
  app.post('/:id/actividades', { preHandler: [app.requirePerm('crm', 'edit')] }, async (req, reply) => {
    const p = actividadSchema.safeParse(req.body);
    if (!p.success) return reply.code(400).send({ error: 'bad_request', detail: p.error.flatten() });
    const cur = await q('SELECT bu, owner_id FROM prospectos WHERE id = $1', [req.params.id]);
    if (!cur.rows[0]) return reply.code(404).send({ error: 'not_found' });
    if (!canSeeBU(req.user, cur.rows[0].bu)) return reply.code(403).send({ error: 'bu_forbidden' });
    if (!puedeEditarProspecto(req.user, cur.rows[0])) return reply.code(403).send({ error: 'not_owner' });
    const d = p.data;
    const result = await withTx(async (client) => {
      const act = await client.query(
        `INSERT INTO prospecto_actividades (prospecto_id, bu, tipo, fecha, responsable, nota, data)
         VALUES ($1,$2,$3,COALESCE($4::timestamptz, now()),$5,$6,$7) RETURNING *`,
        [req.params.id, cur.rows[0].bu, d.tipo ?? 'nota', d.fecha ?? null, d.responsable ?? null, d.nota ?? null, d.data ?? {}],
      );
      await client.query(
        `UPDATE prospectos
           SET ultimo_contacto = GREATEST(COALESCE(ultimo_contacto, to_timestamp(0)), $2::timestamptz),
               updated_at = now()
         WHERE id = $1`,
        [req.params.id, act.rows[0].fecha],
      );
      return act.rows[0];
    });
    return result;
  });
}
