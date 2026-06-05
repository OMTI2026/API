import crypto from 'node:crypto';
import { z } from 'zod';
import { env } from '../env.js';
import { q } from '../db.js';
import { canSeeBU, visibleBUs } from '../lib/scope.js';
import { presignPut, presignGet, deleteObject, ALLOWED_MIME, MAX_BYTES } from '../lib/r2.js';

const CONTEXTS = ['pod', 'factura', 'comprobante', 'complemento', 'evidencia_img', 'estado_cuenta'];

function safeName(name) {
  return String(name).replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 80);
}

// Carga la BU del flete y verifica que el usuario pueda operarla. Devuelve
// `{ ok: false, code }` para que el caller responda 404 (flete inexistente) o
// 403 (existe pero fuera del alcance de BU del usuario) — sin esto, cualquier
// usuario autenticado podía leer/escribir archivos de fletes de otra BU (IDOR).
async function assertFleteScope(user, fleteId) {
  const { rows } = await q('SELECT bu FROM fletes WHERE id = $1', [fleteId]);
  if (!rows[0]) return { ok: false, code: 404 };
  if (!canSeeBU(user, rows[0].bu)) return { ok: false, code: 403 };
  return { ok: true };
}

export default async function uploadRoutes(app) {
  // Todas requieren sesión.
  app.addHook('preHandler', app.authenticate);

  const signSchema = z.object({
    fleteId: z.string().uuid(),
    contexto: z.enum(CONTEXTS),
    modulo: z.enum(['cxc', 'cxp', 'flete']).optional(),
    filename: z.string().min(1),
    mime: z.string().min(1),
    bytes: z.number().int().positive(),
  });

  // 1) Pide una URL PUT firmada (el binario va directo del cliente a R2).
  app.post('/sign', async (req, reply) => {
    const parsed = signSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'bad_request', detail: parsed.error.flatten() });
    const { fleteId, contexto, filename, mime, bytes } = parsed.data;

    if (!ALLOWED_MIME.has(mime)) return reply.code(415).send({ error: 'mime_no_permitido', allowed: [...ALLOWED_MIME] });
    if (bytes > MAX_BYTES) return reply.code(413).send({ error: 'archivo_muy_grande', maxBytes: MAX_BYTES });

    const scope = await assertFleteScope(req.user, fleteId);
    if (!scope.ok) return reply.code(scope.code).send({ error: scope.code === 404 ? 'no_encontrado' : 'bu_forbidden' });

    const key = `${env.NODE_ENV}/fletes/${fleteId}/${contexto}/${crypto.randomUUID()}-${safeName(filename)}`;
    try {
      const url = await presignPut(key, mime);
      return { key, url, expiresIn: 300 };
    } catch (err) {
      req.log.error(err);
      return reply.code(503).send({ error: 'r2_no_disponible' });
    }
  });

  const confirmSchema = z.object({
    fleteId: z.string().uuid(),
    contexto: z.enum(CONTEXTS),
    modulo: z.enum(['cxc', 'cxp', 'flete']).optional(),
    key: z.string().min(1),
    filename: z.string().min(1),
    mime: z.string().min(1),
    bytes: z.number().int().positive(),
  });

  // 2) Confirma la subida: registra metadata en `archivos`.
  app.post('/confirm', async (req, reply) => {
    const parsed = confirmSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'bad_request' });
    const { fleteId, contexto, modulo, key, filename, mime, bytes } = parsed.data;

    const scope = await assertFleteScope(req.user, fleteId);
    if (!scope.ok) return reply.code(scope.code).send({ error: scope.code === 404 ? 'no_encontrado' : 'bu_forbidden' });

    const { rows } = await q(
      `INSERT INTO archivos (flete_id, contexto, modulo, r2_key, filename, mime, bytes, uploaded_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id, contexto, filename, created_at`,
      [fleteId, contexto, modulo || null, key, filename, mime, bytes, req.user.id],
    );
    return rows[0];
  });

  // 3) URL GET firmada para mostrar/descargar.
  app.get('/:id/url', async (req, reply) => {
    const { rows } = await q(
      `SELECT a.r2_key, a.filename, a.mime, f.bu
       FROM archivos a JOIN fletes f ON f.id = a.flete_id
       WHERE a.id = $1`,
      [req.params.id],
    );
    if (!rows[0]) return reply.code(404).send({ error: 'no_encontrado' });
    if (!canSeeBU(req.user, rows[0].bu)) return reply.code(403).send({ error: 'bu_forbidden' });
    try {
      const url = await presignGet(rows[0].r2_key);
      return { url, filename: rows[0].filename, mime: rows[0].mime, expiresIn: 600 };
    } catch (err) {
      req.log.error(err);
      return reply.code(503).send({ error: 'r2_no_disponible' });
    }
  });

  // Lista archivos de un flete (opcionalmente por contexto).
  app.get('/by-flete/:fleteId', async (req, reply) => {
    const scope = await assertFleteScope(req.user, req.params.fleteId);
    if (!scope.ok) return reply.code(scope.code).send({ error: scope.code === 404 ? 'no_encontrado' : 'bu_forbidden' });

    const { contexto } = req.query;
    const params = [req.params.fleteId];
    let sql = 'SELECT id, contexto, modulo, filename, mime, bytes, created_at FROM archivos WHERE flete_id = $1';
    if (contexto) { params.push(contexto); sql += ' AND contexto = $2'; }
    sql += ' ORDER BY created_at DESC';
    const { rows } = await q(sql, params);
    return rows;
  });

  // ADMIN: lista TODOS los archivos de las BUs visibles, con folio y cliente del
  // servicio. Para la pantalla central de archivos. Filtros opcionales por
  // contexto y modulo. requireAdmin = solo administradores.
  app.get('/all', { preHandler: [app.requireAdmin()] }, async (req) => {
    const params = [visibleBUs(req.user)];
    let sql =
      `SELECT a.id, a.flete_id, a.contexto, a.modulo, a.filename, a.mime, a.bytes, a.created_at,
              f.folio, c.empresa AS cliente_nombre
       FROM archivos a
       JOIN fletes f ON f.id = a.flete_id
       LEFT JOIN clients c ON c.id = f.cliente_id
       WHERE f.bu = ANY($1)`;
    const { contexto, modulo } = req.query || {};
    if (contexto) { params.push(contexto); sql += ` AND a.contexto = $${params.length}`; }
    if (modulo) { params.push(modulo); sql += ` AND a.modulo = $${params.length}`; }
    sql += ' ORDER BY a.created_at DESC LIMIT 1000';
    const { rows } = await q(sql, params);
    return rows;
  });

  // Elimina un archivo: quita el objeto del bucket R2 + su fila en `archivos`.
  // Mismo alcance que el resto del módulo (sesión + BU del flete). El borrado de
  // documentos es operativo (el botón en FileUpload no está restringido a admin).
  app.delete('/:id', async (req, reply) => {
    const { rows } = await q(
      `SELECT a.r2_key, f.bu
       FROM archivos a JOIN fletes f ON f.id = a.flete_id
       WHERE a.id = $1`,
      [req.params.id],
    );
    if (!rows[0]) return reply.code(404).send({ error: 'no_encontrado' });
    if (!canSeeBU(req.user, rows[0].bu)) return reply.code(403).send({ error: 'bu_forbidden' });
    // Best-effort sobre R2: si el objeto ya no existe o el bucket falla, igual
    // eliminamos la metadata para no dejar un archivo "fantasma" en la UI.
    try {
      await deleteObject(rows[0].r2_key);
    } catch (err) {
      req.log.error(err, 'no se pudo borrar el objeto R2; se elimina solo la metadata');
    }
    await q('DELETE FROM archivos WHERE id = $1', [req.params.id]);
    return { ok: true };
  });
}
