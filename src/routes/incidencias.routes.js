import crypto from 'node:crypto';
import { z } from 'zod';
import { env } from '../env.js';
import { q } from '../db.js';
import { visibleBUs, canSeeBU } from '../lib/scope.js';
import { presignPut, presignGet, ALLOWED_MIME, MAX_BYTES } from '../lib/r2.js';

// Incidencias de operador (Flota Propia). Alimentan el Desempeño del Operador.
// Escritura reservada a Gerencia/Admin (registran RRHH/gerente de flota);
// lectura para cualquier usuario autenticado de la BU. Evidencia (foto/PDF) a
// R2 vía sign→PUT→url, guardada como {key,filename,mime} en data.evidencia.
// Sigue el patrón de gastos-operativos.routes.js.

function safeName(name) {
  return String(name).replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 80);
}

const buEnum = z.enum(['broker', 'flota', 'ambos']);
const TIPOS = ['multa', 'dano_unidad', 'dano_carga', 'queja', 'falta_admin', 'accidente'];
const GRAVEDADES = ['leve', 'media', 'grave'];

const baseSchema = z.object({
  bu: buEnum,
  operador: z.string().min(1),
  fecha: z.string().min(1),
  tipo: z.enum(TIPOS),
  gravedad: z.enum(GRAVEDADES).default('media'),
  descripcion: z.string().optional(),
  costo: z.number().nullable().optional(),
  unidad: z.string().optional(),
  flete_id: z.string().uuid().nullable().optional(),
  estado: z.enum(['abierta', 'resuelta']).default('abierta'),
  data: z.record(z.any()).optional(),
});

const COLS = 'id, bu, operador, fecha, tipo, gravedad, descripcion, costo, unidad, flete_id, estado, data, created_at, updated_at';

const fotoSignSchema = z.object({
  filename: z.string().min(1),
  mime: z.string().min(1),
  bytes: z.number().int().positive(),
});

export default async function incidenciasRoutes(app) {
  app.addHook('preHandler', app.authenticate);

  // Presign PUT para la evidencia (foto/PDF). Autocontenido.
  app.post('/evidencia/sign', { preHandler: [app.requireMinRole('gerente')] }, async (req, reply) => {
    const p = fotoSignSchema.safeParse(req.body);
    if (!p.success) return reply.code(400).send({ error: 'bad_request', detail: p.error.flatten() });
    const { filename, mime, bytes } = p.data;
    if (!ALLOWED_MIME.has(mime)) return reply.code(415).send({ error: 'mime_no_permitido', allowed: [...ALLOWED_MIME] });
    if (bytes > MAX_BYTES) return reply.code(413).send({ error: 'archivo_muy_grande', maxBytes: MAX_BYTES });
    const key = `${env.NODE_ENV}/incidencias/${crypto.randomUUID()}-${safeName(filename)}`;
    try {
      const url = await presignPut(key, mime);
      return { key, url, expiresIn: 300 };
    } catch (err) {
      req.log.error(err);
      return reply.code(503).send({ error: 'r2_no_disponible' });
    }
  });

  // URL GET firmada para mostrar/descargar la evidencia. Solo claves del prefijo.
  app.get('/evidencia/url', async (req, reply) => {
    const key = req.query?.key;
    if (!key || typeof key !== 'string') return reply.code(400).send({ error: 'bad_request' });
    if (!key.includes('/incidencias/')) return reply.code(400).send({ error: 'key_invalida' });
    try {
      const url = await presignGet(key);
      return { url, expiresIn: 600 };
    } catch (err) {
      req.log.error(err);
      return reply.code(503).send({ error: 'r2_no_disponible' });
    }
  });

  // Lista por BU visible. Filtro opcional: ?operador=.
  app.get('/', async (req) => {
    const params = [visibleBUs(req.user)];
    let sql = `SELECT ${COLS} FROM incidencias WHERE bu = ANY($1)`;
    if (req.query?.operador) {
      params.push(req.query.operador);
      sql += ` AND lower(operador) = lower($${params.length})`;
    }
    sql += ' ORDER BY fecha DESC, created_at DESC';
    const { rows } = await q(sql, params);
    return rows;
  });

  app.post('/', { preHandler: [app.requireMinRole('gerente')] }, async (req, reply) => {
    const p = baseSchema.safeParse(req.body);
    if (!p.success) return reply.code(400).send({ error: 'bad_request', detail: p.error.flatten() });
    const d = p.data;
    if (!canSeeBU(req.user, d.bu)) return reply.code(403).send({ error: 'bu_forbidden' });
    const { rows } = await q(
      `INSERT INTO incidencias (bu, operador, fecha, tipo, gravedad, descripcion, costo, unidad, flete_id, estado, data)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb) RETURNING ${COLS}`,
      [d.bu, d.operador, d.fecha, d.tipo, d.gravedad, d.descripcion ?? null, d.costo ?? null, d.unidad ?? null,
        d.flete_id ?? null, d.estado, JSON.stringify(d.data || {})],
    );
    return rows[0];
  });

  app.put('/:id', { preHandler: [app.requireMinRole('gerente')] }, async (req, reply) => {
    const cur = await q('SELECT bu FROM incidencias WHERE id = $1', [req.params.id]);
    if (!cur.rows[0]) return reply.code(404).send({ error: 'not_found' });
    if (!canSeeBU(req.user, cur.rows[0].bu)) return reply.code(403).send({ error: 'bu_forbidden' });
    const p = baseSchema.partial().safeParse(req.body);
    if (!p.success) return reply.code(400).send({ error: 'bad_request', detail: p.error.flatten() });
    const d = p.data;
    const { rows } = await q(
      `UPDATE incidencias SET
         operador = COALESCE($2, operador),
         fecha = COALESCE($3, fecha),
         tipo = COALESCE($4, tipo),
         gravedad = COALESCE($5, gravedad),
         descripcion = COALESCE($6, descripcion),
         costo = COALESCE($7, costo),
         unidad = COALESCE($8, unidad),
         flete_id = COALESCE($9, flete_id),
         estado = COALESCE($10, estado),
         data = COALESCE($11::jsonb, data),
         updated_at = now()
       WHERE id = $1 RETURNING ${COLS}`,
      [req.params.id, d.operador ?? null, d.fecha ?? null, d.tipo ?? null, d.gravedad ?? null,
        d.descripcion ?? null, d.costo ?? null, d.unidad ?? null, d.flete_id ?? null, d.estado ?? null,
        d.data ? JSON.stringify(d.data) : null],
    );
    return rows[0];
  });

  app.delete('/:id', { preHandler: [app.requireAdmin()] }, async (req, reply) => {
    const cur = await q('SELECT bu FROM incidencias WHERE id = $1', [req.params.id]);
    if (!cur.rows[0]) return reply.code(404).send({ error: 'not_found' });
    if (!canSeeBU(req.user, cur.rows[0].bu)) return reply.code(403).send({ error: 'bu_forbidden' });
    await q('DELETE FROM incidencias WHERE id = $1', [req.params.id]);
    return { ok: true };
  });
}
