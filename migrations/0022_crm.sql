-- CRM · Prospección de clientes (Fase 1).
-- Módulo comercial para dar seguimiento a prospectos ANTES de que sean clientes.
-- Desacoplado de la operación: un prospecto solo se liga al TMS cuando se "gana"
-- y se da de alta como cliente (cliente_id se llena en la conversión).
-- Reusa el enum bu_t existente (0001_init.sql). Los contactos y campos
-- comerciales (giro, origen, responsable, potencial, notas, motivo de pérdida)
-- viven en `data` JSONB para no normalizar de más en la Fase 1.

CREATE TABLE IF NOT EXISTS prospectos (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  bu          bu_t NOT NULL,
  cliente_id  UUID REFERENCES clients(id) ON DELETE SET NULL,  -- se llena al convertir (Ganado)
  empresa     TEXT NOT NULL,
  contacto    TEXT,                                            -- contacto principal (texto)
  etapa       TEXT NOT NULL DEFAULT 'nuevo',                   -- nuevo|contactado|propuesta|negociacion|ganado|perdido
  data        JSONB NOT NULL DEFAULT '{}',                     -- contactos[], telefono, correo, rfc, giro, origen, responsable, potencial, notas, motivoPerdida
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_prospectos_bu ON prospectos(bu);
CREATE INDEX IF NOT EXISTS idx_prospectos_etapa ON prospectos(etapa);
CREATE INDEX IF NOT EXISTS idx_prospectos_cliente ON prospectos(cliente_id);
CREATE INDEX IF NOT EXISTS idx_prospectos_creado ON prospectos(created_at DESC);
