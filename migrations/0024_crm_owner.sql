-- CRM · Dueño del prospecto (control de edición).
-- La edición/avance de un prospecto queda restringida a su DUEÑO (el usuario que
-- lo registró), con admin y gerente como excepción. La VISIBILIDAD no cambia:
-- todos siguen viendo todo por unidad de negocio. Los registros previos quedan
-- con owner NULL = editables por cualquiera con permiso (no se bloquean retro).
ALTER TABLE prospectos ADD COLUMN IF NOT EXISTS owner_id UUID REFERENCES users(id);

CREATE INDEX IF NOT EXISTS idx_prospectos_owner ON prospectos(owner_id);
