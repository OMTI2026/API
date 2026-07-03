-- Capacidades finas por usuario, además de la matriz de permisos por módulo
-- (users.permissions). JSONB de flags booleanos, p.ej.:
--   { "editar_datos_viaje": true, "recibe_avisos_datos_viaje": true }
-- Ausencia de una clave = false. Se otorgan/revocan por usuario desde el
-- UserModal. Ver src/lib/permissions.js (CAPABILITIES) y el guard
-- app.requireCapability en src/plugins/rbac.js.
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS capabilities JSONB NOT NULL DEFAULT '{}'::jsonb;
