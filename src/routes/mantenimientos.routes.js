import crypto from 'node:crypto';
import { z } from 'zod';
import { env } from '../env.js';
import { q, withTx } from '../db.js';
import { visibleBUs, canSeeBU } from '../lib/scope.js';
import { presignPut, presignGet, ALLOWED_MIME, MAX_BYTES } from '../lib/r2.js';

// Registros de mantenimiento de flota. Cada fila es un checklist diligenciado
// para una unidad. Sigue el patrón de documentos.routes.js / carriers.routes.js.

const buEnum = z.enum(['broker', 'flota', 'ambos']);

// Nombre de archivo saneado para la clave en R2 (igual que documentos.routes.js).
function safeName(name) {
  return String(name).replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 80);
}

// Siguiente folio de Orden de Trabajo (OT001, OT002, …) consecutivo por BU.
// Se calcula sobre data->>'folioOt' de los registros existentes. Debe correr
// dentro de una transacción con advisory lock para evitar duplicados en
// altas concurrentes.
async function nextFolioOt(client, bu) {
  await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['mant_folio_ot_' + bu]);
  const { rows } = await client.query(
    "SELECT data->>'folioOt' AS folio FROM mantenimientos WHERE bu = $1",
    [bu],
  );
  let max = 0;
  for (const r of rows) {
    const m = /^OT(\d+)$/.exec(r.folio || '');
    if (m) {
      const n = parseInt(m[1], 10);
      if (n > max) max = n;
    }
  }
  return 'OT' + String(max + 1).padStart(3, '0');
}

const createSchema = z.object({
  bu: buEnum,
  checklist_id: z.string().min(1),
  referencia: z.string().min(1),
  data: z.record(z.any()).optional(),
});

export default async function mantenimientosRoutes(app) {
  app.addHook('preHandler', app.authenticate);

  // Lista por BU visible. Filtros opcionales: checklist_id, q (referencia).
  app.get('/', async (req) => {
    const params = [visibleBUs(req.user)];
    let sql = 'SELECT * FROM mantenimientos WHERE bu = ANY($1)';
    const { checklist_id, q: term } = req.query || {};
    if (checklist_id) { params.push(checklist_id); sql += ` AND checklist_id = $${params.length}`; }
    if (term) { params.push(`%${String(term).toLowerCase()}%`); sql += ` AND lower(referencia) LIKE $${params.length}`; }
    sql += ' ORDER BY created_at DESC';
    const { rows } = await q(sql, params);
    return rows;
  });

  app.post('/', { preHandler: [app.requirePerm('mantenimiento', 'edit')] }, async (req, reply) => {
    const p = createSchema.safeParse(req.body);
    if (!p.success) return reply.code(400).send({ error: 'bad_request', detail: p.error.flatten() });
    if (!canSeeBU(req.user, p.data.bu)) return reply.code(403).send({ error: 'bu_forbidden' });
    const d = p.data;
    // Folio OT autogenerado y consecutivo (se ignora lo que mande el cliente).
    const row = await withTx(async (client) => {
      const folioOt = await nextFolioOt(client, d.bu);
      const data = { ...(d.data ?? {}), folioOt };
      const { rows } = await client.query(
        `INSERT INTO mantenimientos (bu, checklist_id, referencia, data)
         VALUES ($1,$2,$3,$4) RETURNING *`,
        [d.bu, d.checklist_id, d.referencia, data],
      );
      return rows[0];
    });
    return row;
  });

  app.put('/:id', { preHandler: [app.requirePerm('mantenimiento', 'edit')] }, async (req, reply) => {
    const p = createSchema.partial().safeParse(req.body);
    if (!p.success) return reply.code(400).send({ error: 'bad_request', detail: p.error.flatten() });
    const cur = await q('SELECT bu FROM mantenimientos WHERE id = $1', [req.params.id]);
    if (!cur.rows[0]) return reply.code(404).send({ error: 'not_found' });
    if (!canSeeBU(req.user, cur.rows[0].bu)) return reply.code(403).send({ error: 'bu_forbidden' });
    const d = p.data;
    const { rows } = await q(
      `UPDATE mantenimientos SET
         checklist_id = COALESCE($2, checklist_id),
         referencia   = COALESCE($3, referencia),
         data         = COALESCE($4, data),
         updated_at   = now()
       WHERE id = $1 RETURNING *`,
      [req.params.id, d.checklist_id ?? null, d.referencia ?? null, d.data ?? null],
    );
    return rows[0];
  });

  // ── Fotos del registro (p. ej. evidencia de la inspección diaria) ───────────
  // Patrón autocontenido sign→PUT→url (como documentos/foto/*). Las referencias
  // {key,filename,mime} se guardan luego en data.fotos al crear/editar.
  const fotoSignSchema = z.object({
    filename: z.string().min(1),
    mime: z.string().min(1),
    bytes: z.number().int().positive(),
  });

  app.post('/foto/sign', { preHandler: [app.requirePerm('mantenimiento', 'edit')] }, async (req, reply) => {
    const p = fotoSignSchema.safeParse(req.body);
    if (!p.success) return reply.code(400).send({ error: 'bad_request', detail: p.error.flatten() });
    const { filename, mime, bytes } = p.data;
    if (!ALLOWED_MIME.has(mime)) return reply.code(415).send({ error: 'mime_no_permitido', allowed: [...ALLOWED_MIME] });
    if (bytes > MAX_BYTES) return reply.code(413).send({ error: 'archivo_muy_grande', maxBytes: MAX_BYTES });
    const key = `${env.NODE_ENV}/mantenimientos/${crypto.randomUUID()}-${safeName(filename)}`;
    try {
      const url = await presignPut(key, mime);
      return { key, url, expiresIn: 300 };
    } catch (err) {
      req.log.error(err);
      return reply.code(503).send({ error: 'r2_no_disponible' });
    }
  });

  // URL GET firmada para mostrar una foto. Solo claves del prefijo mantenimientos.
  app.get('/foto/url', async (req, reply) => {
    const key = req.query?.key;
    if (!key || typeof key !== 'string') return reply.code(400).send({ error: 'bad_request' });
    if (!key.includes('/mantenimientos/')) return reply.code(400).send({ error: 'key_invalida' });
    try {
      const url = await presignGet(key);
      return { url, expiresIn: 600 };
    } catch (err) {
      req.log.error(err);
      return reply.code(503).send({ error: 'r2_no_disponible' });
    }
  });

  app.delete('/:id', { preHandler: [app.requireAdmin()] }, async (req, reply) => {
    const cur = await q('SELECT bu FROM mantenimientos WHERE id = $1', [req.params.id]);
    if (!cur.rows[0]) return reply.code(404).send({ error: 'not_found' });
    if (!canSeeBU(req.user, cur.rows[0].bu)) return reply.code(403).send({ error: 'bu_forbidden' });
    await q('DELETE FROM mantenimientos WHERE id = $1', [req.params.id]);
    return { ok: true };
  });
}
