import { q } from '../db.js';
import { visibleBUs } from '../lib/scope.js';

// BUs a considerar: si la petición pide ?bu= y el usuario puede verla, se limita
// a esa unidad (separación Flota/Broker del dashboard); si no, todas las visibles.
function scopedBUs(req) {
  const all = visibleBUs(req.user);
  const bu = req.query?.bu;
  return bu && all.includes(bu) ? [bu] : all;
}

export default async function statsRoutes(app) {
  app.addHook('preHandler', app.authenticate);

  // KPIs del dashboard. La venta/utilidad se determina por el STATUS DE
  // MONITOREO (data.monStatus), NO por la columna `status` del flete (que solo
  // es 'activo'/'cancelado' y nunca 'finalizado', por eso antes salía en $0):
  //   REAL       = viajes con monStatus '19 Servicio Finalizado' ('finalizado').
  //   PROYECCIÓN = viajes en monitoreo (status 1..22) EXCEPTO 19 Finalizado y
  //                20 Siniestro ('siniestro'). En ambos casos se excluyen los
  //                cancelados. El mes/año se toma de la fecha de CARGA (fcarga,
  //                mes operativo; fallback a created_at), en hora de México, para
  //                que el mes actual se separe del total aunque la captura sea
  //                posterior y para no recorrer el corte por el UTC de la BD.
  app.get('/dashboard', async (req) => {
    const bus = scopedBUs(req);
    const { rows } = await q(
      `WITH gx AS (
         -- Gastos extra sumados por flete: cobro es la contraparte de VENTA del
         -- gasto adicional (se cobra al cliente) y pago el costo al proveedor.
         SELECT flete_id,
                SUM(COALESCE(cobro,0)) AS g_cobro,
                SUM(COALESCE(pago,0))  AS g_pago
         FROM gastos_extra
         GROUP BY flete_id
       ),
       base AS (
         SELECT f.id, f.status,
                f.data->>'monStatus' AS mon,
                -- Mes/año del flete = fecha de CARGA (mes operativo), con fallback a
                -- created_at si el flete no tiene fcarga. En hora de México para que
                -- el corte de mes/año no se recorra por el UTC de la BD (Railway).
                (date_trunc('month', COALESCE(f.fcarga, f.created_at) AT TIME ZONE 'America/Mexico_City')
                   = date_trunc('month', now() AT TIME ZONE 'America/Mexico_City')) AS es_mes,
                (date_trunc('year',  COALESCE(f.fcarga, f.created_at) AT TIME ZONE 'America/Mexico_City')
                   = date_trunc('year',  now() AT TIME ZONE 'America/Mexico_City')) AS es_anio,
                -- Venta = tarifa de flete + cobro de gastos adicionales.
                COALESCE(f.tarifa_cobro,0) + COALESCE(gx.g_cobro,0) AS cobro,
                -- Utilidad = (tarifa_cobro − tarifa_pago) + (cobro − pago) de gastos.
                (COALESCE(f.tarifa_cobro,0) - COALESCE(f.tarifa_pago,0))
                  + (COALESCE(gx.g_cobro,0) - COALESCE(gx.g_pago,0)) AS util
         FROM fletes f
         LEFT JOIN gx ON gx.flete_id = f.id
         WHERE f.bu = ANY($1)
       )
       SELECT
         COALESCE(SUM(cobro) FILTER (WHERE mon='finalizado' AND status<>'cancelado' AND es_anio),0)  AS venta_anual,
         COALESCE(SUM(util)  FILTER (WHERE mon='finalizado' AND status<>'cancelado' AND es_anio),0)  AS util_anual,
         COALESCE(SUM(cobro) FILTER (WHERE mon='finalizado' AND status<>'cancelado' AND es_mes),0)   AS venta_mes,
         COALESCE(SUM(util)  FILTER (WHERE mon='finalizado' AND status<>'cancelado' AND es_mes),0)   AS util_mes,
         COUNT(*) FILTER (WHERE status='cancelado' AND es_mes)  AS cancel_mes,
         COUNT(*) FILTER (WHERE status='cancelado' AND es_anio) AS cancel_anual,
         -- Proyección: en monitoreo (monStatus 1..22) salvo 19 Finalizado y 20 Siniestro; sin cancelados.
         COALESCE(SUM(cobro) FILTER (WHERE status<>'cancelado' AND mon NOT IN ('finalizado','siniestro') AND es_anio),0) AS proy_venta_anual,
         COALESCE(SUM(util)  FILTER (WHERE status<>'cancelado' AND mon NOT IN ('finalizado','siniestro') AND es_anio),0) AS proy_util_anual,
         COUNT(*)            FILTER (WHERE status<>'cancelado' AND mon NOT IN ('finalizado','siniestro') AND es_anio)    AS proy_viajes_anual,
         COALESCE(SUM(cobro) FILTER (WHERE status<>'cancelado' AND mon NOT IN ('finalizado','siniestro') AND es_mes),0)  AS proy_venta_mes,
         COALESCE(SUM(util)  FILTER (WHERE status<>'cancelado' AND mon NOT IN ('finalizado','siniestro') AND es_mes),0)  AS proy_util_mes,
         COUNT(*)            FILTER (WHERE status<>'cancelado' AND mon NOT IN ('finalizado','siniestro') AND es_mes)     AS proy_viajes_mes
       FROM base`,
      [bus],
    );
    return rows[0];
  });

  // Proyección mensual del año en curso: venta, utilidad y viajes de los fletes
  // EN MONITOREO (monStatus 1..22) EXCEPTO 19 Finalizado y 20 Siniestro, sin
  // cancelados, agrupados por mes. Alimenta la gráfica del dashboard (venta/
  // utilidad PROYECTADA por mes), a diferencia del histórico (ya cerrado).
  app.get('/proyeccion-mensual', async (req) => {
    const { rows } = await q(
      `SELECT to_char(date_trunc('month', COALESCE(f.fcarga, f.created_at) AT TIME ZONE 'America/Mexico_City'), 'YYYY-MM') AS mes,
              COALESCE(SUM(COALESCE(f.tarifa_cobro,0) + COALESCE(gx.g_cobro,0)),0)        AS venta,
              COALESCE(SUM((COALESCE(f.tarifa_cobro,0) - COALESCE(f.tarifa_pago,0))
                           + (COALESCE(gx.g_cobro,0) - COALESCE(gx.g_pago,0))),0)         AS util,
              COUNT(*)                                                                   AS viajes
         FROM fletes f
         LEFT JOIN (SELECT flete_id, SUM(COALESCE(cobro,0)) AS g_cobro, SUM(COALESCE(pago,0)) AS g_pago
                      FROM gastos_extra GROUP BY flete_id) gx ON gx.flete_id = f.id
        WHERE f.bu = ANY($1)
          AND f.status <> 'cancelado'
          AND f.data->>'monStatus' NOT IN ('finalizado','siniestro')
          AND date_trunc('year', COALESCE(f.fcarga, f.created_at) AT TIME ZONE 'America/Mexico_City')
              = date_trunc('year', now() AT TIME ZONE 'America/Mexico_City')
        GROUP BY 1
        ORDER BY 1`,
      [scopedBUs(req)],
    );
    return rows;
  });

  // Venta REAL mensual del año en curso: venta, utilidad y viajes de los fletes
  // con monStatus '19 Servicio Finalizado' ('finalizado'), sin cancelados,
  // agrupados por mes. Alimenta la línea REAL de la gráfica del dashboard (la
  // proyección vive en /proyeccion-mensual y en los KPIs proy_* de /dashboard).
  app.get('/real-mensual', async (req) => {
    const { rows } = await q(
      `SELECT to_char(date_trunc('month', COALESCE(f.fcarga, f.created_at) AT TIME ZONE 'America/Mexico_City'), 'YYYY-MM') AS mes,
              COALESCE(SUM(COALESCE(f.tarifa_cobro,0) + COALESCE(gx.g_cobro,0)),0)        AS venta,
              COALESCE(SUM((COALESCE(f.tarifa_cobro,0) - COALESCE(f.tarifa_pago,0))
                           + (COALESCE(gx.g_cobro,0) - COALESCE(gx.g_pago,0))),0)         AS util,
              COUNT(*)                                                                   AS viajes
         FROM fletes f
         LEFT JOIN (SELECT flete_id, SUM(COALESCE(cobro,0)) AS g_cobro, SUM(COALESCE(pago,0)) AS g_pago
                      FROM gastos_extra GROUP BY flete_id) gx ON gx.flete_id = f.id
        WHERE f.bu = ANY($1)
          AND f.status <> 'cancelado'
          AND f.data->>'monStatus' = 'finalizado'
          AND date_trunc('year', COALESCE(f.fcarga, f.created_at) AT TIME ZONE 'America/Mexico_City')
              = date_trunc('year', now() AT TIME ZONE 'America/Mexico_City')
        GROUP BY 1
        ORDER BY 1`,
      [scopedBUs(req)],
    );
    return rows;
  });

  // Histórico mensual archivado.
  app.get('/historico', async (req) => {
    const { rows } = await q(
      'SELECT * FROM stats_historico WHERE bu = ANY($1) ORDER BY mes DESC',
      [scopedBUs(req)],
    );
    return rows;
  });
}
