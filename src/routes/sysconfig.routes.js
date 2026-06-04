import { z } from 'zod';
import { q } from '../db.js';

// Configuración del sistema (tema, logo, ajustes varios).
// Antes vivía solo en localStorage del frontend (sysConfig = {theme, logoDataUrl, lang, timezone}).
//
// Resolución de BU:
//  - Usuario con BU específica (broker|flota) -> su propia fila.
//  - Usuario 'ambos' -> configuración GLOBAL (fila con bu NULL).
// Esto evita ambigüedad: un usuario 'ambos' administra el tema/logo global.

const WRITE = ['admin']; // solo admin puede escribir config

const putSchema = z.object({
  theme: z.string().min(1).optional(),
  logo_ref: z.string().nullable().optional(),
  settings: z.record(z.any()).optional(), // lang, timezone, etc.
});

// BU efectiva para este usuario: específica o NULL (global) si es 'ambos'.
function configBU(user) {
  return user.bu === 'ambos' ? null : user.bu;
}

// Fila por defecto cuando aún no hay config guardada.
function defaultConfig(bu) {
  return { bu, theme: 'elroi', logo_ref: null, settings: {} };
}

export default async function sysconfigRoutes(app) {
  app.addHook('preHandler', app.authenticate);

  // GET /sysconfig — config actual para la BU del usuario (o global si 'ambos').
  app.get('/', async (req) => {
    const bu = configBU(req.user);
    const { rows } = bu
      ? await q('SELECT * FROM sys_config WHERE bu = $1', [bu])
      : await q('SELECT * FROM sys_config WHERE bu IS NULL', []);
    return rows[0] || defaultConfig(bu);
  });

  // PUT /sysconfig — upsert (solo admin). Mergea settings JSONB.
  app.put('/', { preHandler: [app.requireAdmin()] }, async (req, reply) => {
    const p = putSchema.safeParse(req.body);
    if (!p.success) return reply.code(400).send({ error: 'bad_request', detail: p.error.flatten() });
    const bu = configBU(req.user);
    const d = p.data;

    // ON CONFLICT necesita una condición; los índices únicos son parciales,
    // así que hacemos el upsert manual (SELECT -> INSERT/UPDATE) sobre la fila.
    const cur = bu
      ? await q('SELECT id FROM sys_config WHERE bu = $1', [bu])
      : await q('SELECT id FROM sys_config WHERE bu IS NULL', []);

    if (cur.rows[0]) {
      const { rows } = await q(
        `UPDATE sys_config SET
           theme = COALESCE($2, theme),
           logo_ref = CASE WHEN $3::boolean THEN $4 ELSE logo_ref END,
           settings = settings || COALESCE($5,'{}'::jsonb),
           updated_at = now(), updated_by = $6
         WHERE id = $1 RETURNING *`,
        [
          cur.rows[0].id,
          d.theme ?? null,
          Object.prototype.hasOwnProperty.call(d, 'logo_ref'),
          d.logo_ref ?? null,
          d.settings ? JSON.stringify(d.settings) : null,
          req.user.id,
        ],
      );
      return rows[0];
    }

    const { rows } = await q(
      `INSERT INTO sys_config (bu, theme, logo_ref, settings, updated_by)
       VALUES ($1, COALESCE($2,'elroi'), $3, COALESCE($4,'{}'::jsonb), $5) RETURNING *`,
      [bu, d.theme ?? null, d.logo_ref ?? null, d.settings ? JSON.stringify(d.settings) : null, req.user.id],
    );
    return reply.code(201).send(rows[0]);
  });
}
