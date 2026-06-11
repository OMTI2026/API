-- Cargas de combustible por unidad (módulo Combustible / Rendimientos, Flota
-- Propia). Cada fila es una carga del reporte del proveedor: unidad (placa),
-- litros, precio, total, producto (DIESEL / 91 OCTANOS), estación, ticket y
-- factura, más el ODÓMETRO capturado por el usuario (el reporte del proveedor NO
-- trae el kilometraje real). El rendimiento (km/L) se calcula en el frontend
-- entre cargas consecutivas de la misma unidad: (odómetro actual − anterior) /
-- litros de la carga. `data` JSONB para extras del reporte.

CREATE TABLE IF NOT EXISTS combustible_cargas (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  bu           bu_t NOT NULL,
  fecha        TIMESTAMPTZ,            -- fecha/hora de la carga (ISO)
  placa        TEXT NOT NULL,          -- unidad
  economico    TEXT,
  descripcion  TEXT,                   -- descripción de la unidad (del reporte)
  departamento TEXT,                   -- FLOTA DEDICADA / TRACTOCAMION
  producto     TEXT,                   -- DIESEL / 91 OCTANOS
  litros       NUMERIC,
  precio       NUMERIC,                -- precio por litro
  total        NUMERIC,                -- costo total de la carga
  odometro     NUMERIC,                -- km capturado por el usuario (puede ser null)
  ticket       TEXT,                   -- No. Ticket del proveedor (dedup de import)
  estacion     TEXT,
  factura      TEXT,
  data         JSONB NOT NULL DEFAULT '{}',
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_combustible_bu ON combustible_cargas(bu);
CREATE INDEX IF NOT EXISTS idx_combustible_placa ON combustible_cargas(lower(placa));
CREATE INDEX IF NOT EXISTS idx_combustible_fecha ON combustible_cargas(fecha DESC);
CREATE INDEX IF NOT EXISTS idx_combustible_ticket ON combustible_cargas(ticket);
