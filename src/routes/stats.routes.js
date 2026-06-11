import { q } from '../db.js';
import { visibleBUs } from '../lib/scope.js';

export default async function statsRoutes(app) {
  app.addHook('preHandler', app.authenticate);

  // KPIs del dashboard. La venta/utilidad se determina por el STATUS DE
  // MONITOREO (data.monStatus), NO por la columna `status` del flete (que solo
  // es 'activo'/'cancelado' y nunca 'finalizado', por eso antes salía en $0):
  //   REAL       = viajes con monStatus '19 Servicio Finalizado' ('finalizado').
  //   PROYECCIÓN = viajes en monitoreo (status 1..22) EXCEPTO 19 Finalizado y
  //                20 Siniestro ('siniestro'). En ambos casos se excluyen los
  //                cancelados. Mes y año por created_at.
  app.get('/dashboard', async (req) => {
    const bus = visibleBUs(req.user);
    const { rows } = await q(
      `WITH base AS (
         SELECT f.id, f.status, f.created_at,
                f.data->>'monStatus' AS mon,
                COALESCE(f.tarifa_cobro,0) AS cobro,
                COALESCE(f.tarifa_cobro,0) - COALESCE(f.tarifa_pago,0) AS util
         FROM fletes f
         WHERE f.bu = ANY($1)
       )
       SELECT
         COALESCE(SUM(cobro) FILTER (WHERE mon='finalizado' AND status<>'cancelado' AND date_trunc('year', created_at) = date_trunc('year', now())),0)  AS venta_anual,
         COALESCE(SUM(util)  FILTER (WHERE mon='finalizado' AND status<>'cancelado' AND date_trunc('year', created_at) = date_trunc('year', now())),0)  AS util_anual,
         COALESCE(SUM(cobro) FILTER (WHERE mon='finalizado' AND status<>'cancelado' AND date_trunc('month', created_at) = date_trunc('month', now())),0) AS venta_mes,
         COALESCE(SUM(util)  FILTER (WHERE mon='finalizado' AND status<>'cancelado' AND date_trunc('month', created_at) = date_trunc('month', now())),0) AS util_mes,
         COUNT(*) FILTER (WHERE status='cancelado' AND date_trunc('month', created_at) = date_trunc('month', now())) AS cancel_mes,
         COUNT(*) FILTER (WHERE status='cancelado' AND date_trunc('year', created_at)  = date_trunc('year', now()))  AS cancel_anual,
         -- Proyección: en monitoreo (monStatus 1..22) salvo 19 Finalizado y 20 Siniestro; sin cancelados.
         COALESCE(SUM(cobro) FILTER (WHERE status<>'cancelado' AND mon NOT IN ('finalizado','siniestro') AND date_trunc('year', created_at) = date_trunc('year', now())),0) AS proy_venta_anual,
         COALESCE(SUM(util)  FILTER (WHERE status<>'cancelado' AND mon NOT IN ('finalizado','siniestro') AND date_trunc('year', created_at) = date_trunc('year', now())),0) AS proy_util_anual,
         COUNT(*)            FILTER (WHERE status<>'cancelado' AND mon NOT IN ('finalizado','siniestro') AND date_trunc('year', created_at) = date_trunc('year', now()))    AS proy_viajes_anual,
         COALESCE(SUM(cobro) FILTER (WHERE status<>'cancelado' AND mon NOT IN ('finalizado','siniestro') AND date_trunc('month', created_at) = date_trunc('month', now())),0) AS proy_venta_mes,
         COALESCE(SUM(util)  FILTER (WHERE status<>'cancelado' AND mon NOT IN ('finalizado','siniestro') AND date_trunc('month', created_at) = date_trunc('month', now())),0) AS proy_util_mes,
         COUNT(*)            FILTER (WHERE status<>'cancelado' AND mon NOT IN ('finalizado','siniestro') AND date_trunc('month', created_at) = date_trunc('month', now()))    AS proy_viajes_mes
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
      `SELECT to_char(date_trunc('month', created_at), 'YYYY-MM') AS mes,
              COALESCE(SUM(COALESCE(tarifa_cobro,0)),0)                                  AS venta,
              COALESCE(SUM(COALESCE(tarifa_cobro,0) - COALESCE(tarifa_pago,0)),0)         AS util,
              COUNT(*)                                                                   AS viajes
         FROM fletes
        WHERE bu = ANY($1)
          AND status <> 'cancelado'
          AND data->>'monStatus' NOT IN ('finalizado','siniestro')
          AND date_trunc('year', created_at) = date_trunc('year', now())
        GROUP BY 1
        ORDER BY 1`,
      [visibleBUs(req.user)],
    );
    return rows;
  });

  // Histórico mensual archivado.
  app.get('/historico', async (req) => {
    const { rows } = await q(
      'SELECT * FROM stats_historico WHERE bu = ANY($1) ORDER BY mes DESC',
      [visibleBUs(req.user)],
    );
    return rows;
  });
}
