import { q } from '../db.js';
import { visibleBUs } from '../lib/scope.js';

export default async function statsRoutes(app) {
  app.addHook('preHandler', app.authenticate);

  // KPIs del dashboard: venta/utilidad del mes y del año, cancelados.
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
         COALESCE(SUM(cobro) FILTER (WHERE date_trunc('year', created_at) = date_trunc('year', now())),0)  AS venta_anual,
         COALESCE(SUM(util)  FILTER (WHERE date_trunc('year', created_at) = date_trunc('year', now())),0)  AS util_anual,
         COALESCE(SUM(cobro) FILTER (WHERE date_trunc('month', created_at) = date_trunc('month', now())),0) AS venta_mes,
         COALESCE(SUM(util)  FILTER (WHERE date_trunc('month', created_at) = date_trunc('month', now())),0) AS util_mes,
         COUNT(*) FILTER (WHERE status='cancelado' AND date_trunc('month', created_at) = date_trunc('month', now())) AS cancel_mes,
         COUNT(*) FILTER (WHERE status='cancelado' AND date_trunc('year', created_at)  = date_trunc('year', now()))  AS cancel_anual
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
