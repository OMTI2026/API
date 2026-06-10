-- Registros de mantenimiento de flota (módulo Mantenimiento, solo Flota Propia).
-- Cada fila es un checklist diligenciado para una unidad: el tipo de checklist
-- (checklist_id, p.ej. 'menor-camioneta-1-5t'), la unidad (referencia = placa/
-- económico) y, en `data` JSONB, el encabezado (operador, fecha, km, folio OT,
-- taller) + el estado de cada ítem ({ estado: ok|atencion|falla, obs, responsable }).
-- Las plantillas de los checklists viven en el frontend (datos de referencia).

CREATE TABLE IF NOT EXISTS mantenimientos (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  bu           bu_t NOT NULL,
  checklist_id TEXT NOT NULL,          -- tipo de checklist (slug del Excel)
  referencia   TEXT NOT NULL,          -- unidad / placa
  data         JSONB NOT NULL DEFAULT '{}',
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_mantenimientos_bu ON mantenimientos(bu);
CREATE INDEX IF NOT EXISTS idx_mantenimientos_checklist ON mantenimientos(checklist_id);
CREATE INDEX IF NOT EXISTS idx_mantenimientos_referencia ON mantenimientos(lower(referencia));
CREATE INDEX IF NOT EXISTS idx_mantenimientos_creado ON mantenimientos(created_at DESC);
