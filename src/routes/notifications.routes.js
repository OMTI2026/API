import { q } from '../db.js';

// Notificaciones persistidas por usuario (campana in-app). Cada usuario ve y
// gestiona SOLO las suyas — no requiere permiso de módulo. Se CREAN desde otros
// endpoints (p.ej. PUT /fletes/:id/datos-viaje) hacia los usuarios que tengan la
// capacidad correspondiente.
export default async function notificationsRoutes(app) {
  app.addHook('preHandler', app.authenticate);

  // Bandeja (más recientes primero). ?unread=1 → solo no leídas; ?limit= (máx 100).
  app.get('/', async (req) => {
    const unread = String(req.query.unread || '') === '1';
    const limit = Math.min(Number(req.query.limit) || 50, 100);
    const params = [req.user.id];
    let sql = 'SELECT * FROM notifications WHERE user_id = $1';
    if (unread) sql += ' AND read_at IS NULL';
    params.push(limit);
    sql += ` ORDER BY created_at DESC LIMIT $${params.length}`;
    const { rows } = await q(sql, params);
    return rows;
  });

  // Conteo de no leídas (para el badge de la campana).
  app.get('/unread-count', async (req) => {
    const { rows } = await q(
      'SELECT COUNT(*)::int AS n FROM notifications WHERE user_id = $1 AND read_at IS NULL',
      [req.user.id],
    );
    return { count: rows[0].n };
  });

  // Marcar una como leída (solo si es del usuario).
  app.patch('/:id/read', async (req, reply) => {
    const { rows } = await q(
      'UPDATE notifications SET read_at = now() WHERE id = $1 AND user_id = $2 RETURNING *',
      [req.params.id, req.user.id],
    );
    if (!rows[0]) return reply.code(404).send({ error: 'not_found' });
    return rows[0];
  });

  // Marcar todas como leídas.
  app.post('/read-all', async (req) => {
    const { rows } = await q(
      'UPDATE notifications SET read_at = now() WHERE user_id = $1 AND read_at IS NULL RETURNING id',
      [req.user.id],
    );
    return { updated: rows.length };
  });
}

// Helper reutilizable: crea una notificación para cada usuario ACTIVO que tenga
// la capacidad `cap` (excepto `exceptUserId`, típicamente el autor del cambio).
// Best-effort: quien llama decide si envolver en try/catch. Devuelve el conteo.
export async function notifyCapability(cap, exceptUserId, { type, title, message, entityType, entityId, data }) {
  const { rows } = await q(
    `INSERT INTO notifications (user_id, type, title, message, entity_type, entity_id, data)
     SELECT u.id, $1, $2, $3, $4, $5, $6::jsonb
     FROM users u
     WHERE u.capabilities @> jsonb_build_object($7::text, true)
       AND u.activo = true
       AND ($8::uuid IS NULL OR u.id <> $8)
     RETURNING id`,
    [type, title, message ?? null, entityType ?? null, entityId ?? null, JSON.stringify(data || {}), cap, exceptUserId ?? null],
  );
  return rows.length;
}
