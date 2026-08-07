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
    const { rows } = await q(
      `INSERT INTO prospectos (bu, empresa, contacto, etapa, data)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [d.bu, d.empresa, d.contacto ?? null, d.etapa ?? 'nuevo', d.data ?? {}],
    );
    return rows[0];
  });

  app.put('/:id', { preHandler: [app.requirePerm('crm', 'edit')] }, async (req, reply) => {
    const p = baseSchema.partial().safeParse(req.body);
    if (!p.success) return reply.code(400).send({ error: 'bad_request', detail: p.error.flatten() });
    const cur = await q('SELECT bu FROM prospectos WHERE id = $1', [req.params.id]);
    if (!cur.rows[0]) return reply.code(404).send({ error: 'not_found' });
    if (!canSeeBU(req.user, cur.rows[0].bu)) return reply.code(403).send({ error: 'bu_forbidden' });
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
}
