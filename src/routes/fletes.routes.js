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
      // Folio automatico por unidad de negocio (si no viene del cliente):
      //   - Flota Propia: "TR" + consecutivo de 3 digitos, arranca en TR001.
      //   - Broker:       "ELR" + consecutivo, arranca en 5829.
      // Se hace DENTRO de la transaccion y serializado con un advisory lock a
      // nivel transaccion, de modo que dos altas simultaneas no generen el mismo
      // folio (cada BU lleva su propia secuencia y su propio lock).
      let folio = d.folio ?? null;
      if (!folio && d.bu === 'flota') {
        await client.query('SELECT pg_advisory_xact_lock(hashtext($1)::bigint)', ['flete_folio_seq_flota']);
        const { rows: nf } = await client.query(
          `SELECT GREATEST(1, COALESCE(MAX((substring(folio from '^TR([0-9]+)$'))::int), 0) + 1) AS next
             FROM fletes WHERE bu = 'flota' AND folio ~ '^TR[0-9]+$'`,
        );
        folio = 'TR' + String(nf[0].next).padStart(3, '0');
      } else if (!folio) {
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

  // UPDATE parcial (incluye merge de data JSONB).
  // Ciclo borrador → liberado: con fletes:edit se puede editar mientras es
  // borrador; una vez liberado a monitoreo (checklist autorizado) el registro se
  // bloquea y solo admin puede editar (correcciones).
  app.put('/:id', { preHandler: [app.requirePerm('fletes', 'edit')] }, async (req, reply) => {
    const p = createSchema.partial().safeParse(req.body);
    if (!p.success) return reply.code(400).send({ error: 'bad_request' });
    const cur = await q(
      `SELECT bu, (data->>'checklistAutorizado')::boolean AS liberado FROM fletes WHERE id = $1`,
      [req.params.id],
    );
    if (!cur.rows[0]) return reply.code(404).send({ error: 'not_found' });
    if (!canSeeBU(req.user, cur.rows[0].bu)) return reply.code(403).send({ error: 'bu_forbidden' });
    if (cur.rows[0].liberado === true && req.user.rol !== 'admin') {
      return reply.code(403).send({ error: 'flete_released', detail: 'Solo un administrador puede editar un servicio ya liberado a monitoreo.' });
    }
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

  // Gastos en efectivo del viaje (Flota): casetas, maniobras, viáticos… Se
  // pueden registrar ANTES y DURANTE el viaje, por eso este endpoint es
  // append-only y NO se bloquea aunque el servicio ya esté liberado (a
  // diferencia del PUT). Reemplaza data.gastosViaje con la lista enviada.
  const gastosViajeSchema = z.object({
    gastos: z.array(z.object({
      concepto: z.string().optional().nullable(),
      monto: z.number().optional().nullable(),
      fecha: z.string().optional().nullable(),
    })),
  });
  app.put('/:id/gastos-viaje', { preHandler: [app.requirePerm('fletes', 'edit')] }, async (req, reply) => {
    const p = gastosViajeSchema.safeParse(req.body);
    if (!p.success) return reply.code(400).send({ error: 'bad_request' });
    const cur = await q('SELECT bu FROM fletes WHERE id = $1', [req.params.id]);
    if (!cur.rows[0]) return reply.code(404).send({ error: 'not_found' });
    if (!canSeeBU(req.user, cur.rows[0].bu)) return reply.code(403).send({ error: 'bu_forbidden' });
    const { rows } = await q(
      `UPDATE fletes SET data = data || jsonb_build_object('gastosViaje', $2::jsonb), updated_at = now()
         WHERE id = $1 RETURNING *`,
      [req.params.id, JSON.stringify(p.data.gastos)],
    );
    return rows[0];
  });

  // Odómetro inicial/final del viaje (Flota). Editable DURANTE el viaje aunque el
  // servicio esté liberado (el km final se lee al terminar), PERO se bloquea una
  // vez capturado el status 19 / mon_finalizado: ahí queda fijo (km final).
  const odoSchema = z.object({
    odometroInicial: z.number().optional().nullable(),
    odometroFinal: z.number().optional().nullable(),
  });
  app.put('/:id/odometro-viaje', { preHandler: [app.requirePerm('fletes', 'edit')] }, async (req, reply) => {
    const p = odoSchema.safeParse(req.body);
    if (!p.success) return reply.code(400).send({ error: 'bad_request' });
    const cur = await q(
      `SELECT bu, (data->>'monStatus') AS mon, mon_finalizado FROM fletes WHERE id = $1`,
      [req.params.id],
    );
    if (!cur.rows[0]) return reply.code(404).send({ error: 'not_found' });
    if (!canSeeBU(req.user, cur.rows[0].bu)) return reply.code(403).send({ error: 'bu_forbidden' });
    if (cur.rows[0].mon === 'finalizado' || cur.rows[0].mon_finalizado === true) {
      return reply.code(403).send({ error: 'flete_finalizado', detail: 'El odómetro queda fijo al finalizar el servicio (status 19).' });
    }
    const patch = {};
    if (p.data.odometroInicial !== undefined) patch.odometroInicial = p.data.odometroInicial;
    if (p.data.odometroFinal !== undefined) patch.odometroFinal = p.data.odometroFinal;
    const { rows } = await q(
      `UPDATE fletes SET data = data || $2::jsonb, updated_at = now() WHERE id = $1 RETURNING *`,
      [req.params.id, JSON.stringify(patch)],
    );
    return rows[0];
  });

  // Datos de viaje editables tras liberar (capacidad fina 'editar_datos_viaje'):
  // folio de cliente y vueltas/tiros de Ingram. A diferencia del PUT /:id, NO se
  // bloquea por servicio liberado ni por finalizado — son correcciones operativas
  // acotadas (p.ej. el folio del cliente llega tarde). Registra una bitácora en
  // data.datosViajeLog (quién, cuándo, qué cambió) para avisar a quien tenga la
  // capacidad 'recibe_avisos_datos_viaje' (entrega de la notificación: Fase 2).
  const datosViajeSchema = z.object({
    folio_cli: z.string().optional().nullable(),
    ingramVueltas: z.array(z.object({ tiros: z.array(z.string()) })).optional(),
  });
  app.put('/:id/datos-viaje', { preHandler: [app.requireCapability('editar_datos_viaje')] }, async (req, reply) => {
    const p = datosViajeSchema.safeParse(req.body);
    if (!p.success) return reply.code(400).send({ error: 'bad_request', detail: p.error.flatten() });
    const cur = await q('SELECT * FROM fletes WHERE id = $1', [req.params.id]);
    const flete = cur.rows[0];
    if (!flete) return reply.code(404).send({ error: 'not_found' });
    if (!canSeeBU(req.user, flete.bu)) return reply.code(403).send({ error: 'bu_forbidden' });

    const prevData = flete.data || {};
    const cambios = [];
    let nuevoFolioCli = null; // null -> no tocar la columna (COALESCE la conserva)

    if (p.data.folio_cli !== undefined) {
      const nuevo = p.data.folio_cli || null;
      const viejo = flete.folio_cli || null;
      if (String(nuevo || '') !== String(viejo || '')) {
        cambios.push({ campo: 'folio_cli', de: viejo, a: nuevo });
        nuevoFolioCli = nuevo;
      }
    }

    const patchData = {};
    if (p.data.ingramVueltas !== undefined) {
      const limpio = p.data.ingramVueltas.map((v) => ({
        tiros: (v.tiros || []).map((t) => String(t).trim()).filter(Boolean),
      }));
      const prevVueltas = Array.isArray(prevData.ingramVueltas) ? prevData.ingramVueltas : [];
      if (JSON.stringify(limpio) !== JSON.stringify(prevVueltas)) {
        const cuenta = (arr) => arr.reduce((a, v) => a + (v.tiros?.length || 0), 0);
        cambios.push({
          campo: 'ingramVueltas',
          de: `${prevVueltas.length} vueltas / ${cuenta(prevVueltas)} tiros`,
          a: `${limpio.length} vueltas / ${cuenta(limpio)} tiros`,
        });
        patchData.ingramVueltas = limpio;
      }
    }

    // Nada cambió: devuelve el servicio tal cual, sin escribir ni auditar.
    if (!cambios.length) return flete;

    // Bitácora de auditoría (append, con tope de 50 entradas).
    const prevLog = Array.isArray(prevData.datosViajeLog) ? prevData.datosViajeLog : [];
    patchData.datosViajeLog = [
      ...prevLog,
      { at: new Date().toISOString(), by: req.user.id, byNombre: req.user.name || null, cambios },
    ].slice(-50);

    const { rows } = await q(
      `UPDATE fletes SET folio_cli = COALESCE($2, folio_cli), data = data || $3::jsonb, updated_at = now()
         WHERE id = $1 RETURNING *`,
      [req.params.id, nuevoFolioCli, JSON.stringify(patchData)],
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
    // Siembra de monitoreo ATÓMICA: al autorizar, el front manda aquí el estatus
    // inicial (confirmado) + su historial, para que checklistAutorizado y monStatus
    // queden en la MISMA escritura (bajo permiso `checklist`). Antes eran dos
    // llamadas (la 2ª exigía `monitoreo` y, si fallaba por permiso o red en la
    // tablet, el servicio quedaba autorizado pero atorado en "pendiente").
    mon: z.object({ status: z.string().optional(), historial: z.array(z.any()).optional() }).optional(),
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
    if (d.mon) {
      if (d.mon.status !== undefined) patch.monStatus = d.mon.status;
      if (d.mon.historial !== undefined) patch.monHistorial = d.mon.historial;
    }
    const { rows } = await q(
      `UPDATE fletes SET data = data || $2::jsonb, updated_at = now()
       WHERE id = $1 RETURNING *`,
      [req.params.id, JSON.stringify(patch)],
    );
    return rows[0];
  });

  // CANCELAR — admin/gerente
  const cancelSchema = z.object({ motivo: z.string().min(1), responsable: z.string().min(1) });
  // Cancelar servicio: jerarquía de Gerencia (gerente o admin).
  app.post('/:id/cancelar', { preHandler: [app.requireMinRole('gerente')] }, async (req, reply) => {
    const p = cancelSchema.safeParse(req.body);
    if (!p.success) return reply.code(400).send({ error: 'bad_request' });
    const cur = await q('SELECT bu FROM fletes WHERE id = $1', [req.params.id]);
    if (!cur.rows[0]) return reply.code(404).send({ error: 'not_found' });
    if (!canSeeBU(req.user, cur.rows[0].bu)) return reply.code(403).send({ error: 'bu_forbidden' });
    const cancelacion = { ...p.data, fecha: new Date().toISOString().slice(0, 10) };
    // Cancelar el flete y, en cascada, su Cobranza (CxC) y Pago (CxP): un viaje
    // cancelado deja de contar/afectar venta, cobranza y pagos en TODA vista.
    // Además se ponen en CERO los montos (tarifa del flete + cobro/pago de sus
    // gastos_extra) para que no sumen en ningún módulo/KPI; los montos originales
    // se preservan en data.cancelacion.montos_previos (auditoría/reversible). El
    // registro sigue apareciendo en los XLS con status CANCELADO y en $0.
    const flete = await withTx(async (client) => {
      // Snapshot de montos antes de ponerlos en cero.
      const prev = await client.query(
        'SELECT tarifa_cobro, tarifa_pago FROM fletes WHERE id = $1', [req.params.id],
      );
      const gx = await client.query(
        'SELECT id, cobro, pago FROM gastos_extra WHERE flete_id = $1', [req.params.id],
      );
      const cancelacionFull = {
        ...cancelacion,
        montos_previos: {
          tarifa_cobro: prev.rows[0]?.tarifa_cobro ?? null,
          tarifa_pago: prev.rows[0]?.tarifa_pago ?? null,
          gastos: gx.rows.map((g) => ({ id: g.id, cobro: g.cobro, pago: g.pago })),
        },
      };
      const { rows } = await client.query(
        `UPDATE fletes SET status = 'cancelado', tarifa_cobro = 0, tarifa_pago = 0,
           data = data || jsonb_build_object('cancelacion', $2::jsonb), updated_at = now()
         WHERE id = $1 RETURNING *`,
        [req.params.id, JSON.stringify(cancelacionFull)],
      );
      await client.query(
        'UPDATE gastos_extra SET cobro = 0, pago = 0 WHERE flete_id = $1', [req.params.id],
      );
      for (const t of ['cxc', 'cxp']) {
        // t es una whitelist fija (no input de usuario) — seguro interpolar.
        await client.query(
          `UPDATE ${t} SET status = 'cancelado',
             data = data || jsonb_build_object('cancelacion', $2::jsonb), updated_at = now()
           WHERE flete_id = $1`,
          [req.params.id, JSON.stringify(cancelacion)],
        );
      }
      return rows[0];
    });
    return flete;
  });
}
