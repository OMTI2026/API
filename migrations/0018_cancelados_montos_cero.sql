-- Servicios cancelados: sus montos ya no deben contar en ningún total/KPI de los
-- módulos financieros (solo se cuentan en el apartado "Cancelados" del dashboard
-- y siguen apareciendo en los XLS de cada módulo, con status CANCELADO y en $0).
--
-- Mecanismo: poner en CERO tarifa_cobro/tarifa_pago del flete y cobro/pago de sus
-- gastos_extra. Los montos ORIGINALES se preservan en data.cancelacion.montos_previos
-- (auditoría / reversible). Idempotente: no re-preserva ni re-pisa lo ya en cero.

BEGIN;

-- 1) Preservar montos originales (una sola vez) y poner en cero la tarifa del flete.
UPDATE fletes f
   SET data = f.data || jsonb_build_object(
                'cancelacion',
                COALESCE(f.data->'cancelacion', '{}'::jsonb) || jsonb_build_object(
                  'montos_previos', jsonb_build_object(
                    'tarifa_cobro', f.tarifa_cobro,
                    'tarifa_pago',  f.tarifa_pago,
                    'gastos', COALESCE(
                      (SELECT jsonb_agg(jsonb_build_object('id', g.id, 'cobro', g.cobro, 'pago', g.pago))
                         FROM gastos_extra g WHERE g.flete_id = f.id),
                      '[]'::jsonb)
                  ))),
       tarifa_cobro = 0,
       tarifa_pago  = 0,
       updated_at   = now()
 WHERE f.status = 'cancelado'
   AND NOT COALESCE(f.data->'cancelacion' ? 'montos_previos', false);

-- 2) Poner en cero los gastos_extra de los fletes cancelados.
UPDATE gastos_extra g
   SET cobro = 0, pago = 0
  FROM fletes f
 WHERE f.id = g.flete_id
   AND f.status = 'cancelado'
   AND (COALESCE(g.cobro, 0) <> 0 OR COALESCE(g.pago, 0) <> 0);

COMMIT;
