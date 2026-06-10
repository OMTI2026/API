-- Gastos operativos (módulo Gastos Operativos, solo Flota Propia). Registra
-- cada gasto que hace operación; puede ligarse OPCIONALMENTE a un viaje (flete)
-- o quedar sin viaje. Distinto de `gastos_extra` (cobro/pago por servicio con
-- flujo de liberación a CxC/CxP): aquí solo se captura el gasto y su monto.
-- flete_id es NULL-able y usa ON DELETE SET NULL para no perder el gasto si el
-- viaje se elimina. Sigue el patrón de mantenimientos (0010).

CREATE TABLE IF NOT EXISTS gastos_operativos (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  bu           bu_t NOT NULL,
  flete_id     UUID REFERENCES fletes(id) ON DELETE SET NULL,  -- viaje opcional
  fecha        DATE,
  concepto     TEXT,
  monto        NUMERIC(12,2),
  categoria    TEXT,
  metodo_pago  TEXT,
  proveedor    TEXT,
  comprobante  TEXT,
  data         JSONB NOT NULL DEFAULT '{}',
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_gastos_operativos_bu ON gastos_operativos(bu);
CREATE INDEX IF NOT EXISTS idx_gastos_operativos_flete ON gastos_operativos(flete_id);
CREATE INDEX IF NOT EXISTS idx_gastos_operativos_fecha ON gastos_operativos(fecha DESC);
