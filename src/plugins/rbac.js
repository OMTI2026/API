import fp from 'fastify-plugin';
import { q } from '../db.js';
import { effectivePerms, hasPerm } from '../lib/permissions.js';

// Decora la app con:
//   - requireRole(...roles): allow-list por rol exacto (legacy; aún usado donde
//     aplica). Usar como preHandler después de `authenticate`.
//   - requirePerm(module, level): permisos por módulo (manual por usuario). Lee
//     rol+permissions FRESCOS de la BD (un query por PK) y valida el nivel.
//     level: 'view' | 'edit'. 'edit' implica 'view'.
export default fp(async function rbacPlugin(app) {
  app.decorate('requireRole', function (...roles) {
    return async function (req, reply) {
      if (!req.user) return reply.code(401).send({ error: 'unauthenticated' });
      if (!roles.includes(req.user.rol)) {
        return reply.code(403).send({ error: 'forbidden', need: roles });
      }
    };
  });

  // Solo Administrador. Para acciones de control/jerarquía: editar un registro
  // ya capturado, eliminar, y cancelar/revertir capturas. (Crear/capturar y las
  // capturas operativas de seguimiento siguen por la matriz, vía requirePerm.)
  app.decorate('requireAdmin', function () {
    return async function (req, reply) {
      if (!req.user) return reply.code(401).send({ error: 'unauthenticated' });
      const { rows } = await q('SELECT rol, activo FROM users WHERE id = $1', [req.user.id]);
      const u = rows[0];
      if (!u || u.activo === false) return reply.code(401).send({ error: 'user_inactive' });
      if (u.rol !== 'admin') return reply.code(403).send({ error: 'forbidden', need: 'admin' });
    };
  });

  // Jerarquía mínima de rol. Re-lee rol/activo FRESCOS de la BD (como
  // requireAdmin) y exige que el rol del usuario sea >= minRole en la jerarquía.
  // Para acciones de control delegables a Gerencia (p.ej. cancelar servicios).
  const ROLE_ORDER = ['readonly', 'finanzas', 'operaciones', 'gerente', 'admin'];
  app.decorate('requireMinRole', function (minRole) {
    return async function (req, reply) {
      if (!req.user) return reply.code(401).send({ error: 'unauthenticated' });
      const { rows } = await q('SELECT rol, activo FROM users WHERE id = $1', [req.user.id]);
      const u = rows[0];
      if (!u || u.activo === false) return reply.code(401).send({ error: 'user_inactive' });
      if (ROLE_ORDER.indexOf(u.rol) < ROLE_ORDER.indexOf(minRole)) {
        return reply.code(403).send({ error: 'forbidden', need: minRole + '+' });
      }
    };
  });

  app.decorate('requirePerm', function (module, level = 'view') {
    return async function (req, reply) {
      if (!req.user) return reply.code(401).send({ error: 'unauthenticated' });
      const { rows } = await q('SELECT rol, permissions, activo FROM users WHERE id = $1', [req.user.id]);
      const u = rows[0];
      if (!u || u.activo === false) return reply.code(401).send({ error: 'user_inactive' });
      const perms = effectivePerms(u);
      if (!hasPerm(perms, module, level)) {
        return reply.code(403).send({ error: 'forbidden', module, need: level });
      }
      // Deja los permisos efectivos disponibles para el handler si los necesita.
      req.perms = perms;
    };
  });
});
