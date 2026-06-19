-- Transacciones de casetas por unidad (TAG IAVE), Flota Propia. Cada fila es un
-- cruce del reporte de IAVE: TAG, fecha/hora de cruce, operador (PASE/CEPSICE/
-- CAPUFE/SITEL/OHL), plaza de cobro, categoría, importe cobrado, fecha de cobro,
-- número económico de la unidad, vehículo y la factura IAVE (serie-folio). El
-- `uuid_tx` (UUID TRANSACCION del reporte) es la llave de deduplicación: re-subir
-- el mismo archivo NO duplica. `placa` se resuelve desde Documentos por económico
-- (puede quedar null si la unidad aún no está dada de alta). Análoga a
-- combustible_cargas: costo operativo por unidad que alimenta CPK/P&L y el pago
-- semanal a proveedor (IAVE, crédito 30 días). `data` JSONB para extras.

CREATE TABLE IF NOT EXISTS casetas_cargas (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  bu           bu_t NOT NULL,
  uuid_tx      TEXT,                  -- UUID TRANSACCION (dedup de import)
  tag          TEXT,                  -- TAG IAVE (CPFI...)
  fecha_cruce  TIMESTAMPTZ,           -- FECHA Y HORA CRUCE (ancla de periodo/pago)
  fecha_cobro  DATE,                  -- FECHA COBRO de IAVE
  operador     TEXT,                  -- concesionaria: PASE/CEPSICE/CAPUFE/SITEL/OHL
  plaza        TEXT,                  -- PLAZA DE COBRO
  carril       TEXT,
  categoria    TEXT,                  -- CATEGORIA COBRADA (T05, T02, ...)
  importe      NUMERIC,               -- IMPORTE COBRADO
  economico    TEXT,                  -- NO ECONOMICO de la unidad (normalizado)
  placa        TEXT,                  -- resuelta desde Documentos (puede ser null)
  vehiculo     TEXT,                  -- CAMION 3 EJES / 2 EJES / AUTOMOVIL
  serie_folio  TEXT,                  -- factura IAVE (SERIE-FOLIO)
  decena       TEXT,                  -- periodo de facturación IAVE
  proveedor    TEXT NOT NULL DEFAULT 'IAVE',
  data         JSONB NOT NULL DEFAULT '{}',
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Dedup por UUID de transacción (parcial: filas sin uuid no chocan entre sí).
CREATE UNIQUE INDEX IF NOT EXISTS uq_casetas_cargas_uuid ON casetas_cargas(uuid_tx) WHERE uuid_tx IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_casetas_cargas_bu ON casetas_cargas(bu);
CREATE INDEX IF NOT EXISTS idx_casetas_cargas_econ ON casetas_cargas(lower(economico));
CREATE INDEX IF NOT EXISTS idx_casetas_cargas_fcruce ON casetas_cargas(fecha_cruce DESC);
