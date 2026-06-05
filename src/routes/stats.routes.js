import { q } from '../db.js';
import { visibleBUs } from '../lib/scope.js';

export default async function statsRoutes(app) {
  app.addHook('preHandler', app.authenticate);

  // KPIs del dashboard: venta/utilidad del mes y del año (SOLO fletes
  // finalizados; los cancelados NO suman venta), más conteo de cancelados.
  // Proyección: viajes (número) y venta de TODOS los no cancelados
  // (activo + finalizado), del mes y del año.
  app.get('/dashboard', async (req) => {
    const bus = visibleBUs(req.user);
    const { rows } = await q(
      `WITH base AS (
         SELECT f.id, f.status, f.created_at,
                COALESCE(f.tarifa_cobro,0) AS cobro,
                COALESCE(f.tarifa_cobro,0) - COALESCE(f.tarifa_pago,0) AS util
         FROM fletes f
         WHERE f.bu = ANY($1)
       )
       SELECT
         COALESCE(SUM(cobro) FILTER (WHERE status='finalizado' AND date_trunc('year', created_at) = date_trunc('year', now())),0)  AS venta_anual,
         COALESCE(SUM(util)  FILTER (WHERE status='finalizado' AND date_trunc('year', created_at) = date_trunc('year', now())),0)  AS util_anual,
         COALESCE(SUM(cobro) FILTER (WHERE status='finalizado' AND date_trunc('month', created_at) = date_trunc('month', now())),0) AS venta_mes,
         COALESCE(SUM(util)  FILTER (WHERE status='finalizado' AND date_trunc('month', created_at) = date_trunc('month', now())),0) AS util_mes,
         COUNT(*) FILTER (WHERE status='cancelado' AND date_trunc('month', created_at) = date_trunc('month', now())) AS cancel_mes,
         COUNT(*) FILTER (WHERE status='cancelado' AND date_trunc('year', created_at)  = date_trunc('year', now()))  AS cancel_anual,
         -- Proyección: TODOS los viajes no cancelados (activo + finalizado), número y venta.
         COALESCE(SUM(cobro) FILTER (WHERE status<>'cancelado' AND date_trunc('year', created_at) = date_trunc('year', now())),0) AS proy_venta_anual,
         COUNT(*)            FILTER (WHERE status<>'cancelado' AND date_trunc('year', created_at) = date_trunc('year', now()))    AS proy_viajes_anual,
         COALESCE(SUM(cobro) FILTER (WHERE status<>'cancelado' AND date_trunc('month', created_at) = date_trunc('month', now())),0) AS proy_venta_mes,
         COUNT(*)            FILTER (WHERE status<>'cancelado' AND date_trunc('month', created_at) = date_trunc('month', now()))    AS proy_viajes_mes
       FROM base`,
      [bus],
    );
    return rows[0];
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
