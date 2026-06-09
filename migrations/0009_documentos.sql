-- Documentación de operadores y unidades (tracto/remolque) por proveedor.
-- Catálogo plano: un registro por entidad (operador | tracto | remolque),
-- ligado a un transportista (carrier). Los campos específicos de cada tipo,
-- los vencimientos y las referencias a fotos {key,filename} en R2 viven en
-- `data` JSONB (mismo patrón que carriers/fletes). `referencia` es el
-- identificador del titular: nombre del operador o placa de la unidad — se usa
-- para cruzar con los fletes (operador, placa tracto, placa remolque).

DO $$ BEGIN
  CREATE TYPE doc_entidad_t AS ENUM ('operador','tracto','remolque');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS documentos (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  bu          bu_t NOT NULL,
  carrier_id  UUID REFERENCES carriers(id) ON DELETE SET NULL,
  entidad     doc_entidad_t NOT NULL,
  referencia  TEXT NOT NULL,          -- nombre del operador | placa de la unidad
  data        JSONB NOT NULL DEFAULT '{}',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_documentos_bu ON documentos(bu);
CREATE INDEX IF NOT EXISTS idx_documentos_carrier ON documentos(carrier_id);
CREATE INDEX IF NOT EXISTS idx_documentos_entidad ON documentos(entidad);
CREATE INDEX IF NOT EXISTS idx_documentos_referencia ON documentos(entidad, lower(referencia));
