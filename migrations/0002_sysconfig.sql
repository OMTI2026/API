-- ELROI CargoDesk — configuración del sistema (tema, logo, ajustes varios)
-- El frontend guardaba esto solo en localStorage (sysConfig = {theme, logoDataUrl, lang, timezone}).
-- Lo persistimos en backend para que sea consistente entre dispositivos.
--
-- Modelo: una fila por business-unit, con `bu` NULL = configuración GLOBAL (fallback).
-- `theme`, `logo_ref` y `settings` (JSONB) cubren tema, logo y ajustes misceláneos
-- (lang, timezone, y cualquier clave futura sin migración adicional).
-- El logo se guarda como referencia (URL o archivo id), nunca el binario.

CREATE TABLE IF NOT EXISTS sys_config (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  bu          bu_t,                              -- NULL = configuración global
  theme       TEXT NOT NULL DEFAULT 'elroi',
  logo_ref    TEXT,                              -- URL o archivos.id (no el binario)
  settings    JSONB NOT NULL DEFAULT '{}',       -- lang, timezone, etc.
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by  UUID REFERENCES users(id)
);

-- Una sola fila por BU (y una sola global). Índice único parcial para permitir
-- un único registro con bu NULL (los UNIQUE normales no aplican a NULLs).
CREATE UNIQUE INDEX IF NOT EXISTS idx_sysconfig_bu ON sys_config(bu) WHERE bu IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_sysconfig_global ON sys_config((bu IS NULL)) WHERE bu IS NULL;
