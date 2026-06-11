-- Cotizaciones (módulo Cotizador, solo Flota Propia). Cada fila es una cotización
-- de un servicio: origen/destino + cliente opcional, con el desglose de costos y
-- el precio sugerido. Los insumos (distancia, casetas, días) y el desglose
-- calculado se guardan en `data` JSONB para que la cotización sea reproducible
-- aunque cambie el perfil de costos. Fase A del Cotizador (distancia y casetas
-- capturadas a mano; el ruteo/casetas automáticos llegan en fases B/C).

CREATE TABLE IF NOT EXISTS cotizaciones (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  bu          bu_t NOT NULL,
  cliente_id  UUID REFERENCES clients(id) ON DELETE SET NULL,  -- cliente opcional
  origen      TEXT,
  destino     TEXT,
  precio      NUMERIC(12,2),                                   -- precio sugerido
  estado      TEXT NOT NULL DEFAULT 'borrador',                -- borrador|enviada|aprobada|rechazada
  data        JSONB NOT NULL DEFAULT '{}',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_cotizaciones_bu ON cotizaciones(bu);
CREATE INDEX IF NOT EXISTS idx_cotizaciones_cliente ON cotizaciones(cliente_id);
CREATE INDEX IF NOT EXISTS idx_cotizaciones_creada ON cotizaciones(created_at DESC);
