import { z } from 'zod';
import { q } from '../db.js';
import { hashPassword } from '../lib/argon.js';
import { effectivePerms, diffOverrides, LEVELS } from '../lib/permissions.js';

const buEnum = z.enum(['broker', 'flota', 'ambos']);
const rolEnum = z.enum(['admin', 'gerente', 'operaciones', 'finanzas', 'readonly']);
// Mapa de permisos EFECTIVO que arma la UI (módulo -> nivel). Se guarda como
// overrides (diff vs el preset del rol) en la columna users.permissions.
const permsSchema = z.record(z.enum(LEVELS)).optional();

export default async function usuariosRoutes(app) {
  // Gestión de usuarios: requiere permiso del módulo 'usuarios' (admin lo tiene
  // siempre; otros roles solo si se les otorga por override). Ver = entrar/listar,
  // Editar = crear/modificar/eliminar/resetear.
  app.addHook('preHandler', app.authenticate);
  app.addHook('preHandler', app.requirePerm('usuarios', 'view'));

  app.get('/', async () => {
    const { rows } = await q(
      `SELECT id, nombre, email, rol, bu, activo, must_change_password, permissions,
        totp_secret IS NOT NULL AS has_2fa, created_at
       FROM users ORDER BY created_at DESC`,
    );
    // Devuelve permisos EFECTIVOS (preset del rol + overrides) para la matriz.
    return rows.map((u) => {
      const { permissions, ...rest } = u;
      return { ...rest, permissions: effectivePerms(u) };
    });
  });

  const createSchema = z.object({
    nombre: z.string().min(1),
    email: z.string().email(),
    password: z.string().min(8),
    rol: rolEnum,
    bu: buEnum,
    permissions: permsSchema,
  });

  app.post('/', { preHandler: [app.requirePerm('usuarios', 'edit')] }, async (req, reply) => {
    const p = createSchema.safeParse(req.body);
    if (!p.success) return reply.code(400).send({ error: 'bad_request', detail: p.error.flatten() });
    const d = p.data;
    const dup = await q('SELECT 1 FROM users WHERE email = $1', [d.email]);
    if (dup.rows[0]) return reply.code(409).send({ error: 'email_existe' });
    const hash = await hashPassword(d.password);
    const overrides = diffOverrides(d.rol, d.permissions || {});
    const { rows } = await q(
      `INSERT INTO users (nombre, email, pass_hash, rol, bu, activo, must_change_password, permissions)
       VALUES ($1,$2,$3,$4,$5,true,true,$6)
       RETURNING id, nombre, email, rol, bu, activo, must_change_password, permissions, created_at`,
      [d.nombre, d.email, hash, d.rol, d.bu, JSON.stringify(overrides)],
    );
    const u = rows[0];
    return reply.code(201).send({ ...u, permissions: effectivePerms(u) });
  });

  const updateSchema = z.object({
    nombre: z.string().min(1).optional(),
    rol: rolEnum.optional(),
    bu: buEnum.optional(),
    activo: z.boolean().optional(),
    permissions: permsSchema,
  });

  app.put('/:id', { preHandler: [app.requireAdmin()] }, async (req, reply) => {
    const p = updateSchema.safeParse(req.body);
    if (!p.success) return reply.code(400).send({ error: 'bad_request' });
    // No permitir auto-desactivarse / auto-degradarse.
    if (req.params.id === req.user.id && (p.data.activo === false || (p.data.rol && p.data.rol !== 'admin'))) {
      return reply.code(409).send({ error: 'no_puedes_modificarte_asi' });
    }
    const d = p.data;

    // Si vienen permisos, recalcular overrides contra el rol final (el nuevo si
    // se cambió, si no el actual).
    let overridesJson = null;
    if (d.permissions !== undefined) {
      let rol = d.rol;
      if (!rol) {
        const cur = await q('SELECT rol FROM users WHERE id = $1', [req.params.id]);
        if (!cur.rows[0]) return reply.code(404).send({ error: 'not_found' });
        rol = cur.rows[0].rol;
      }
      overridesJson = JSON.stringify(diffOverrides(rol, d.permissions));
    }

    const { rows } = await q(
      `UPDATE users SET nombre = COALESCE($2,nombre), rol = COALESCE($3,rol),
        bu = COALESCE($4,bu), activo = COALESCE($5,activo),
        permissions = COALESCE($6, permissions), updated_at = now()
       WHERE id = $1
       RETURNING id, nombre, email, rol, bu, activo, permissions`,
      [req.params.id, d.nombre ?? null, d.rol ?? null, d.bu ?? null, d.activo ?? null, overridesJson],
    );
    if (!rows[0]) return reply.code(404).send({ error: 'not_found' });
    // Si se desactiva, revoca sus sesiones.
    if (d.activo === false) await q('UPDATE refresh_tokens SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL', [req.params.id]);
    const u = rows[0];
    return { ...u, permissions: effectivePerms(u) };
  });

  const pwSchema = z.object({ password: z.string().min(8) });
  app.post('/:id/reset-password', { preHandler: [app.requireAdmin()] }, async (req, reply) => {
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

  app.delete('/:id', { preHandler: [app.requireAdmin()] }, async (req, reply) => {
    if (req.params.id === req.user.id) return reply.code(409).send({ error: 'no_puedes_eliminarte' });
    const { rows } = await q('DELETE FROM users WHERE id = $1 RETURNING id', [req.params.id]);
    if (!rows[0]) return reply.code(404).send({ error: 'not_found' });
    return { ok: true };
  });
}
