-- ELROI CargoDesk — permisos manuales por usuario.
-- `permissions` guarda SOLO los overrides respecto al preset del rol:
-- un mapa parcial { modulo: 'none'|'view'|'edit' }. Vacío = usa el preset del rol.
-- Los permisos efectivos se calculan en la app (src/lib/permissions.js).

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS permissions JSONB NOT NULL DEFAULT '{}'::jsonb;
