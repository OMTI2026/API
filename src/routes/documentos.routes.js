import crypto from 'node:crypto';
import { z } from 'zod';
import { env } from '../env.js';
import { q } from '../db.js';
import { visibleBUs, canSeeBU } from '../lib/scope.js';
import { presignPut, presignGet, ALLOWED_MIME, MAX_BYTES } from '../lib/r2.js';

// Catálogo de documentación de operadores y unidades (tracto/remolque) por
// proveedor. Recurso plano: cada fila es una entidad con sus campos/vencimientos
// y referencias a fotos en `data`. Sigue el patrón de carriers.routes.js.

const buEnum = z.enum(['broker', 'flota', 'ambos']);
const entidadEnum = z.enum(['operador', 'tracto', 'remolque']);

function safeName(name) {
  return String(name).replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 80);
}

const createSchema = z.object({
  bu: buEnum,
  carrier_id: z.string().uuid().optional().nullable(),
  entidad: entidadEnum,
  referencia: z.string().min(1),
  data: z.record(z.any()).optional(),
});

export default async function documentosRoutes(app) {
  app.addHook('preHandler', app.authenticate);

  // Lista por BU visible. Filtros opcionales: carrier_id, entidad, q (referencia).
  app.get('/', async (req) => {
    const params = [visibleBUs(req.user)];
    let sql = 'SELECT * FROM documentos WHERE bu = ANY($1)';
    const { carrier_id, entidad, q: term } = req.query || {};
    if (carrier_id) { params.push(carrier_id); sql += ` AND carrier_id = $${params.length}`; }
    if (entidad) { params.push(entidad); sql += ` AND entidad = $${params.length}`; }
    if (term) { params.push(`%${String(term).toLowerCase()}%`); sql += ` AND lower(referencia) LIKE $${params.length}`; }
    sql += ' ORDER BY entidad, lower(referencia)';
    const { rows } = await q(sql, params);
    return rows;
  });

  app.post('/', { preHandler: [app.requirePerm('documentos', 'edit')] }, async (req, reply) => {
    const p = createSchema.safeParse(req.body);
    if (!p.success) return reply.code(400).send({ error: 'bad_request', detail: p.error.flatten() });
    if (!canSeeBU(req.user, p.data.bu)) return reply.code(403).send({ error: 'bu_forbidden' });
    const d = p.data;
    const { rows } = await q(
      `INSERT INTO documentos (bu, carrier_id, entidad, referencia, data)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [d.bu, d.carrier_id ?? null, d.entidad, d.referencia, d.data ?? {}],
    );
    return rows[0];
  });

  app.put('/:id', { preHandler: [app.requirePerm('documentos', 'edit')] }, async (req, reply) => {
    const p = createSchema.partial().safeParse(req.body);
    if (!p.success) return reply.code(400).send({ error: 'bad_request', detail: p.error.flatten() });
    const cur = await q('SELECT bu FROM documentos WHERE id = $1', [req.params.id]);
    if (!cur.rows[0]) return reply.code(404).send({ error: 'not_found' });
    if (!canSeeBU(req.user, cur.rows[0].bu)) return reply.code(403).send({ error: 'bu_forbidden' });
    const d = p.data;
    const { rows } = await q(
      `UPDATE documentos SET
         carrier_id = COALESCE($2, carrier_id),
         entidad    = COALESCE($3, entidad),
         referencia = COALESCE($4, referencia),
         data       = COALESCE($5, data),
         updated_at = now()
       WHERE id = $1 RETURNING *`,
      [req.params.id, d.carrier_id ?? null, d.entidad ?? null, d.referencia ?? null, d.data ?? null],
    );
    return rows[0];
  });

  app.delete('/:id', { preHandler: [app.requireAdmin()] }, async (req, reply) => {
    const cur = await q('SELECT bu FROM documentos WHERE id = $1', [req.params.id]);
    if (!cur.rows[0]) return reply.code(404).send({ error: 'not_found' });
    if (!canSeeBU(req.user, cur.rows[0].bu)) return reply.code(403).send({ error: 'bu_forbidden' });
    await q('DELETE FROM documentos WHERE id = $1', [req.params.id]);
    return { ok: true };
  });

  // ── Fotos (autocontenido, sin flete) ──────────────────────────────────────
  // 1) URL PUT firmada. La referencia {key,filename} se guarda luego en data
  //    al crear/editar el registro (no hay fila en `archivos`).
  const fotoSignSchema = z.object({
    entidad: entidadEnum,
    filename: z.string().min(1),
    mime: z.string().min(1),
    bytes: z.number().int().positive(),
  });

  app.post('/foto/sign', { preHandler: [app.requirePerm('documentos', 'edit')] }, async (req, reply) => {
    const p = fotoSignSchema.safeParse(req.body);
    if (!p.success) return reply.code(400).send({ error: 'bad_request', detail: p.error.flatten() });
    const { entidad, filename, mime, bytes } = p.data;
    if (!ALLOWED_MIME.has(mime)) return reply.code(415).send({ error: 'mime_no_permitido', allowed: [...ALLOWED_MIME] });
    if (bytes > MAX_BYTES) return reply.code(413).send({ error: 'archivo_muy_grande', maxBytes: MAX_BYTES });
    const key = `${env.NODE_ENV}/documentos/${entidad}/${crypto.randomUUID()}-${safeName(filename)}`;
    try {
      const url = await presignPut(key, mime);
      return { key, url, expiresIn: 300 };
    } catch (err) {
      req.log.error(err);
      return reply.code(503).send({ error: 'r2_no_disponible' });
    }
  });

  // 2) URL GET firmada para mostrar una foto. Solo claves del prefijo documentos.
  app.get('/foto/url', async (req, reply) => {
    const key = req.query?.key;
    if (!key || typeof key !== 'string') return reply.code(400).send({ error: 'bad_request' });
    if (!key.includes('/documentos/')) return reply.code(400).send({ error: 'key_invalida' });
    try {
      const url = await presignGet(key);
      return { url, expiresIn: 600 };
    } catch (err) {
      req.log.error(err);
      return reply.code(503).send({ error: 'r2_no_disponible' });
    }
  });
}
