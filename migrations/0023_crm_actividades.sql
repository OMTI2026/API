-- CRM · Bitácora de actividades (Fase 2).
-- Registra cada interacción con un prospecto (llamada/correo/visita/whatsapp/
-- reunión/nota): quién, cuándo y qué resultó. Alimenta la ficha del prospecto
-- (línea de tiempo), el feed de actividad por vendedor y el semáforo de
-- estancados. Se denormaliza `ultimo_contacto` en `prospectos` para el semáforo.

CREATE TABLE IF NOT EXISTS prospecto_actividades (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  prospecto_id UUID NOT NULL REFERENCES prospectos(id) ON DELETE CASCADE,
  bu           bu_t NOT NULL,                       -- denormalizado para el feed scopeado
  tipo         TEXT NOT NULL DEFAULT 'nota',        -- llamada|correo|visita|whatsapp|reunion|nota
  fecha        TIMESTAMPTZ NOT NULL DEFAULT now(),  -- cuándo ocurrió
  responsable  TEXT,                                -- vendedor que la realizó
  nota         TEXT,                                -- qué pasó / resultado
  data         JSONB NOT NULL DEFAULT '{}',         -- proximoPaso, proximoFecha, etc.
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_prosp_act_prospecto ON prospecto_actividades(prospecto_id);
CREATE INDEX IF NOT EXISTS idx_prosp_act_bu ON prospecto_actividades(bu);
CREATE INDEX IF NOT EXISTS idx_prosp_act_fecha ON prospecto_actividades(fecha DESC);
CREATE INDEX IF NOT EXISTS idx_prosp_act_responsable ON prospecto_actividades(responsable);

-- Semáforo de seguimiento: fecha de la última actividad del prospecto.
ALTER TABLE prospectos ADD COLUMN IF NOT EXISTS ultimo_contacto TIMESTAMPTZ;
