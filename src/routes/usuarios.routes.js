import { z } from 'zod';
import { q } from '../db.js';
import { hashPassword } from '../lib/argon.js';

const buEnum = z.enum(['broker', 'flota', 'ambos']);
const rolEnum = z.enum(['admin', 'gerente', 'operaciones', 'finanzas', 'readonly']);

export default async function usuariosRoutes(app) {
  // Todo el módulo es solo-admin.
  app.addHook('preHandler', app.authenticate);
  app.addHook('preHandler', app.requireRole('admin'));

  app.get('/', async () => {
    const { rows } = await q(
      `SELECT id, nombre, email, rol, bu, activo, must_change_password,
        totp_secret IS NOT NULL AS has_2fa, created_at
       FROM users ORDER BY created_at DESC`,
    );
    return rows;
  });

  const createSchema = z.object({
    nombre: z.string().min(1),
    email: z.string().email(),
    password: z.string().min(8),
    rol: rolEnum,
    bu: buEnum,
  });

  app.post('/', async (req, reply) => {
    const p = createSchema.safeParse(req.body);
    if (!p.success) return reply.code(400).send({ error: 'bad_request', detail: p.error.flatten() });
    const d = p.data;
    const dup = await q('SELECT 1 FROM users WHERE email = $1', [d.email]);
    if (dup.rows[0]) return reply.code(409).send({ error: 'email_existe' });
    const hash = await hashPassword(d.password);
    const { rows } = await q(
      `INSERT INTO users (nombre, email, pass_hash, rol, bu, activo, must_change_password)
       VALUES ($1,$2,$3,$4,$5,true,true)
       RETURNING id, nombre, email, rol, bu, activo, must_change_password, created_at`,
      [d.nombre, d.email, hash, d.rol, d.bu],
    );
    return reply.code(201).send(rows[0]);
  });

  const updateSchema = z.object({
    nombre: z.string().min(1).optional(),
    rol: rolEnum.optional(),
    bu: buEnum.optional(),
    activo: z.boolean().optional(),
  });

  app.put('/:id', async (req, reply) => {
    const p = updateSchema.safeParse(req.body);
    if (!p.success) return reply.code(400).send({ error: 'bad_request' });
    // No permitir auto-desactivarse / auto-degradarse.
    if (req.params.id === req.user.id && (p.data.activo === false || (p.data.rol && p.data.rol !== 'admin'))) {
      return reply.code(409).send({ error: 'no_puedes_modificarte_asi' });
    }
    const d = p.data;
    const { rows } = await q(
      `UPDATE users SET nombre = COALESCE($2,nombre), rol = COALESCE($3,rol),
        bu = COALESCE($4,bu), activo = COALESCE($5,activo), updated_at = now()
       WHERE id = $1
       RETURNING id, nombre, email, rol, bu, activo`,
      [req.params.id, d.nombre ?? null, d.rol ?? null, d.bu ?? null, d.activo ?? null],
    );
    if (!rows[0]) return reply.code(404).send({ error: 'not_found' });
    // Si se desactiva, revoca sus sesiones.
    if (d.activo === false) await q('UPDATE refresh_tokens SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL', [req.params.id]);
    return rows[0];
  });

  const pwSchema = z.object({ password: z.string().min(8) });
  app.post('/:id/reset-password', async (req, reply) => {
    const p = pwSchema.safeParse(req.body);
    if (!p.success) return reply.code(400).send({ error: 'bad_request' });
    const hash = await hashPassword(p.data.password);
    const { rows } = await q(
      'UPDATE users SET pass_hash = $2, must_change_password = true, updated_at = now() WHERE id = $1 RETURNING id',
      [req.params.id, hash],
    );
    if (!rows[0]) return reply.code(404).send({ error: 'not_found' });
    await q('UPDATE refresh_tokens SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL', [req.params.id]);
    return { ok: true };
  });

  app.delete('/:id', async (req, reply) => {
    if (req.params.id === req.user.id) return reply.code(409).send({ error: 'no_puedes_eliminarte' });
    const { rows } = await q('DELETE FROM users WHERE id = $1 RETURNING id', [req.params.id]);
    if (!rows[0]) return reply.code(404).send({ error: 'not_found' });
    return { ok: true };
  });
}
