-- Llantas (módulo Llantas, Flota Propia). Cada fila es una llanta física con su
-- costo, medida y vida. Se instala en una unidad (placa) + posición; al rotar o
-- retirar se acumulan los km del segmento en `km_acumulados` y se reinicia
-- `odometro_instalacion`. Desgaste por km (vida esperada) y por profundidad de
-- dibujo (mm). El historial de movimientos vive en `data.movimientos` (JSONB):
--   [{ tipo:'instalacion'|'rotacion'|'retiro', fecha, odometro, unidad, posicion }]
-- El odómetro "de hoy" de cada unidad lo calcula el frontend (combustible+viajes).

CREATE TABLE IF NOT EXISTS llantas (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  bu                    bu_t NOT NULL,
  codigo                TEXT,                 -- identificador de la llanta (DOT/interno)
  marca                 TEXT,
  medida                TEXT,                 -- ej. 295/80R22.5
  costo                 NUMERIC,
  fecha_compra          TIMESTAMPTZ,
  estado                TEXT NOT NULL DEFAULT 'inventario', -- inventario | instalada | retirada
  unidad_placa          TEXT,                 -- unidad donde está instalada
  posicion              TEXT,                 -- posición en la unidad
  odometro_instalacion  NUMERIC,              -- odómetro de la unidad al instalar en la posición actual
  km_acumulados         NUMERIC NOT NULL DEFAULT 0, -- km de vida en posiciones anteriores
  vida_esperada_km      NUMERIC,              -- km esperados de vida
  prof_inicial_mm       NUMERIC,              -- profundidad de dibujo inicial
  prof_actual_mm        NUMERIC,              -- última profundidad medida
  prof_min_mm           NUMERIC,              -- mínimo legal (default 4 en el front)
  data                  JSONB NOT NULL DEFAULT '{}',
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_llantas_bu ON llantas(bu);
CREATE INDEX IF NOT EXISTS idx_llantas_placa ON llantas(lower(unidad_placa));
CREATE INDEX IF NOT EXISTS idx_llantas_estado ON llantas(estado);
