-- CRM · Tipo de prospecto (Cliente | Proveedor).
-- Permite prospectar tanto CLIENTES (dan la carga) como PROVEEDORES/transportistas
-- (la mueven), con el mismo embudo. Al ganar: Cliente -> alta en clients (cliente_id);
-- Proveedor -> alta en carriers (carrier_id liga el transportista creado).
ALTER TABLE prospectos ADD COLUMN IF NOT EXISTS tipo TEXT NOT NULL DEFAULT 'cliente';
ALTER TABLE prospectos ADD COLUMN IF NOT EXISTS carrier_id UUID REFERENCES carriers(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_prospectos_tipo ON prospectos(tipo);
