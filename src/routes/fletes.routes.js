import { z } from 'zod';
import { q, withTx } from '../db.js';
import { visibleBUs, canSeeBU } from '../lib/scope.js';

const WRITE = ['admin', 'gerente', 'operaciones'];
const buEnum = z.enum(['broker', 'flota', 'ambos']);

const createSchema = z.object({
  folio: z.string().optional(),
  folio_cli: z.string().optional(),
  bu: buEnum,
  cliente_id: z.string().uuid().optional(),
  carrier_id: z.string().uuid().optional(),
  tipo: z.string().optional(),
  origen: z.string().optional(),
  destino: z.string().optional(),
  fcarga: z.string().optional(),
  fentrega: z.string().optional(),
  tarifa_cobro: z.number().optional(),
  tarifa_pago: z.number().optional(),
  data: z.record(z.any()).optional(),
});

export default async function fletesRoutes(app) {
  app.addHook('preHandler', app.authenticate);

  // LISTA con filtros: ?status=&cliente_id=&q=&limit=&offset=
  app.get('/', async (req) => {
    const { status, cliente_id, q: search, limit = 200, offset = 0 } = req.query;
    const params = [visibleBUs(req.user)];
    let sql = `SELECT f.*, c.empresa AS cliente_nombre, ca.nombre AS carrier_nombre
               FROM fletes f
               LEFT JOIN clients c ON c.id = f.cliente_id
               LEFT JOIN carriers ca ON ca.id = f.carrier_id
               WHERE f.bu = ANY($1)`;
    if (status) { params.push(status); sql += ` AND f.status = $${params.length}`; }
    if (cliente_id) { params.push(cliente_id); sql += ` AND f.cliente_id = $${params.length}`; }
    if (search) { params.push(`%${search}%`); sql += ` AND (f.folio ILIKE $${params.length} OR f.origen ILIKE $${params.length} OR f.destino ILIKE $${params.length})`; }
    params.push(Math.min(Number(limit) || 200, 500));
    sql += ` ORDER BY f.created_at DESC LIMIT $${params.length}`;
    params.push(Number(offset) || 0);
    sql += ` OFFSET $${params.length}`;
    const { rows } = await q(sql, params);
    return rows;
  });

  // DETALLE: flete + cxc + cxp + gastos
  app.get('/:id', async (req, reply) => {
    const { rows } = await q('SELECT * FROM fletes WHERE id = $1', [req.params.id]);
    const flete = rows[0];
    if (!flete) return reply.code(404).send({ error: 'not_found' });
    if (!canSeeBU(req.user, flete.bu)) return reply.code(403).send({ error: 'bu_forbidden' });
    const [cxc, cxp, gastos] = await Promise.all([
      q('SELECT * FROM cxc WHERE flete_id = $1', [flete.id]),
      q('SELECT * FROM cxp WHERE flete_id = $1', [flete.id]),
      q('SELECT * FROM gastos_extra WHERE flete_id = $1 ORDER BY fecha', [flete.id]),
    ]);
    return { ...flete, cxc: cxc.rows[0] || null, cxp: cxp.rows[0] || null, gastos: gastos.rows };
  });

  // CREATE: inserta flete y genera CxC/CxP en una transacción.
  app.post('/', { preHandler: [app.requirePerm('fletes', 'edit')] }, async (req, reply) => {
    const p = createSchema.safeParse(req.body);
    if (!p.success) return reply.code(400).send({ error: 'bad_request', detail: p.error.flatten() });
    if (!canSeeBU(req.user, p.data.bu)) return reply.code(403).send({ error: 'bu_forbidden' });
    const d = p.data;

    const flete = await withTx(async (client) => {
      // Folio ELROI automatico: si no viene del cliente, se genera "ELR" + un
      // consecutivo (arranca en 5829). Se hace DENTRO de la transaccion y
      // serializado con un advisory lock a nivel transaccion, de modo que dos
      // altas simultaneas no puedan generar el mismo folio (evita duplicidad).
      let folio = d.folio ?? null;
      if (!folio) {
        await client.query('SELECT pg_advisory_xact_lock(hashtext($1)::bigint)', ['flete_folio_seq']);
        const { rows: nf } = await client.query(
          `SELECT GREATEST(5829, COALESCE(MAX((substring(folio from '^ELR([0-9]+)$'))::int), 5828) + 1) AS next
             FROM fletes WHERE folio ~ '^ELR[0-9]+$'`,
        );
        folio = 'ELR' + nf[0].next;
      }
      const { rows } = await client.query(
        `INSERT INTO fletes (folio, folio_cli, bu, cliente_id, carrier_id, tipo, origen, destino,
            fcarga, fentrega, tarifa_cobro, tarifa_pago, data)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
        [folio, d.folio_cli ?? null, d.bu, d.cliente_id ?? null, d.carrier_id ?? null,
         d.tipo ?? null, d.origen ?? null, d.destino ?? null, d.fcarga ?? null, d.fentrega ?? null,
         d.tarifa_cobro ?? null, d.tarifa_pago ?? null, d.data ?? {}],
      );
      const f = rows[0];
      await client.query("INSERT INTO cxc (flete_id, bu, status, data) VALUES ($1,$2,'por-facturar','{}')", [f.id, f.bu]);
      await client.query("INSERT INTO cxp (flete_id, bu, status, data) VALUES ($1,$2,'pendiente-prog','{}')", [f.id, f.bu]);
      return f;
    });
    return reply.code(201).send(flete);
  });

  // UPDATE parcial (incluye merge de data JSONB)
  app.put('/:id', { preHandler: [app.requireAdmin()] }, async (req, reply) => {
    const p = createSchema.partial().safeParse(req.body);
    if (!p.success) return reply.code(400).send({ error: 'bad_request' });
    const cur = await q('SELECT bu FROM fletes WHERE id = $1', [req.params.id]);
    if (!cur.rows[0]) return reply.code(404).send({ error: 'not_found' });
    if (!canSeeBU(req.user, cur.rows[0].bu)) return reply.code(403).send({ error: 'bu_forbidden' });
    const d = p.data;
    const { rows } = await q(
      `UPDATE fletes SET
        folio = COALESCE($2,folio), folio_cli = COALESCE($3,folio_cli),
        cliente_id = COALESCE($4,cliente_id), carrier_id = COALESCE($5,carrier_id),
        tipo = COALESCE($6,tipo), origen = COALESCE($7,origen), destino = COALESCE($8,destino),
        fcarga = COALESCE($9,fcarga), fentrega = COALESCE($10,fentrega),
        tarifa_cobro = COALESCE($11,tarifa_cobro), tarifa_pago = COALESCE($12,tarifa_pago),
        data = data || COALESCE($13,'{}'::jsonb), updated_at = now()
       WHERE id = $1 RETURNING *`,
      [req.params.id, d.folio ?? null, d.folio_cli ?? null, d.cliente_id ?? null, d.carrier_id ?? null,
       d.tipo ?? null, d.origen ?? null, d.destino ?? null, d.fcarga ?? null, d.fentrega ?? null,
       d.tarifa_cobro ?? null, d.tarifa_pago ?? null, d.data ? JSON.stringify(d.data) : null],
    );
    return rows[0];
  });

  // Estado de monitoreo (status + data.mon) — operaciones
  const monSchema = z.object({ status: z.string().optional(), mon_finalizado: z.boolean().optional(), data: z.record(z.any()).optional() });
  app.patch('/:id/monitoreo', { preHandler: [app.requirePerm('monitoreo', 'edit')] }, async (req, reply) => {
    const p = monSchema.safeParse(req.body);
    if (!p.success) return reply.code(400).send({ error: 'bad_request' });
    const cur = await q('SELECT bu FROM fletes WHERE id = $1', [req.params.id]);
    if (!cur.rows[0]) return reply.code(404).send({ error: 'not_found' });
    if (!canSeeBU(req.user, cur.rows[0].bu)) return reply.code(403).send({ error: 'bu_forbidden' });
    const d = p.data;
    const { rows } = await q(
      `UPDATE fletes SET mon_finalizado = COALESCE($2, mon_finalizado),
         data = data || COALESCE($3,'{}'::jsonb), updated_at = now()
       WHERE id = $1 RETURNING *`,
      [req.params.id, d.mon_finalizado ?? null, d.data ? JSON.stringify(d.data) : null],
    );
    return rows[0];
  });

  // CHECKLIST operativo (se guarda dentro de fletes.data, sin tabla nueva).
  //   data.checklist            -> {docs:{}, unidad:{}, operador:{}, statusGral, ...}
  //   data.checklistAutorizado  -> boolean (set por autorizarChecklist del front)
  //   data.checklistFechaAut    -> fecha/hora de autorización
  // El PUT /:id genérico también persiste data.checklist (merge JSONB), pero este
  // endpoint da semántica explícita de autorización con el mismo RBAC/BU scoping.
  const checklistSchema = z.object({
    checklist: z.record(z.any()).optional(),
    autorizado: z.boolean().optional(),
    fecha_autorizacion: z.string().optional(),
  });
  app.patch('/:id/checklist', { preHandler: [app.requirePerm('checklist', 'edit')] }, async (req, reply) => {
    const p = checklistSchema.safeParse(req.body);
    if (!p.success) return reply.code(400).send({ error: 'bad_request', detail: p.error.flatten() });
    const cur = await q('SELECT bu FROM fletes WHERE id = $1', [req.params.id]);
    if (!cur.rows[0]) return reply.code(404).send({ error: 'not_found' });
    if (!canSeeBU(req.user, cur.rows[0].bu)) return reply.code(403).send({ error: 'bu_forbidden' });
    const d = p.data;
    // Construye el parche JSONB solo con las claves presentes, para no pisar otras.
    const patch = {};
    if (d.checklist !== undefined) patch.checklist = d.checklist;
    if (d.autorizado !== undefined) patch.checklistAutorizado = d.autorizado;
    if (d.fecha_autorizacion !== undefined) patch.checklistFechaAut = d.fecha_autorizacion;
    const { rows } = await q(
      `UPDATE fletes SET data = data || $2::jsonb, updated_at = now()
       WHERE id = $1 RETURNING *`,
      [req.params.id, JSON.stringify(patch)],
    );
    return rows[0];
  });

  // CANCELAR — admin/gerente
  const cancelSchema = z.object({ motivo: z.string().min(1), responsable: z.string().min(1) });
  app.post('/:id/cancelar', { preHandler: [app.requireAdmin()] }, async (req, reply) => {
    const p = cancelSchema.safeParse(req.body);
    if (!p.success) return reply.code(400).send({ error: 'bad_request' });
    const cur = await q('SELECT bu FROM fletes WHERE id = $1', [req.params.id]);
    if (!cur.rows[0]) return reply.code(404).send({ error: 'not_found' });
    if (!canSeeBU(req.user, cur.rows[0].bu)) return reply.code(403).send({ error: 'bu_forbidden' });
    const cancelacion = { ...p.data, fecha: new Date().toISOString().slice(0, 10) };
    const { rows } = await q(
      `UPDATE fletes SET status = 'cancelado', data = data || jsonb_build_object('cancelacion', $2::jsonb), updated_at = now()
       WHERE id = $1 RETURNING *`,
      [req.params.id, JSON.stringify(cancelacion)],
    );
    return rows[0];
  });
}
